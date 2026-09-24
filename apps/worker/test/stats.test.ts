import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import {
  CardStateRepository,
  ReleaseRepository,
  ReviewLogRepository,
  UserRepository,
  UserSettingsRepository,
  WordProgressRepository,
  book,
  cardDefinition,
  createSqliteDatabase,
  unit,
  word,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { estimateRetrievability } from "@lexiloop/fsrs";
import { createMigratedTestDb, type TestDatabase } from "../../../packages/db/test/helpers";
import { buildApp, type AppEnv, type LoginRateLimiter, type WorkerDeps } from "../src/app";
import { statsOverview } from "../src/stats/queries";
import { hashPassword } from "../src/auth/password";
import { SESSION_COOKIE } from "../src/auth/session";

/**
 * Task 14 stats acceptance tests (spec 9.6): learned word/card counts,
 * estimated memory retention (FSRS retrievability), today + historical review
 * counts and the consecutive-study-day streak in the USER'S timezone, the
 * 30-day due forecast, high-lapse/difficult words, and Unit mastery as
 * coverage + predicted retention of graded cards — where "seen" is never
 * "mastered" and undone reviews are excluded from every count.
 */

const PASSWORD = "correct horse battery staple";
const ORIGIN = "https://lexiloop.example";
const R1 = "rel-1";

/**
 * Anchor instant: 2026-03-10 18:30 UTC == 2026-03-11 02:30 in
 * Asia/Shanghai (UTC+8, no DST). All local-day expectations below key off
 * Shanghai calendar dates, not UTC dates.
 */
const NOW = Date.parse("2026-03-10T18:30:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Independent retrievability expectation via the FSRS forgetting curve
 * R = (1 + F*t/S)^decay (t in whole days). The constants are the locked
 * ts-fsrs v5.4 defaults (generatorParameters): decay = -w[20] = -0.1542 and
 * the FSRS-6 factor F = exp(ln(0.9)/decay) - 1, matching the estimator in
 * @lexiloop/fsrs. If a parameter bump changes them, this test fails loudly
 * instead of silently agreeing.
 */
const FSRS_DECAY = -0.1542;
const FSRS_FACTOR = Math.exp(Math.log(0.9) / FSRS_DECAY) - 1;

function expectedRetrievability(stability: number, daysSinceReview: number): number {
  return Math.pow(1 + (FSRS_FACTOR * daysSinceReview) / stability, FSRS_DECAY);
}

interface StatsFixture {
  env: TestDatabase;
  db: LexiloopDatabase;
  deps: WorkerDeps;
  app: Hono<AppEnv>;
  clock: { now: number };
  carol: { userId: string };
  carolCookie: string;
}

class FakeRateLimiter implements LoginRateLimiter {
  async limit(): Promise<{ success: boolean }> {
    return { success: true };
  }
}

async function seedUser(db: LexiloopDatabase, timezone: string | null): Promise<{ userId: string }> {
  const hashed = await hashPassword(PASSWORD);
  const userId = "user-carol";
  await new UserRepository(db).create({
    userId,
    normalizedUsername: "carol",
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    status: "ACTIVE",
    createdAt: NOW - 30 * DAY,
  });
  if (timezone !== null) {
    await new UserSettingsRepository(db).upsert({ userId }, { timezone });
  }
  return { userId };
}

async function seedContent(db: LexiloopDatabase): Promise<void> {
  await new ReleaseRepository(db).create({
    releaseId: R1,
    sourcePdfSha256: "a".repeat(64),
    schemaVersion: "schema-v1",
    promptVersion: "prompt-v1",
    modelConfigJson: "{}",
    status: "READY",
    createdAt: NOW - 30 * DAY,
    manifestSha256: "b".repeat(64),
  });
  await new ReleaseRepository(db).setActive(R1, NOW - 30 * DAY);
  await db.insert(book).values({
    releaseId: R1,
    bookKey: "bk-1",
    title: "Stats Fixture Book",
    edition: "1st",
    provenanceJson: "{}",
  });
  await db.insert(unit).values([
    { releaseId: R1, unitKey: "u-1", bookKey: "bk-1", level: 1, unitOrder: 1, title: "Unit One", provenanceJson: "{}" },
    { releaseId: R1, unitKey: "u-2", bookKey: "bk-1", level: 1, unitOrder: 2, title: "Unit Two", provenanceJson: "{}" },
  ]);
  await db.insert(word).values([
    { releaseId: R1, wordKey: "w-alpha", unitKey: "u-1", headword: "alpha", phonetic: null, tier: "CORE", sourceOrder: 1, provenanceJson: "{}" },
    { releaseId: R1, wordKey: "w-beta", unitKey: "u-1", headword: "beta", phonetic: null, tier: "CORE", sourceOrder: 2, provenanceJson: "{}" },
    { releaseId: R1, wordKey: "w-gamma", unitKey: "u-2", headword: "gamma", phonetic: null, tier: "CORE", sourceOrder: 1, provenanceJson: "{}" },
  ]);
  await db.insert(cardDefinition).values([
    { releaseId: R1, contentCardKey: "c-alpha-1", cardType: "WORD_MEANING", targetEntityKey: "t-a1", wordKey: "w-alpha", unitKey: "u-1", templateVersion: "tv-1", status: "ACTIVE" },
    { releaseId: R1, contentCardKey: "c-alpha-2", cardType: "WORD_MEANING", targetEntityKey: "t-a2", wordKey: "w-alpha", unitKey: "u-1", templateVersion: "tv-1", status: "ACTIVE" },
    { releaseId: R1, contentCardKey: "c-beta-1", cardType: "WORD_MEANING", targetEntityKey: "t-b1", wordKey: "w-beta", unitKey: "u-1", templateVersion: "tv-1", status: "ACTIVE" },
    { releaseId: R1, contentCardKey: "c-beta-2", cardType: "WORD_MEANING", targetEntityKey: "t-b2", wordKey: "w-beta", unitKey: "u-1", templateVersion: "tv-1", status: "ACTIVE" },
    { releaseId: R1, contentCardKey: "c-gamma-1", cardType: "WORD_MEANING", targetEntityKey: "t-g1", wordKey: "w-gamma", unitKey: "u-2", templateVersion: "tv-1", status: "ACTIVE" },
  ]);
}

interface SeedCardInput {
  contentCardKey: string;
  stability: number;
  difficulty: number;
  lapses: number;
  /** Epoch ms of the card's last review (drives retrievability). */
  lastReviewAt: number;
  /** Epoch ms of the next due date (drives the forecast bucket). */
  due: number;
}

async function seedCardState(db: LexiloopDatabase, userId: string, input: SeedCardInput): Promise<void> {
  await new CardStateRepository(db).upsert({ userId }, {
    contentCardKey: input.contentCardKey,
    state: {
      version: 1,
      state: "Review",
      stability: input.stability,
      difficulty: input.difficulty,
      due_at: input.due,
      last_review_at: input.lastReviewAt,
      reps: 3,
      lapses: input.lapses,
      scheduled_days: 1,
      learning_steps: -1,
    },
    updatedAt: input.lastReviewAt,
  });
}

async function seedReview(
  db: LexiloopDatabase,
  userId: string,
  eventId: string,
  reviewedAt: number,
  undoneAt: number | null,
): Promise<void> {
  await new ReviewLogRepository(db).append({ userId }, {
    eventId,
    contentCardKey: "c-alpha-1",
    presentedCardKey: "c-alpha-1",
    presentedReleaseId: R1,
    rating: 3,
    beforeState: null,
    afterState: {
      version: 1,
      state: "Review",
      stability: 3,
      difficulty: 5,
      due_at: reviewedAt + DAY,
      last_review_at: reviewedAt,
      reps: 1,
      lapses: 0,
      scheduled_days: 1,
      learning_steps: -1,
    },
    reviewedAt,
  });
  if (undoneAt !== null) {
    await new ReviewLogRepository(db).markUndone({ userId }, eventId, undoneAt);
  }
}

/**
 * Standard fixture: carol studies in Asia/Shanghai. Learned state, review
 * history, and due dates are arranged so every spec 9.6 number below has a
 * hand-computed expectation.
 */
async function seedFixture(db: LexiloopDatabase): Promise<{ userId: string }> {
  const { userId } = await seedUser(db, "Asia/Shanghai");
  await seedContent(db);

  // w-alpha INTRODUCED (learned); w-beta only IN_PROGRESS (not learned);
  // w-gamma IN_PROGRESS with no card_state — "seen" must never be "mastered".
  await new WordProgressRepository(db).upsert({ userId }, {
    wordKey: "w-alpha",
    stage: "INTRODUCED",
    initialFamiliarity: "KNOWN",
    firstSeenAt: NOW - 3 * DAY,
    lastSeenAt: NOW - DAY,
    introducedReleaseId: R1,
    introducedAt: NOW - DAY,
  });
  await new WordProgressRepository(db).upsert({ userId }, {
    wordKey: "w-beta",
    stage: "IN_PROGRESS",
    initialFamiliarity: "RECOGNIZABLE",
    firstSeenAt: NOW - 2 * DAY,
    lastSeenAt: NOW - DAY,
  });
  await new WordProgressRepository(db).upsert({ userId }, {
    wordKey: "w-gamma",
    stage: "IN_PROGRESS",
    initialFamiliarity: "UNKNOWN",
    firstSeenAt: NOW - DAY,
    lastSeenAt: NOW - HOUR,
  });

  // Card states (stability/difficulty/lapses chosen for the assertions below).
  await seedCardState(db, userId, {
    contentCardKey: "c-alpha-1", stability: 10, difficulty: 5, lapses: 0,
    lastReviewAt: NOW - 12 * HOUR, due: Date.parse("2026-03-10T20:00:00Z"), // local 03-11 04:00 -> forecast day 0
  });
  await seedCardState(db, userId, {
    contentCardKey: "c-alpha-2", stability: 4, difficulty: 7, lapses: 2,
    lastReviewAt: NOW - 36 * HOUR, due: NOW + 40 * DAY, // beyond the 30-day window
  });
  await seedCardState(db, userId, {
    contentCardKey: "c-beta-1", stability: 10, difficulty: 8.5, lapses: 0,
    lastReviewAt: NOW - 12 * HOUR, due: Date.parse("2026-03-13T10:00:00Z"), // local 03-13 18:00 -> day 2
  });
  await seedCardState(db, userId, {
    contentCardKey: "c-beta-2", stability: 10, difficulty: 6, lapses: 1,
    lastReviewAt: NOW - 12 * HOUR, due: Date.parse("2026-03-01T00:00:00Z"), // overdue -> day 0
  });
  // c-gamma-1 deliberately has NO card_state: Unit Two keeps coverage 0.

  // Review history: local Shanghai days 03-10 (yesterday) and 03-11 (today).
  // 2026-03-09T17:10Z == 03-10 01:10 local; 2026-03-10T01:00Z == 03-10 09:00
  // local; 2026-03-10T17:10Z == 03-11 01:10 local (today). An undone review
  // today must vanish from every count.
  await seedReview(db, userId, "evt-y1", Date.parse("2026-03-09T17:10:00Z"), null);
  await seedReview(db, userId, "evt-y2", Date.parse("2026-03-10T01:00:00Z"), null);
  await seedReview(db, userId, "evt-today", Date.parse("2026-03-10T17:10:00Z"), null);
  await seedReview(db, userId, "evt-undone", Date.parse("2026-03-10T17:30:00Z"), NOW - 60_000);
  return { userId };
}

async function createFixture(): Promise<StatsFixture> {
  const env = createMigratedTestDb();
  const db = createSqliteDatabase(env.sqlite);
  const { userId } = await seedFixture(db);
  const clock = { now: NOW };
  const deps: WorkerDeps = {
    db,
    loginRateLimiter: new FakeRateLimiter(),
    allowedOrigins: [ORIGIN],
    now: () => clock.now,
  };
  const app = buildApp(deps);
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username: "carol", password: PASSWORD }),
  });
  expect(login.status).toBe(200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(",").find((part) => part.trim().startsWith(SESSION_COOKIE));
  expect(cookie).toBeDefined();
  return {
    env,
    db,
    deps,
    app,
    clock,
    carol: { userId },
    carolCookie: cookie!.split(";")[0]!,
  };
}

describe("GET /api/stats/overview", () => {
  let fx: StatsFixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(() => {
    fx.env.cleanup();
  });

  it("requires an authenticated session", async () => {
    const res = await fx.app.request("/api/stats/overview");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("AUTH_SESSION_INVALID");
  });

  it("serves personal data as private, no-store", async () => {
    const res = await fx.app.request("/api/stats/overview", { headers: { cookie: fx.carolCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("counts learned words and graded cards, excluding merely-seen words", async () => {
    const res = await fx.app.request("/api/stats/overview", { headers: { cookie: fx.carolCookie } });
    const body = (await res.json()) as { learned_words: number; learned_cards: number };
    // w-alpha INTRODUCED; w-beta/w-gamma IN_PROGRESS are not learned.
    expect(body.learned_words).toBe(1);
    // Exactly the card_state rows: c-alpha-1/2, c-beta-1/2 (c-gamma-1 none).
    expect(body.learned_cards).toBe(4);
  });

  it("estimates retention as the mean FSRS retrievability over graded cards", async () => {
    const overview = await statsOverview(fx.db, { userId: fx.carol.userId }, NOW);
    const expected =
      (1 + 1 + expectedRetrievability(4, 1) + expectedRetrievability(10, 0)) / 4;
    expect(overview.estimated_retention).not.toBeNull();
    expect(overview.estimated_retention).toBeCloseTo(expected, 6);
    // The estimator is the FSRS adapter's, so a single card matches exactly.
    expect(estimateRetrievability({
      version: 1, state: "Review", stability: 4, difficulty: 7,
      due_at: NOW + DAY, last_review_at: NOW - 36 * HOUR, reps: 3, lapses: 2,
      scheduled_days: 1, learning_steps: -1,
    }, NOW)).toBeCloseTo(expectedRetrievability(4, 1), 6);
  });

  it("counts today's and historical reviews by the user's local calendar, excluding undone", async () => {
    const res = await fx.app.request("/api/stats/overview", { headers: { cookie: fx.carolCookie } });
    const body = (await res.json()) as { reviews_today: number; reviews_total: number };
    // Local today is 03-11 (started 2026-03-10T16:00Z); evt-today landed there.
    expect(body.reviews_today).toBe(1);
    // evt-undone is excluded from the historical total.
    expect(body.reviews_total).toBe(3);
  });

  it("computes the streak over consecutive LOCAL study days ending today or yesterday", async () => {
    const res = await fx.app.request("/api/stats/overview", { headers: { cookie: fx.carolCookie } });
    const body = (await res.json()) as { streak_days: number };
    // Local days with activity: 03-10 (two reviews) and 03-11 (today, one).
    // An UTC-day calculation would both break today (UTC date is 03-10 with
    // all three reviews on 03-09/03-10 UTC) and count today as active — the
    // local answer is a 2-day streak.
    expect(body.streak_days).toBe(2);
  });

  it("breaks the streak when the local day chain has a gap", async () => {
    // Advance the clock two local days: last activity was local 03-11, now it
    // is local 03-13 -> the chain is broken and today has no reviews.
    fx.clock.now = NOW + 2 * DAY;
    const res = await fx.app.request("/api/stats/overview", { headers: { cookie: fx.carolCookie } });
    const body = (await res.json()) as { streak_days: number; reviews_today: number };
    expect(body.streak_days).toBe(0);
    expect(body.reviews_today).toBe(0);
  });

  it("forecasts due cards across the next 30 local days, overdue in day 0", async () => {
    const res = await fx.app.request("/api/stats/overview", { headers: { cookie: fx.carolCookie } });
    const body = (await res.json()) as { due_forecast: Array<{ date: string; cards: number }> };
    expect(body.due_forecast).toHaveLength(30);
    expect(body.due_forecast[0]).toEqual({ date: "2026-03-11", cards: 2 });
    expect(body.due_forecast[1]).toEqual({ date: "2026-03-12", cards: 0 });
    expect(body.due_forecast[2]).toEqual({ date: "2026-03-13", cards: 1 });
    const total = body.due_forecast.reduce((acc, day) => acc + day.cards, 0);
    expect(total).toBe(3); // c-alpha-2 (due +40d) stays outside the window
  });

  it("lists high-lapse and difficult words aggregated per word", async () => {
    const res = await fx.app.request("/api/stats/overview", { headers: { cookie: fx.carolCookie } });
    const body = (await res.json()) as {
      difficult_words: Array<{ word_key: string; headword: string; lapses: number; max_difficulty: number; cards: number }>;
    };
    expect(body.difficult_words).toEqual([
      { word_key: "w-alpha", headword: "alpha", lapses: 2, max_difficulty: 7, cards: 2 },
      { word_key: "w-beta", headword: "beta", lapses: 1, max_difficulty: 8.5, cards: 2 },
    ]);
  });

  it("derives Unit mastery from graded coverage + predicted retention, never from seen words", async () => {
    const res = await fx.app.request("/api/stats/overview", { headers: { cookie: fx.carolCookie } });
    const body = (await res.json()) as {
      units: Array<{ unit_key: string; title: string; total_cards: number; studied_cards: number; coverage: number; estimated_retention: number | null }>;
    };
    expect(body.units).toHaveLength(2);
    expect(body.units[0]).toEqual({
      unit_key: "u-1",
      title: "Unit One",
      total_cards: 4,
      studied_cards: 4,
      coverage: 1,
      estimated_retention: expect.any(Number), // asserted with tolerance below
    });
    expect(body.units[0]!.estimated_retention).toBeCloseTo(
      (1 + expectedRetrievability(4, 1) + expectedRetrievability(10, 0) + 1) / 4,
      6,
    );
    expect(body.units[1]).toEqual({
      unit_key: "u-2",
      title: "Unit Two",
      total_cards: 1,
      studied_cards: 0,
      coverage: 0,
      estimated_retention: null,
    });
    // The IN_PROGRESS word w-gamma ("seen") must not raise Unit Two's coverage.
    expect(body.units.map((entry) => entry.coverage)).toEqual([1, 0]);
  });

  it("reports null retention for a user with no graded cards", async () => {
    const env = createMigratedTestDb();
    try {
      const db = createSqliteDatabase(env.sqlite);
      const fresh = await seedUser(db, "UTC");
      await seedContent(db);
      const overview = await statsOverview(db, { userId: fresh.userId }, NOW);
      expect(overview.estimated_retention).toBeNull();
      expect(overview.learned_cards).toBe(0);
      expect(overview.streak_days).toBe(0);
    } finally {
      env.cleanup();
    }
  });
});
