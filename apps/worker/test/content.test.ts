import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthSessionRepository,
  ReleaseRepository,
  StudySessionRepository,
  UserRepository,
  WordProgressRepository,
  createSqliteDatabase,
  type LexiloopDatabase,
} from "@lexiloop/db";
import {
  audioAsset,
  book,
  contentAudioLink,
  example,
  explanation,
  lexicalRelation,
  phrase,
  releaseUnit,
  sense,
  unit,
  word,
} from "@lexiloop/db";
import { createMigratedTestDb, type TestDatabase } from "../../../packages/db/test/helpers";
import { buildApp, type LoginRateLimiter, type WorkerDeps } from "../src/app";
import { hashPassword } from "../src/auth/password";
import { SESSION_COOKIE, sha256Hex } from "../src/auth/session";

/**
 * Task 12 acceptance tests (spec 8.2/9.5/10, plan step 3): release-scoped
 * content reads, deterministic dictionary search, user-scoped progress, and
 * the content/personal cache-policy split. The app runs against the
 * established better-sqlite3 temp database (packages/db test pattern); the
 * FTS5 index fills itself through the migration triggers.
 */

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const ORIGIN = "https://lexiloop.example";
const PASSWORD = "correct horse battery staple";

const ACTIVE_RELEASE = "rel-active-1";
const READY_RELEASE = "rel-ready-2";
const RETIRED_RELEASE = "rel-retired-3";

/** Minimal WAV-ish bytes; audio assets reference their SHA-256. */
const AUDIO_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45, 0x66, 0x6d, 0x74, 0x20,
]);

function sha256HexOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class FakeRateLimiter implements LoginRateLimiter {
  constructor(private readonly success = true) {}
  async limit(): Promise<{ success: boolean }> {
    return { success: this.success };
  }
}

interface ContentFixture {
  env: TestDatabase;
  db: LexiloopDatabase;
  logs: string[];
  deps: WorkerDeps;
  app: ReturnType<typeof buildApp>;
  clock: { now: number };
  alice: { userId: string };
  bob: { userId: string };
  aliceCookie: string;
  bobCookie: string;
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

async function loginAs(app: ContentFixture["app"], username: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")?.split(",").find((part) => part.trim().startsWith(SESSION_COOKIE));
  expect(cookie).toBeDefined();
  return cookie!.split(";")[0]!;
}

/**
 * Seeds three releases exactly as activation leaves them: rel-retired-3
 * RETIRED (retained for pinned sessions), rel-active-1 ACTIVE (the app_meta
 * pointer), rel-ready-2 READY (never activated).
 */
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
  await releases.create({ releaseId: RETIRED_RELEASE, ...base, status: "READY" });
  await releases.create({ releaseId: ACTIVE_RELEASE, ...base, status: "READY" });
  await releases.create({ releaseId: READY_RELEASE, ...base, status: "READY" });
  await releases.setActive(RETIRED_RELEASE, T0);
  await releases.setActive(ACTIVE_RELEASE, T0 + 1);
}

/** Textbook content for the ACTIVE release; FTS rows follow via triggers. */
async function seedActiveContent(db: LexiloopDatabase): Promise<void> {
  await db.insert(book).values({
    releaseId: ACTIVE_RELEASE,
    bookKey: "bk-english-1",
    title: "New Horizon English 1",
    edition: "2nd",
    provenanceJson: "{}",
  });
  await db.insert(unit).values([
    { releaseId: ACTIVE_RELEASE, unitKey: "u-1", bookKey: "bk-english-1", level: 1, unitOrder: 1, title: "Unit 1 School Life", provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, unitKey: "u-2", bookKey: "bk-english-1", level: 1, unitOrder: 2, title: "Unit 2 Daily Talk", provenanceJson: "{}" },
  ]);
  await db.insert(word).values([
    { releaseId: ACTIVE_RELEASE, wordKey: "w-abandon", unitKey: "u-1", headword: "abandon", phonetic: "/əˈbændən/", tier: "CORE", sourceOrder: 1, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, wordKey: "w-abandoned", unitKey: "u-1", headword: "abandoned", phonetic: null, tier: "CORE", sourceOrder: 2, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, wordKey: "w-ability", unitKey: "u-1", headword: "ability", phonetic: "/əˈbɪləti/", tier: "CORE", sourceOrder: 3, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, wordKey: "w-aboard", unitKey: "u-2", headword: "aboard", phonetic: null, tier: "EXT", sourceOrder: 1, provenanceJson: "{}" },
  ]);
  await db.insert(sense).values([
    { releaseId: ACTIVE_RELEASE, senseKey: "s-abandon-1", wordKey: "w-abandon", pos: "verb", gloss: "放弃；抛弃", senseOrder: 1, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, senseKey: "s-abandon-2", wordKey: "w-abandon", pos: "noun", gloss: "放纵", senseOrder: 2, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, senseKey: "s-ability-1", wordKey: "w-ability", pos: "noun", gloss: "能力", senseOrder: 1, provenanceJson: "{}" },
  ]);
  await db.insert(phrase).values([
    { releaseId: ACTIVE_RELEASE, phraseKey: "p-abandon-1", wordKey: "w-abandon", senseKey: "s-abandon-1", text: "abandon the plan", gloss: "放弃计划", sourceOrder: 1, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, phraseKey: "p-abandon-2", wordKey: "w-abandon", senseKey: null, text: "give up smoking", gloss: "戒烟", sourceOrder: 2, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, phraseKey: "p-ability-1", wordKey: "w-ability", senseKey: null, text: "to the best of one's ability", gloss: "尽力而为", sourceOrder: 1, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, phraseKey: "p-ability-2", wordKey: "w-ability", senseKey: null, text: "abandon ship", gloss: "弃船", sourceOrder: 2, provenanceJson: "{}" },
  ]);
  await db.insert(example).values([
    { releaseId: ACTIVE_RELEASE, exampleKey: "e-abandon-1", wordKey: "w-abandon", senseKey: "s-abandon-1", phraseKey: "p-abandon-1", origin: "exam", sourceRef: "2023 全国甲卷", text: "She abandoned the plan at the last minute.", targetStart: 4, targetEnd: 12, sourceOrder: 1, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, exampleKey: "e-ability-1", wordKey: "w-ability", senseKey: null, phraseKey: null, origin: "textbook", sourceRef: null, text: "He has the ability to solve hard problems.", targetStart: 7, targetEnd: 13, sourceOrder: 1, provenanceJson: "{}" },
    { releaseId: ACTIVE_RELEASE, exampleKey: "e-aboard-1", wordKey: "w-aboard", senseKey: null, phraseKey: null, origin: "exam", sourceRef: "2022 新高考", text: "They abandoned the ship in a storm.", targetStart: 5, targetEnd: 14, sourceOrder: 1, provenanceJson: "{}" },
  ]);
  await db.insert(explanation).values({
    releaseId: ACTIVE_RELEASE,
    explanationKey: "x-abandon-1",
    wordKey: "w-abandon",
    unitKey: "u-1",
    generatedJson: JSON.stringify({
      explanation_key: "x-abandon-1",
      word_key: "w-abandon",
      unit_key: "u-1",
      syntax_notes: ["abandon + noun"],
      translation_hints: "放弃做某事",
      pitfalls: ["作名词时常与 with 连用"],
      context_meanings: [{ example_key: "e-abandon-1", gloss: "放弃" }],
      discrimination_candidates: [{ against_word_key: "w-abandoned", note: "形容词形式" }],
      input_hash: "c".repeat(64),
      prompt_version: "prompt-v1",
      model_id: "model-x",
      agent_run_id: "run-1",
      generated_at: "2026-01-01T00:00:00Z",
    }),
  });
  await db.insert(lexicalRelation).values({
    releaseId: ACTIVE_RELEASE,
    relationKey: "r-abandon-1",
    fromWordKey: "w-abandon",
    toWordKey: "w-abandoned",
    relationType: "derivative",
    provenanceJson: "{}",
  });
  await db.insert(releaseUnit).values([
    { releaseId: ACTIVE_RELEASE, unitKey: "u-1", status: "PASSED", words: 3, senses: 3, phrases: 4, examples: 2, explanations: 1, cards: 9, qaSummary: null },
    { releaseId: ACTIVE_RELEASE, unitKey: "u-2", status: "PASSED", words: 1, senses: 0, phrases: 0, examples: 1, explanations: 0, cards: 3, qaSummary: null },
  ]);
}

function audioBytesSha(): string {
  return sha256HexOf(AUDIO_BYTES);
}

/** Audio metadata for the ACTIVE release; objects live in the test R2 fake. */
async function seedActiveAudio(db: LexiloopDatabase): Promise<void> {
  await db.insert(audioAsset).values({
    releaseId: ACTIVE_RELEASE,
    assetKey: "audio/ab/abandon-1.wav",
    contentSha256: audioBytesSha(),
    textHash: "d".repeat(64),
    provider: "mimo",
    modelId: "mimo-audio",
    voice: "lexi",
    synthesisConfigVersion: "tts-v1",
    formatContainer: "wav",
    sampleRateHz: 24000,
    channels: 1,
    encoding: "pcm_s16le",
    durationMs: 640,
    validation: "PASSED",
  });
  await db.insert(contentAudioLink).values([
    { releaseId: ACTIVE_RELEASE, entityType: "word", entityKey: "w-abandon", assetKey: "audio/ab/abandon-1.wav" },
    { releaseId: ACTIVE_RELEASE, entityType: "example", entityKey: "e-abandon-1", assetKey: "audio/ab/abandon-1.wav" },
  ]);
}

/** Minimal content in the RETAINED release so pinned reads differ visibly. */
async function seedRetainedContent(db: LexiloopDatabase): Promise<void> {
  await db.insert(book).values({
    releaseId: RETIRED_RELEASE,
    bookKey: "bk-english-1",
    title: "New Horizon English 1",
    edition: "1st",
    provenanceJson: "{}",
  });
  await db.insert(unit).values({
    releaseId: RETIRED_RELEASE,
    unitKey: "u-1",
    bookKey: "bk-english-1",
    level: 1,
    unitOrder: 1,
    title: "Unit 1 School Life (old)",
    provenanceJson: "{}",
  });
  await db.insert(word).values({
    releaseId: RETIRED_RELEASE,
    wordKey: "w-r-abandon",
    unitKey: "u-1",
    headword: "abandon",
    phonetic: "/əˈbændən/",
    tier: "CORE",
    sourceOrder: 1,
    provenanceJson: "{}",
  });
  await db.insert(sense).values({
    releaseId: RETIRED_RELEASE,
    senseKey: "s-r-abandon-1",
    wordKey: "w-r-abandon",
    pos: "verb",
    gloss: "舍弃",
    senseOrder: 1,
    provenanceJson: "{}",
  });
  await db.insert(audioAsset).values({
    releaseId: RETIRED_RELEASE,
    assetKey: "audio/rr/retired-abandon.wav",
    contentSha256: "e".repeat(64),
    textHash: "f".repeat(64),
    provider: "mimo",
    modelId: "mimo-audio",
    voice: "lexi",
    synthesisConfigVersion: "tts-v1",
    formatContainer: "wav",
    sampleRateHz: 24000,
    channels: 1,
    encoding: "pcm_s16le",
    durationMs: 500,
    validation: "PASSED",
  });
}

async function seedReadyAudioOnly(db: LexiloopDatabase): Promise<void> {
  await db.insert(audioAsset).values({
    releaseId: READY_RELEASE,
    assetKey: "audio/nn/never-activated.wav",
    contentSha256: "1".repeat(64),
    textHash: "2".repeat(64),
    provider: "mimo",
    modelId: "mimo-audio",
    voice: "lexi",
    synthesisConfigVersion: "tts-v1",
    formatContainer: "wav",
    sampleRateHz: 24000,
    channels: 1,
    encoding: "pcm_s16le",
    durationMs: 300,
    validation: "PASSED",
  });
}

async function seedSessions(db: LexiloopDatabase, alice: { userId: string }, bob: { userId: string }): Promise<void> {
  const queue = (releaseId: string) => ({
    version: 1 as const,
    release_id: releaseId,
    cards: [{ canonical_card_key: "card-1", presented_card_key: "card-1" }],
  });
  // Alice's live session pins the RETAINED release (spec 6.4).
  await new StudySessionRepository(db).create({ userId: alice.userId }, {
    sessionId: "sess-alice-live",
    mode: "NEW_WORDS",
    releaseId: RETIRED_RELEASE,
    queueSnapshot: queue(RETIRED_RELEASE),
    createdAt: T0,
    expiresAt: T0 + HOUR,
  });
  // Alice's expired session: created two hours ago, expired an hour ago.
  await new StudySessionRepository(db).create({ userId: alice.userId }, {
    sessionId: "sess-alice-expired",
    mode: "NEW_WORDS",
    releaseId: RETIRED_RELEASE,
    queueSnapshot: queue(RETIRED_RELEASE),
    createdAt: T0 - 2 * HOUR,
    expiresAt: T0 - HOUR,
  });
  // Bob's session: never visible to Alice.
  await new StudySessionRepository(db).create({ userId: bob.userId }, {
    sessionId: "sess-bob-live",
    mode: "NEW_WORDS",
    releaseId: RETIRED_RELEASE,
    queueSnapshot: queue(RETIRED_RELEASE),
    createdAt: T0,
    expiresAt: T0 + HOUR,
  });
}

async function createFixture(options: { seedReleases: boolean } = { seedReleases: true }): Promise<ContentFixture> {
  const env = createMigratedTestDb();
  const db = createSqliteDatabase(env.sqlite);
  const logs: string[] = [];
  const clock = { now: T0 };
  const alice = await seedUser(db, "alice");
  const bob = await seedUser(db, "bob");
  if (options.seedReleases) {
    await seedReleases(db);
    await seedActiveContent(db);
    await seedActiveAudio(db);
    await seedRetainedContent(db);
    await seedReadyAudioOnly(db);
    await seedSessions(db, alice, bob);
  }
  const deps: WorkerDeps = {
    db,
    loginRateLimiter: new FakeRateLimiter(),
    allowedOrigins: [ORIGIN],
    logWrite: (line: string) => logs.push(line),
    now: () => clock.now,
  };
  const app = buildApp(deps);
  const aliceCookie = await loginAs(app, "alice");
  const bobCookie = await loginAs(app, "bob");
  return { env, db, logs, deps, app, clock, alice, bob, aliceCookie, bobCookie };
}

let fx: ContentFixture;

beforeEach(async () => {
  fx = await createFixture();
});

afterEach(() => {
  fx.env.cleanup();
});

/** Every /api/content/* response must carry shared textbook data only. */
const PERSONAL_FIELD_PATTERN =
  /familiarity|user_id|first_seen_at|last_seen_at|introduced_|"due"|"stage"|"reps"|"lapses"/;

function expectNoPersonalFields(body: unknown): void {
  expect(JSON.stringify(body)).not.toMatch(PERSONAL_FIELD_PATTERN);
}

describe("GET /api/content/bootstrap", () => {
  it("requires authentication", async () => {
    const res = await fx.app.request("/api/content/bootstrap");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });

  it("returns the active release, book, units, and client content config", async () => {
    const res = await fx.app.request("/api/content/bootstrap", { headers: { cookie: fx.aliceCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const body = (await res.json()) as {
      release_id: string;
      config_version: number;
      release: { status: string; activated_at: number | null };
      books: Array<{ book_key: string; title: string; edition: string }>;
      units: Array<{ unit_key: string; book_key: string; level: number; unit_order: number; title: string }>;
    };
    expect(body.release_id).toBe(ACTIVE_RELEASE);
    expect(body.release.status).toBe("ACTIVE");
    expect(body.release.activated_at).toBe(T0 + 1);
    const storedMeta = fx.env.sqlite.prepare("SELECT config_version FROM app_meta WHERE id = 1").get() as {
      config_version: number;
    };
    expect(body.config_version).toBe(storedMeta.config_version);
    expect(body.books).toEqual([
      { book_key: "bk-english-1", title: "New Horizon English 1", edition: "2nd" },
    ]);
    expect(body.units.map((entry) => entry.unit_key)).toEqual(["u-1", "u-2"]);
    expect(body.units[0]).toMatchObject({ book_key: "bk-english-1", level: 1, unit_order: 1, title: "Unit 1 School Life" });
    expectNoPersonalFields(body);
  });

  it("answers 404 with a stable code when no release is active", async () => {
    fx.env.sqlite.prepare("UPDATE app_meta SET active_release_id = NULL WHERE id = 1").run();
    const res = await fx.app.request("/api/content/bootstrap", { headers: { cookie: fx.aliceCookie } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("CONTENT_NO_ACTIVE_RELEASE");
  });

  it("serves the pinned release through a valid study session", async () => {
    const res = await fx.app.request("/api/content/bootstrap?session=sess-alice-live", {
      headers: { cookie: fx.aliceCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { release_id: string; books: Array<{ edition: string }> };
    expect(body.release_id).toBe(RETIRED_RELEASE);
    expect(body.books[0]?.edition).toBe("1st");
  });

  it("rejects an unknown, expired, or foreign study session", async () => {
    for (const sessionId of ["sess-does-not-exist", "sess-alice-expired", "sess-bob-live"]) {
      const res = await fx.app.request(`/api/content/bootstrap?session=${sessionId}`, {
        headers: { cookie: fx.aliceCookie },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("CONTENT_SESSION_INVALID");
    }
  });
});

describe("GET /api/content/units/:unitKey", () => {
  it("returns the unit structure, summary counts, and tier-ordered words", async () => {
    const res = await fx.app.request("/api/content/units/u-1", { headers: { cookie: fx.aliceCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const body = (await res.json()) as {
      unit: { unit_key: string; book_key: string; level: number; unit_order: number; title: string };
      summary: { status: string; words: number; senses: number; phrases: number; examples: number } | null;
      words: Array<{ word_key: string; headword: string; phonetic: string | null; tier: string; source_order: number }>;
    };
    expect(body.unit).toMatchObject({ unit_key: "u-1", book_key: "bk-english-1", level: 1, unit_order: 1, title: "Unit 1 School Life" });
    expect(body.summary).toMatchObject({ status: "PASSED", words: 3, senses: 3, phrases: 4, examples: 2 });
    expect(body.words.map((entry) => entry.word_key)).toEqual(["w-abandon", "w-abandoned", "w-ability"]);
    expect(body.words[0]).toMatchObject({ headword: "abandon", phonetic: "/əˈbændən/", tier: "CORE", source_order: 1 });
    expectNoPersonalFields(body);
  });

  it("answers 404 for an unknown unit and for a unit of another release", async () => {
    const missing = await fx.app.request("/api/content/units/u-404", { headers: { cookie: fx.aliceCookie } });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("CONTENT_UNIT_NOT_FOUND");

    const foreign = await fx.app.request("/api/content/units/u-foreign", { headers: { cookie: fx.aliceCookie } });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { code: string }).code).toBe("CONTENT_UNIT_NOT_FOUND");
  });
});

describe("GET /api/content/words/:wordKey", () => {
  it("returns the full entry: senses, phrases, examples, explanation, related words, and audio", async () => {
    const res = await fx.app.request("/api/content/words/w-abandon", { headers: { cookie: fx.aliceCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    const body = (await res.json()) as {
      word: { word_key: string; unit_key: string; headword: string; phonetic: string | null; tier: string; source_order: number };
      unit: { unit_key: string; title: string } | null;
      senses: Array<{ sense_key: string; pos: string; gloss: string; sense_order: number }>;
      phrases: Array<{ phrase_key: string; sense_key: string | null; text: string; gloss: string; source_order: number }>;
      examples: Array<{ example_key: string; origin: string; source_ref: string | null; text: string; target_start: number; target_end: number; source_order: number }>;
      explanations: Array<{ explanation_key: string; syntax_notes: string[]; translation_hints: string; pitfalls: string[]; context_meanings: Array<{ example_key: string; gloss: string }>; discrimination_candidates: Array<{ against_word_key: string; note: string }> }>;
      related: Array<{ to_word_key: string; relation_type: string }>;
      audio: Array<{ entity_type: string; entity_key: string; asset_key: string }>;
    };
    expect(body.word).toMatchObject({ word_key: "w-abandon", unit_key: "u-1", headword: "abandon", tier: "CORE", source_order: 1 });
    expect(body.unit).toMatchObject({ unit_key: "u-1", title: "Unit 1 School Life" });
    expect(body.senses.map((senseRow) => senseRow.gloss)).toEqual(["放弃；抛弃", "放纵"]);
    expect(body.senses[0]).toMatchObject({ sense_key: "s-abandon-1", pos: "verb", sense_order: 1 });
    expect(body.phrases.map((phraseRow) => phraseRow.text)).toEqual(["abandon the plan", "give up smoking"]);
    expect(body.phrases[0]).toMatchObject({ phrase_key: "p-abandon-1", sense_key: "s-abandon-1", gloss: "放弃计划" });
    expect(body.examples).toHaveLength(1);
    expect(body.examples[0]).toMatchObject({
      example_key: "e-abandon-1",
      origin: "exam",
      source_ref: "2023 全国甲卷",
      text: "She abandoned the plan at the last minute.",
      target_start: 4,
      target_end: 12,
    });
    expect(body.explanations).toHaveLength(1);
    expect(body.explanations[0]).toMatchObject({
      explanation_key: "x-abandon-1",
      syntax_notes: ["abandon + noun"],
      translation_hints: "放弃做某事",
      pitfalls: ["作名词时常与 with 连用"],
    });
    expect(body.explanations[0]?.context_meanings).toEqual([{ example_key: "e-abandon-1", gloss: "放弃" }]);
    // Compilation provenance never leaks into the client payload.
    expect(JSON.stringify(body)).not.toContain("agent_run_id");
    expect(body.related).toEqual([{ to_word_key: "w-abandoned", relation_type: "derivative" }]);
    expect(body.audio).toEqual([
      { entity_type: "example", entity_key: "e-abandon-1", asset_key: "audio/ab/abandon-1.wav" },
      { entity_type: "word", entity_key: "w-abandon", asset_key: "audio/ab/abandon-1.wav" },
    ]);
    expectNoPersonalFields(body);
  });

  it("answers 404 for an unknown word and for a word that only exists in another release", async () => {
    const missing = await fx.app.request("/api/content/words/w-404", { headers: { cookie: fx.aliceCookie } });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("CONTENT_WORD_NOT_FOUND");

    // w-r-abandon belongs to the RETAINED release, not the active one.
    const foreign = await fx.app.request("/api/content/words/w-r-abandon", { headers: { cookie: fx.aliceCookie } });
    expect(foreign.status).toBe(404);
    expect(((await foreign.json()) as { code: string }).code).toBe("CONTENT_WORD_NOT_FOUND");
  });

  it("serves the pinned release entry through a valid study session", async () => {
    const res = await fx.app.request("/api/content/words/w-r-abandon?session=sess-alice-live", {
      headers: { cookie: fx.aliceCookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      word: { word_key: string };
      senses: Array<{ gloss: string }>;
      unit: { title: string } | null;
    };
    expect(body.word.word_key).toBe("w-r-abandon");
    expect(body.senses[0]?.gloss).toBe("舍弃");
    expect(body.unit?.title).toBe("Unit 1 School Life (old)");
  });
});

describe("GET /api/content/search", () => {
  interface SearchResponse {
    query: string;
    release_id: string;
    hits: Array<{ word_key: string; headword: string; phonetic: string | null; tier: string; unit_key: string; matched_field: string; matched_text: string }>;
  }

  async function search(query: string, extra = ""): Promise<{ res: Response; body: SearchResponse }> {
    const res = await fx.app.request(`/api/content/search?q=${encodeURIComponent(query)}${extra}`, {
      headers: { cookie: fx.aliceCookie },
    });
    return { res, body: (await res.json()) as SearchResponse };
  }

  it("requires authentication", async () => {
    const res = await fx.app.request("/api/content/search?q=abandon");
    expect(res.status).toBe(401);
  });

  it("ranks an exact headword above prefix and FTS matches", async () => {
    const { res, body } = await search("abandon");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(body.release_id).toBe(ACTIVE_RELEASE);
    const fields = body.hits.map((hit) => hit.matched_field);
    expect(body.hits[0]).toMatchObject({ word_key: "w-abandon", matched_field: "headword_exact", headword: "abandon", phonetic: "/əˈbændən/", tier: "CORE", unit_key: "u-1", matched_text: "abandon" });
    // Every headword hit outranks every FTS hit; exact outranks prefix.
    const firstFtsField = fields.findIndex((field) => field !== "headword_exact" && field !== "headword_prefix");
    const lastHeadwordField = Math.max(fields.lastIndexOf("headword_exact"), fields.lastIndexOf("headword_prefix"));
    expect(lastHeadwordField).toBeLessThan(firstFtsField);
    expect(fields.indexOf("headword_exact")).toBeLessThan(fields.indexOf("headword_prefix"));
  });

  it("orders prefix matches deterministically by unit order then source order", async () => {
    const { body } = await search("ab");
    expect(body.hits.map((hit) => hit.word_key)).toEqual(["w-abandon", "w-abandoned", "w-ability", "w-aboard"]);
    expect(body.hits.every((hit) => hit.matched_field === "headword_prefix")).toBe(true);
  });

  it("finds Chinese sense glosses through the FTS index", async () => {
    const { body } = await search("放弃");
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({
      word_key: "w-abandon",
      matched_field: "sense_gloss",
      matched_text: "放弃；抛弃",
    });
  });

  it("finds phrases and ranks them below gloss matches", async () => {
    const { body } = await search("give up");
    expect(body.hits.map((hit) => [hit.word_key, hit.matched_field, hit.matched_text])).toEqual([
      ["w-abandon", "phrase", "give up smoking"],
    ]);
  });

  it("finds example sentences full-text", async () => {
    const { body } = await search("last minute");
    expect(body.hits).toEqual([
      expect.objectContaining({ word_key: "w-abandon", matched_field: "example", matched_text: "She abandoned the plan at the last minute." }),
    ]);
  });

  it("applies the spec 9.5 priority across fields for one query", async () => {
    // "abandon" hits: exact headword (w-abandon), prefix headword (w-abandoned),
    // phrase "abandon ship" (w-ability), example "They abandoned..." (w-aboard).
    const { body } = await search("abandon");
    expect(body.hits.map((hit) => [hit.word_key, hit.matched_field])).toEqual([
      ["w-abandon", "headword_exact"],
      ["w-abandoned", "headword_prefix"],
      ["w-ability", "phrase"],
      ["w-aboard", "example"],
    ]);
  });

  it("keeps the best field per word and returns identical order on repeats", async () => {
    const first = await search("abandon the plan");
    const second = await search("abandon the plan");
    expect(first.body.hits.length).toBeGreaterThan(0);
    expect(first.body.hits[0]?.word_key).toBe("w-abandon");
    expect(first.body.hits.map((hit) => hit.word_key)).toEqual(second.body.hits.map((hit) => hit.word_key));
  });

  it("honours the limit parameter", async () => {
    const { body } = await search("ab", "&limit=2");
    expect(body.hits.map((hit) => hit.word_key)).toEqual(["w-abandon", "w-abandoned"]);
  });

  it("is release-scoped: the active release hides retained-only words", async () => {
    const { body } = await search("abandon");
    expect(body.hits.map((hit) => hit.word_key)).not.toContain("w-r-abandon");
  });

  it("searches the pinned release through a valid study session", async () => {
    const { body } = await search("abandon", "&session=sess-alice-live");
    expect(body.release_id).toBe(RETIRED_RELEASE);
    expect(body.hits[0]).toMatchObject({ word_key: "w-r-abandon", matched_field: "headword_exact" });
  });

  it("rejects an invalid study session and an empty query", async () => {
    const badSession = await fx.app.request("/api/content/search?q=abandon&session=sess-alice-expired", {
      headers: { cookie: fx.aliceCookie },
    });
    expect(badSession.status).toBe(400);
    expect(((await badSession.json()) as { code: string }).code).toBe("CONTENT_SESSION_INVALID");

    const emptyQuery = await fx.app.request("/api/content/search?q=", { headers: { cookie: fx.aliceCookie } });
    expect(emptyQuery.status).toBe(400);
    expect(((await emptyQuery.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
  });

  it("never includes personal fields in search responses", async () => {
    const { res, body } = await search("abandon");
    expect(res.status).toBe(200);
    expect(body.hits.length).toBeGreaterThan(0);
    expectNoPersonalFields(body);
  });
});

describe("search query plans (EXPLAIN QUERY PLAN)", () => {
  it("runs the FTS search through the FTS5 index, not a plain scan", async () => {
    const search = await import("../src/content/search");
    const match = search.buildFtsMatchExpression("放弃");
    expect(match).not.toBeNull();
    const query = search.ftsSearchQuery(fx.db, ACTIVE_RELEASE, match!, 200);
    const { sql: text, params } = query.toSQL();
    const plan = fx.env.sqlite.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...params) as Array<{ detail: string }>;
    expect(plan.some((row) => /SCAN content_search_fts VIRTUAL TABLE INDEX/.test(row.detail))).toBe(true);
  });

  it("scopes exact and prefix headword lookups by the release key prefix", async () => {
    const search = await import("../src/content/search");
    const exact = search.exactHeadwordQuery(fx.db, ACTIVE_RELEASE, "abandon").toSQL();
    const exactPlan = fx.env.sqlite.prepare(`EXPLAIN QUERY PLAN ${exact.sql}`).all(...exact.params) as Array<{ detail: string }>;
    expect(exactPlan.some((row) => /SEARCH word USING .*INDEX .*\(release_id=\?\)/.test(row.detail))).toBe(true);

    const prefix = search.prefixHeadwordQuery(fx.db, ACTIVE_RELEASE, "ab", 50).toSQL();
    const prefixPlan = fx.env.sqlite.prepare(`EXPLAIN QUERY PLAN ${prefix.sql}`).all(...prefix.params) as Array<{ detail: string }>;
    expect(prefixPlan.some((row) => /SEARCH word USING .*INDEX .*\((release_id=\? AND unit_key=?|release_id=\?)\)/.test(row.detail))).toBe(true);
  });

  it("resolves FTS sense hits through the sense primary key", async () => {
    const search = await import("../src/content/search");
    const query = search.senseRowsQuery(fx.db, ACTIVE_RELEASE, ["s-abandon-1", "s-abandon-2"]).toSQL();
    const plan = fx.env.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>;
    expect(plan.some((row) => /SEARCH sense USING .*INDEX .*\(?release_id=\? AND sense_key=\?/.test(row.detail))).toBe(true);
  });

  it("lists unit words through the spec 6.3 teaching-order index", async () => {
    const service = await import("../src/content/service");
    const query = service.unitWordsQuery(fx.db, ACTIVE_RELEASE, "u-1").toSQL();
    const plan = fx.env.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.params) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes("word_release_unit_tier_order_idx"))).toBe(true);
  });
});

describe("GET /api/progress/words/:wordKey", () => {
  it("requires authentication", async () => {
    const res = await fx.app.request("/api/progress/words/w-abandon");
    expect(res.status).toBe(401);
  });

  it("returns only the caller's personal progress with private no-store caching", async () => {
    await new WordProgressRepository(fx.db).upsert({ userId: fx.alice.userId }, {
      wordKey: "w-abandon",
      stage: "IN_PROGRESS",
      initialFamiliarity: "UNKNOWN",
      firstSeenAt: T0,
      lastSeenAt: T0 + 5 * 60 * 1000,
    });
    const res = await fx.app.request("/api/progress/words/w-abandon", { headers: { cookie: fx.aliceCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as {
      word_key: string;
      progress: {
        stage: string;
        initial_familiarity: string;
        first_seen_at: number;
        introduced_release_id: string | null;
        introduced_at: number | null;
        last_seen_at: number;
      } | null;
    };
    expect(body.word_key).toBe("w-abandon");
    expect(body.progress).toMatchObject({
      stage: "IN_PROGRESS",
      initial_familiarity: "UNKNOWN",
      first_seen_at: T0,
      introduced_release_id: null,
      introduced_at: null,
      last_seen_at: T0 + 5 * 60 * 1000,
    });
  });

  it("returns null progress for an unstudied word", async () => {
    const res = await fx.app.request("/api/progress/words/w-never-studied", { headers: { cookie: fx.aliceCookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = (await res.json()) as { word_key: string; progress: unknown };
    expect(body.progress).toBeNull();
  });

  it("never returns another user's progress", async () => {
    await new WordProgressRepository(fx.db).upsert({ userId: fx.bob.userId }, {
      wordKey: "w-abandon",
      stage: "INTRODUCED",
      initialFamiliarity: "KNOWN",
      firstSeenAt: T0,
      lastSeenAt: T0,
      introducedReleaseId: ACTIVE_RELEASE,
      introducedAt: T0,
    });
    const res = await fx.app.request("/api/progress/words/w-abandon", { headers: { cookie: fx.aliceCookie } });
    const body = (await res.json()) as { progress: unknown };
    expect(body.progress).toBeNull();
  });

  it("keeps personal data out of the shared content endpoints", async () => {
    await new WordProgressRepository(fx.db).upsert({ userId: fx.alice.userId }, {
      wordKey: "w-abandon",
      stage: "IN_PROGRESS",
      initialFamiliarity: "RECOGNIZABLE",
      firstSeenAt: T0,
      lastSeenAt: T0,
    });
    for (const path of ["/api/content/bootstrap", "/api/content/units/u-1", "/api/content/words/w-abandon", "/api/content/search?q=abandon"]) {
      const res = await fx.app.request(path, { headers: { cookie: fx.aliceCookie } });
      expect(res.status).toBe(200);
      const text = JSON.stringify(await res.json());
      expect(text).not.toMatch(PERSONAL_FIELD_PATTERN);
    }
  });
});

describe("production entry point (src/index.ts)", () => {
  it("wires the real bindings and reports per-request D1 usage in the logs", async () => {
    const worker = await import("../src/index");
    // The production path runs on the real clock, so this test issues a
    // dedicated long-lived session instead of reusing the fixture logins.
    const entryToken = "entry-point-test-token-0123456789abcdef";
    await new AuthSessionRepository(fx.db).create(
      { userId: fx.alice.userId },
      {
        sessionId: "sess-entry-point",
        tokenHash: await sha256Hex(entryToken),
        issuedAt: T0,
        expiresAt: T0 + 10 * 365 * 24 * HOUR,
        sessionVersion: 1,
      },
    );
    const sessionRow = fx.env.sqlite
      .prepare("SELECT * FROM auth_session WHERE session_id = 'sess-entry-point'")
      .get() as Record<string, unknown>;
    const userRow = fx.env.sqlite.prepare("SELECT * FROM app_user WHERE user_id = ?").get(fx.alice.userId) as Record<string, unknown>;
    const releaseRow = fx.env.sqlite.prepare("SELECT * FROM content_release WHERE release_id = ?").get(ACTIVE_RELEASE) as Record<string, unknown>;
    const bookRow = fx.env.sqlite.prepare("SELECT * FROM book").all() as Record<string, unknown>[];
    const unitRows = fx.env.sqlite.prepare("SELECT * FROM unit").all() as Record<string, unknown>[];
    const statementsRun: string[] = [];
    const handlerFor = (query: string): Record<string, unknown>[] => {
      if (query.includes("auth_session")) return [sessionRow];
      if (query.includes("app_user")) return [userRow];
      if (query.includes("app_meta")) return [{ id: 1, active_release_id: ACTIVE_RELEASE, config_version: 1 }];
      if (query.includes("content_release")) return [releaseRow];
      if (query.includes("book")) return bookRow;
      if (query.includes('"unit"')) return unitRows;
      throw new Error(`unexpected statement: ${query}`);
    };
    const fakeD1 = {
      prepare: (query: string) => {
        statementsRun.push(query);
        const statement = {
          bind: () => statement,
          all: async () => ({ results: handlerFor(query), meta: { rows_read: 2, rows_written: 0 } }),
          // drizzle's D1 driver maps selected rows through the raw() path
          // (array rows in column order), so both shapes are served here.
          raw: async () => handlerFor(query).map((row) => Object.values(row)),
          run: async () => ({ results: [], meta: { rows_read: 0, rows_written: 1 } }),
          first: async () => handlerFor(query)[0] ?? null,
        };
        return statement;
      },
      batch: async (items: unknown[]) => items.map(() => ({ results: [], meta: { rows_read: 0, rows_written: 0 } })),
    } as unknown as D1Database;
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => {
      logs.push(String(line));
    };
    try {
      const response = await worker.default.fetch(
        new Request("https://lexiloop.example/api/content/bootstrap", {
          headers: { cookie: `${SESSION_COOKIE}=${entryToken}`, "x-request-id": "entry-point-req-1" },
        }),
        {
          DB: fakeD1,
          AUDIO: { get: async () => null, head: async () => null } as unknown as R2Bucket,
          LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
          WORKER_RELEASE_ID: "worker-rel-9",
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("entry-point-req-1");
      const body = (await response.json()) as { release_id: string };
      expect(body.release_id).toBe(ACTIVE_RELEASE);

      expect(logs).toHaveLength(1);
      const entry = JSON.parse(logs[0]!) as Record<string, unknown>;
      expect(entry["request_id"]).toBe("entry-point-req-1");
      expect(entry["release_id"]).toBe("worker-rel-9");
      // D1 usage flowed from the instrumented binding into the request log.
      expect((entry["d1_rows_read"] as number)).toBeGreaterThan(0);
      expect(entry["r2_operations"]).toBe(0);
      expect(statementsRun.length).toBeGreaterThan(0);
    } finally {
      console.log = original;
    }
  });
});
