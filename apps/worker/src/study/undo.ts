/**
 * Undo (spec 8.3): revocation of the user's LATEST valid, un-undone review
 * event, and only while its owning study_session is unexpired. One atomic
 * batch: fill `undone_at`, rewind the session position, and restore the
 * canonical state — an empty `before_state` marks a FIRST grade, so the
 * card_state row is DELETED; otherwise it is restored. When that reopens a
 * word's introduction (an active card of its first-introduction queue is
 * missing again), word_progress atomically reverts to IN_PROGRESS and the
 * introduction release/time are cleared. The review_log row itself always
 * remains — only `undone_at` is filled.
 */

import { sql, type SQL } from "drizzle-orm";
import type { FsrsStateV1 } from "@lexiloop/fsrs";
import type { UserContext, WordProgressRow } from "@lexiloop/db";
import { StudyHttpError, StudyService } from "./service";

export interface UndoResult {
  event_id: string;
  undone_at: number;
  /** Canonical state key the undone event addressed. */
  card_key: string;
  /** Restored envelope; null when the first grade's card_state was deleted. */
  restored_state: FsrsStateV1 | null;
  /** The word's stage after the batch; null when the word has no progress row. */
  word_stage: string | null;
}

/**
 * Undoes one event. Rejections are stable: unknown event (404), already
 * undone (409), not the latest event (409), owning session expired (400).
 */
export async function undoReview(
  service: StudyService,
  ctx: UserContext,
  eventId: string,
): Promise<UndoResult> {
  const record = await service.reviewLogs.get(ctx, eventId);
  if (!record) {
    throw new StudyHttpError(404, "REVIEW_EVENT_NOT_FOUND", "Review event does not exist");
  }
  if (record.undoneAt !== null) {
    throw new StudyHttpError(409, "REVIEW_EVENT_UNDONE", "Review event has already been undone");
  }
  // Latest-only (spec 8.3): card_state reflects this event's after_state, so
  // restoring/deleting it is exact; an older event would corrupt the chain.
  const latest = (await service.reviewLogs.listRecent(ctx, 1))[0];
  if (latest && record.reviewedAt < latest.reviewedAt) {
    throw new StudyHttpError(409, "REVIEW_UNDO_NOT_LATEST", "Only the latest review event can be undone");
  }
  if (!record.sessionId) {
    throw new StudyHttpError(400, "STUDY_SESSION_INVALID", "Review event does not belong to a study session");
  }
  const session = await service.requireSession(ctx, record.sessionId);

  const now = service.now();
  const resolvedCard = await service.resolvePresented(session, record.presentedCardKey);
  const progress = await service.words.get(ctx, resolvedCard.canonicalWordKey);
  // The introduction release is the release whose queue defined completeness
  // at flip time; for an in-session undo it is the session's own release.
  const completenessRelease = progress?.introducedReleaseId ?? session.releaseId;
  const canonicalKeys = await service.canonicalCardKeys(completenessRelease, resolvedCard.localWordKey);
  const isFirstGrade = record.beforeState === null;

  const statements: SQL[] = [
    sql`UPDATE review_log SET undone_at = ${now} WHERE event_id = ${record.eventId} AND user_id = ${ctx.userId} AND undone_at IS NULL`,
    isFirstGrade
      ? sqlDeleteCardState(ctx.userId, resolvedCard.canonicalCardKey)
      : sqlRestoreCardState(ctx.userId, resolvedCard.canonicalCardKey, record.beforeState!, now),
    sql`UPDATE study_session SET position = max(position - 1, 0) WHERE session_id = ${session.sessionId} AND user_id = ${ctx.userId}`,
  ];
  if (progress && progress.stage === "INTRODUCED" && canonicalKeys.length > 0) {
    // Evaluated in-batch AFTER the delete/restore: reverts the word exactly
    // when its introduction was reopened by this undo. A restored row still
    // counts, so a restore keeps the word INTRODUCED while a delete reopens it.
    statements.push(sqlRevertWordIntroduced(ctx.userId, resolvedCard.canonicalWordKey, canonicalKeys, now));
  }
  await service.atomic.run(statements);

  return {
    event_id: record.eventId,
    undone_at: now,
    card_key: record.contentCardKey,
    restored_state: record.beforeState,
    word_stage: progress ? wordStageAfter(progress, isFirstGrade) : null,
  };
}

/** The word's stage after the batch: unchanged unless the revert fired. */
function wordStageAfter(progress: WordProgressRow, isFirstGrade: boolean): string {
  if (progress.stage !== "INTRODUCED") {
    return progress.stage;
  }
  return isFirstGrade ? "IN_PROGRESS" : progress.stage;
}

function sqlDeleteCardState(userId: string, canonicalCardKey: string): SQL {
  return sql`DELETE FROM card_state WHERE user_id = ${userId} AND content_card_key = ${canonicalCardKey}`;
}

function sqlRestoreCardState(userId: string, canonicalCardKey: string, before: FsrsStateV1, now: number): SQL {
  return sql`UPDATE card_state
    SET fsrs_state = ${JSON.stringify(before)}, due = ${before.due_at}, reps = ${before.reps}, lapses = ${before.lapses},
        last_review_at = ${before.last_review_at}, updated_at = ${now}
    WHERE user_id = ${userId} AND content_card_key = ${canonicalCardKey}`;
}

/** Reopens the word when an active card of its first-introduction queue is
 * missing a card_state (evaluated in-batch, post delete/restore). */
function sqlRevertWordIntroduced(
  userId: string,
  canonicalWordKey: string,
  canonicalCardKeys: readonly string[],
  now: number,
): SQL {
  const keys = sql.join(canonicalCardKeys.map((key) => sql`${key}`), sql`, `);
  return sql`UPDATE word_progress
    SET stage = 'IN_PROGRESS', introduced_release_id = NULL, introduced_at = NULL, last_seen_at = ${now}
    WHERE user_id = ${userId} AND word_key = ${canonicalWordKey} AND stage = 'INTRODUCED'
      AND (SELECT COUNT(*) FROM card_state cs WHERE cs.user_id = ${userId} AND cs.content_card_key IN (${keys})) < ${canonicalCardKeys.length}`;
}
