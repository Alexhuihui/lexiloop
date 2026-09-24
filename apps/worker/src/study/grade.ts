/**
 * Server-authoritative grading (spec 8.3). Validation runs in the binding
 * order: auth session (middleware), Origin/CSRF (middleware), `event_id`
 * idempotency, study-session queue position, then card validity in the
 * session's pinned release — ONLY then does the Worker run ts-fsrs.
 *
 * One grade = ONE atomic batch (`service.atomic`, a D1 batch in production):
 * (1) insert the append-only review_log row with before/after states and
 * both canonical and presented keys; (2) upsert the canonical card_state;
 * (3) advance the session position; (4) flip word_progress to INTRODUCED
 * when this grade completes the last active card of the word's
 * first-introduction queue. Any statement failure rolls back the whole unit.
 * A replayed `event_id` returns the ORIGINAL result without re-counting.
 */

import { sql, type SQL } from "drizzle-orm";
import { gradeCard, type FsrsStateV1, type GradeRating } from "@lexiloop/fsrs";
import type { ReviewLogRecord, UserContext } from "@lexiloop/db";
import { StudyHttpError, StudyService } from "./service";

export interface GradeRequest {
  event_id: string;
  session_id: string;
  card_key: string;
  rating: GradeRating;
  duration_ms?: number;
}

export interface GradeResult {
  event_id: string;
  session_id: string;
  /** Canonical state key card_state is keyed by (spec 6.4). */
  card_key: string;
  presented_card_key: string;
  release_id: string;
  rating: GradeRating;
  before_state: FsrsStateV1 | null;
  after_state: FsrsStateV1;
  reviewed_at: number;
  duration_ms: number | null;
  undone_at: number | null;
  replayed: boolean;
}

export interface GradeBatchRequest {
  session_id: string;
  grades: Array<{ event_id: string; card_key: string }>;
  rating: GradeRating;
  duration_ms?: number;
}

export interface GradeBatchResult {
  session_id: string;
  position: number;
  results: GradeResult[];
  replayed: boolean;
}

function toResult(record: ReviewLogRecord, fallbackSessionId: string, replayed: boolean): GradeResult {
  return {
    event_id: record.eventId,
    session_id: record.sessionId ?? fallbackSessionId,
    card_key: record.contentCardKey,
    presented_card_key: record.presentedCardKey,
    release_id: record.presentedReleaseId,
    rating: record.rating,
    before_state: record.beforeState,
    after_state: record.afterState,
    reviewed_at: record.reviewedAt,
    duration_ms: record.durationMs,
    undone_at: record.undoneAt,
    replayed,
  };
}

/**
 * Grades the queue's current card. The presented key must match the item at
 * the session position exactly (the client does not advance before a
 * success response); scheduling runs server-side through the FSRS adapter.
 */
export async function gradeReview(
  service: StudyService,
  ctx: UserContext,
  request: GradeRequest,
): Promise<GradeResult> {
  // Idempotency and the owned session are independent reads. Keep the
  // historical single-grade behavior where a recorded event replays even if
  // its old session has since expired.
  const [existingResult, sessionResult] = await Promise.allSettled([
    service.reviewLogs.get(ctx, request.event_id),
    service.requireSession(ctx, request.session_id),
  ]);
  if (existingResult.status === "rejected") {
    throw existingResult.reason;
  }
  const existing = existingResult.value;
  if (existing) {
    return toResult(existing, request.session_id, true);
  }
  if (sessionResult.status === "rejected") {
    throw sessionResult.reason;
  }

  // 2. study-session queue position.
  const session = sessionResult.value;
  const current = service.currentCard(session);
  if (!current) {
    throw new StudyHttpError(409, "STUDY_QUEUE_EXHAUSTED", "Every card in this session has been answered");
  }
  if (request.card_key !== current.presented_card_key) {
    throw new StudyHttpError(409, "STUDY_CARD_NOT_CURRENT", "Graded card is not the current queue item");
  }

  // 3. card validity in the session's pinned release + alias resolution.
  const resolvedCards = await service.resolvePresentedMany(session, [current.presented_card_key]);
  const resolved = resolvedCards.items[0]!;
  const now = service.now();

  // 4. The remaining state reads depend only on resolved keys and therefore
  // share one network phase. getMany also keeps grouped grading under D1's
  // simultaneous-connection limit.
  const [stateRows, canonicalKeys, progress] = await Promise.all([
    service.cardStates.getMany(ctx, [resolved.canonicalCardKey]),
    service.canonicalCardKeys(session.releaseId, resolved.localWordKey, resolvedCards.aliases),
    service.words.get(ctx, resolved.canonicalWordKey),
  ]);
  const before = stateRows[0]?.state ?? null;
  const outcome = gradeCard({ before, rating: request.rating, reviewedAt: now });

  const statements: SQL[] = [
    sqlInsertReviewLog(ctx.userId, request, resolved.canonicalCardKey, session.releaseId, outcome, now),
    sqlUpsertCardState(ctx.userId, resolved.canonicalCardKey, outcome.after, now),
    sql`UPDATE study_session SET position = position + 1 WHERE session_id = ${session.sessionId} AND user_id = ${ctx.userId}`,
  ];
  // Flip only a first-introduction word (IN_PROGRESS) whose active cards are
  // now ALL graded; the count is evaluated INSIDE the batch, after the
  // card_state upsert, so the flip is atomic with the grade that completed it.
  if (progress && progress.stage === "IN_PROGRESS" && canonicalKeys.length > 0) {
    statements.push(
      sqlFlipWordIntroduced(ctx.userId, resolved.canonicalWordKey, session.releaseId, canonicalKeys, now),
    );
  }

  try {
    await service.atomic.run(statements);
  } catch (error) {
    // event_id is a GLOBAL primary key: a unique violation here means a twin
    // request with the same event_id committed first. Re-read and replay the
    // winner; an id owned by ANOTHER user yields a stable 409 (no info leak,
    // the log row stays untouched).
    if (isUniqueEventIdViolation(error)) {
      const winner = await service.reviewLogs.get(ctx, request.event_id);
      if (winner) {
        return toResult(winner, request.session_id, true);
      }
      throw new StudyHttpError(409, "REVIEW_EVENT_ID_TAKEN", "event_id has already been used");
    }
    throw error;
  }

  return {
    event_id: request.event_id,
    session_id: session.sessionId,
    card_key: resolved.canonicalCardKey,
    presented_card_key: current.presented_card_key,
    release_id: session.releaseId,
    rating: request.rating,
    before_state: outcome.before,
    after_state: outcome.after,
    reviewed_at: now,
    duration_ms: request.duration_ms ?? null,
    undone_at: null,
    replayed: false,
  };
}

/**
 * Grades consecutive cards for one word in a single atomic write. The
 * content model keeps separate FSRS states for its recall targets, while the
 * learner sees and rates the word only once.
 */
export async function gradeReviewBatch(
  service: StudyService,
  ctx: UserContext,
  request: GradeBatchRequest,
): Promise<GradeBatchResult> {
  const [existingRows, session] = await Promise.all([
    service.reviewLogs.getMany(ctx, request.grades.map((grade) => grade.event_id)),
    service.requireSession(ctx, request.session_id),
  ]);
  const existingById = new Map(existingRows.map((record) => [record.eventId, record]));
  const existing = request.grades.map((grade) => existingById.get(grade.event_id));
  if (existing.every((record) => record !== undefined)) {
    return {
      session_id: request.session_id,
      position: session.position,
      results: existing.map((record) => toResult(record!, request.session_id, true)),
      replayed: true,
    };
  }
  if (existing.some((record) => record !== undefined)) {
    throw new StudyHttpError(
      409,
      "REVIEW_BATCH_PARTIAL_REPLAY",
      "Batch event ids must all be new or all be a replay",
    );
  }

  const queued = session.queue.cards.slice(
    session.position,
    session.position + request.grades.length,
  );
  if (queued.length !== request.grades.length) {
    throw new StudyHttpError(409, "STUDY_QUEUE_EXHAUSTED", "Not enough cards remain in this session");
  }
  for (const [index, grade] of request.grades.entries()) {
    if (queued[index]?.presented_card_key !== grade.card_key) {
      throw new StudyHttpError(409, "STUDY_CARD_NOT_CURRENT", "Batch cards do not match the current queue items");
    }
  }

  const resolvedCards = await service.resolvePresentedMany(
    session,
    queued.map((card) => card.presented_card_key),
  );
  const resolved = resolvedCards.items;
  const localWordKey = resolved[0]?.localWordKey;
  if (
    !localWordKey ||
    resolved.some((item) => item.localWordKey !== localWordKey)
  ) {
    throw new StudyHttpError(
      400,
      "REVIEW_BATCH_INVALID",
      "Only consecutive cards for one word may be graded together",
    );
  }

  const now = service.now();
  const perCardDuration =
    request.duration_ms === undefined
      ? undefined
      : Math.round(request.duration_ms / request.grades.length);
  const gradeRequests: GradeRequest[] = request.grades.map((grade) => ({
    event_id: grade.event_id,
    session_id: request.session_id,
    card_key: grade.card_key,
    rating: request.rating,
    ...(perCardDuration === undefined ? {} : { duration_ms: perCardDuration }),
  }));
  const [stateRows, canonicalKeys, progress] = await Promise.all([
    service.cardStates.getMany(ctx, resolved.map((item) => item.canonicalCardKey)),
    service.canonicalCardKeys(session.releaseId, localWordKey, resolvedCards.aliases),
    service.words.get(ctx, resolved[0]!.canonicalWordKey),
  ]);
  const statesByKey = new Map(stateRows.map((record) => [record.contentCardKey, record.state]));
  const beforeStates = resolved.map((item) => statesByKey.get(item.canonicalCardKey) ?? null);
  const outcomes = beforeStates.map((before) =>
    gradeCard({ before, rating: request.rating, reviewedAt: now }),
  );
  const statements: SQL[] = [];
  for (const [index, gradeRequest] of gradeRequests.entries()) {
    const item = resolved[index]!;
    const outcome = outcomes[index]!;
    statements.push(
      sqlInsertReviewLog(
        ctx.userId,
        gradeRequest,
        item.canonicalCardKey,
        session.releaseId,
        outcome,
        now,
      ),
      sqlUpsertCardState(ctx.userId, item.canonicalCardKey, outcome.after, now),
    );
  }
  statements.push(
    sql`UPDATE study_session SET position = position + ${request.grades.length} WHERE session_id = ${session.sessionId} AND user_id = ${ctx.userId}`,
  );
  if (progress && progress.stage === "IN_PROGRESS" && canonicalKeys.length > 0) {
    statements.push(
      sqlFlipWordIntroduced(
        ctx.userId,
        resolved[0]!.canonicalWordKey,
        session.releaseId,
        canonicalKeys,
        now,
      ),
    );
  }

  try {
    await service.atomic.run(statements);
  } catch (error) {
    if (isUniqueEventIdViolation(error)) {
      const winnerRows = await service.reviewLogs.getMany(
        ctx,
        request.grades.map((grade) => grade.event_id),
      );
      const winnerById = new Map(winnerRows.map((record) => [record.eventId, record]));
      const winners = request.grades.map((grade) => winnerById.get(grade.event_id));
      if (winners.every((record) => record !== undefined)) {
        const refreshed = await service.requireSession(ctx, request.session_id);
        return {
          session_id: request.session_id,
          position: refreshed.position,
          results: winners.map((record) => toResult(record!, request.session_id, true)),
          replayed: true,
        };
      }
      throw new StudyHttpError(409, "REVIEW_EVENT_ID_TAKEN", "A batch event_id has already been used");
    }
    throw error;
  }

  return {
    session_id: request.session_id,
    position: session.position + request.grades.length,
    results: gradeRequests.map((gradeRequest, index) => ({
      event_id: gradeRequest.event_id,
      session_id: session.sessionId,
      card_key: resolved[index]!.canonicalCardKey,
      presented_card_key: queued[index]!.presented_card_key,
      release_id: session.releaseId,
      rating: request.rating,
      before_state: outcomes[index]!.before,
      after_state: outcomes[index]!.after,
      reviewed_at: now,
      duration_ms: gradeRequest.duration_ms ?? null,
      undone_at: null,
      replayed: false,
    })),
    replayed: false,
  };
}

function sqlInsertReviewLog(
  userId: string,
  request: GradeRequest,
  canonicalCardKey: string,
  releaseId: string,
  outcome: { before: FsrsStateV1 | null; after: FsrsStateV1 },
  now: number,
): SQL {
  return sql`INSERT INTO review_log (event_id, user_id, session_id, content_card_key, presented_card_key, presented_release_id, rating, before_state, after_state, reviewed_at, duration_ms, undone_at)
    VALUES (${request.event_id}, ${userId}, ${request.session_id}, ${canonicalCardKey}, ${request.card_key}, ${releaseId}, ${request.rating},
            ${outcome.before === null ? null : JSON.stringify(outcome.before)}, ${JSON.stringify(outcome.after)}, ${now}, ${request.duration_ms ?? null}, NULL)`;
}

function sqlUpsertCardState(userId: string, canonicalCardKey: string, after: FsrsStateV1, now: number): SQL {
  return sql`INSERT INTO card_state (user_id, content_card_key, fsrs_state, due, reps, lapses, last_review_at, updated_at)
    VALUES (${userId}, ${canonicalCardKey}, ${JSON.stringify(after)}, ${after.due_at}, ${after.reps}, ${after.lapses}, ${after.last_review_at}, ${now})
    ON CONFLICT (user_id, content_card_key) DO UPDATE SET
      fsrs_state = excluded.fsrs_state,
      due = excluded.due,
      reps = excluded.reps,
      lapses = excluded.lapses,
      last_review_at = excluded.last_review_at,
      updated_at = excluded.updated_at`;
}

/** Completes the word's first introduction exactly when no active card of
 * its pinned-release queue is missing a card_state (evaluated in-batch). */
function sqlFlipWordIntroduced(
  userId: string,
  canonicalWordKey: string,
  releaseId: string,
  canonicalCardKeys: readonly string[],
  now: number,
): SQL {
  // One JSON array parameter avoids exceeding D1's 100 bindings when a
  // single word has many active cards; D1 supports SQLite's json_each.
  const keysJson = JSON.stringify(canonicalCardKeys);
  return sql`UPDATE word_progress
    SET stage = 'INTRODUCED', introduced_release_id = ${releaseId}, introduced_at = ${now}, last_seen_at = ${now}
    WHERE user_id = ${userId} AND word_key = ${canonicalWordKey} AND stage = 'IN_PROGRESS'
      AND (SELECT COUNT(*) FROM card_state cs WHERE cs.user_id = ${userId}
           AND cs.content_card_key IN (SELECT value FROM json_each(${keysJson}))) = ${canonicalCardKeys.length}`;
}

/** True when the driver rejected the INSERT for a duplicate event_id. */
function isUniqueEventIdViolation(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.includes("UNIQUE") && message.includes("review_log.event_id");
}
