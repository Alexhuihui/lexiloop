import { desc } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { contentRelease } from "./releases";
import { appUser } from "./users";

/**
 * Learning state tables (spec 6.2 "用户与学习状态", 6.4, 8.3).
 *
 * All user learning tables reference stable logical keys only (never
 * release-scoped row ids) so FSRS state survives release switches; history
 * additionally records the exact presented key/release (review_log).
 */

/** Per-word study lifecycle (spec 5.7/6.2): UNSEEN -> IN_PROGRESS -> INTRODUCED. */
export const wordProgress = sqliteTable(
  "word_progress",
  {
    userId: text("user_id").notNull().references(() => appUser.userId, { onDelete: "cascade" }),
    wordKey: text("word_key").notNull(),
    stage: text("stage").notNull().default("UNSEEN"),
    /** First-contact familiarity (spec 9.3), never a FSRS rating. */
    initialFamiliarity: text("initial_familiarity"),
    firstSeenAt: integer("first_seen_at").notNull(),
    introducedReleaseId: text("introduced_release_id").references(() => contentRelease.releaseId, { onDelete: "restrict" }),
    introducedAt: integer("introduced_at"),
    lastSeenAt: integer("last_seen_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.wordKey] }),
  ],
);

export type WordProgressRow = typeof wordProgress.$inferSelect;

/**
 * One FSRS card per user and stable content card key (spec 6.4). The FSRS
 * state itself is a versioned JSON envelope validated at repository
 * boundaries; due/reps/lapses/last_review mirror the envelope for the due
 * queue index (spec 6.3).
 */
export const cardState = sqliteTable(
  "card_state",
  {
    userId: text("user_id").notNull().references(() => appUser.userId, { onDelete: "cascade" }),
    contentCardKey: text("content_card_key").notNull(),
    fsrsState: text("fsrs_state").notNull(),
    due: integer("due").notNull(),
    reps: integer("reps").notNull().default(0),
    lapses: integer("lapses").notNull().default(0),
    lastReviewAt: integer("last_review_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.contentCardKey] }),
    // spec 6.3: card_state(user_id, due) for the due queue.
    index("card_state_user_due_idx").on(t.userId, t.due),
  ],
);

export type CardStateRow = typeof cardState.$inferSelect;

/** Append-only grading evidence (spec 6.2/8.3); undone_at marks revocations. */
export const reviewLog = sqliteTable(
  "review_log",
  {
    eventId: text("event_id").primaryKey(),
    userId: text("user_id").notNull().references(() => appUser.userId, { onDelete: "cascade" }),
    /** Owning study session, when any; no FK so sessions can be cleaned. */
    sessionId: text("session_id"),
    /** Canonical state key user FSRS state references (spec 6.4). */
    contentCardKey: text("content_card_key").notNull(),
    /** Exact presented key at grading time (may differ across aliases). */
    presentedCardKey: text("presented_card_key").notNull(),
    presentedReleaseId: text("presented_release_id").notNull().references(() => contentRelease.releaseId, { onDelete: "restrict" }),
    /** Again=1, Hard=2, Good=3, Easy=4. */
    rating: integer("rating").notNull(),
    /** Versioned FSRS envelopes; null before_state marks a first grade. */
    beforeState: text("before_state"),
    afterState: text("after_state").notNull(),
    reviewedAt: integer("reviewed_at").notNull(),
    durationMs: integer("duration_ms"),
    undoneAt: integer("undone_at"),
  },
  (t) => [
    // spec 6.3: review_log(user_id, reviewed_at desc).
    index("review_log_user_reviewed_idx").on(t.userId, desc(t.reviewedAt)),
  ],
);

export type ReviewLogRow = typeof reviewLog.$inferSelect;

/** Fixed-release study session with a versioned queue snapshot (spec 6.4). */
export const studySession = sqliteTable(
  "study_session",
  {
    sessionId: text("session_id").primaryKey(),
    userId: text("user_id").notNull().references(() => appUser.userId, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    /** Release pinned at creation; content reads use this, not the active pointer. */
    releaseId: text("release_id").notNull().references(() => contentRelease.releaseId, { onDelete: "cascade" }),
    queueSnapshot: text("queue_snapshot").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    index("study_session_user_expires_idx").on(t.userId, t.expiresAt),
  ],
);

export type StudySessionRow = typeof studySession.$inferSelect;
