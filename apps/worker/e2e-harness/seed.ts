/**
 * Harness database seeding (plan Task 18 steps 1/3): applies the D1
 * migrations to a D1-shaped SQLite file, then seeds
 *
 * - TWO synthetic accounts (random per-run credentials — they are returned
 *   to the caller and written ONLY to the harness temp state file), and
 * - the synthetic release fixture from ./fixture: two releases tied together
 *   by the harbour->harbor rename alias (v1 ACTIVE, v2 READY) plus the v3
 *   collision probe, their content rows, unit reports, and tiny valid WAV
 *   audio objects in the directory object store.
 *
 * Row counts and FTS population (migration triggers) mirror exactly what the
 * real compiler publishing path leaves behind, so verify-release gates run
 * against the same shape they will see in a real rehearsal.
 */
import { readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  ReleaseRepository,
  UserRepository,
  audioAsset,
  book,
  cardDefinition,
  contentAudioLink,
  createSqliteDatabase,
  example,
  phrase,
  releaseUnit,
  sense,
  unit,
  word,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { hashPassword } from "../src/auth/password";
import {
  ANCHOR_EXAMPLE,
  ANCHOR_EXAMPLE_KEY,
  BOOK_KEY,
  BOOK_TITLE,
  COLLIDE_V3,
  RELEASE_V1,
  RELEASE_V2,
  RELEASE_V3_COLLIDE,
  UNIT_KEY,
  UNIT_TITLE_V1,
  UNIT_TITLE_V2,
  V1_WORDS,
  V2_WORDS,
  type WordKeys,
} from "./fixture";
import { SYNTHETIC_AUDIO, sha256HexOf, syntheticAudioAssetKey, syntheticWav } from "./wav";
import type { DirectoryObjectStore } from "./object-store";

export interface HarnessUser {
  username: string;
  password: string;
}

/** Applies infra/migrations when the database is empty (idempotent). */
export function ensureMigrated(sqlite: Database.Database, migrationsDir: string): void {
  sqlite.pragma("foreign_keys = ON");
  const hasAppMeta = sqlite
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'")
    .get() as { n: number } | undefined;
  if ((hasAppMeta?.n ?? 0) > 0) {
    return;
  }
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
}

/** Random printable password from a 56-char alphabet (no quoting hazards). */
function randomPassword(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(24);
  let password = "";
  for (const byte of bytes) {
    password += alphabet[byte % alphabet.length]!;
  }
  return password;
}

function randomUsername(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

async function seedUser(db: LexiloopDatabase, prefix: string, now: number): Promise<HarnessUser> {
  const username = randomUsername(prefix);
  const password = randomPassword();
  const hashed = await hashPassword(password);
  await new UserRepository(db).create({
    userId: `user-${username}`,
    normalizedUsername: username,
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    status: "ACTIVE",
    createdAt: now,
  });
  return { username, password };
}

/** Inserts book/unit/content rows for one release's word key sets. */
async function seedReleaseContent(
  db: LexiloopDatabase,
  input: {
    releaseId: string;
    unitTitle: string;
    edition: string;
    words: readonly WordKeys[];
    withExample: boolean;
  },
): Promise<void> {
  const { releaseId, unitTitle, edition, words } = input;
  await db.insert(book).values({
    releaseId,
    bookKey: BOOK_KEY,
    title: BOOK_TITLE,
    edition,
    provenanceJson: "{}",
  });
  await db.insert(unit).values({
    releaseId,
    unitKey: UNIT_KEY,
    bookKey: BOOK_KEY,
    level: 1,
    unitOrder: 1,
    title: unitTitle,
    provenanceJson: "{}",
  });

  const unitReport = { words: 0, senses: 0, phrases: 0, examples: 0, explanations: 0, cards: 0 };
  for (const wordKeys of words) {
    await db.insert(word).values({
      releaseId,
      wordKey: wordKeys.wordKey,
      unitKey: UNIT_KEY,
      headword: wordKeys.headword,
      phonetic: null,
      tier: wordKeys.tier,
      sourceOrder: wordKeys.sourceOrder,
      provenanceJson: "{}",
    });
    await db.insert(sense).values({
      releaseId,
      senseKey: wordKeys.senseKey,
      wordKey: wordKeys.wordKey,
      pos: "noun",
      gloss: wordKeys.gloss,
      senseOrder: 1,
      provenanceJson: "{}",
    });
    await db.insert(phrase).values({
      releaseId,
      phraseKey: wordKeys.phraseKey,
      wordKey: wordKeys.wordKey,
      senseKey: wordKeys.senseKey,
      text: `${wordKeys.headword} phrase`,
      gloss: `${wordKeys.headword} 的短语`,
      sourceOrder: 1,
      provenanceJson: "{}",
    });
    await db.insert(cardDefinition).values([
      {
        releaseId,
        contentCardKey: wordKeys.cardKeys.WORD_MEANING,
        cardType: "WORD_MEANING",
        targetEntityKey: wordKeys.senseKey,
        wordKey: wordKeys.wordKey,
        unitKey: UNIT_KEY,
        templateVersion: "e2e-v1",
        status: "ACTIVE",
      },
      {
        releaseId,
        contentCardKey: wordKeys.cardKeys.PHRASE,
        cardType: "PHRASE",
        targetEntityKey: wordKeys.phraseKey,
        wordKey: wordKeys.wordKey,
        unitKey: UNIT_KEY,
        templateVersion: "e2e-v1",
        status: "ACTIVE",
      },
    ]);
    unitReport.words += 1;
    unitReport.senses += 1;
    unitReport.phrases += 1;
    unitReport.cards += 2;
  }

  if (input.withExample) {
    const anchor = words[0]!;
    await db.insert(example).values({
      releaseId,
      exampleKey: ANCHOR_EXAMPLE_KEY,
      wordKey: anchor.wordKey,
      senseKey: anchor.senseKey,
      phraseKey: null,
      origin: ANCHOR_EXAMPLE.origin,
      sourceRef: ANCHOR_EXAMPLE.sourceRef,
      text: ANCHOR_EXAMPLE.text,
      targetStart: ANCHOR_EXAMPLE.targetStart,
      targetEnd: ANCHOR_EXAMPLE.targetEnd,
      sourceOrder: 1,
      provenanceJson: "{}",
    });
    unitReport.examples += 1;
  }

  await db.insert(releaseUnit).values({
    releaseId,
    unitKey: UNIT_KEY,
    status: "PASSED",
    words: unitReport.words,
    senses: unitReport.senses,
    phrases: unitReport.phrases,
    examples: unitReport.examples,
    explanations: unitReport.explanations,
    cards: unitReport.cards,
    qaSummary: null,
  });
}

/** Seeds one word-level synthetic audio asset + link; stores the object. */
async function seedAudio(
  db: LexiloopDatabase,
  store: DirectoryObjectStore,
  input: { releaseId: string; word: WordKeys },
): Promise<void> {
  const bytes = syntheticWav(input.word.headword);
  const assetKey = syntheticAudioAssetKey(input.word.headword);
  await store.put(assetKey, bytes);
  await db.insert(audioAsset).values({
    releaseId: input.releaseId,
    assetKey,
    contentSha256: sha256HexOf(bytes),
    textHash: sha256HexOf(Buffer.from(input.word.headword, "utf8")),
    provider: "synthetic",
    modelId: "e2e-tone",
    voice: "square",
    synthesisConfigVersion: "e2e-v1",
    formatContainer: "wav",
    sampleRateHz: SYNTHETIC_AUDIO.sampleRateHz,
    channels: SYNTHETIC_AUDIO.channels,
    encoding: SYNTHETIC_AUDIO.encoding,
    durationMs: SYNTHETIC_AUDIO.durationMs,
    validation: "PASSED",
  });
  await db.insert(contentAudioLink).values({
    releaseId: input.releaseId,
    entityType: "word",
    entityKey: input.word.wordKey,
    assetKey,
  });
}

export interface SeedResult {
  users: HarnessUser[];
  startedAt: number;
}

/**
 * Migrates and seeds the harness database. Returns the generated accounts —
 * the ONLY place the synthetic credentials exist besides the temp state
 * file, which the server writes from this result.
 */
export async function seedHarnessDatabase(input: {
  sqlite: Database.Database;
  migrationsDir: string;
  store: DirectoryObjectStore;
}): Promise<SeedResult> {
  ensureMigrated(input.sqlite, input.migrationsDir);
  const db = createSqliteDatabase(input.sqlite);
  const now = Date.now();

  // Accounts (2): the plan's two seeded users.
  const users = [
    await seedUser(db, "e2e-alice", now),
    await seedUser(db, "e2e-bob", now),
  ];

  // Releases: v1 (will be ACTIVE), v2 (READY, carries the rename), v3
  // collision probe (READY, never activated in the happy path).
  const releases = new ReleaseRepository(db);
  const releaseBase = {
    sourcePdfSha256: sha256HexOf(Buffer.from("e2e-synthetic-source")),
    schemaVersion: "schema-v1",
    promptVersion: "prompt-v1",
    modelConfigJson: "{}",
    manifestSha256: sha256HexOf(Buffer.from("e2e-synthetic-manifest")),
    createdAt: now,
  };
  await releases.create({ releaseId: RELEASE_V1, ...releaseBase, status: "READY" });
  await releases.create({ releaseId: RELEASE_V2, ...releaseBase, status: "READY" });
  await releases.create({ releaseId: RELEASE_V3_COLLIDE, ...releaseBase, status: "READY" });

  await seedReleaseContent(db, {
    releaseId: RELEASE_V1,
    unitTitle: UNIT_TITLE_V1,
    edition: "v1",
    words: V1_WORDS,
    withExample: true,
  });
  await seedReleaseContent(db, {
    releaseId: RELEASE_V2,
    unitTitle: UNIT_TITLE_V2,
    edition: "v2",
    words: V2_WORDS,
    withExample: true,
  });
  await seedReleaseContent(db, {
    releaseId: RELEASE_V3_COLLIDE,
    unitTitle: "Unit 1 · Collision Probe",
    edition: "probe",
    words: [COLLIDE_V3],
    withExample: false,
  });

  // Audio: word-level synthetic WAVs, content-addressed (the anchor and tide
  // objects are shared across releases by key; harbour/harbor differ).
  for (const [releaseId, words] of [
    [RELEASE_V1, V1_WORDS],
    [RELEASE_V2, V2_WORDS],
  ] as const) {
    for (const wordKeys of words.filter((candidate) => candidate.slug !== "compass")) {
      await seedAudio(db, input.store, { releaseId, word: wordKeys });
    }
  }

  // The active pointer: v1 (through the ONLY pointer writer path).
  await releases.setActive(RELEASE_V1, now);

  return { users, startedAt: now };
}
