import { z } from "zod";
import { LogicalKey } from "@lexiloop/content-schema";

/**
 * Versioned JSON envelopes for blobs this package stores as TEXT (spec 6.2).
 * Every repository read/write of these blobs validates the envelope at the
 * boundary, so malformed or future-versioned data fails fast instead of
 * silently corrupting learning state.
 */

/**
 * FSRS card state envelope (v1), mirroring the ts-fsrs card fields we persist.
 * `due_at` / `last_review_at` are UTC epoch ms; `due`, `reps`, `lapses` and
 * `last_review_at` are additionally mirrored into card_state columns for the
 * due-queue index (spec 6.3).
 */
export const FsrsStateEnvelope = z.strictObject({
  version: z.literal(1),
  /** ts-fsrs card state. */
  state: z.enum(["New", "Learning", "Review", "Relearning"]),
  stability: z.number().min(0),
  difficulty: z.number().min(1).max(10),
  due_at: z.number().int().nonnegative(),
  last_review_at: z.number().int().nonnegative().nullable(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
});

export type FsrsState = z.infer<typeof FsrsStateEnvelope>;

/**
 * study_session queue snapshot envelope (v1). The session pins its release
 * (spec 6.4) and every queued entry keeps both the canonical card key (which
 * card_state is keyed by) and the exact presented key for that release.
 */
export const QueueSnapshotEnvelope = z.strictObject({
  version: z.literal(1),
  release_id: z.string().min(1),
  cards: z.array(
    z.strictObject({
      canonical_card_key: LogicalKey,
      presented_card_key: LogicalKey,
    }),
  ),
});

export type QueueSnapshot = z.infer<typeof QueueSnapshotEnvelope>;

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new Error(`${what}: stored value is not valid JSON`, { cause });
  }
}

/** Parses and validates a stored FSRS state blob. */
export function parseFsrsState(json: string): FsrsState {
  return FsrsStateEnvelope.parse(parseJson(json, "fsrs_state"));
}

/** Validates a FSRS state before it is written. */
export function validateFsrsState(state: FsrsState): FsrsState {
  return FsrsStateEnvelope.parse(state);
}

/** Parses and validates a stored queue snapshot blob. */
export function parseQueueSnapshot(json: string): QueueSnapshot {
  return QueueSnapshotEnvelope.parse(parseJson(json, "queue_snapshot"));
}

/** Validates a queue snapshot before it is written. */
export function validateQueueSnapshot(snapshot: QueueSnapshot): QueueSnapshot {
  return QueueSnapshotEnvelope.parse(snapshot);
}
