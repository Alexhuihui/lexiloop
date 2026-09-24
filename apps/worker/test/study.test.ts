import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import {
  CardStateRepository,
  ReleaseRepository,
  UserRepository,
  WordProgressRepository,
  createSqliteDatabase,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { book, cardDefinition, contentKeyAlias, unit, word } from "@lexiloop/db";
import { createMigratedTestDb, type TestDatabase } from "../../../packages/db/test/helpers";
import { buildApp, type AppEnv, type LoginRateLimiter, type WorkerDeps } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { SESSION_COOKIE } from "../src/auth/session";
import { StudyService } from "../src/study/service";
import { gradeReview, gradeReviewBatch } from "../src/study/grade";

/**
 * Task 13 acceptance tests (spec 5.7/6.4/8.3, plan step 3): the
 * server-authoritative study surface — fixed-release session queues in the
 * binding 5.7 order, the StudyPatch endpoint (WORD_PRESENTED /
 * FAMILIARITY_SET), server-side FSRS grading as one atomic batch with
 * event_id replay, latest-only undo, and alias-aware grading/undo across
 * release activation and rollback. The app runs against the established
 * better-sqlite3 temp database (packages/db test pattern).
 */

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ORIGIN = "https://lexiloop.example";
const PASSWORD = "correct horse battery staple";

const R1 = "rel-1";
const R2 = "rel-2";

/** Queue order of bob's NEW_WORDS session: the binding 5.7 sort over the deck. */
const BOB_QUEUE = [
  "k-wm-1",
  "k-wm-2",
  "k-wm-3",
  "k-old",
  "k-cm-4",
  "k-ph-5",
  "k-sd-0",
  "k-sd-6",
] as const;

interface Credentials {
  cookie: string;
  csrf: string;
}

interface StudyFixture {
  env: TestDatabase;
  db: LexiloopDatabase;
  deps: WorkerDeps;
  app: Hono<AppEnv>;
  clock: { now: number };
  alice: { userId: string };
  bob: { userId: string };
  aliceAuth: Credentials;
  bobAuth: Credentials;
}

class FakeRateLimiter implements LoginRateLimiter {
  async limit(): Promise<{ success: boolean }> {
    return { success: true };
  }
}

async function seedUser(db: LexiloopDatabase, username: string): Promise<{ userId: string }> {
  const hashed = await hashPassword(PASSWORD);
  const userId = `user-${username}`;
  await new UserRepository(db).create({
    userId,
    normalizedUsername: username,
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    status: "ACTIVE",
    createdAt: T0,
  });
  return { userId };
}

async function seedReleases(db: LexiloopDatabase): Promise<void> {
  const releases = new ReleaseRepository(db);
  const base = {
    sourcePdfSha256: "a".repeat(64),
    schemaVersion: "schema-v1",
    promptVersion: "prompt-v1",
    modelConfigJson: "{}",
    createdAt: T0,
    manifestSha256: "b".repeat(64),
  };
  await releases.create({ releaseId: R1, ...base, status: "READY" });
  await releases.create({ releaseId: R2, ...base, status: "READY" });
  await releases.setActive(R1, T0);
}

/** Textbook content of R1: three words plus the 5.7 sorting deck + alias source. */
async function seedR1Content(db: LexiloopDatabase): Promise<void> {
  await db.insert(book).values({
    releaseId: R1,
    bookKey: "bk-1",
    title: "New Horizon English 1",
    edition: "2nd",
    provenanceJson: "{}",
  });
  await db.insert(unit).values({
    releaseId: R1,
    unitKey: "u-1",
    bookKey: "bk-1",
    level: 1,
    unitOrder: 1,
    title: "Unit 1",
    provenanceJson: "{}",
  });
  await db.insert(word).values([
    { releaseId: R1, wordKey: "w1", unitKey: "u-1", headword: "abandon", phonetic: null, tier: "CORE", sourceOrder: 1, provenanceJson: "{}" },
    { releaseId: R1, wordKey: "w2", unitKey: "u-1", headword: "ability", phonetic: null, tier: "CORE", sourceOrder: 2, provenanceJson: "{}" },
    { releaseId: R1, wordKey: "w-old", unitKey: "u-1", headword: "aboard", phonetic: null, tier: "CORE", sourceOrder: 9, provenanceJson: "{}" },
  ]);
  const cards: Array<[string, string, string, string]> = [
    // [content_card_key, card_type, target_entity_key, word_key]
    ["k-wm-1", "WORD_MEANING", "t-wm-1", "w1"],
    ["k-wm-2", "WORD_MEANING", "t-wm-2", "w1"],
    ["k-wm-3", "WORD_MEANING", "t-wm-3", "w2"],
    ["k-old", "WORD_MEANING", "t-old", "w-old"],
    ["k-cm-4", "CONTEXT_MEANING", "t-cm", "w1"],
    ["k-ph-5", "PHRASE", "t-ph", "w2"],
    ["k-sd-0", "SENSE_DISCRIMINATION", "t-sd", "w1"],
    ["k-sd-6", "SENSE_DISCRIMINATION", "t-sd", "w1"],
  ];
  await db.insert(cardDefinition).values(
    cards.map(([contentCardKey, cardType, targetEntityKey, wordKey]) => ({
      releaseId: R1,
      contentCardKey,
      cardType,
      targetEntityKey,
      wordKey,
      unitKey: "u-1",
      templateVersion: "tv-1",
      status: "ACTIVE",
    })),
  );
}

/** R2 renames w-old -> w-new and k-old -> k-new (the alias test's target). */
async function seedR2ContentAndAliases(db: LexiloopDatabase): Promise<void> {
  await db.insert(book).values({
    releaseId: R2,
    bookKey: "bk-1",
    title: "New Horizon English 1",
    edition: "3rd",
    provenanceJson: "{}",
  });
  await db.insert(unit).values({
    releaseId: R2,
    unitKey: "u-1",
    bookKey: "bk-1",
    level: 1,
    unitOrder: 1,
    title: "Unit 1 (revised)",
    provenanceJson: "{}",
  });
  await db.insert(word).values({
    releaseId: R2,
    wordKey: "w-new",
    unitKey: "u-1",
    headword: "aboard",
    phonetic: null,
    tier: "CORE",
    sourceOrder: 1,
    provenanceJson: "{}",
  });
  await db.insert(cardDefinition).values({
    releaseId: R2,
    contentCardKey: "k-new",
    cardType: "WORD_MEANING",
    targetEntityKey: "t-new",
    wordKey: "w-new",
    unitKey: "u-1",
    templateVersion: "tv-1",
    status: "ACTIVE",
  });
  // Edges are stored under the release the FROM key belongs to (R1).
  await db.insert(contentKeyAlias).values([
    { releaseId: R1, fromKey: "w-old", toKey: "w-new", edgeType: "RENAME", canonicalKey: "w-new", createdAt: T0 },
    { releaseId: R1, fromKey: "k-old", toKey: "k-new", edgeType: "RENAME", canonicalKey: "k-new", createdAt: T0 },
  ]);
}

/** Valid FSRS envelope mirrored into card_state for due-queue seeding. */
async function seedCardState(
  db: LexiloopDatabase,
  userId: string,
  contentCardKey: string,
  due: number,
): Promise<void> {
  await new CardStateRepository(db).upsert({ userId }, {
    contentCardKey,
    state: {
      version: 1,
      state: "Review",
      stability: 3,
      difficulty: 5,
      due_at: due,
      last_review_at: due - DAY,
      reps: 3,
      lapses: 0,
      scheduled_days: 1,
      learning_steps: -1,
    },
    updatedAt: T0 - DAY,
  });
}

/**
 * Alice has partially learned w1: INTRODUCED with four of its five cards
 * graded (k-sd-6 missing) and stale due dates on the graded ones. Her
 * QUICK_TEST session must therefore offer exactly k-sd-6, her REVIEW session
 * the four graded cards in due-then-key order, and NEW_WORDS must skip w1.
 */
async function seedAliceProgress(db: LexiloopDatabase, userId: string): Promise<void> {
  await new WordProgressRepository(db).upsert({ userId }, {
    wordKey: "w1",
    stage: "INTRODUCED",
    initialFamiliarity: "KNOWN",
    firstSeenAt: T0 - 3 * DAY,
    lastSeenAt: T0 - DAY,
    introducedReleaseId: R1,
    introducedAt: T0 - DAY,
  });
  await seedCardState(db, userId, "k-wm-2", T0 - 1000);
  await seedCardState(db, userId, "k-sd-0", T0 - 2000);
  await seedCardState(db, userId, "k-cm-4", T0 - 3000);
  await seedCardState(db, userId, "k-wm-1", T0 - 3000);
}

async function loginAs(app: StudyFixture["app"], username: string): Promise<Credentials> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(",").find((part) => part.trim().startsWith(SESSION_COOKIE));
  expect(cookie).toBeDefined();
  const body = (await res.json()) as { csrf_token: string };
  return { cookie: cookie!.split(";")[0]!, csrf: body.csrf_token };
}

function writeHeaders(auth: Credentials): Record<string, string> {
  return {
    cookie: auth.cookie,
    origin: ORIGIN,
    "x-csrf-token": auth.csrf,
    "content-type": "application/json",
  };
}

interface SessionBody {
  session_id: string;
  mode: string;
  release_id: string;
  position: number;
  created_at: number;
  expires_at: number;
  cards: Array<{ canonical_card_key: string; presented_card_key: string }>;
  current_card_key: string | null;
  unit_keys: string[];
  word_keys: string[];
}

interface GradeBody {
  event_id: string;
  session_id: string;
  card_key: string;
  presented_card_key: string;
  release_id: string;
  rating: number;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown>;
  reviewed_at: number;
  duration_ms: number | null;
  undone_at: number | null;
  replayed: boolean;
}

interface GradeBatchBody {
  session_id: string;
  position: number;
  results: GradeBody[];
  replayed: boolean;
}

type ApiOutcome<B> = { status: number; headers: Headers; body: B };
type ErrorCode = { code: string; message: string };

async function postJson<B>(path: string, auth: Credentials, body: unknown): Promise<ApiOutcome<B & Partial<ErrorCode>>> {
  const res = await fx.app.request(path, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as B & ErrorCode };
}

async function createSession(
  auth: Credentials,
  mode: "NEW_WORDS" | "QUICK_TEST" | "REVIEW",
): Promise<ApiOutcome<SessionBody & Partial<ErrorCode>>> {
  return await postJson<SessionBody>("/api/study/sessions", auth, { mode });
}

async function grade(
  auth: Credentials,
  input: { event_id: string; session_id: string; card_key: string; rating: number; duration_ms?: number },
): Promise<ApiOutcome<GradeBody & Partial<ErrorCode>>> {
  return await postJson<GradeBody>("/api/reviews/grade", auth, { duration_ms: 5000, ...input });
}

async function gradeBatch(
  auth: Credentials,
  input: {
    session_id: string;
    grades: Array<{ event_id: string; card_key: string }>;
    rating: number;
    duration_ms?: number;
  },
): Promise<ApiOutcome<GradeBatchBody & Partial<ErrorCode>>> {
  return await postJson<GradeBatchBody>("/api/reviews/grade-batch", auth, {
    duration_ms: 5000,
    ...input,
  });
}

/** Sequential grade counter so every event id is unique within the file. */
let gradeCounter = 0;

/** Grades bob's queue positions [from, to] in order with fresh event ids. */
async function gradePositions(
  auth: Credentials,
  sessionId: string,
  from: number,
  to: number,
  rating = 3,
): Promise<Array<GradeBody>> {
  const results: Array<GradeBody> = [];
  for (let position = from; position <= to; position += 1) {
    gradeCounter += 1;
    const cardKey = BOB_QUEUE[position]!;
    const outcome = await grade(auth, {
      event_id: `evt-${gradeCounter}`,
      session_id: sessionId,
      card_key: cardKey,
      rating,
    });
    expect(outcome.status).toBe(200);
    results.push(outcome.body);
  }
  return results;
}

async function patchSession(
  auth: Credentials,
  sessionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fx.app.request(`/api/study/sessions/${sessionId}`, {
    method: "PATCH",
    headers: writeHeaders(auth),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function undo(
  auth: Credentials,
  eventId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fx.app.request(`/api/reviews/${eventId}/undo`, {
    method: "POST",
    headers: writeHeaders(auth),
    body: JSON.stringify({}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function wordProgressRow(userId: string, wordKey: string): Record<string, unknown> {
  return fx.env.sqlite
    .prepare("SELECT * FROM word_progress WHERE user_id = ? AND word_key = ?")
    .get(userId, wordKey) as Record<string, unknown>;
}

function cardStateRow(userId: string, contentCardKey: string): Record<string, unknown> | undefined {
  return fx.env.sqlite
    .prepare("SELECT * FROM card_state WHERE user_id = ? AND content_card_key = ?")
    .get(userId, contentCardKey) as Record<string, unknown> | undefined;
}

function reviewLogRows(userId: string): Array<Record<string, unknown>> {
  return fx.env.sqlite
    .prepare("SELECT * FROM review_log WHERE user_id = ? ORDER BY reviewed_at, event_id")
    .all(userId) as Array<Record<string, unknown>>;
}

function snapshotOf(sessionId: string): { patch_event_ids?: string[]; cards: unknown[] } {
  const row = fx.env.sqlite
    .prepare("SELECT queue_snapshot FROM study_session WHERE session_id = ?")
    .get(sessionId) as { queue_snapshot: string };
  return JSON.parse(row.queue_snapshot) as { patch_event_ids?: string[]; cards: unknown[] };
}

async function getSession(auth: Credentials, sessionId: string): Promise<{ status: number; body: SessionBody & ErrorCode }> {
  const res = await fx.app.request(`/api/study/sessions/${sessionId}`, { headers: { cookie: auth.cookie } });
  return { status: res.status, body: (await res.json()) as SessionBody & ErrorCode };
}

async function createFixture(): Promise<StudyFixture> {
  const env = createMigratedTestDb();
  const db = createSqliteDatabase(env.sqlite);
  const clock = { now: T0 };
  const alice = await seedUser(db, "alice");
  const bob = await seedUser(db, "bob");
  await seedReleases(db);
  await seedR1Content(db);
  await seedR2ContentAndAliases(db);
  await seedAliceProgress(db, alice.userId);
  const deps: WorkerDeps = {
    db,
    loginRateLimiter: new FakeRateLimiter(),
    allowedOrigins: [ORIGIN],
    logWrite: () => {},
    now: () => clock.now,
  };
  const app = buildApp(deps);
  const aliceAuth = await loginAs(app, "alice");
  const bobAuth = await loginAs(app, "bob");
  return { env, db, deps, app, clock, alice, bob, aliceAuth, bobAuth };
}

let fx: StudyFixture;

beforeEach(async () => {
  fx = await createFixture();
});

afterEach(() => {
  fx.env.cleanup();
});

describe("POST /api/study/sessions", () => {
  it("requires authentication", async () => {
    const res = await fx.app.request("/api/study/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ mode: "NEW_WORDS" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorCode).code).toBe("AUTH_SESSION_INVALID");
  });

  it("requires origin and CSRF token", async () => {
    const noCsrf = await fx.app.request("/api/study/sessions", {
      method: "POST",
      headers: { cookie: fx.bobAuth.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ mode: "NEW_WORDS" }),
    });
    expect(noCsrf.status).toBe(403);
    expect(((await noCsrf.json()) as ErrorCode).code).toBe("CSRF_INVALID");

    const badOrigin = await fx.app.request("/api/study/sessions", {
      method: "POST",
      headers: {
        cookie: fx.bobAuth.cookie,
        origin: "https://evil.example",
        "x-csrf-token": fx.bobAuth.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "NEW_WORDS" }),
    });
    expect(badOrigin.status).toBe(403);
    expect(((await badOrigin.json()) as ErrorCode).code).toBe("ORIGIN_INVALID");
  });

  it("builds the NEW_WORDS queue in the binding 5.7 order and pins the release for 24h", async () => {
    const { status, headers, body } = await createSession(fx.bobAuth, "NEW_WORDS");
    expect(status).toBe(201);
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(body.release_id).toBe(R1);
    expect(body.position).toBe(0);
    expect(body.created_at).toBe(T0);
    expect(body.expires_at).toBe(T0 + DAY);
    // Presented keys are the pinned release's own keys, in the binding order...
    expect(body.cards.map((card) => card.presented_card_key)).toEqual([...BOB_QUEUE]);
    // ...and canonical keys resolve through the alias repository (k-old -> k-new).
    const canonical = body.cards.map((card) => card.canonical_card_key);
    expect(canonical.slice(0, 3)).toEqual(["k-wm-1", "k-wm-2", "k-wm-3"]);
    expect(canonical[3]).toBe("k-new");
    expect(canonical.slice(4)).toEqual(["k-cm-4", "k-ph-5", "k-sd-0", "k-sd-6"]);
    expect(body.current_card_key).toBe("k-wm-1");
  });

  it("resolves several presented cards through one reusable alias snapshot", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const service = new StudyService(fx.db, () => T0);
    const session = await service.requireSession(fx.bob, created.body.session_id);

    const resolved = await service.resolvePresentedMany(session, ["k-wm-1", "k-wm-2"]);

    expect(resolved.items.map((item) => item.canonicalCardKey)).toEqual(["k-wm-1", "k-wm-2"]);
    expect(resolved.items.every((item) => item.localWordKey === "w1")).toBe(true);
  });

  it("offers only the missing card of an introduced word as the QUICK_TEST (supplemental) queue", async () => {
    const { status, body } = await createSession(fx.aliceAuth, "QUICK_TEST");
    expect(status).toBe(201);
    expect(body.cards).toEqual([{ canonical_card_key: "k-sd-6", presented_card_key: "k-sd-6" }]);
    expect(body.release_id).toBe(R1);
  });

  it("orders the REVIEW queue by due then canonical stable key", async () => {
    const { status, body } = await createSession(fx.aliceAuth, "REVIEW");
    expect(status).toBe(201);
    // due ascending: k-cm-4 and k-wm-1 tie at T0-3000 and fall back to the
    // canonical key; then k-sd-0 (T0-2000) and k-wm-2 (T0-1000).
    expect(body.cards.map((card) => card.canonical_card_key)).toEqual([
      "k-cm-4",
      "k-wm-1",
      "k-sd-0",
      "k-wm-2",
    ]);
  });

  it("answers 409 when there is nothing left to study and 404 without an active release", async () => {
    // Exhaust alice's supplemental queue by grading her missing card.
    const quick = await createSession(fx.aliceAuth, "QUICK_TEST");
    expect(quick.status).toBe(201);
    const graded = await grade(fx.aliceAuth, {
      event_id: "evt-exhaust",
      session_id: quick.body.session_id,
      card_key: "k-sd-6",
      rating: 3,
    });
    expect(graded.status).toBe(200);
    const empty = await createSession(fx.aliceAuth, "QUICK_TEST");
    expect(empty.status).toBe(409);
    expect(empty.body.code).toBe("STUDY_QUEUE_EMPTY");

    fx.env.sqlite.prepare("UPDATE app_meta SET active_release_id = NULL WHERE id = 1").run();
    const none = await createSession(fx.bobAuth, "NEW_WORDS");
    expect(none.status).toBe(404);
    expect(none.body.code).toBe("STUDY_NO_ACTIVE_RELEASE");
  });

  it("rejects an unknown mode", async () => {
    const res = await createSession(fx.bobAuth, "MARATHON" as "NEW_WORDS");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_FAILED");
  });
});

describe("session resume (GET)", () => {
  it("returns the frozen queue and current position after partial progress", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    await gradePositions(fx.bobAuth, created.body.session_id, 0, 1);
    const resumed = await getSession(fx.bobAuth, created.body.session_id);
    expect(resumed.status).toBe(200);
    expect(resumed.body.position).toBe(2);
    expect(resumed.body.current_card_key).toBe("k-wm-3");
    // The queue is FROZEN: still the presented keys of the pinned release.
    expect(resumed.body.cards.map((card) => card.presented_card_key)).toEqual([...BOB_QUEUE]);
    // The session's group is recoverable from the snapshot (release-local
    // keys, sorted): unit + word keys let a resuming client verify the
    // session matches its study selection.
    expect(resumed.body.unit_keys).toEqual(["u-1"]);
    expect(resumed.body.word_keys).toEqual(["w-old", "w1", "w2"]);
  });

  it("lists only the caller's unexpired sessions", async () => {
    await createSession(fx.aliceAuth, "REVIEW");
    await createSession(fx.aliceAuth, "QUICK_TEST");
    const res = await fx.app.request("/api/study/sessions", { headers: { cookie: fx.aliceAuth.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: SessionBody[] };
    expect(body.sessions).toHaveLength(2);
    for (const session of body.sessions) {
      expect(session.release_id).toBe(R1);
    }
    const bobRes = await fx.app.request("/api/study/sessions", { headers: { cookie: fx.bobAuth.cookie } });
    expect(((await bobRes.json()) as { sessions: SessionBody[] }).sessions).toHaveLength(0);
  });

  it("answers 400 for an expired session", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    fx.clock.now = T0 + DAY + 1;
    const resumed = await getSession(fx.bobAuth, created.body.session_id);
    expect(resumed.status).toBe(400);
    expect(resumed.body.code).toBe("STUDY_SESSION_INVALID");
  });
});

describe("PATCH /api/study/sessions/:id (StudyPatch)", () => {
  it("keeps a 100+ card session within the D1 free query and binding budgets", async () => {
    // Local SQLite normally has neither D1 limit. Enforce both at prepare
    // time so this reproduces the production failure rather than just
    // asserting that the final response is successful.
    for (let start = 0; start < 110; start += 50) {
      const extra = Array.from({ length: Math.min(50, 110 - start) }, (_, offset) => {
        const index = start + offset;
        return {
          releaseId: R1,
          contentCardKey: `k-budget-${index}`,
          cardType: "WORD_MEANING" as const,
          targetEntityKey: `t-budget-${index}`,
          wordKey: "w1",
          unitKey: "u-1",
          templateVersion: "tv-1",
          status: "ACTIVE" as const,
        };
      });
      await fx.db.insert(cardDefinition).values(extra);
    }

    const originalPrepare = fx.env.sqlite.prepare.bind(fx.env.sqlite);
    let queryCount = 0;
    fx.env.sqlite.prepare = ((source: string) => {
      queryCount += 1;
      if (queryCount > 50) throw new Error("simulated D1 free query limit");
      if ((source.match(/\?/g) ?? []).length > 100) throw new Error("simulated D1 binding limit");
      return originalPrepare(source);
    }) as typeof fx.env.sqlite.prepare;
    try {
      const withinBudget = async <T>(request: () => Promise<T>): Promise<T> => {
        queryCount = 0;
        const result = await request();
        expect(queryCount).toBeLessThanOrEqual(50);
        return result;
      };
      const created = await withinBudget(() => createSession(fx.bobAuth, "NEW_WORDS"));
      expect(created.status).toBe(201);
      expect(created.body.cards.length).toBeGreaterThan(100);
      const resumed = await withinBudget(() => getSession(fx.bobAuth, created.body.session_id));
      expect(resumed.status).toBe(200);
      expect(resumed.body.word_keys).toEqual(["w-old", "w1", "w2"]);
      const presented = await withinBudget(() => patchSession(fx.bobAuth, created.body.session_id, {
        event_id: "budget-presented", action: "WORD_PRESENTED", word_key: "w2",
      }));
      expect(presented.status).toBe(200);
      const familiarity = await withinBudget(() => patchSession(fx.bobAuth, created.body.session_id, {
        event_id: "budget-familiarity", action: "FAMILIARITY_SET", word_key: "w1",
        familiarity: "VERY_UNFAMILIAR",
      }));
      expect(familiarity.status).toBe(200);
      const first = await withinBudget(() => grade(fx.bobAuth, {
        event_id: "budget-grade", session_id: created.body.session_id,
        card_key: created.body.current_card_key!, rating: 3,
      }));
      expect(first.status).toBe(200);
      const supplemental = await withinBudget(() => createSession(fx.aliceAuth, "QUICK_TEST"));
      expect(supplemental.status).toBe(201);
      expect(supplemental.body.cards.length).toBeGreaterThan(100);
      const clone = originalPrepare(`INSERT INTO study_session
        (session_id, user_id, mode, release_id, queue_snapshot, position, created_at, expires_at)
        SELECT ?, user_id, mode, release_id, queue_snapshot, position, created_at, expires_at
        FROM study_session WHERE session_id = ?`);
      for (let index = 0; index < 30; index += 1) clone.run(`budget-clone-${index}`, supplemental.body.session_id);
      queryCount = 0;
      const listed = await fx.app.request("/api/study/sessions", { headers: { cookie: fx.aliceAuth.cookie } });
      expect(listed.status).toBe(200);
      expect(queryCount).toBeLessThanOrEqual(50);
      expect(((await listed.json()) as { sessions: unknown[] }).sessions).toHaveLength(31);
    } finally {
      fx.env.sqlite.prepare = originalPrepare as typeof fx.env.sqlite.prepare;
    }
  });

  it("records WORD_PRESENTED: creates word_progress moving UNSEEN -> IN_PROGRESS and snapshots the event id", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const outcome = await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "patch-1",
      action: "WORD_PRESENTED",
      word_key: "w1",
    });
    expect(outcome.status).toBe(200);
    expect(outcome.json).toMatchObject({
      event_id: "patch-1",
      word_key: "w1",
      replayed: false,
      progress: { stage: "IN_PROGRESS", initial_familiarity: null, first_seen_at: T0, last_seen_at: T0 },
    });
    const row = wordProgressRow(fx.bob.userId, "w1");
    expect(row.stage).toBe("IN_PROGRESS");
    expect(row.first_seen_at).toBe(T0);
    expect(row.last_seen_at).toBe(T0);
    expect(snapshotOf(created.body.session_id).patch_event_ids).toEqual(["patch-1"]);
  });

  it("is idempotent: replaying a patch event changes nothing and reports the prior result", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const body = { event_id: "patch-1", action: "WORD_PRESENTED", word_key: "w1" };
    const first = await patchSession(fx.bobAuth, created.body.session_id, body);
    expect(first.status).toBe(200);
    fx.clock.now = T0 + HOUR;
    const replay = await patchSession(fx.bobAuth, created.body.session_id, body);
    expect(replay.status).toBe(200);
    expect(replay.json).toMatchObject({ event_id: "patch-1", replayed: true });
    expect(wordProgressRow(fx.bob.userId, "w1").last_seen_at).toBe(T0); // replay wrote nothing
    expect(snapshotOf(created.body.session_id).patch_event_ids).toEqual(["patch-1"]);
  });

  it("never moves a word out of INTRODUCED (UNSEEN -> IN_PROGRESS is the only stage change)", async () => {
    // Alice's w1 is INTRODUCED; her QUICK_TEST session presents its missing card.
    const created = await createSession(fx.aliceAuth, "QUICK_TEST");
    const outcome = await patchSession(fx.aliceAuth, created.body.session_id, {
      event_id: "patch-introduced",
      action: "WORD_PRESENTED",
      word_key: "w1",
    });
    expect(outcome.status).toBe(200);
    expect(outcome.json).toMatchObject({
      progress: { stage: "INTRODUCED", first_seen_at: T0 - 3 * DAY, last_seen_at: T0 },
    });
  });

  it("validates the patched word against the session's group, not the queue position", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    // w2 belongs to the group but does not own the current queue item; spec
    // 9.3 first-sorting familiarity must reach EVERY studied word, so
    // membership — not the live position — decides (controller ruling).
    const sameGroup = await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "patch-group-w2",
      action: "WORD_PRESENTED",
      word_key: "w2",
    });
    expect(sameGroup.status).toBe(200);
    expect(sameGroup.json).toMatchObject({ word_key: "w2", replayed: false });

    // Alice's next NEW_WORDS group skips her INTRODUCED w1: a patch for w1
    // is outside the session's group and is rejected with a stable code.
    const aliceSession = await createSession(fx.aliceAuth, "NEW_WORDS");
    const outside = await patchSession(fx.aliceAuth, aliceSession.body.session_id, {
      event_id: "patch-outside",
      action: "WORD_PRESENTED",
      word_key: "w1",
    });
    expect(outside.status).toBe(409);
    expect((outside.json as ErrorCode).code).toBe("STUDY_WORD_NOT_IN_GROUP");
  });

  it("records familiarity for any group word without any FSRS write", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    // w2 is not the current queue item; the familiarity choice is still a
    // first-sorting write for the studied word and never touches grading.
    const outcome = await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "fam-w2",
      action: "FAMILIARITY_SET",
      word_key: "w2",
      familiarity: "SOMEWHAT_FAMILIAR",
    });
    expect(outcome.status).toBe(200);
    expect(outcome.json).toMatchObject({
      progress: { stage: "IN_PROGRESS", initial_familiarity: "SOMEWHAT_FAMILIAR" },
    });
    expect(reviewLogRows(fx.bob.userId)).toHaveLength(0);
    expect(cardStateRow(fx.bob.userId, "k-wm-3")).toBeUndefined();
  });

  it("persists all three familiarity values with last_seen_at and never writes FSRS state", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const cases: Array<[string, string]> = [
      ["VERY_UNFAMILIAR", "UNKNOWN"],
      ["SOMEWHAT_FAMILIAR", "RECOGNIZABLE"],
      ["FAMILIAR", "KNOWN"],
    ];
    for (const [index, [apiValue, dbValue]] of cases.entries()) {
      fx.clock.now = T0 + (index + 1) * MINUTE;
      const outcome = await patchSession(fx.bobAuth, created.body.session_id, {
        event_id: `fam-${index + 1}`,
        action: "FAMILIARITY_SET",
        word_key: "w1",
        familiarity: apiValue,
      });
      expect(outcome.status).toBe(200);
      expect(outcome.json).toMatchObject({
        progress: { stage: "IN_PROGRESS", initial_familiarity: apiValue, last_seen_at: fx.clock.now },
      });
      const row = wordProgressRow(fx.bob.userId, "w1");
      expect(row.initial_familiarity).toBe(dbValue);
      expect(row.stage).toBe("IN_PROGRESS");
    }
    expect(reviewLogRows(fx.bob.userId)).toHaveLength(0);
    expect(cardStateRow(fx.bob.userId, "k-wm-1")).toBeUndefined();
  });

  it("rejects malformed patch bodies", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const badFamiliarity = await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "patch-bad",
      action: "FAMILIARITY_SET",
      word_key: "w1",
      familiarity: "MEH",
    });
    expect(badFamiliarity.status).toBe(400);
    expect((badFamiliarity.json as ErrorCode).code).toBe("VALIDATION_FAILED");

    const unknownAction = await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "patch-bad-2",
      action: "WORD_IGNORED",
      word_key: "w1",
    });
    expect(unknownAction.status).toBe(400);
  });

  it("rejects patches on unknown or expired sessions", async () => {
    const missing = await patchSession(fx.bobAuth, "sess-nope", {
      event_id: "p",
      action: "WORD_PRESENTED",
      word_key: "w1",
    });
    expect(missing.status).toBe(400);
    expect((missing.json as ErrorCode).code).toBe("STUDY_SESSION_INVALID");

    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    fx.clock.now = T0 + DAY + 1;
    const expired = await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "p2",
      action: "WORD_PRESENTED",
      word_key: "w1",
    });
    expect(expired.status).toBe(400);
    expect((expired.json as ErrorCode).code).toBe("STUDY_SESSION_INVALID");
  });
});

describe("POST /api/reviews/grade", () => {
  it("uses batched state and idempotency reads for single and grouped grades", async () => {
    const singleSession = await createSession(fx.bobAuth, "NEW_WORDS");
    const singleService = new StudyService(fx.db, () => T0);
    const singleStateBatch = vi.spyOn(singleService.cardStates, "getMany");
    const singleStateRead = vi.spyOn(singleService.cardStates, "get");
    await gradeReview(singleService, fx.bob, {
      event_id: "evt-batched-single",
      session_id: singleSession.body.session_id,
      card_key: "k-wm-1",
      rating: 3,
    });
    expect(singleStateBatch).toHaveBeenCalledTimes(1);
    expect(singleStateRead).not.toHaveBeenCalled();

    const batchSession = await createSession(fx.bobAuth, "NEW_WORDS");
    const batchService = new StudyService(fx.db, () => T0);
    const logBatch = vi.spyOn(batchService.reviewLogs, "getMany");
    const logRead = vi.spyOn(batchService.reviewLogs, "get");
    const stateBatch = vi.spyOn(batchService.cardStates, "getMany");
    const stateRead = vi.spyOn(batchService.cardStates, "get");
    await gradeReviewBatch(batchService, fx.bob, {
      session_id: batchSession.body.session_id,
      grades: [
        { event_id: "evt-batched-1", card_key: "k-wm-1" },
        { event_id: "evt-batched-2", card_key: "k-wm-2" },
      ],
      rating: 3,
    });
    expect(logBatch).toHaveBeenCalledTimes(1);
    expect(logRead).not.toHaveBeenCalled();
    expect(stateBatch).toHaveBeenCalledTimes(1);
    expect(stateRead).not.toHaveBeenCalled();
  });

  it("atomically grades consecutive same-word meaning cards and advances by the batch size", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const request = {
      session_id: created.body.session_id,
      grades: [
        { event_id: "evt-batch-1", card_key: "k-wm-1" },
        { event_id: "evt-batch-2", card_key: "k-wm-2" },
      ],
      rating: 3,
    };
    const outcome = await gradeBatch(fx.bobAuth, request);
    expect(outcome.status).toBe(200);
    expect(outcome.headers.get("cache-control")).toBe("private, no-store");
    expect(outcome.body).toMatchObject({
      session_id: created.body.session_id,
      position: 2,
      replayed: false,
    });
    expect(outcome.body.results.map((result) => result.presented_card_key)).toEqual([
      "k-wm-1",
      "k-wm-2",
    ]);
    expect(outcome.body.results.every((result) => result.rating === 3)).toBe(true);
    expect(cardStateRow(fx.bob.userId, "k-wm-1")).not.toBeNull();
    expect(cardStateRow(fx.bob.userId, "k-wm-2")).not.toBeNull();
    expect((await getSession(fx.bobAuth, created.body.session_id)).body.position).toBe(2);

    const replay = await gradeBatch(fx.bobAuth, request);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ position: 2, replayed: true });
    expect(replay.body.results.every((result) => result.replayed)).toBe(true);
  });

  it("rejects a batch that crosses words instead of silently over-grading", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const outcome = await gradeBatch(fx.bobAuth, {
      session_id: created.body.session_id,
      grades: [
        { event_id: "evt-cross-1", card_key: "k-wm-1" },
        { event_id: "evt-cross-2", card_key: "k-wm-2" },
        { event_id: "evt-cross-3", card_key: "k-wm-3" },
      ],
      rating: 3,
    });
    expect(outcome.status).toBe(400);
    expect(outcome.body.code).toBe("REVIEW_BATCH_INVALID");
    expect((await getSession(fx.bobAuth, created.body.session_id)).body.position).toBe(0);
  });

  it("creates card_state from a null before_state, appends the log, and advances the session position", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const outcome = await grade(fx.bobAuth, {
      event_id: "evt-first",
      session_id: created.body.session_id,
      card_key: "k-wm-1",
      rating: 3,
    });
    expect(outcome.status).toBe(200);
    expect(outcome.headers.get("cache-control")).toBe("private, no-store");
    expect(outcome.body).toMatchObject({
      event_id: "evt-first",
      card_key: "k-wm-1",
      presented_card_key: "k-wm-1",
      release_id: R1,
      rating: 3,
      before_state: null,
      reviewed_at: T0,
      duration_ms: 5000,
      undone_at: null,
      replayed: false,
    });
    // Locked first-grade Good vector: 10m learning step, stability = w[2].
    expect(outcome.body.after_state).toMatchObject({
      version: 1,
      state: "Learning",
      stability: 2.3065,
      difficulty: 2.11810397,
      due_at: T0 + 10 * MINUTE,
      last_review_at: T0,
      reps: 1,
      lapses: 0,
      scheduled_days: 0,
      learning_steps: 1,
    });
    const row = cardStateRow(fx.bob.userId, "k-wm-1")!;
    expect(row.due).toBe(T0 + 10 * MINUTE);
    expect(row.reps).toBe(1);
    const resumed = await getSession(fx.bobAuth, created.body.session_id);
    expect(resumed.body.position).toBe(1);
  });

  it("enforces the queue position and card validity in the pinned release", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const notCurrent = await grade(fx.bobAuth, {
      event_id: "evt-nc",
      session_id: created.body.session_id,
      card_key: "k-sd-6",
      rating: 3,
    });
    expect(notCurrent.status).toBe(409);
    expect(notCurrent.body.code).toBe("STUDY_CARD_NOT_CURRENT");

    // k-new only exists in R2, which this session does not pin.
    const foreign = await grade(fx.bobAuth, {
      event_id: "evt-foreign",
      session_id: created.body.session_id,
      card_key: "k-new",
      rating: 3,
    });
    expect(foreign.status).toBe(409);
    expect(foreign.body.code).toBe("STUDY_CARD_NOT_CURRENT");

    // Remove the current card's definition: the presented key no longer
    // resolves in the pinned release.
    fx.env.sqlite
      .prepare("DELETE FROM card_definition WHERE release_id = ? AND content_card_key = ?")
      .run(R1, "k-wm-1");
    const invalid = await grade(fx.bobAuth, {
      event_id: "evt-invalid",
      session_id: created.body.session_id,
      card_key: "k-wm-1",
      rating: 3,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe("STUDY_CARD_INVALID");
  });

  it("rejects grading an exhausted or unknown session and bad ratings", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    await gradePositions(fx.bobAuth, created.body.session_id, 0, BOB_QUEUE.length - 1);
    const exhausted = await grade(fx.bobAuth, {
      event_id: "evt-extra",
      session_id: created.body.session_id,
      card_key: "k-sd-6",
      rating: 3,
    });
    expect(exhausted.status).toBe(409);
    expect(exhausted.body.code).toBe("STUDY_QUEUE_EXHAUSTED");

    const unknown = await grade(fx.bobAuth, {
      event_id: "evt-unknown",
      session_id: "sess-nope",
      card_key: "k-wm-1",
      rating: 3,
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("STUDY_SESSION_INVALID");

    const badRating = await grade(fx.bobAuth, {
      event_id: "evt-bad-rating",
      session_id: created.body.session_id,
      card_key: "k-sd-6",
      rating: 5,
    });
    expect(badRating.status).toBe(400);
    expect(badRating.body.code).toBe("VALIDATION_FAILED");
  });

  it("replays a duplicate event_id as the original result without re-counting", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const request = {
      event_id: "evt-dup",
      session_id: created.body.session_id,
      card_key: "k-wm-1",
      rating: 4,
    };
    const first = await grade(fx.bobAuth, request);
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    fx.clock.now = T0 + HOUR;
    const replay = await grade(fx.bobAuth, request);
    expect(replay.status).toBe(200);
    // The original result verbatim, except the replay marker.
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect(reviewLogRows(fx.bob.userId)).toHaveLength(1);
    expect(cardStateRow(fx.bob.userId, "k-wm-1")!.reps).toBe(1);
    const resumed = await getSession(fx.bobAuth, created.body.session_id);
    expect(resumed.body.position).toBe(1);
  });

  it("flips word_progress to INTRODUCED exactly when a word's last active card is graded", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "patch-w1",
      action: "WORD_PRESENTED",
      word_key: "w1",
    });
    // k-wm-1 (pos 0): w1 is IN_PROGRESS, not yet INTRODUCED.
    await gradePositions(fx.bobAuth, created.body.session_id, 0, 0);
    expect(wordProgressRow(fx.bob.userId, "w1").stage).toBe("IN_PROGRESS");
    // Grade w1's second card; then w2 owns the current item (k-wm-3).
    await gradePositions(fx.bobAuth, created.body.session_id, 1, 1);
    await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "patch-w2",
      action: "WORD_PRESENTED",
      word_key: "w2",
    });
    const graded = await gradePositions(fx.bobAuth, created.body.session_id, 2, BOB_QUEUE.length - 1);
    expect(graded).toHaveLength(BOB_QUEUE.length - 2);
    // w2 completed with k-ph-5 (pos 5), introduced mid-queue...
    expect(wordProgressRow(fx.bob.userId, "w2")).toMatchObject({
      stage: "INTRODUCED",
      introduced_release_id: R1,
      introduced_at: T0,
    });
    // ...and w1 completes only with the final card k-sd-6.
    expect(wordProgressRow(fx.bob.userId, "w1")).toMatchObject({
      stage: "INTRODUCED",
      introduced_release_id: R1,
      introduced_at: T0,
      first_seen_at: T0,
    });
  });

  it("grades a later review on top of the stored state (before_state is the prior after_state)", async () => {
    // Alice grades her missing card in QUICK_TEST...
    const quick = await createSession(fx.aliceAuth, "QUICK_TEST");
    const first = await grade(fx.aliceAuth, {
      event_id: "evt-q1",
      session_id: quick.body.session_id,
      card_key: "k-sd-6",
      rating: 3,
    });
    expect(first.status).toBe(200);
    expect(first.body.before_state).toBeNull();
    // ...time passes; the card is now due and re-graded in REVIEW.
    fx.clock.now = T0 + 2 * HOUR;
    const review = await createSession(fx.aliceAuth, "REVIEW");
    const keys = review.body.cards.map((card) => card.canonical_card_key);
    const position = keys.indexOf("k-sd-6");
    for (let i = 0; i < position; i += 1) {
      const skip = await grade(fx.aliceAuth, {
        event_id: `evt-r-skip-${i}`,
        session_id: review.body.session_id,
        card_key: keys[i]!,
        rating: 3,
      });
      expect(skip.status).toBe(200);
    }
    const second = await grade(fx.aliceAuth, {
      event_id: "evt-r1",
      session_id: review.body.session_id,
      card_key: "k-sd-6",
      rating: 3,
    });
    expect(second.status).toBe(200);
    expect(second.body.before_state).toEqual(first.body.after_state);
    // Locked Good -> Good chain with 2h elapsed (past the 10m due): graduates
    // to Review with a 7d interval.
    expect(second.body.after_state).toMatchObject({
      state: "Review",
      stability: 7.31530068,
      reps: 2,
      due_at: fx.clock.now + 7 * DAY,
    });
  });
});

describe("POST /api/reviews/:eventId/undo", () => {
  it("restores the before_state and rewinds the session position, keeping the log row", async () => {
    // Alice grades her missing card twice (QUICK_TEST then REVIEW) and undoes
    // the SECOND grade: card_state must return to the first grade's state.
    const quick = await createSession(fx.aliceAuth, "QUICK_TEST");
    const first = await grade(fx.aliceAuth, {
      event_id: "evt-q1",
      session_id: quick.body.session_id,
      card_key: "k-sd-6",
      rating: 3,
    });
    expect(first.status).toBe(200);
    fx.clock.now = T0 + 2 * HOUR;
    const review = await createSession(fx.aliceAuth, "REVIEW");
    const keys = review.body.cards.map((card) => card.canonical_card_key);
    const position = keys.indexOf("k-sd-6");
    for (let i = 0; i < position; i += 1) {
      const skip = await grade(fx.aliceAuth, {
        event_id: `evt-r-skip-${i}`,
        session_id: review.body.session_id,
        card_key: keys[i]!,
        rating: 3,
      });
      expect(skip.status).toBe(200);
    }
    const second = await grade(fx.aliceAuth, {
      event_id: "evt-r1",
      session_id: review.body.session_id,
      card_key: "k-sd-6",
      rating: 3,
    });
    expect(second.status).toBe(200);

    const outcome = await undo(fx.aliceAuth, "evt-r1");
    expect(outcome.status).toBe(200);
    expect(outcome.json).toMatchObject({ event_id: "evt-r1", card_key: "k-sd-6", word_stage: "INTRODUCED" });
    const restored = cardStateRow(fx.alice.userId, "k-sd-6")!;
    expect(JSON.parse(restored.fsrs_state as string)).toEqual(first.body.after_state);
    const log = fx.env.sqlite.prepare("SELECT * FROM review_log WHERE event_id = ?").get("evt-r1") as Record<string, unknown>;
    expect(log.undone_at).toBe(T0 + 2 * HOUR);
    expect(log.after_state).toBeTruthy(); // the log row itself always remains
    const resumed = await getSession(fx.aliceAuth, review.body.session_id);
    expect(resumed.body.position).toBe(position);
  });

  it("deletes the card_state on a first-grade undo but keeps the log row", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const graded = await grade(fx.bobAuth, {
      event_id: "evt-only",
      session_id: created.body.session_id,
      card_key: "k-wm-1",
      rating: 3,
    });
    expect(graded.status).toBe(200);
    expect(cardStateRow(fx.bob.userId, "k-wm-1")).toBeDefined();

    const outcome = await undo(fx.bobAuth, "evt-only");
    expect(outcome.status).toBe(200);
    expect(outcome.json).toMatchObject({ restored_state: null, word_stage: null });
    expect(cardStateRow(fx.bob.userId, "k-wm-1")).toBeUndefined();
    const log = fx.env.sqlite.prepare("SELECT * FROM review_log WHERE event_id = ?").get("evt-only") as Record<string, unknown>;
    expect(log.undone_at).toBe(T0);
    const resumed = await getSession(fx.bobAuth, created.body.session_id);
    expect(resumed.body.position).toBe(0);
  });

  it("rolls an INTRODUCED word back to IN_PROGRESS when the undo reopens its card", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "patch-w1",
      action: "WORD_PRESENTED",
      word_key: "w1",
    });
    await gradePositions(fx.bobAuth, created.body.session_id, 0, 1);
    // Present w2 while k-wm-3 (pos 2) is the current item, then complete it:
    // its cards are k-wm-3 (pos 2) and k-ph-5 (pos 5).
    await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "patch-w2",
      action: "WORD_PRESENTED",
      word_key: "w2",
    });
    const graded = await gradePositions(fx.bobAuth, created.body.session_id, 2, 5);
    expect(wordProgressRow(fx.bob.userId, "w2")).toMatchObject({
      stage: "INTRODUCED",
      introduced_release_id: R1,
    });
    const last = graded[graded.length - 1]!.event_id; // k-ph-5's grade
    const outcome = await undo(fx.bobAuth, last);
    expect(outcome.status).toBe(200);
    expect(outcome.json).toMatchObject({ word_stage: "IN_PROGRESS" });
    expect(wordProgressRow(fx.bob.userId, "w2")).toMatchObject({
      stage: "IN_PROGRESS",
      introduced_release_id: null,
      introduced_at: null,
    });
    expect(cardStateRow(fx.bob.userId, "k-ph-5")).toBeUndefined();
    // w1 still lacks k-sd-0/k-sd-6: untouched by the rollback.
    expect(wordProgressRow(fx.bob.userId, "w1").stage).toBe("IN_PROGRESS");
  });

  it("rejects undoing a non-latest event", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    // Distinct review times make "latest" unambiguous.
    for (const [index, cardKey] of BOB_QUEUE.entries()) {
      if (index > 2) break;
      fx.clock.now = T0 + index;
      const outcome = await grade(fx.bobAuth, {
        event_id: `evt-nl-${index}`,
        session_id: created.body.session_id,
        card_key: cardKey,
        rating: 3,
      });
      expect(outcome.status).toBe(200);
    }
    const outcome = await undo(fx.bobAuth, "evt-nl-0");
    expect(outcome.status).toBe(409);
    expect((outcome.json as ErrorCode).code).toBe("REVIEW_UNDO_NOT_LATEST");
  });

  it("undoes deterministically when two grades of one card share a millisecond", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    fx.clock.now = T0;
    const first = await grade(fx.bobAuth, {
      event_id: "evt-tie-first",
      session_id: created.body.session_id,
      card_key: "k-wm-1",
      rating: 3,
    });
    expect(first.status).toBe(200);
    // Test-only rewind: re-present the SAME card and grade it again within
    // the SAME millisecond, so both events tie on reviewed_at and insertion
    // order must decide which one is "latest".
    fx.env.sqlite
      .prepare("UPDATE study_session SET position = 0 WHERE session_id = ?")
      .run(created.body.session_id);
    const second = await grade(fx.bobAuth, {
      event_id: "evt-tie-second",
      session_id: created.body.session_id,
      card_key: "k-wm-1",
      rating: 2,
    });
    expect(second.status).toBe(200);
    expect(second.body.before_state).toEqual(first.body.after_state);
    expect(second.body.reviewed_at).toBe(first.body.reviewed_at);

    // The effectively-OLDER tied event is not undoable: its "first grade"
    // deletion would silently drop the second grade's scheduling state.
    const olderFirst = await undo(fx.bobAuth, "evt-tie-first");
    expect(olderFirst.status).toBe(409);
    expect((olderFirst.json as ErrorCode).code).toBe("REVIEW_UNDO_NOT_LATEST");

    // Undoing the truly-latest event restores the first grade's state...
    const outcome = await undo(fx.bobAuth, "evt-tie-second");
    expect(outcome.status).toBe(200);
    const restored = cardStateRow(fx.bob.userId, "k-wm-1")!;
    expect(JSON.parse(restored.fsrs_state as string)).toEqual(first.body.after_state);
    // ...the tied log row remains un-undone and intact...
    const tied = fx.env.sqlite
      .prepare("SELECT * FROM review_log WHERE event_id = ?")
      .get("evt-tie-first") as Record<string, unknown>;
    expect(tied.undone_at).toBeNull();
    expect(tied.after_state).toBeTruthy();
    // ...and the position rewound exactly once (grade, rewind, grade, undo).
    const resumed = await getSession(fx.bobAuth, created.body.session_id);
    expect(resumed.body.position).toBe(0);

    // The chain stays consistent: the first grade is now the latest
    // un-undone event, and undoing it deletes the state it created.
    const chained = await undo(fx.bobAuth, "evt-tie-first");
    expect(chained.status).toBe(200);
    expect(cardStateRow(fx.bob.userId, "k-wm-1")).toBeUndefined();
  });

  it("rejects a second undo of the same event and unknown events", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const graded = await gradePositions(fx.bobAuth, created.body.session_id, 0, 0);
    const eventId = graded[0]!.event_id;
    const first = await undo(fx.bobAuth, eventId);
    expect(first.status).toBe(200);
    const second = await undo(fx.bobAuth, eventId);
    expect(second.status).toBe(409);
    expect((second.json as ErrorCode).code).toBe("REVIEW_EVENT_UNDONE");

    const missing = await undo(fx.bobAuth, "evt-nope");
    expect(missing.status).toBe(404);
    expect((missing.json as ErrorCode).code).toBe("REVIEW_EVENT_NOT_FOUND");
  });

  it("rejects undoing an event whose study session has expired", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    const graded = await gradePositions(fx.bobAuth, created.body.session_id, 0, 0);
    fx.clock.now = T0 + DAY + 1;
    const outcome = await undo(fx.bobAuth, graded[0]!.event_id);
    expect(outcome.status).toBe(400);
    expect((outcome.json as ErrorCode).code).toBe("STUDY_SESSION_INVALID");
  });

  it("requires authentication and CSRF", async () => {
    const noAuth = await fx.app.request("/api/reviews/evt-1/undo", { method: "POST" });
    expect(noAuth.status).toBe(401);
    const noCsrf = await fx.app.request("/api/reviews/evt-1/undo", {
      method: "POST",
      headers: { cookie: fx.bobAuth.cookie, origin: ORIGIN },
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe("alias-aware grading and undo across release activation and rollback", () => {
  it("grades a pinned old key into its canonical state and undoes it, regardless of the active pointer", async () => {
    const created = await createSession(fx.bobAuth, "NEW_WORDS");
    // k-old sits at position 3; grade up to it and present its word.
    await gradePositions(fx.bobAuth, created.body.session_id, 0, 2);
    await patchSession(fx.bobAuth, created.body.session_id, {
      event_id: "patch-w-old",
      action: "WORD_PRESENTED",
      word_key: "w-old",
    });

    // Activate R2 (R1 becomes RETIRED): the pinned session must not move.
    const releases = new ReleaseRepository(fx.db);
    await releases.setActive(R2, T0 + HOUR);
    fx.clock.now = T0 + HOUR;
    const resumed = await getSession(fx.bobAuth, created.body.session_id);
    expect(resumed.body.release_id).toBe(R1);
    expect(resumed.body.cards.map((card) => card.presented_card_key)).toEqual([...BOB_QUEUE]);

    // Grade the old key: state lands on the canonical k-new / w-new keys.
    const graded = await grade(fx.bobAuth, {
      event_id: "evt-alias",
      session_id: created.body.session_id,
      card_key: "k-old",
      rating: 3,
    });
    expect(graded.status).toBe(200);
    expect(graded.body).toMatchObject({
      card_key: "k-new",
      presented_card_key: "k-old",
      release_id: R1,
    });
    expect(cardStateRow(fx.bob.userId, "k-new")).toBeDefined();
    expect(cardStateRow(fx.bob.userId, "k-old")).toBeUndefined();
    const log = fx.env.sqlite
      .prepare("SELECT * FROM review_log WHERE event_id = ?")
      .get("evt-alias") as Record<string, unknown>;
    expect(log).toMatchObject({ content_card_key: "k-new", presented_card_key: "k-old", presented_release_id: R1 });
    expect(wordProgressRow(fx.bob.userId, "w-new")).toMatchObject({
      stage: "INTRODUCED",
      introduced_release_id: R1,
    });

    // Undo the alias grade: the canonical state is rolled back.
    const undone = await undo(fx.bobAuth, "evt-alias");
    expect(undone.status).toBe(200);
    expect(undone.json).toMatchObject({ card_key: "k-new", word_stage: "IN_PROGRESS" });
    expect(cardStateRow(fx.bob.userId, "k-new")).toBeUndefined();

    // Roll the release pointer back to R1 and re-grade the old key: the same
    // canonical state is addressed again.
    await releases.setActive(R1, T0 + 2 * HOUR);
    fx.clock.now = T0 + 2 * HOUR;
    const regraded = await grade(fx.bobAuth, {
      event_id: "evt-alias-2",
      session_id: created.body.session_id,
      card_key: "k-old",
      rating: 3,
    });
    expect(regraded.status).toBe(200);
    expect(regraded.body.card_key).toBe("k-new");
    expect(cardStateRow(fx.bob.userId, "k-new")).toBeDefined();
  });
});

describe("alias-aware queue selection across a rename (canonical progress)", () => {
  /**
   * Finding (final review): group/supplemental selection joined
   * word_progress.word_key (canonical) directly to the release-local
   * word.word_key, so a renamed word with existing progress re-entered
   * NEW_WORDS as if unseen and vanished from QUICK_TEST. Bob therefore holds
   * INTRODUCED progress under the canonical w-new, with k-new (k-old's
   * canonical card) already graded and a second, ungraded active card
   * (k-old-2) — while the ACTIVE release R1 still presents the OLD keys.
   */
  async function seedRenamedWordProgress(): Promise<void> {
    await fx.db.insert(cardDefinition).values({
      releaseId: R1,
      contentCardKey: "k-old-2",
      cardType: "WORD_MEANING",
      targetEntityKey: "t-old-2",
      wordKey: "w-old",
      unitKey: "u-1",
      templateVersion: "tv-1",
      status: "ACTIVE",
    });
    await new WordProgressRepository(fx.db).upsert({ userId: fx.bob.userId }, {
      wordKey: "w-new",
      stage: "INTRODUCED",
      initialFamiliarity: null,
      firstSeenAt: T0 - DAY,
      lastSeenAt: T0 - DAY,
      introducedReleaseId: R1,
      introducedAt: T0 - DAY,
    });
    await seedCardState(fx.db, fx.bob.userId, "k-new", T0 - 500);
  }

  it("does not re-teach a renamed word whose canonical key already has progress", async () => {
    await seedRenamedWordProgress();
    const group = await createSession(fx.bobAuth, "NEW_WORDS");
    expect(group.status).toBe(201);
    // w-old resolves to w-new, which is INTRODUCED: it must not re-enter the
    // teaching order. The group is exactly w1's and w2's cards.
    expect(group.body.cards.map((card) => card.presented_card_key)).toEqual([
      "k-wm-1",
      "k-wm-2",
      "k-wm-3",
      "k-cm-4",
      "k-ph-5",
      "k-sd-0",
      "k-sd-6",
    ]);
  });

  it("surfaces the renamed word's ungraded active cards in the QUICK_TEST queue", async () => {
    await seedRenamedWordProgress();
    const quick = await createSession(fx.bobAuth, "QUICK_TEST");
    expect(quick.status).toBe(201);
    // w-old is introduced through its canonical root; k-old is graded (its
    // canonical k-new carries card_state), so only the ungraded k-old-2 is
    // offered — under its release-local presented key.
    expect(quick.body.cards).toEqual([{ canonical_card_key: "k-old-2", presented_card_key: "k-old-2" }]);
    expect(quick.body.release_id).toBe(R1);
  });
});
