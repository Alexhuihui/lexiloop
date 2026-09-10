import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";
import {
  AuthSessionRepository,
  CardStateRepository,
  ContentRepository,
  ReviewLogRepository,
  StudySessionRepository,
  UserSettingsRepository,
  UserRepository,
  WordProgressRepository,
} from "../src";
import type { FsrsState } from "../src";
import * as schema from "../src/schema";
import { createMigratedTestDb, T0, type TestDatabase } from "./helpers";

/**
 * Personal data must be user-scoped by construction (spec 6.3: every study
 * query resolves user_id from the session and filters on it explicitly).
 * These tests drive the repositories through their public API and assert a
 * context for Alice can never observe Bob's rows.
 */

const HOUR = 60 * 60 * 1000;

interface Fixture {
  env: TestDatabase;
  users: UserRepository;
  settings: UserSettingsRepository;
  authSessions: AuthSessionRepository;
  cardStates: CardStateRepository;
  reviewLogs: ReviewLogRepository;
  studySessions: StudySessionRepository;
  wordProgress: WordProgressRepository;
  content: ContentRepository;
  alice: { userId: string };
  bob: { userId: string };
  aliceCardKey: string;
  bobCardKey: string;
  aliceEventId: string;
  bobEventId: string;
  aliceSessionId: string;
  bobSessionId: string;
  aliceAuthSessionId: string;
  bobAuthSessionId: string;
  aliceWordKey: string;
  bobWordKey: string;
}

const INSERT_RELEASE = `INSERT INTO content_release
  (release_id, source_pdf_sha256, schema_version, prompt_version, model_config_json, status, created_at, manifest_sha256)
  VALUES (?, ?, 'schema-v1', 'prompt-v1', '{}', 'READY', ?, 'manifest-sha')`;

function seedReleaseWithWord(
  env: TestDatabase,
  releaseId: string,
  wordKey: string,
  headword: string,
): void {
  env.sqlite.prepare(INSERT_RELEASE).run(releaseId, "a".repeat(64), T0);
  env.sqlite
    .prepare("INSERT INTO book (release_id, book_key, title, edition, provenance_json) VALUES (?, 'bk-1', 't', 'e', '{}')")
    .run(releaseId);
  env.sqlite
    .prepare("INSERT INTO unit (release_id, unit_key, book_key, level, unit_order, title, provenance_json) VALUES (?, 'u1', 'bk-1', 1, 1, 'Unit 1', '{}')")
    .run(releaseId);
  env.sqlite
    .prepare("INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) VALUES (?, ?, 'u1', ?, NULL, 'core', 1, '{}')")
    .run(releaseId, wordKey, headword);
}

function fsrsState(dueAt: number): FsrsState {
  return {
    version: 1,
    state: "Review",
    stability: 5,
    difficulty: 5.5,
    due_at: dueAt,
    last_review_at: T0,
    reps: 2,
    lapses: 0,
  };
}

let fx: Fixture;

beforeEach(() => {
  const env = createMigratedTestDb();
  const db = drizzle(env.sqlite, { schema });

  seedReleaseWithWord(env, "r1", "w-alice", "abandon");
  seedReleaseWithWord(env, "r2", "w-bob", "zeal");

  const fixture: Fixture = {
    env,
    users: new UserRepository(db),
    settings: new UserSettingsRepository(db),
    authSessions: new AuthSessionRepository(db),
    cardStates: new CardStateRepository(db),
    reviewLogs: new ReviewLogRepository(db),
    studySessions: new StudySessionRepository(db),
    wordProgress: new WordProgressRepository(db),
    content: new ContentRepository(db),
    alice: { userId: "user-alice" },
    bob: { userId: "user-bob" },
    aliceCardKey: "card-alice-1",
    bobCardKey: "card-bob-1",
    aliceEventId: "event-alice-1",
    bobEventId: "event-bob-1",
    aliceSessionId: "study-alice-1",
    bobSessionId: "study-bob-1",
    aliceAuthSessionId: "auth-alice-1",
    bobAuthSessionId: "auth-bob-1",
    aliceWordKey: "w-alice",
    bobWordKey: "w-bob",
  };
  fx = fixture;

  const { alice, bob } = fixture;
  fixture.users.create({ userId: alice.userId, normalizedUsername: "alice", passwordSalt: "s", passwordVerifier: "v", createdAt: T0 });
  fixture.users.create({ userId: bob.userId, normalizedUsername: "bob", passwordSalt: "s", passwordVerifier: "v", createdAt: T0 });

  // Auth sessions (cookie token stays client-side; only the hash is stored).
  fixture.authSessions.create(alice, { sessionId: fixture.aliceAuthSessionId, tokenHash: "hash-alice", issuedAt: T0, expiresAt: T0 + 12 * HOUR, sessionVersion: 1 });
  fixture.authSessions.create(bob, { sessionId: fixture.bobAuthSessionId, tokenHash: "hash-bob", issuedAt: T0, expiresAt: T0 + 12 * HOUR, sessionVersion: 1 });

  // Card states: Bob's card is due EARLIER, so an unscoped due queue would leak it.
  fixture.cardStates.upsert(alice, { contentCardKey: fixture.aliceCardKey, state: fsrsState(T0 + 2 * HOUR), updatedAt: T0 });
  fixture.cardStates.upsert(bob, { contentCardKey: fixture.bobCardKey, state: fsrsState(T0 + 1 * HOUR), updatedAt: T0 });

  fixture.reviewLogs.append(alice, {
    eventId: fixture.aliceEventId,
    contentCardKey: fixture.aliceCardKey,
    presentedCardKey: fixture.aliceCardKey,
    presentedReleaseId: "r1",
    rating: 3,
    beforeState: null,
    afterState: fsrsState(T0 + 2 * HOUR),
    reviewedAt: T0 + 1000,
    durationMs: 4200,
  });
  fixture.reviewLogs.append(bob, {
    eventId: fixture.bobEventId,
    contentCardKey: fixture.bobCardKey,
    presentedCardKey: fixture.bobCardKey,
    presentedReleaseId: "r2",
    rating: 4,
    beforeState: null,
    afterState: fsrsState(T0 + 3 * HOUR),
    reviewedAt: T0 + 2000,
    durationMs: 3100,
  });

  fixture.studySessions.create(alice, {
    sessionId: fixture.aliceSessionId,
    mode: "NEW_WORDS",
    releaseId: "r1",
    queueSnapshot: { version: 1, release_id: "r1", cards: [{ canonical_card_key: fixture.aliceCardKey, presented_card_key: fixture.aliceCardKey }] },
    position: 0,
    createdAt: T0,
    expiresAt: T0 + 4 * HOUR,
  });
  fixture.studySessions.create(bob, {
    sessionId: fixture.bobSessionId,
    mode: "REVIEW",
    releaseId: "r2",
    queueSnapshot: { version: 1, release_id: "r2", cards: [{ canonical_card_key: fixture.bobCardKey, presented_card_key: fixture.bobCardKey }] },
    position: 0,
    createdAt: T0,
    expiresAt: T0 + 4 * HOUR,
  });

  fixture.wordProgress.upsert(alice, { wordKey: fixture.aliceWordKey, stage: "IN_PROGRESS", initialFamiliarity: "UNKNOWN", firstSeenAt: T0, lastSeenAt: T0 });
  fixture.wordProgress.upsert(bob, { wordKey: fixture.bobWordKey, stage: "IN_PROGRESS", initialFamiliarity: "RECOGNIZABLE", firstSeenAt: T0, lastSeenAt: T0 });

  fixture.settings.upsert(alice, { startUnitKey: "u1", newWordsPerGroup: 8, dailyGoal: 25, timezone: "Asia/Shanghai" });
});

afterEach(() => {
  fx.env.cleanup();
});

describe("cross-user isolation", () => {
  it("never returns another user's card state", () => {
    const { alice, cardStates } = fx;
    expect(cardStates.get(alice, fx.bobCardKey)).toBeUndefined();
    const due = cardStates.getDue(alice, T0 + 4 * HOUR, 50);
    expect(due.map((row) => row.contentCardKey)).toEqual([fx.aliceCardKey]);
  });

  it("never returns another user's review log", () => {
    const { alice, reviewLogs } = fx;
    expect(reviewLogs.get(alice, fx.bobEventId)).toBeUndefined();
    const recent = reviewLogs.listRecent(alice, 50);
    expect(recent.map((row) => row.eventId)).toEqual([fx.aliceEventId]);
    // Bob's context cannot read Alice's event either.
    expect(reviewLogs.get(fx.bob, fx.aliceEventId)).toBeUndefined();
  });

  it("never returns another user's study session", () => {
    const { alice, studySessions } = fx;
    expect(studySessions.get(alice, fx.bobSessionId)).toBeUndefined();
    const active = studySessions.listActive(alice, T0 + HOUR);
    expect(active.map((row) => row.sessionId)).toEqual([fx.aliceSessionId]);
    // Patching by id under the wrong user context is a no-op.
    expect(studySessions.patch(alice, fx.bobSessionId, { position: 1 })).toBeUndefined();
    const bobSession = studySessions.get(fx.bob, fx.bobSessionId);
    expect(bobSession?.position).toBe(0);
  });

  it("never returns another user's auth session", () => {
    const { alice, authSessions } = fx;
    expect(authSessions.get(alice, fx.bobAuthSessionId)).toBeUndefined();
    expect(authSessions.touch(alice, fx.bobAuthSessionId, T0 + 1)).toBe(false);
    // Token lookup is the one global auth path; revocation stays user-scoped.
    expect(authSessions.revoke(alice, fx.bobAuthSessionId, T0 + 1)).toBe(false);
    const bobSession = authSessions.get(fx.bob, fx.bobAuthSessionId);
    expect(bobSession?.revokedAt).toBeNull();
  });

  it("never returns another user's word progress or settings", () => {
    const { alice, wordProgress, settings } = fx;
    expect(wordProgress.get(alice, fx.bobWordKey)).toBeUndefined();
    expect(settings.get(fx.bob)).toBeUndefined();
    const aliceSettings = settings.get(alice);
    expect(aliceSettings?.newWordsPerGroup).toBe(8);
  });

  it("scopes content reads to a release", () => {
    const { content } = fx;
    expect(content.getWord("r1", fx.aliceWordKey)?.headword).toBe("abandon");
    expect(content.getWord("r1", fx.bobWordKey)).toBeUndefined();
    expect(content.getWord("r2", fx.aliceWordKey)).toBeUndefined();
  });
});
