import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  ReleaseRepository,
  ReviewLogRepository,
  StudySessionRepository,
  UserRepository,
  WordProgressRepository,
  appMeta,
  audioAsset,
  book,
  contentRelease,
  createSqliteDatabase,
  studySession,
  unit,
  word,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { queueSnapshot } from "@lexiloop/domain";
import { createMigratedTestDb, type TestDatabase } from "../../../packages/db/test/helpers";
import { hashPassword } from "../src/auth/password";
import { applyRetentionPlan, planRetention } from "../src/releases/retention";

/**
 * Task 14 release-retention acceptance tests (plan Task 14 / spec 15): a
 * release is cleanup-eligible only when it is RETIRED, neither the active
 * release nor the immediately previous rollback target, not pinned by an
 * unexpired study session, unreferenced by user state, and at least 14 days
 * past its last activation. Zero-reference R2 audio gains a 7-day grace
 * period. The dry run is the default: nothing is deleted until an apply passes
 * the EXACT eligible release ids / audio keys.
 */

const NOW = Date.parse("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const PASSWORD = "correct horse battery staple";

interface RetentionFixture {
  env: TestDatabase;
  db: LexiloopDatabase;
}

/**
 * Minimal R2 fake with the list/delete semantics the retention module uses
 * (pages of { key, uploaded }, delete by exact key).
 */
class FakeRetentionBucket {
  deletedKeys: string[] = [];
  private readonly objects = new Map<string, { bytes: Uint8Array; uploaded: number }>();

  async put(key: string, bytes: Uint8Array, uploaded: number): Promise<void> {
    this.objects.set(key, { bytes, uploaded });
  }

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
    this.objects.delete(key);
  }

  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ objects: Array<{ key: string; uploaded: Date }>; truncated: boolean }> {
    const prefix = options?.prefix ?? "";
    const objects = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, object]) => ({ key, uploaded: new Date(object.uploaded) }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
    return { objects, truncated: false };
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }
}

const asBucket = (fake: FakeRetentionBucket): R2Bucket => fake as unknown as R2Bucket;
async function seedUserWithName(db: LexiloopDatabase, userId: string, username: string): Promise<void> {
  const hashed = await hashPassword(PASSWORD);
  await new UserRepository(db).create({
    userId,
    normalizedUsername: username,
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    status: "ACTIVE",
    createdAt: NOW - DAY,
  });
}

/**
 * Seeds one release row directly with the given status/timestamp (bypassing
 * the activate lifecycle so any history shape is expressible).
 */
async function rawRelease(
  db: LexiloopDatabase,
  releaseId: string,
  input: { status: "ACTIVE" | "RETIRED"; activatedAt: number },
): Promise<void> {
  const releases = new ReleaseRepository(db);
  await releases.create({
    releaseId,
    sourcePdfSha256: "a".repeat(64),
    schemaVersion: "schema-v1",
    promptVersion: "prompt-v1",
    modelConfigJson: "{}",
    status: "READY",
    createdAt: NOW - 60 * DAY,
    manifestSha256: "b".repeat(64),
  });
  await db
    .update(contentRelease)
    .set({ status: input.status, activatedAt: input.activatedAt })
    .where(eq(contentRelease.releaseId, releaseId));
}

/** One searchable content row so FTS behavior is observable. */
async function seedContent(db: LexiloopDatabase, releaseId: string): Promise<void> {
  await db.insert(book).values({
    releaseId,
    bookKey: "bk-1",
    title: "Retention Fixture",
    edition: "1st",
    provenanceJson: "{}",
  });
  await db.insert(unit).values({
    releaseId,
    unitKey: "u-1",
    bookKey: "bk-1",
    level: 1,
    unitOrder: 1,
    title: "Unit",
    provenanceJson: "{}",
  });
  await db.insert(word).values({
    releaseId,
    wordKey: "w-keep",
    unitKey: "u-1",
    headword: "keepsake",
    phonetic: null,
    tier: "CORE",
    sourceOrder: 1,
    provenanceJson: "{}",
  });
}

async function getReleaseStatus(db: LexiloopDatabase, releaseId: string): Promise<string | undefined> {
  const row = await db.select().from(contentRelease).where(eq(contentRelease.releaseId, releaseId)).get();
  return row?.status;
}

/** Chain: rel-old (RETIRED, 40d), rel-previous (RETIRED, 20d), rel-current (ACTIVE, 3d). */
async function createChainFixture(): Promise<RetentionFixture> {
  const env = createMigratedTestDb();
  const db = createSqliteDatabase(env.sqlite);
  await rawRelease(db, "rel-old", { status: "RETIRED", activatedAt: NOW - 40 * DAY });
  await rawRelease(db, "rel-previous", { status: "RETIRED", activatedAt: NOW - 20 * DAY });
  await rawRelease(db, "rel-current", { status: "ACTIVE", activatedAt: NOW - 3 * DAY });
  // rawRelease bypasses the activate lifecycle, so set the pointer explicitly.
  await db.update(appMeta).set({ activeReleaseId: "rel-current" }).where(eq(appMeta.id, 1));
  return { env, db };
}

describe("planRetention", () => {
  let fx: RetentionFixture;

  beforeEach(async () => {
    fx = await createChainFixture();
  });

  afterEach(() => {
    fx.env.cleanup();
  });

  it("protects the active release and the immediately previous rollback target", async () => {
    const plan = await planRetention(fx.db, null, { now: NOW });
    expect(plan.activeReleaseId).toBe("rel-current");
    expect(plan.previousReleaseId).toBe("rel-previous");
    const byId = new Map(plan.releases.map((entry) => [entry.releaseId, entry]));
    expect(byId.get("rel-current")?.eligible).toBe(false);
    expect(byId.get("rel-current")?.blockedBy).toContain("status-not-retired");
    expect(byId.get("rel-previous")?.eligible).toBe(false);
    expect(byId.get("rel-previous")?.blockedBy).toContain("immediately-previous-rollback-target");
    expect(plan.deletions.releaseIds).toEqual(["rel-old"]);
  });

  it("keeps every release at least 14 days past its last activation", async () => {
    const env = createMigratedTestDb();
    try {
      const db = createSqliteDatabase(env.sqlite);
      await rawRelease(db, "rel-young", { status: "RETIRED", activatedAt: NOW - 10 * DAY });
      // rel-mid was demoted most recently (2d ago) -> it is the immediately
      // previous rollback target, leaving rel-young "merely old".
      await rawRelease(db, "rel-mid", { status: "RETIRED", activatedAt: NOW - 2 * DAY });
      await rawRelease(db, "rel-live", { status: "ACTIVE", activatedAt: NOW - DAY });
      await db.update(appMeta).set({ activeReleaseId: "rel-live" }).where(eq(appMeta.id, 1));
      const plan = await planRetention(db, null, { now: NOW });
      const young = plan.releases.find((entry) => entry.releaseId === "rel-young");
      // rel-young is neither active nor immediately previous (rel-mid is), but
      // only 10 days have passed since its activation: the floor holds.
      expect(young?.eligible).toBe(false);
      expect(young?.blockedBy).toContain("retention-window-14d");
      expect(plan.deletions.releaseIds).toEqual([]);
    } finally {
      env.cleanup();
    }
  });

  it("blocks releases pinned by an unexpired study session, but not expired pins", async () => {
    await seedUserWithName(fx.db, "user-pin", "pin");
    const sessions = new StudySessionRepository(fx.db);
    await sessions.create({ userId: "user-pin" }, {
      sessionId: "sess-live-pin",
      mode: "REVIEW",
      releaseId: "rel-old",
      queueSnapshot: queueSnapshot("rel-old", []),
      createdAt: NOW - HOUR,
      expiresAt: NOW + 12 * HOUR,
    });
    const pinned = await planRetention(fx.db, null, { now: NOW });
    expect(pinned.releases.find((entry) => entry.releaseId === "rel-old")?.blockedBy).toContain("session-pin");

    await fx.db.update(studySession).set({ expiresAt: NOW - 1000 }).where(eq(studySession.sessionId, "sess-live-pin"));
    const unpinned = await planRetention(fx.db, null, { now: NOW });
    expect(unpinned.releases.find((entry) => entry.releaseId === "rel-old")?.eligible).toBe(true);
  });

  it("blocks releases referenced by word_progress.introduced_release_id or review_log", async () => {
    await seedUserWithName(fx.db, "user-state", "state");
    await new WordProgressRepository(fx.db).upsert({ userId: "user-state" }, {
      wordKey: "w-introduced",
      stage: "INTRODUCED",
      initialFamiliarity: "KNOWN",
      firstSeenAt: NOW - DAY,
      lastSeenAt: NOW - DAY,
      introducedReleaseId: "rel-old",
      introducedAt: NOW - DAY,
    });
    const introduced = await planRetention(fx.db, null, { now: NOW });
    expect(introduced.releases.find((entry) => entry.releaseId === "rel-old")?.blockedBy)
      .toContain("introduced-reference");

    // Clear the introduction; a presented (even undone) review still pins.
    await new WordProgressRepository(fx.db).upsert({ userId: "user-state" }, {
      wordKey: "w-introduced",
      stage: "IN_PROGRESS",
      initialFamiliarity: null,
      firstSeenAt: NOW - DAY,
      lastSeenAt: NOW - DAY,
    });
    const appended = await new ReviewLogRepository(fx.db).append({ userId: "user-state" }, {
      eventId: "evt-presented",
      contentCardKey: "c-old",
      presentedCardKey: "c-old",
      presentedReleaseId: "rel-old",
      rating: 3,
      beforeState: null,
      afterState: {
        version: 1, state: "Review", stability: 3, difficulty: 5, due_at: NOW + DAY,
        last_review_at: NOW, reps: 1, lapses: 0, scheduled_days: 1, learning_steps: -1,
      },
      reviewedAt: NOW - 1000,
    });
    await new ReviewLogRepository(fx.db).markUndone({ userId: "user-state" }, appended.eventId, NOW - 500);
    const presented = await planRetention(fx.db, null, { now: NOW });
    expect(presented.releases.find((entry) => entry.releaseId === "rel-old")?.blockedBy)
      .toContain("review-reference");
  });

  it("gives zero-reference R2 audio a 7-day grace period", async () => {
    const bucket = new FakeRetentionBucket();
    await bucket.put("audio/aa/referenced.wav", new Uint8Array([1]), NOW - 30 * DAY);
    await bucket.put("audio/bb/stale-orphan.wav", new Uint8Array([2]), NOW - 8 * DAY);
    await bucket.put("audio/cc/fresh-orphan.wav", new Uint8Array([3]), NOW - 6 * DAY);
    await bucket.put("backups/2026-03-09/user-data.jsonl.gz", new Uint8Array([4]), NOW - DAY);
    await fx.db.insert(audioAsset).values({
      releaseId: "rel-current",
      assetKey: "audio/aa/referenced.wav",
      contentSha256: "c".repeat(64),
      textHash: "d".repeat(64),
      provider: "p",
      modelId: "m",
      voice: "v",
      synthesisConfigVersion: "scv-1",
      formatContainer: "wav",
      sampleRateHz: 24000,
      channels: 1,
      encoding: "pcm_s16le",
      durationMs: 500,
      validation: "PASSED",
    });
    const plan = await planRetention(fx.db, asBucket(bucket), { now: NOW });
    const byKey = new Map(plan.audio.map((entry) => [entry.key, entry]));
    expect(byKey.get("audio/aa/referenced.wav")?.eligible).toBe(false);
    expect(byKey.get("audio/aa/referenced.wav")?.blockedBy).toContain("referenced-by-audio-asset");
    expect(byKey.get("audio/bb/stale-orphan.wav")?.eligible).toBe(true);
    expect(byKey.get("audio/cc/fresh-orphan.wav")?.eligible).toBe(false);
    expect(byKey.get("audio/cc/fresh-orphan.wav")?.blockedBy).toContain("audio-grace-7d");
    // Non-audio prefixes (the backups!) are never audio candidates.
    expect(byKey.has("backups/2026-03-09/user-data.jsonl.gz")).toBe(false);
    expect(plan.deletions.audioKeys).toEqual(["audio/bb/stale-orphan.wav"]);
  });
});

describe("applyRetentionPlan", () => {
  let fx: RetentionFixture;
  let bucket: FakeRetentionBucket;
  let plan: Awaited<ReturnType<typeof planRetention>>;

  beforeEach(async () => {
    fx = await createChainFixture();
    bucket = new FakeRetentionBucket();
    await bucket.put("audio/bb/stale-orphan.wav", new Uint8Array([2]), NOW - 8 * DAY);
    await bucket.put("audio/aa/kept.wav", new Uint8Array([9]), NOW - 30 * DAY);
    await seedContent(fx.db, "rel-old");
    plan = await planRetention(fx.db, asBucket(bucket), { now: NOW });
  });

  afterEach(() => {
    fx.env.cleanup();
  });

  it("defaults to a dry run that deletes nothing and reports the exact deletions", async () => {
    const result = await applyRetentionPlan(fx.db, asBucket(bucket), plan, {
      releaseIds: ["rel-old"],
      audioKeys: ["audio/bb/stale-orphan.wav"],
    });
    expect(result.dryRun).toBe(true);
    expect(result.deletedReleaseIds).toEqual(["rel-old"]);
    expect(result.deletedAudioKeys).toEqual(["audio/bb/stale-orphan.wav"]);
    expect(bucket.has("audio/bb/stale-orphan.wav")).toBe(true);
    expect(bucket.deletedKeys).toEqual([]);
    expect(await getReleaseStatus(fx.db, "rel-old")).toBe("RETIRED");
  });

  it("deletes exactly the requested eligible releases and audio keys", async () => {
    const result = await applyRetentionPlan(fx.db, asBucket(bucket), plan, {
      releaseIds: ["rel-old"],
      audioKeys: ["audio/bb/stale-orphan.wav"],
      dryRun: false,
    });
    expect(result.dryRun).toBe(false);
    expect(result.deletedReleaseIds).toEqual(["rel-old"]);
    expect(result.deletedAudioKeys).toEqual(["audio/bb/stale-orphan.wav"]);
    expect(await getReleaseStatus(fx.db, "rel-old")).toBeUndefined();
    expect(bucket.has("audio/bb/stale-orphan.wav")).toBe(false);
    // Content rows and their FTS index rows are gone; other releases untouched.
    const fts = (await fx.db.all(
      sql`SELECT COUNT(*) AS n FROM content_search_fts WHERE release_id = 'rel-old'`,
    )) as Array<{ n: number }>;
    expect(Number(fts[0]?.n ?? 0)).toBe(0);
    expect(await getReleaseStatus(fx.db, "rel-previous")).toBe("RETIRED");
    expect(bucket.has("audio/aa/kept.wav")).toBe(true);
    expect(bucket.deletedKeys).toEqual(["audio/bb/stale-orphan.wav"]);
  });

  it("refuses anything that is not exactly an eligible deletion and deletes nothing", async () => {
    await expect(applyRetentionPlan(fx.db, asBucket(bucket), plan, {
      releaseIds: ["rel-previous"],
      audioKeys: [],
      dryRun: false,
    })).rejects.toThrow(/rel-previous/);
    await expect(applyRetentionPlan(fx.db, asBucket(bucket), plan, {
      releaseIds: ["rel-unknown"],
      audioKeys: [],
      dryRun: false,
    })).rejects.toThrow(/rel-unknown/);
    await expect(applyRetentionPlan(fx.db, asBucket(bucket), plan, {
      releaseIds: [],
      audioKeys: ["audio/cc/not-planned.wav"],
      dryRun: false,
    })).rejects.toThrow(/audio\/cc\/not-planned\.wav/);
    expect(bucket.deletedKeys).toEqual([]);
    expect(await getReleaseStatus(fx.db, "rel-old")).toBe("RETIRED");
  });

  it("refuses to execute against a stale plan whose deletions no longer hold", async () => {
    // A pin added after planning blocks the release: the caller must re-plan.
    await seedUserWithName(fx.db, "user-pin", "pin");
    await new StudySessionRepository(fx.db).create({ userId: "user-pin" }, {
      sessionId: "sess-after-plan",
      mode: "REVIEW",
      releaseId: "rel-old",
      queueSnapshot: queueSnapshot("rel-old", []),
      createdAt: NOW,
      expiresAt: NOW + HOUR,
    });
    await expect(applyRetentionPlan(fx.db, asBucket(bucket), plan, {
      releaseIds: ["rel-old"],
      audioKeys: [],
      dryRun: false,
    })).rejects.toThrow(/no longer eligible/);
    expect(await getReleaseStatus(fx.db, "rel-old")).toBe("RETIRED");
  });
});
