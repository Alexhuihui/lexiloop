/**
 * StudyPatch handling (spec 8.3/9.3): WORD_PRESENTED and FAMILIARITY_SET.
 *
 * Both actions validate that the patched word is the CURRENT item of the
 * session's pinned queue (both sides alias-resolved to their canonical
 * words), are idempotent by `event_id` (processed ids are recorded on the
 * session snapshot), and run as ONE atomic batch: the word_progress upsert
 * plus the snapshot bookkeeping commit together or not at all.
 *
 * WORD_PRESENTED atomically creates/updates word_progress, sets
 * `first_seen_at` once (insert-only), and moves ONLY UNSEEN -> IN_PROGRESS —
 * an INTRODUCED word is never demoted. FAMILIARITY_SET stores the
 * first-contact choice (spec 9.3) and `last_seen_at` but NEVER creates
 * `card_state` and NEVER invokes FSRS.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Familiarity, UserContext, WordProgressRow } from "@lexiloop/db";
import { StudyHttpError, StudyService } from "./service";

/** The plan's binding StudyPatch discriminated body. */
export const StudyPatchSchema = z.discriminatedUnion("action", [
  z.strictObject({
    event_id: z.string().min(1).max(128),
    action: z.literal("WORD_PRESENTED"),
    word_key: z.string().min(1).max(256),
  }),
  z.strictObject({
    event_id: z.string().min(1).max(128),
    action: z.literal("FAMILIARITY_SET"),
    word_key: z.string().min(1).max(256),
    familiarity: z.enum(["VERY_UNFAMILIAR", "SOMEWHAT_FAMILIAR", "FAMILIAR"]),
  }),
]);

export type StudyPatch = z.infer<typeof StudyPatchSchema>;

type ApiFamiliarity = "VERY_UNFAMILIAR" | "SOMEWHAT_FAMILIAR" | "FAMILIAR";

/** API familiarity -> stored `initial_familiarity` (spec 9.3: 很陌生/有印象/熟悉). */
const FAMILIARITY_STORAGE: Record<ApiFamiliarity, Familiarity> = {
  VERY_UNFAMILIAR: "UNKNOWN",
  SOMEWHAT_FAMILIAR: "RECOGNIZABLE",
  FAMILIAR: "KNOWN",
};

/** Stored value back to the API vocabulary. */
const FAMILIARITY_API: Record<Familiarity, ApiFamiliarity> = {
  UNKNOWN: "VERY_UNFAMILIAR",
  RECOGNIZABLE: "SOMEWHAT_FAMILIAR",
  KNOWN: "FAMILIAR",
};

export interface PatchProgressView {
  stage: string;
  initial_familiarity: ApiFamiliarity | null;
  first_seen_at: number;
  last_seen_at: number;
}

export interface PatchResult {
  event_id: string;
  word_key: string;
  progress: PatchProgressView;
  replayed: boolean;
}

/**
 * Applies one patch. The patched word must own the queue item at the
 * session's current position. Replayed event ids return the word's current
 * progress with `replayed: true` and perform no write — idempotent by
 * construction, since the first application already committed.
 */
export async function applyStudyPatch(
  service: StudyService,
  ctx: UserContext,
  sessionId: string,
  patch: StudyPatch,
): Promise<PatchResult> {
  const session = await service.requireSession(ctx, sessionId);
  const canonicalWordKey = await service.aliases.resolve({ releaseId: session.releaseId, key: patch.word_key });

  if ((session.queue.patch_event_ids ?? []).includes(patch.event_id)) {
    const existing = await service.words.get(ctx, canonicalWordKey);
    return {
      event_id: patch.event_id,
      word_key: patch.word_key,
      replayed: true,
      progress: existing ? toProgressView(existing, patch.action) : emptyProgress(),
    };
  }

  const current = service.currentCard(session);
  if (!current) {
    throw new StudyHttpError(409, "STUDY_QUEUE_EXHAUSTED", "Every card in this session has been answered");
  }
  const resolved = await service.resolvePresented(session, current.presented_card_key);
  if (canonicalWordKey !== resolved.canonicalWordKey) {
    throw new StudyHttpError(409, "STUDY_WORD_NOT_CURRENT", "Patched word is not the current queue item");
  }

  const now = service.now();
  const familiarity = patch.action === "FAMILIARITY_SET" ? FAMILIARITY_STORAGE[patch.familiarity] : null;
  await service.atomic.run([
    sqlUpsertWordProgress(ctx.userId, canonicalWordKey, familiarity, now),
    await service.appendPatchEventId(session, patch.event_id),
  ]);

  // Report the row as stored: an already-INTRODUCED word keeps its stage.
  const row = (await service.words.get(ctx, canonicalWordKey))!;
  return {
    event_id: patch.event_id,
    word_key: patch.word_key,
    replayed: false,
    progress: toProgressView(row, patch.action),
  };
}

/** Echoes the stored row in the API vocabulary (spec 9.3 familiarity). */
function toProgressView(row: WordProgressRow, action: StudyPatch["action"]): PatchProgressView {
  return {
    stage: row.stage,
    initial_familiarity:
      action === "FAMILIARITY_SET" && row.initialFamiliarity !== null
        ? FAMILIARITY_API[row.initialFamiliarity as Familiarity]
        : null,
    first_seen_at: row.firstSeenAt,
    last_seen_at: row.lastSeenAt,
  };
}

function emptyProgress(): PatchProgressView {
  return { stage: "IN_PROGRESS", initial_familiarity: null, first_seen_at: 0, last_seen_at: 0 };
}

/**
 * word_progress upsert (UNSEEN -> IN_PROGRESS only, `first_seen_at` set
 * once on insert). WORD_PRESENTED leaves `initial_familiarity` untouched;
 * FAMILIARITY_SET overwrites it with the presented choice.
 */
function sqlUpsertWordProgress(userId: string, wordKey: string, familiarity: Familiarity | null, now: number) {
  return sql`INSERT INTO word_progress (user_id, word_key, stage, initial_familiarity, first_seen_at, introduced_release_id, introduced_at, last_seen_at)
    VALUES (${userId}, ${wordKey}, 'IN_PROGRESS', ${familiarity}, ${now}, NULL, NULL, ${now})
    ON CONFLICT (user_id, word_key) DO UPDATE SET
      stage = CASE word_progress.stage WHEN 'UNSEEN' THEN 'IN_PROGRESS' ELSE word_progress.stage END,
      initial_familiarity = ${familiarity === null ? sql`word_progress.initial_familiarity` : sql`excluded.initial_familiarity`},
      last_seen_at = excluded.last_seen_at`;
}
