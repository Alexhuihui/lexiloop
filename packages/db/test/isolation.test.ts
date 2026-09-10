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
  type FsrsState,
  type QueueSnapshot,
} from "../src";
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

function seedReleaseWithWord(fx: Fixture, releaseId: string, wordKey: string, headword: string): void {
  fx.env.sqlite.prepare(INSERT_RELEASE).run(releaseId, "a".repeat(64), T0);
  fx.env.sqlite
    .prepare("INSERT INTO book (release_id, book_key, title, edition, provenance_json) VALUES (?, 'bk-1', 't', 'e', '{}')")
    .run(releaseId);
  fx.env.sqlite
    .prepare("INSERT INTO unit (release_id, unit_key, book_key, level, unit_order, title, provenance_json) VALUES (?, 'u1', 'bk-1', 1, 1, 'Unit 1', '{}')")
    .run(releaseId);
  fx.env.sqlite
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
    scheduled_days: 3,
    learning_steps: -1,
  };
}

function queueFor(releaseId: string, cardKey: string): QueueSnapshot {
  return { version: 1, release_id: releaseId, cards: [{ canonical_card_key: cardKey, presented_card_key: cardKey }] };
}

let fx: Fixture;

beforeEach(async () => {
  const env = createMigratedTestDb();
  const db = drizzle(env.sqlite, { schema });
  // fx is assigned before any seeding so afterEach cleans up even if a seed
  // statement or repository call throws midway.
  fx = {
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

  seedReleaseWithWord(fx, "r1", fx.aliceWordKey, "abandon");
  seedReleaseWithWord(fx, "r2", fx.bobWordKey, "zeal");

  const { alice, bob } = fx;
  await fx.users.create({ userId: alice.userId, normalizedUsername: "alice", passwordSalt: "s", passwordVerifier: "v", createdAt: T0 });
  await fx.users.create({ userId: bob.userId, normalizedUsername: "bob", passwordSalt: "s", passwordVerifier: "v", createdAt: T0 });

  // Auth sessions (cookie token stays client-side; only the hash is stored).
  await fx.authSessions.create(alice, { sessionId: fx.aliceAuthSessionId, tokenHash: "hash-alice", issuedAt: T0, expiresAt: T0 + 12 * HOUR, sessionVersion: 1 });
  await fx.authSessions.create(bob, { sessionId: fx.bobAuthSessionId, tokenHash: "hash-bob", issuedAt: T0, expiresAt: T0 + 12 * HOUR, sessionVersion: 1 });

  // Card states: Bob's card is due EARLIER, so an unscoped due queue would leak it.
  await fx.cardStates.upsert(alice, { contentCardKey: fx.aliceCardKey, state: fsrsState(T0 + 2 * HOUR), updatedAt: T0 });
  await fx.cardStates.upsert(bob, { contentCardKey: fx.bobCardKey, state: fsrsState(T0 + 1 * HOUR), updatedAt: T0 });

  await fx.reviewLogs.append(alice, {
    eventId: fx.aliceEventId,
    contentCardKey: fx.aliceCardKey,
    presentedCardKey: fx.aliceCardKey,
    presentedReleaseId: "r1",
    rating: 3,
    beforeState: null,
    afterState: fsrsState(T0 + 2 * HOUR),
    reviewedAt: T0 + 1000,
    durationMs: 4200,
  });
  await fx.reviewLogs.append(bob, {
    eventId: fx.bobEventId,
    contentCardKey: fx.bobCardKey,
    presentedCardKey: fx.bobCardKey,
    presentedReleaseId: "r2",
    rating: 4,
    beforeState: null,
    afterState: fsrsState(T0 + 3 * HOUR),
    reviewedAt: T0 + 2000,
    durationMs: 3100,
  });

  await fx.studySessions.create(alice, {
    sessionId: fx.aliceSessionId,
    mode: "NEW_WORDS",
    releaseId: "r1",
    queueSnapshot: queueFor("r1", fx.aliceCardKey),
    position: 0,
    createdAt: T0,
    expiresAt: T0 + 4 * HOUR,
  });
  await fx.studySessions.create(bob, {
    sessionId: fx.bobSessionId,
    mode: "REVIEW",
    releaseId: "r2",
    queueSnapshot: queueFor("r2", fx.bobCardKey),
    position: 0,
    createdAt: T0,
    expiresAt: T0 + 4 * HOUR,
  });

  await fx.wordProgress.upsert(alice, { wordKey: fx.aliceWordKey, stage: "IN_PROGRESS", initialFamiliarity: "UNKNOWN", firstSeenAt: T0, lastSeenAt: T0 });
  await fx.wordProgress.upsert(bob, { wordKey: fx.bobWordKey, stage: "IN_PROGRESS", initialFamiliarity: "RECOGNIZABLE", firstSeenAt: T0, lastSeenAt: T0 });

  await fx.settings.upsert(alice, { startUnitKey: "u1", newWordsPerGroup: 8, dailyGoal: 25, timezone: "Asia/Shanghai" });
});

afterEach(() => {
  fx.env.cleanup();
});

describe("cross-user isolation", () => {
  it("never returns another user's card state", async () => {
    const { alice, cardStates } = fx;
    await expect(cardStates.get(alice, fx.bobCardKey)).resolves.toBeUndefined();
    const due = await cardStates.getDue(alice, T0 + 4 * HOUR, 50);
    expect(due.map((row) => row.contentCardKey)).toEqual([fx.aliceCardKey]);
  });

  it("never returns another user's review log", async () => {
    const { alice, reviewLogs } = fx;
    await expect(reviewLogs.get(alice, fx.bobEventId)).resolves.toBeUndefined();
    const recent = await reviewLogs.listRecent(alice, 50);
    expect(recent.map((row) => row.eventId)).toEqual([fx.aliceEventId]);
    // Bob's context cannot read Alice's event either.
    await expect(reviewLogs.get(fx.bob, fx.aliceEventId)).resolves.toBeUndefined();
  });

  it("never returns another user's study session", async () => {
    const { alice, studySessions } = fx;
    await expect(studySessions.get(alice, fx.bobSessionId)).resolves.toBeUndefined();
    const active = await studySessions.listActive(alice, T0 + HOUR);
    expect(active.map((row) => row.sessionId)).toEqual([fx.aliceSessionId]);
    // Patching by id under the wrong user context is a no-op.
    await expect(studySessions.patch(alice, fx.bobSessionId, { position: 1 })).resolves.toBeUndefined();
    const bobSession = await studySessions.get(fx.bob, fx.bobSessionId);
    expect(bobSession?.position).toBe(0);
  });

  it("never returns another user's auth session", async () => {
    const { alice, authSessions } = fx;
    await expect(authSessions.get(alice, fx.bobAuthSessionId)).resolves.toBeUndefined();
    await expect(authSessions.touch(alice, fx.bobAuthSessionId, T0 + 1)).resolves.toBe(false);
    // Token lookup is the one global auth path; revocation stays user-scoped.
    await expect(authSessions.revoke(alice, fx.bobAuthSessionId, T0 + 1)).resolves.toBe(false);
    const bobSession = await authSessions.get(fx.bob, fx.bobAuthSessionId);
    expect(bobSession?.revokedAt).toBeNull();
  });

  it("never returns another user's word progress or settings", async () => {
    const { alice, wordProgress, settings } = fx;
    await expect(wordProgress.get(alice, fx.bobWordKey)).resolves.toBeUndefined();
    await expect(settings.get(fx.bob)).resolves.toBeUndefined();
    const aliceSettings = await settings.get(alice);
    expect(aliceSettings?.newWordsPerGroup).toBe(8);
  });

  it("scopes content reads to a release", async () => {
    const { content } = fx;
    const aliceWord = await content.getWord("r1", fx.aliceWordKey);
    expect(aliceWord?.headword).toBe("abandon");
    await expect(content.getWord("r1", fx.bobWordKey)).resolves.toBeUndefined();
    await expect(content.getWord("r2", fx.aliceWordKey)).resolves.toBeUndefined();
  });
});

describe("word_progress introduction lifecycle", () => {
  it("clears introduced fields when rolling INTRODUCED back to IN_PROGRESS", async () => {
    const { alice, wordProgress } = fx;
    const introduced = await wordProgress.markIntroduced(alice, {
      wordKey: fx.aliceWordKey,
      introducedReleaseId: "r1",
      introducedAt: T0 + HOUR,
    });
    expect(introduced?.stage).toBe("INTRODUCED");
    expect(introduced?.introducedReleaseId).toBe("r1");

    // Undo path (spec 8.3): the row must keep satisfying its own CHECK.
    const rolledBack = await wordProgress.upsert(alice, {
      wordKey: fx.aliceWordKey,
      stage: "IN_PROGRESS",
      initialFamiliarity: "UNKNOWN",
      firstSeenAt: T0,
      lastSeenAt: T0 + 2 * HOUR,
    });
    expect(rolledBack.stage).toBe("IN_PROGRESS");
    expect(rolledBack.introducedReleaseId).toBeNull();
    expect(rolledBack.introducedAt).toBeNull();
  });

  it("keeps first_seen_at stable across upserts", async () => {
    const { alice, wordProgress } = fx;
    await wordProgress.upsert(alice, {
      wordKey: fx.aliceWordKey,
      stage: "IN_PROGRESS",
      initialFamiliarity: "KNOWN",
      firstSeenAt: T0,
      lastSeenAt: T0 + HOUR,
    });
    const row = await wordProgress.get(alice, fx.aliceWordKey);
    expect(row?.firstSeenAt).toBe(T0);
    expect(row?.initialFamiliarity).toBe("KNOWN");
  });
});

describe("queue snapshot release consistency", () => {
  it("rejects a snapshot that targets a different release than the session pins", async () => {
    const { alice, studySessions } = fx;
    await expect(
      studySessions.create(alice, {
        sessionId: "study-mismatch",
        mode: "REVIEW",
        releaseId: "r1",
        queueSnapshot: queueFor("r2", fx.aliceCardKey),
        createdAt: T0,
        expiresAt: T0 + HOUR,
      }),
    ).rejects.toThrow(/queue snapshot targets release r2/);
    await expect(studySessions.get(alice, "study-mismatch")).resolves.toBeUndefined();
  });

  it("rejects patching a session with a snapshot from another release", async () => {
    const { alice, studySessions } = fx;
    await expect(
      studySessions.patch(alice, fx.aliceSessionId, { queueSnapshot: queueFor("r2", fx.aliceCardKey) }),
    ).rejects.toThrow(/pins r1/);
    const unchanged = await studySessions.get(alice, fx.aliceSessionId);
    expect(unchanged?.queue.release_id).toBe("r1");
  });

  it("accepts a patch that keeps the pinned release", async () => {
    const { alice, studySessions } = fx;
    const patched = await studySessions.patch(alice, fx.aliceSessionId, {
      queueSnapshot: { ...queueFor("r1", fx.aliceCardKey), patch_event_ids: [fx.aliceEventId] },
      position: 1,
    });
    expect(patched?.position).toBe(1);
    expect(patched?.queue.patch_event_ids).toEqual([fx.aliceEventId]);
  });
});
