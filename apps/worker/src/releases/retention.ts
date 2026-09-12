/**
 * Release retention (plan Task 14 / spec 11.3/15): decides which RETIRED
 * content releases and which zero-reference R2 audio objects may be cleaned
 * up, and applies only EXACTLY the deletions an operator confirms.
 *
 * A release is cleanup-eligible only when ALL of these hold:
 * - its status is RETIRED (never the ACTIVE release, never a live pointer);
 * - it is NOT the immediately previous rollback target (the non-active
 *   release with the latest `activated_at` — the version one rollback would
 *   switch back to);
 * - no unexpired `study_session` pins it (spec 15: even past 14 days, a
 *   session reference blocks cleanup);
 * - no user state references it (`word_progress.introduced_release_id`,
 *   `review_log.presented_release_id` — both RESTRICT at the schema level,
 *   so this is checked up front instead of failing mid-delete);
 * - at least 14 days (plan minimum) have passed since its last activation,
 *   so the previous-release content stays available well past the spec's
 *   14-day availability floor.
 *
 * R2 audio that no `audio_asset` row references becomes deletable only after
 * a 7-day grace period, measured from the object's `uploaded` timestamp; the
 * scan is prefix-bounded to `audio/` so backup objects are never candidates.
 *
 * Safety model: `planRetention` is a pure dry-run computation. `applyRetenti-
 * onPlan` defaults to dry-run, refuses anything that is not an exact eligible
 * id/key (never globs or prefixes), and re-verifies release eligibility at
 * execution time so a stale plan cannot delete a release that gained a pin.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  appMeta,
  audioAsset,
  contentRelease,
  reviewLog,
  schema,
  studySession,
  wordProgress,
  type LexiloopDatabase,
} from "@lexiloop/db";

/** Minimum days a release stays available after its last activation (spec 15). */
export const DEFAULT_MIN_DAYS_RETAINED = 14;

/** Grace period for zero-reference R2 audio objects (plan Task 14). */
export const DEFAULT_AUDIO_GRACE_DAYS = 7;

/** R2 prefix that holds audio objects; backups live elsewhere. */
const AUDIO_PREFIX = "audio/";

/**
 * Builder-typed handle for drizzle's field-select overloads: the union handle
 * cannot express them at the type level (the same documented cast the study
 * service uses); both drivers share the builder runtime and every statement
 * runs behind `await`.
 */
function builder(db: LexiloopDatabase): BetterSQLite3Database<typeof schema> {
  return db as BetterSQLite3Database<typeof schema>;
}

export interface RetentionOptions {
  now: number;
  /** Availability floor past the last activation. Default 14 (spec 15). */
  minDaysRetained?: number;
  /** Grace period for zero-reference audio. Default 7 (plan Task 14). */
  audioGraceDays?: number;
}

export interface ReleaseRetentionEntry {
  releaseId: string;
  status: string;
  activatedAt: number | null;
  eligible: boolean;
  /** Machine-readable retention reasons; empty exactly when eligible. */
  blockedBy: string[];
}

export interface AudioRetentionEntry {
  key: string;
  uploadedAt: number;
  referenced: boolean;
  eligible: boolean;
  blockedBy: string[];
}

export interface RetentionPlan {
  now: number;
  activeReleaseId: string | null;
  previousReleaseId: string | null;
  releases: ReleaseRetentionEntry[];
  audio: AudioRetentionEntry[];
  /** The exact deletions a confirmed (non-dry-run) apply would perform. */
  deletions: {
    releaseIds: string[];
    audioKeys: string[];
  };
}

/**
 * Computes the retention dry-run plan. `bucket` may be null to plan release
 * cleanup without an audio scan (no bucket configured).
 */
export async function planRetention(
  db: LexiloopDatabase,
  bucket: R2Bucket | null,
  options: RetentionOptions,
): Promise<RetentionPlan> {
  const minDaysRetained = options.minDaysRetained ?? DEFAULT_MIN_DAYS_RETAINED;
  const audioGraceDays = options.audioGraceDays ?? DEFAULT_AUDIO_GRACE_DAYS;
  const now = options.now;

  const releaseRows = await db.select().from(contentRelease);
  const meta = (await db.select().from(appMeta).where(eq(appMeta.id, 1)).get()) ?? null;
  const activeReleaseId = meta?.activeReleaseId ?? null;

  // The immediately previous rollback target: the non-active release whose
  // last activation is the most recent (the one demoted latest).
  let previousReleaseId: string | null = null;
  let previousActivatedAt = -1;
  for (const row of releaseRows) {
    if (row.releaseId === activeReleaseId || row.activatedAt === null) {
      continue;
    }
    if (row.activatedAt > previousActivatedAt) {
      previousActivatedAt = row.activatedAt;
      previousReleaseId = row.releaseId;
    }
  }

  // Referencing sets (all release-scoped blockers in one round of queries).
  const pinnedReleases = new Set(
    (
      await builder(db)
        .select({ releaseId: studySession.releaseId })
        .from(studySession)
        .where(gt(studySession.expiresAt, now))
    ).map((row) => row.releaseId),
  );
  const introducedReleases = new Set(
    (
      await builder(db)
        .select({ releaseId: wordProgress.introducedReleaseId })
        .from(wordProgress)
        .where(sql`${wordProgress.introducedReleaseId} IS NOT NULL`)
    )
      .map((row) => row.releaseId)
      .filter((releaseId): releaseId is string => releaseId !== null),
  );
  const presentedReleases = new Set(
    (await builder(db).select({ releaseId: reviewLog.presentedReleaseId }).from(reviewLog)).map(
      (row) => row.releaseId,
    ),
  );

  const retentionWindowLabel = `retention-window-${minDaysRetained}d`;
  const releases: ReleaseRetentionEntry[] = releaseRows.map((row) => {
    const blockedBy: string[] = [];
    if (row.status !== "RETIRED") {
      blockedBy.push("status-not-retired");
    }
    if (row.releaseId === previousReleaseId) {
      blockedBy.push("immediately-previous-rollback-target");
    }
    if (pinnedReleases.has(row.releaseId)) {
      blockedBy.push("session-pin");
    }
    if (introducedReleases.has(row.releaseId)) {
      blockedBy.push("introduced-reference");
    }
    if (presentedReleases.has(row.releaseId)) {
      blockedBy.push("review-reference");
    }
    if (row.activatedAt === null) {
      blockedBy.push("never-activated");
    } else if (now - row.activatedAt < minDaysRetained * 86_400_000) {
      blockedBy.push(retentionWindowLabel);
    }
    return {
      releaseId: row.releaseId,
      status: row.status,
      activatedAt: row.activatedAt,
      eligible: blockedBy.length === 0,
      blockedBy,
    };
  });

  // -- R2 audio: zero-reference objects after the grace period. -------------
  const audio: AudioRetentionEntry[] = [];
  if (bucket !== null) {
    const referenced = new Set(
      (await builder(db).select({ assetKey: audioAsset.assetKey }).from(audioAsset)).map((row) => row.assetKey),
    );
    const graceLabel = `audio-grace-${audioGraceDays}d`;
    let cursor: string | undefined;
    for (;;) {
      const page = await bucket.list({ prefix: AUDIO_PREFIX, ...(cursor !== undefined ? { cursor } : {}) });
      for (const object of page.objects) {
        const isReferenced = referenced.has(object.key);
        const uploadedAt = object.uploaded.getTime();
        const blockedBy: string[] = [];
        if (isReferenced) {
          blockedBy.push("referenced-by-audio-asset");
        } else if (now - uploadedAt < audioGraceDays * 86_400_000) {
          blockedBy.push(graceLabel);
        }
        audio.push({
          key: object.key,
          uploadedAt,
          referenced: isReferenced,
          eligible: blockedBy.length === 0,
          blockedBy,
        });
      }
      if (!page.truncated || !page.cursor) {
        break;
      }
      cursor = page.cursor;
    }
  }

  return {
    now,
    activeReleaseId,
    previousReleaseId,
    releases,
    audio,
    deletions: {
      releaseIds: releases
        .filter((entry) => entry.eligible)
        .map((entry) => entry.releaseId)
        .sort(),
      audioKeys: audio
        .filter((entry) => entry.eligible)
        .map((entry) => entry.key)
        .sort(),
    },
  };
}

export interface ApplyRetentionInput {
  /** EXACT release ids from `plan.deletions.releaseIds` — never patterns. */
  releaseIds: readonly string[];
  /** EXACT audio keys from `plan.deletions.audioKeys` — never patterns. */
  audioKeys: readonly string[];
  /**
   * Dry-run by default: nothing is deleted until this is explicitly false.
   */
  dryRun?: boolean;
}

export interface ApplyRetentionResult {
  dryRun: boolean;
  deletedReleaseIds: string[];
  deletedAudioKeys: string[];
}

function requireExact<T>(requested: readonly T[], deletable: ReadonlySet<T>, what: string): void {
  for (const item of requested) {
    if (!deletable.has(item)) {
      throw new Error(`retention apply: ${what} ${String(item)} is not in the eligible deletion set`);
    }
  }
}

/**
 * Applies (or, by default, simulates) exactly the confirmed deletions.
 * Release deletion clears the FTS index rows FIRST (the ordering mandated by
 * infra/migrations/0002 for trigger performance), then deletes the
 * `content_release` row and lets its ON DELETE CASCADE remove the immutable
 * content rows.
 */
export async function applyRetentionPlan(
  db: LexiloopDatabase,
  bucket: R2Bucket,
  plan: RetentionPlan,
  input: ApplyRetentionInput,
): Promise<ApplyRetentionResult> {
  const dryRun = input.dryRun ?? true;
  const deletableReleases = new Set(plan.deletions.releaseIds);
  const deletableAudio = new Set(plan.deletions.audioKeys);
  requireExact(input.releaseIds, deletableReleases, "release");
  requireExact(input.audioKeys, deletableAudio, "audio key");

  if (dryRun) {
    return {
      dryRun: true,
      deletedReleaseIds: [...input.releaseIds].sort(),
      deletedAudioKeys: [...input.audioKeys].sort(),
    };
  }

  // Last-chance guard: a plan computed earlier must not delete a release that
  // gained an unexpired session pin or user-state reference since planning.
  for (const releaseId of input.releaseIds) {
    const pinned = await builder(db)
      .select({ sessionId: studySession.sessionId })
      .from(studySession)
      .where(and(eq(studySession.releaseId, releaseId), gt(studySession.expiresAt, plan.now)))
      .limit(1);
    if (pinned.length > 0) {
      throw new Error(`retention apply: release ${releaseId} is no longer eligible (unexpired session pin)`);
    }
    const introduced = await builder(db)
      .select({ wordKey: wordProgress.wordKey })
      .from(wordProgress)
      .where(eq(wordProgress.introducedReleaseId, releaseId))
      .limit(1);
    if (introduced.length > 0) {
      throw new Error(`retention apply: release ${releaseId} is no longer eligible (introduced reference)`);
    }
    const presented = await builder(db)
      .select({ eventId: reviewLog.eventId })
      .from(reviewLog)
      .where(eq(reviewLog.presentedReleaseId, releaseId))
      .limit(1);
    if (presented.length > 0) {
      throw new Error(`retention apply: release ${releaseId} is no longer eligible (review reference)`);
    }
  }

  for (const releaseId of input.releaseIds) {
    // 0002 migration ordering: bulk-clear the FTS index before the cascading
    // content deletes, so per-row delete triggers scan a near-empty index.
    await db.run(sql`DELETE FROM content_search_fts WHERE release_id = ${releaseId}`);
    await db.delete(contentRelease).where(eq(contentRelease.releaseId, releaseId));
  }
  for (const audioKey of input.audioKeys) {
    await bucket.delete(audioKey);
  }
  return {
    dryRun: false,
    deletedReleaseIds: [...input.releaseIds].sort(),
    deletedAudioKeys: [...input.audioKeys].sort(),
  };
}
