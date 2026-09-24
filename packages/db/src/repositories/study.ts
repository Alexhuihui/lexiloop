import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import {
  parseFsrsState,
  parseQueueSnapshot,
  validateFsrsState,
  validateQueueSnapshot,
  type FsrsState,
  type QueueSnapshot,
} from "../envelopes";
import type { LexiloopDatabase } from "../schema";
import { cardState, reviewLog, studySession, wordProgress, type WordProgressRow } from "../schema";
import type { UserContext } from "./context";

/** Per-word study lifecycle (spec 5.7/6.2). */
export type WordStage = "UNSEEN" | "IN_PROGRESS" | "INTRODUCED";

/** First-contact familiarity (spec 9.3): 很陌生 / 有印象 / 熟悉. */
export type Familiarity = "UNKNOWN" | "RECOGNIZABLE" | "KNOWN";

export interface UpsertWordProgressInput {
  wordKey: string;
  stage: WordStage;
  initialFamiliarity: Familiarity | null;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Required iff stage is INTRODUCED (spec 5.7 rule 5); normally use markIntroduced. */
  introducedReleaseId?: string;
  introducedAt?: number;
}

/**
 * Persistent per-word stage (spec 5.7 rule 5). The table CHECK requires
 * introduced_release_id to be set exactly when stage is INTRODUCED, so a
 * non-INTRODUCED upsert always clears the pair (undo path, spec 8.3) and an
 * INTRODUCED upsert must carry it. Stage transitions that depend on grading
 * are applied by the worker inside a D1 batch; these methods only store the
 * resulting state.
 */
export class WordProgressRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async get(ctx: UserContext, wordKey: string): Promise<WordProgressRow | undefined> {
    return await this.db
      .select()
      .from(wordProgress)
      .where(and(eq(wordProgress.userId, ctx.userId), eq(wordProgress.wordKey, wordKey)))
      .get();
  }

  /** Reads a preview/group in one query instead of one round trip per word. */
  async getMany(ctx: UserContext, wordKeys: readonly string[]): Promise<WordProgressRow[]> {
    const unique = [...new Set(wordKeys)];
    if (unique.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(wordProgress)
      .where(and(eq(wordProgress.userId, ctx.userId), inArray(wordProgress.wordKey, unique)));
  }

  async upsert(ctx: UserContext, input: UpsertWordProgressInput): Promise<WordProgressRow> {
    const introduced = input.stage === "INTRODUCED";
    const nextIntroducedReleaseId = introduced ? input.introducedReleaseId : null;
    const nextIntroducedAt = introduced ? input.introducedAt : null;
    if (introduced && (nextIntroducedReleaseId === undefined || nextIntroducedAt === undefined)) {
      throw new Error(
        `word_progress: stage INTRODUCED requires introducedReleaseId and introducedAt (word_key=${input.wordKey})`,
      );
    }
    const rows = await this.db
      .insert(wordProgress)
      .values({
        userId: ctx.userId,
        wordKey: input.wordKey,
        stage: input.stage,
        initialFamiliarity: input.initialFamiliarity,
        firstSeenAt: input.firstSeenAt,
        introducedReleaseId: nextIntroducedReleaseId ?? null,
        introducedAt: nextIntroducedAt ?? null,
        lastSeenAt: input.lastSeenAt,
      })
      .onConflictDoUpdate({
        target: [wordProgress.userId, wordProgress.wordKey],
        set: {
          stage: input.stage,
          initialFamiliarity: input.initialFamiliarity,
          lastSeenAt: input.lastSeenAt,
          // Undo path: rolling back to a non-INTRODUCED stage must clear the
          // introduction so the row keeps satisfying its own CHECK (spec 8.3).
          introducedReleaseId: nextIntroducedReleaseId ?? null,
          introducedAt: nextIntroducedAt ?? null,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`word_progress upsert returned no row (word_key=${input.wordKey})`);
    }
    return row;
  }

  /** Marks a word INTRODUCED, pinning release and time (spec 5.7 rule 5). */
  async markIntroduced(
    ctx: UserContext,
    input: { wordKey: string; introducedReleaseId: string; introducedAt: number },
  ): Promise<WordProgressRow | undefined> {
    const rows = await this.db
      .update(wordProgress)
      .set({
        stage: "INTRODUCED",
        introducedReleaseId: input.introducedReleaseId,
        introducedAt: input.introducedAt,
        lastSeenAt: input.introducedAt,
      })
      .where(and(eq(wordProgress.userId, ctx.userId), eq(wordProgress.wordKey, input.wordKey)))
      .returning();
    return rows[0];
  }
}

/** FSRS rating (spec 5.7): Again=1, Hard=2, Good=3, Easy=4. */
export type Rating = 1 | 2 | 3 | 4;

/** card_state row with the validated FSRS envelope parsed out of its blob. */
export interface CardStateRecord {
  userId: string;
  contentCardKey: string;
  state: FsrsState;
  updatedAt: number;
}

export interface UpsertCardStateInput {
  contentCardKey: string;
  state: FsrsState;
  updatedAt: number;
}

/**
 * FSRS state keyed by the stable canonical content card key (spec 6.4). The
 * envelope is validated on every write and parse-validated on every read;
 * due/reps/lapses/last_review mirror the envelope for index-backed queries.
 */
export class CardStateRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async get(ctx: UserContext, contentCardKey: string): Promise<CardStateRecord | undefined> {
    const row = await this.db
      .select()
      .from(cardState)
      .where(and(eq(cardState.userId, ctx.userId), eq(cardState.contentCardKey, contentCardKey)))
      .get();
    return row ? toCardStateRecord(row) : undefined;
  }

  /** Reads a bounded grading batch in one indexed query. */
  async getMany(ctx: UserContext, contentCardKeys: readonly string[]): Promise<CardStateRecord[]> {
    const unique = [...new Set(contentCardKeys)];
    if (unique.length === 0) {
      return [];
    }
    return (await this.db
      .select()
      .from(cardState)
      .where(and(eq(cardState.userId, ctx.userId), inArray(cardState.contentCardKey, unique))))
      .map(toCardStateRecord);
  }

  async upsert(ctx: UserContext, input: UpsertCardStateInput): Promise<CardStateRecord> {
    const state = validateFsrsState(input.state);
    const blob = JSON.stringify(state);
    const rows = await this.db
      .insert(cardState)
      .values({
        userId: ctx.userId,
        contentCardKey: input.contentCardKey,
        fsrsState: blob,
        due: state.due_at,
        reps: state.reps,
        lapses: state.lapses,
        lastReviewAt: state.last_review_at,
        updatedAt: input.updatedAt,
      })
      .onConflictDoUpdate({
        target: [cardState.userId, cardState.contentCardKey],
        set: {
          fsrsState: blob,
          due: state.due_at,
          reps: state.reps,
          lapses: state.lapses,
          lastReviewAt: state.last_review_at,
          updatedAt: input.updatedAt,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`card_state upsert returned no row (content_card_key=${input.contentCardKey})`);
    }
    return toCardStateRecord(row);
  }

  /** Due queue source, ordered by due ascending (spec 6.3). Negative or
   * fractional limits are clamped: a negative limit yields no rows. */
  async getDue(ctx: UserContext, asOfMs: number, limit: number): Promise<CardStateRecord[]> {
    return (await this.db
      .select()
      .from(cardState)
      .where(and(eq(cardState.userId, ctx.userId), lte(cardState.due, asOfMs)))
      .orderBy(asc(cardState.due))
      .limit(clampLimit(limit)))
      .map(toCardStateRecord);
  }
}

interface CardStateRawRow {
  userId: string;
  contentCardKey: string;
  fsrsState: string;
  updatedAt: number;
}

function toCardStateRecord(row: CardStateRawRow): CardStateRecord {
  return {
    userId: row.userId,
    contentCardKey: row.contentCardKey,
    state: parseFsrsState(row.fsrsState),
    updatedAt: row.updatedAt,
  };
}

/** review_log row with validated before/after envelopes. */
export interface ReviewLogRecord {
  eventId: string;
  userId: string;
  sessionId: string | null;
  contentCardKey: string;
  presentedCardKey: string;
  presentedReleaseId: string;
  rating: Rating;
  beforeState: FsrsState | null;
  afterState: FsrsState;
  reviewedAt: number;
  durationMs: number | null;
  undoneAt: number | null;
}

export interface AppendReviewInput {
  eventId: string;
  sessionId?: string | null;
  /** Canonical state key card_state is keyed by (spec 6.4). */
  contentCardKey: string;
  /** Exact presented key at grading time. */
  presentedCardKey: string;
  presentedReleaseId: string;
  rating: Rating;
  /** Null marks the first grade of a card (spec 8.3 undo semantics). */
  beforeState: FsrsState | null;
  afterState: FsrsState;
  reviewedAt: number;
  durationMs?: number | null;
}

/**
 * Append-only grading evidence (spec 6.2/8.3/11.2). event_id idempotency is
 * enforced by the primary key; callers replay duplicates as reads, not writes.
 */
export class ReviewLogRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async append(ctx: UserContext, input: AppendReviewInput): Promise<ReviewLogRecord> {
    const beforeState = input.beforeState === null ? null : JSON.stringify(validateFsrsState(input.beforeState));
    const afterState = JSON.stringify(validateFsrsState(input.afterState));
    const rows = await this.db
      .insert(reviewLog)
      .values({
        eventId: input.eventId,
        userId: ctx.userId,
        sessionId: input.sessionId ?? null,
        contentCardKey: input.contentCardKey,
        presentedCardKey: input.presentedCardKey,
        presentedReleaseId: input.presentedReleaseId,
        rating: input.rating,
        beforeState,
        afterState,
        reviewedAt: input.reviewedAt,
        durationMs: input.durationMs ?? null,
        undoneAt: null,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`review_log append returned no row (event_id=${input.eventId})`);
    }
    return toReviewLogRecord(row);
  }

  async get(ctx: UserContext, eventId: string): Promise<ReviewLogRecord | undefined> {
    const row = await this.db
      .select()
      .from(reviewLog)
      .where(and(eq(reviewLog.eventId, eventId), eq(reviewLog.userId, ctx.userId)))
      .get();
    return row ? toReviewLogRecord(row) : undefined;
  }

  /** Reads an idempotency batch in one indexed query; callers restore request order. */
  async getMany(ctx: UserContext, eventIds: readonly string[]): Promise<ReviewLogRecord[]> {
    const unique = [...new Set(eventIds)];
    if (unique.length === 0) {
      return [];
    }
    return (await this.db
      .select()
      .from(reviewLog)
      .where(and(eq(reviewLog.userId, ctx.userId), inArray(reviewLog.eventId, unique))))
      .map(toReviewLogRecord);
  }

  /**
   * The user's single undoable event (spec 8.3): the newest UN-undone review,
   * with insertion order (`rowid`) breaking `reviewed_at` ties so exactly ONE
   * event is ever "latest". Ties on the same millisecond are real (two grades
   * inside one clock tick), and letting an effectively-older tied event be
   * undone first could delete a newer event's card_state — so the tiebreak is
   * a total order, not an implementation detail.
   */
  async getLatestUnUndone(ctx: UserContext): Promise<ReviewLogRecord | undefined> {
    const rows = await this.db
      .select()
      .from(reviewLog)
      .where(and(eq(reviewLog.userId, ctx.userId), isNull(reviewLog.undoneAt)))
      .orderBy(desc(reviewLog.reviewedAt), desc(sql`rowid`))
      .limit(1);
    const row = rows[0];
    return row ? toReviewLogRecord(row) : undefined;
  }

  /** Newest-first history (spec 6.3 index), optionally paged by time.
   * Negative or fractional limits are clamped: a negative limit yields no rows. */
  async listRecent(ctx: UserContext, limit: number, beforeMs?: number): Promise<ReviewLogRecord[]> {
    const condition =
      beforeMs === undefined
        ? eq(reviewLog.userId, ctx.userId)
        : and(eq(reviewLog.userId, ctx.userId), lte(reviewLog.reviewedAt, beforeMs));
    const rows = await this.db
      .select()
      .from(reviewLog)
      .where(condition)
      .orderBy(desc(reviewLog.reviewedAt))
      .limit(clampLimit(limit));
    return rows.map(toReviewLogRecord);
  }

  /** Fills undone_at; the log row itself is never deleted (spec 8.3). */
  async markUndone(ctx: UserContext, eventId: string, undoneAt: number): Promise<boolean> {
    const rows = await this.db
      .update(reviewLog)
      .set({ undoneAt })
      .where(and(eq(reviewLog.eventId, eventId), eq(reviewLog.userId, ctx.userId)))
      .returning();
    return rows.length > 0;
  }
}

interface ReviewLogRawRow {
  eventId: string;
  userId: string;
  sessionId: string | null;
  contentCardKey: string;
  presentedCardKey: string;
  presentedReleaseId: string;
  rating: number;
  beforeState: string | null;
  afterState: string;
  reviewedAt: number;
  durationMs: number | null;
  undoneAt: number | null;
}

function toReviewLogRecord(row: ReviewLogRawRow): ReviewLogRecord {
  return {
    eventId: row.eventId,
    userId: row.userId,
    sessionId: row.sessionId,
    contentCardKey: row.contentCardKey,
    presentedCardKey: row.presentedCardKey,
    presentedReleaseId: row.presentedReleaseId,
    rating: row.rating as Rating,
    beforeState: row.beforeState === null ? null : parseFsrsState(row.beforeState),
    afterState: parseFsrsState(row.afterState),
    reviewedAt: row.reviewedAt,
    durationMs: row.durationMs,
    undoneAt: row.undoneAt,
  };
}

/** Session mode (spec 8.3): 新词 / 快测 / 复习. */
export type StudySessionMode = "NEW_WORDS" | "QUICK_TEST" | "REVIEW";

/** study_session row with the validated queue snapshot parsed out. */
export interface StudySessionRecord {
  sessionId: string;
  userId: string;
  mode: StudySessionMode;
  releaseId: string;
  queue: QueueSnapshot;
  position: number;
  createdAt: number;
  expiresAt: number;
}

export interface CreateStudySessionInput {
  sessionId: string;
  mode: StudySessionMode;
  /** Release pinned at creation time (spec 6.4). */
  releaseId: string;
  queueSnapshot: QueueSnapshot;
  position?: number;
  createdAt: number;
  expiresAt: number;
}

export interface PatchStudySessionInput {
  queueSnapshot?: QueueSnapshot;
  position?: number;
}

/** Queue snapshots must describe the exact release the row pins (spec 6.4). */
function requireMatchingRelease(rowReleaseId: string, queueReleaseId: string, sessionId: string): void {
  if (rowReleaseId !== queueReleaseId) {
    throw new Error(
      `study_session ${sessionId}: queue snapshot targets release ${queueReleaseId}, but the session pins ${rowReleaseId}`,
    );
  }
}

/**
 * Fixed-release study sessions (spec 5.7/6.4). Content reads during a session
 * use `releaseId` from this row, never the current active pointer. The 24h
 * maximum lifetime is enforced by a CHECK constraint (spec 6.4).
 */
export class StudySessionRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async create(ctx: UserContext, input: CreateStudySessionInput): Promise<StudySessionRecord> {
    const queue = validateQueueSnapshot(input.queueSnapshot);
    requireMatchingRelease(input.releaseId, queue.release_id, input.sessionId);
    const rows = await this.db
      .insert(studySession)
      .values({
        sessionId: input.sessionId,
        userId: ctx.userId,
        mode: input.mode,
        releaseId: input.releaseId,
        queueSnapshot: JSON.stringify(queue),
        position: input.position ?? 0,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`study_session insert returned no row (session_id=${input.sessionId})`);
    }
    return toStudySessionRecord(row);
  }

  async get(ctx: UserContext, sessionId: string): Promise<StudySessionRecord | undefined> {
    const row = await this.db
      .select()
      .from(studySession)
      .where(and(eq(studySession.sessionId, sessionId), eq(studySession.userId, ctx.userId)))
      .get();
    return row ? toStudySessionRecord(row) : undefined;
  }

  /** Unexpired sessions for resuming work (spec 11.2). */
  async listActive(ctx: UserContext, nowMs: number): Promise<StudySessionRecord[]> {
    const rows = await this.db
      .select()
      .from(studySession)
      .where(and(eq(studySession.userId, ctx.userId), gt(studySession.expiresAt, nowMs)))
      .orderBy(desc(studySession.createdAt));
    return rows.map(toStudySessionRecord);
  }

  /**
   * Non-grading progress: queue snapshot rewrites and position advancement
   * (spec 8.3 PATCH). A rewritten snapshot must still describe the session's
   * pinned release. Grading batches update the position atomically with
   * review_log/card_state writes in the worker.
   */
  async patch(ctx: UserContext, sessionId: string, input: PatchStudySessionInput): Promise<StudySessionRecord | undefined> {
    const set: { queueSnapshot?: string; position?: number } = {};
    if (input.queueSnapshot !== undefined) {
      set.queueSnapshot = JSON.stringify(validateQueueSnapshot(input.queueSnapshot));
    }
    if (input.position !== undefined) {
      set.position = input.position;
    }
    if (Object.keys(set).length === 0) {
      return await this.get(ctx, sessionId);
    }
    const current = await this.get(ctx, sessionId);
    if (!current) {
      return undefined;
    }
    if (input.queueSnapshot !== undefined) {
      requireMatchingRelease(current.releaseId, input.queueSnapshot.release_id, sessionId);
    }
    const rows = await this.db
      .update(studySession)
      .set(set)
      .where(and(eq(studySession.sessionId, sessionId), eq(studySession.userId, ctx.userId)))
      .returning();
    const row = rows[0];
    return row ? toStudySessionRecord(row) : undefined;
  }
}

interface StudySessionRawRow {
  sessionId: string;
  userId: string;
  mode: string;
  releaseId: string;
  queueSnapshot: string;
  position: number;
  createdAt: number;
  expiresAt: number;
}

function toStudySessionRecord(row: StudySessionRawRow): StudySessionRecord {
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    mode: row.mode as StudySessionMode,
    releaseId: row.releaseId,
    queue: parseQueueSnapshot(row.queueSnapshot),
    position: row.position,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/** Review finding: negative or fractional limits collapse to a sane minimum. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  return Math.max(0, Math.trunc(limit));
}
