import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ReleaseRepository,
  UserRepository,
  createSqliteDatabase,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { book, cardDefinition, unit, word } from "@lexiloop/db";
import { createMigratedTestDb, type TestDatabase } from "../../../packages/db/test/helpers";
import { buildApp, type LoginRateLimiter, type WorkerDeps } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { SESSION_COOKIE } from "../src/auth/session";
import { createAtomicBatchRunner, StudyService } from "../src/study/service";
import { sql } from "drizzle-orm";

/**
 * Task 13 concurrency and atomicity tests (spec 8.3, plan step 4): duplicate
 * grades collapse into one row set with the replay returning the prior
 * result, undo applies at most once, and the atomic batch runner is a real
 * transaction (a failing statement rolls the whole unit back). Runs are
 * deterministic; `--repeat=10` must not change a single assertion.
 */

const T0 = 1_700_000_000_000;
const ORIGIN = "https://lexiloop.example";
const PASSWORD = "correct horse battery staple";
const RELEASE = "rel-concurrency";

interface Credentials {
  cookie: string;
  csrf: string;
}

interface ConcurrencyFixture {
  env: TestDatabase;
  db: LexiloopDatabase;
  app: ReturnType<typeof buildApp>;
  clock: { now: number };
  carol: { userId: string };
  carolAuth: Credentials;
  sessionId: string;
}

class FakeRateLimiter implements LoginRateLimiter {
  async limit(): Promise<{ success: boolean }> {
    return { success: true };
  }
}

async function createFixture(): Promise<ConcurrencyFixture> {
  const env = createMigratedTestDb();
  const db = createSqliteDatabase(env.sqlite);
  const clock = { now: T0 };
  const hashed = await hashPassword(PASSWORD);
  const carol = { userId: "user-carol" };
  await new UserRepository(db).create({
    userId: carol.userId,
    normalizedUsername: "carol",
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    status: "ACTIVE",
    createdAt: T0,
  });
  const releases = new ReleaseRepository(db);
  await releases.create({
    releaseId: RELEASE,
    sourcePdfSha256: "a".repeat(64),
    schemaVersion: "schema-v1",
    promptVersion: "prompt-v1",
    modelConfigJson: "{}",
    createdAt: T0,
    manifestSha256: "b".repeat(64),
    status: "READY",
  });
  await releases.setActive(RELEASE, T0);
  await db.insert(book).values({
    releaseId: RELEASE,
    bookKey: "bk-1",
    title: "New Horizon English 1",
    edition: "2nd",
    provenanceJson: "{}",
  });
  await db.insert(unit).values({
    releaseId: RELEASE,
    unitKey: "u-1",
    bookKey: "bk-1",
    level: 1,
    unitOrder: 1,
    title: "Unit 1",
    provenanceJson: "{}",
  });
  await db.insert(word).values({
    releaseId: RELEASE,
    wordKey: "w1",
    unitKey: "u-1",
    headword: "abandon",
    phonetic: null,
    tier: "CORE",
    sourceOrder: 1,
    provenanceJson: "{}",
  });
  await db.insert(cardDefinition).values([
    { releaseId: RELEASE, contentCardKey: "k-a", cardType: "WORD_MEANING", targetEntityKey: "t-a", wordKey: "w1", unitKey: "u-1", templateVersion: "tv-1", status: "ACTIVE" },
    { releaseId: RELEASE, contentCardKey: "k-b", cardType: "PHRASE", targetEntityKey: "t-b", wordKey: "w1", unitKey: "u-1", templateVersion: "tv-1", status: "ACTIVE" },
  ]);
  const deps: WorkerDeps = {
    db,
    loginRateLimiter: new FakeRateLimiter(),
    allowedOrigins: [ORIGIN],
    logWrite: () => {},
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
  const loginBody = (await login.json()) as { csrf_token: string };
  const carolAuth: Credentials = { cookie: cookie!.split(";")[0]!, csrf: loginBody.csrf_token };

  // One NEW_WORDS session over [k-a, k-b].
  const created = await app.request("/api/study/sessions", {
    method: "POST",
    headers: {
      cookie: carolAuth.cookie,
      origin: ORIGIN,
      "x-csrf-token": carolAuth.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({ mode: "NEW_WORDS" }),
  });
  expect(created.status).toBe(201);
  const session = (await created.json()) as { session_id: string };
  return { env, db, app, clock, carol, carolAuth, sessionId: session.session_id };
}

let fx: ConcurrencyFixture;

beforeEach(async () => {
  fx = await createFixture();
});

afterEach(() => {
  fx.env.cleanup();
});

interface GradeResponse {
  event_id: string;
  card_key: string;
  after_state: Record<string, unknown>;
  replayed: boolean;
}

async function postGrade(eventId: string, cardKey: string): Promise<{ status: number; body: GradeResponse }> {
  const res = await fx.app.request("/api/reviews/grade", {
    method: "POST",
    headers: {
      cookie: fx.carolAuth.cookie,
      origin: ORIGIN,
      "x-csrf-token": fx.carolAuth.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      event_id: eventId,
      session_id: fx.sessionId,
      card_key: cardKey,
      rating: 3,
      duration_ms: 1000,
    }),
  });
  return { status: res.status, body: (await res.json()) as GradeResponse };
}

async function postUndo(eventId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fx.app.request(`/api/reviews/${eventId}/undo`, {
    method: "POST",
    headers: {
      cookie: fx.carolAuth.cookie,
      origin: ORIGIN,
      "x-csrf-token": fx.carolAuth.csrf,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("duplicate grade races", () => {
  it("replays the prior result for a sequential duplicate without re-counting", async () => {
    const first = await postGrade("evt-same", "k-a");
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBe(false);
    const replay = await postGrade("evt-same", "k-a");
    expect(replay.status).toBe(200);
    // The original result verbatim, except the replay marker.
    expect(replay.body).toEqual({ ...first.body, replayed: true });

    const logs = fx.env.sqlite.prepare("SELECT COUNT(*) AS n FROM review_log").get() as { n: number };
    expect(logs.n).toBe(1);
    const state = fx.env.sqlite.prepare("SELECT reps, due FROM card_state").get() as { reps: number; due: number };
    expect(state.reps).toBe(1);
    expect(state.due).toBe(first.body.after_state.due_at);
    const session = fx.env.sqlite.prepare("SELECT position FROM study_session WHERE session_id = ?").get(fx.sessionId) as { position: number };
    expect(session.position).toBe(1);
  });

  it("collapses two simultaneous submissions of the same event into one row set", async () => {
    const [a, b] = await Promise.all([postGrade("evt-race", "k-a"), postGrade("evt-race", "k-a")]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Both responses describe the SAME single outcome.
    expect(b.body.after_state).toEqual(a.body.after_state);
    const logs = fx.env.sqlite.prepare("SELECT COUNT(*) AS n FROM review_log").get() as { n: number };
    expect(logs.n).toBe(1);
    const states = fx.env.sqlite.prepare("SELECT COUNT(*) AS n FROM card_state").get() as { n: number };
    expect(states.n).toBe(1);
    const session = fx.env.sqlite.prepare("SELECT position FROM study_session WHERE session_id = ?").get(fx.sessionId) as { position: number };
    expect(session.position).toBe(1);
  });

  it("keeps distinct event ids distinct (two grades, two rows, position 2)", async () => {
    const first = await postGrade("evt-one", "k-a");
    const second = await postGrade("evt-two", "k-b");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const logs = fx.env.sqlite.prepare("SELECT COUNT(*) AS n FROM review_log").get() as { n: number };
    expect(logs.n).toBe(2);
    const session = fx.env.sqlite.prepare("SELECT position FROM study_session WHERE session_id = ?").get(fx.sessionId) as { position: number };
    expect(session.position).toBe(2);
  });
});

describe("duplicate undo races", () => {
  it("applies an undo at most once under simultaneous submissions", async () => {
    const graded = await postGrade("evt-undo-me", "k-a");
    expect(graded.status).toBe(200);
    const [a, b] = await Promise.all([postUndo("evt-undo-me"), postUndo("evt-undo-me")]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]); // exactly one application
    const log = fx.env.sqlite.prepare("SELECT undone_at FROM review_log WHERE event_id = ?").get("evt-undo-me") as { undone_at: number | null };
    expect(log.undone_at).not.toBeNull();
    const states = fx.env.sqlite.prepare("SELECT COUNT(*) AS n FROM card_state").get() as { n: number };
    expect(states.n).toBe(0); // first grade undone -> card_state deleted once
    const session = fx.env.sqlite.prepare("SELECT position FROM study_session WHERE session_id = ?").get(fx.sessionId) as { position: number };
    expect(session.position).toBe(0); // rewound exactly once
  });
});

describe("atomic batch runner", () => {
  it("rolls back the whole statement list when one statement fails", async () => {
    const service = new StudyService(fx.db, () => fx.clock.now);
    const runner = service.atomic;
    expect(runner).toBeDefined();

    const insert = (eventId: string) =>
      sql`INSERT INTO review_log (event_id, user_id, session_id, content_card_key, presented_card_key, presented_release_id, rating, before_state, after_state, reviewed_at, duration_ms, undone_at)
          VALUES (${eventId}, ${fx.carol.userId}, NULL, 'k-a', 'k-a', ${RELEASE}, 3, NULL, '{}', ${T0}, NULL, NULL)`;

    let threw = false;
    try {
      // The second statement duplicates the first's primary key: the whole
      // unit must fail and roll back.
      await runner.run([insert("evt-atomic"), insert("evt-atomic"), insert("evt-atomic-tail")]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // The first insert must have rolled back with the failing duplicate.
    const logs = fx.env.sqlite
      .prepare("SELECT COUNT(*) AS n FROM review_log WHERE event_id LIKE 'evt-atomic%'")
      .get() as { n: number };
    expect(logs.n).toBe(0);
  });

  it("commits the whole statement list when every statement succeeds", async () => {
    const runner = createAtomicBatchRunner(fx.db);
    const insert = (eventId: string) =>
      sql`INSERT INTO review_log (event_id, user_id, session_id, content_card_key, presented_card_key, presented_release_id, rating, before_state, after_state, reviewed_at, duration_ms, undone_at)
          VALUES (${eventId}, ${fx.carol.userId}, NULL, 'k-a', 'k-a', ${RELEASE}, 3, NULL, '{}', ${T0}, NULL, NULL)`;
    await runner.run([insert("evt-ok-1"), insert("evt-ok-2")]);
    const logs = fx.env.sqlite
      .prepare("SELECT COUNT(*) AS n FROM review_log WHERE event_id LIKE 'evt-ok-%'")
      .get() as { n: number };
    expect(logs.n).toBe(2);
  });
});
