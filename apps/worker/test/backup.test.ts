import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AliasRepository,
  CardStateRepository,
  ReleaseRepository,
  ReviewLogRepository,
  StudySessionRepository,
  UserRepository,
  UserSettingsRepository,
  WordProgressRepository,
  contentKeyAlias,
  createSqliteDatabase,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { queueSnapshot } from "@lexiloop/domain";
import { createMigratedTestDb, type TestDatabase } from "../../../packages/db/test/helpers";
import { hashPassword } from "../src/auth/password";
import { exportUserData, type BackupManifest } from "../src/backups/export";
import { RestoreDrillError, runRestoreDrill } from "../src/backups/restore";
import { runScheduledBackup } from "../src/scheduled";

/**
 * Task 14 backup/restore acceptance tests (spec 13.1, plan Task 14): the daily
 * export keeps ONLY user/settings/progress/card/review/session rows, uploads
 * gzip JSONL + a manifest to private R2, and inventories every required
 * content release (pointers, session pins, introductions, presented reviews,
 * alias lineages). The restore drill rebuilds ONLY an explicitly new temporary
 * database: bundles are verified as an exact set BEFORE any user row is
 * written, then releases/aliases/user data are imported, pointers restored,
 * FTS rebuilt from content tables, and counts/FKs/hashes/alias resolution
 * verified. The Worker scheduled handler drives the same exporter on the
 * `0 19 * * *` cron (03:00 Asia/Shanghai).
 */

const NOW = Date.parse("2026-03-10T19:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const PASSWORD = "correct horse battery staple";

const RELEASE_A = "rel-backup-active";
const RELEASE_B = "rel-backup-prev";

/** Minimal R2 fake capturing puts with byte-identical objects. */
class FakeBackupBucket {
  private readonly objects = new Map<string, Uint8Array>();

  async put(key: string, value: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(value));
  }

  bytes(key: string): Uint8Array | undefined {
    return this.objects.get(key);
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}

const asBucket = (fake: FakeBackupBucket) => fake;

interface BackupFixture {
  env: TestDatabase;
  db: LexiloopDatabase;
  bucket: FakeBackupBucket;
}

async function seedUser(db: LexiloopDatabase): Promise<string> {
  const hashed = await hashPassword(PASSWORD);
  const userId = "user-dana";
  await new UserRepository(db).create({
    userId,
    normalizedUsername: "dana",
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    status: "ACTIVE",
    createdAt: NOW - 5 * DAY,
  });
  await new UserSettingsRepository(db).upsert({ userId }, { timezone: "Asia/Shanghai", dailyGoal: 25 });
  return userId;
}

/**
 * Two releases: B retired (previous), A active. Alias edges under B rename
 * w-old -> w-harbor and c-old -> c-harbor-1 so a restored database can resolve
 * dana's pre-rename progress keys.
 */
async function seedReleasesAndContent(db: LexiloopDatabase): Promise<void> {
  const releases = new ReleaseRepository(db);
  const base = {
    sourcePdfSha256: "a".repeat(64),
    schemaVersion: "schema-v1",
    promptVersion: "prompt-v1",
    modelConfigJson: "{}",
    createdAt: NOW - 30 * DAY,
    manifestSha256: "b".repeat(64),
  };
  await releases.create({ releaseId: RELEASE_B, ...base, status: "READY" });
  await releases.setActive(RELEASE_B, NOW - 5 * DAY); // became ACTIVE
  await releases.create({ releaseId: RELEASE_A, ...base, status: "READY" });
  await releases.setActive(RELEASE_A, NOW - 2 * DAY); // demotes B to RETIRED
}

async function seedUserData(db: LexiloopDatabase): Promise<string> {
  const userId = await seedUser(db);
  await new WordProgressRepository(db).upsert({ userId }, {
    wordKey: "w-harbor",
    stage: "INTRODUCED",
    initialFamiliarity: "KNOWN",
    firstSeenAt: NOW - 3 * DAY,
    lastSeenAt: NOW - DAY,
    introducedReleaseId: RELEASE_A,
    introducedAt: NOW - DAY,
  });
  // Pre-rename key with live progress: its alias lineage (under RELEASE_B)
  // must be part of the backup manifest.
  await new WordProgressRepository(db).upsert({ userId }, {
    wordKey: "w-old",
    stage: "IN_PROGRESS",
    initialFamiliarity: "RECOGNIZABLE",
    firstSeenAt: NOW - 4 * DAY,
    lastSeenAt: NOW - 2 * DAY,
  });
  await new CardStateRepository(db).upsert({ userId }, {
    contentCardKey: "c-harbor-1",
    state: {
      version: 1, state: "Review", stability: 6, difficulty: 5.2,
      due_at: NOW + 2 * DAY, last_review_at: NOW - DAY, reps: 4, lapses: 1,
      scheduled_days: 3, learning_steps: -1,
    },
    updatedAt: NOW - DAY,
  });
  await new ReviewLogRepository(db).append({ userId }, {
    eventId: "evt-old-presentation",
    contentCardKey: "c-harbor-1",
    presentedCardKey: "c-old",
    presentedReleaseId: RELEASE_B,
    rating: 3,
    beforeState: null,
    afterState: {
      version: 1, state: "Review", stability: 4, difficulty: 5.4,
      due_at: NOW - HOUR, last_review_at: NOW - 2 * DAY, reps: 3, lapses: 1,
      scheduled_days: 2, learning_steps: -1,
    },
    reviewedAt: NOW - 2 * DAY,
  });
  const undone = await new ReviewLogRepository(db).append({ userId }, {
    eventId: "evt-undone",
    contentCardKey: "c-harbor-1",
    presentedCardKey: "c-harbor-1",
    presentedReleaseId: RELEASE_A,
    rating: 2,
    beforeState: null,
    afterState: {
      version: 1, state: "Review", stability: 2, difficulty: 5.6,
      due_at: NOW + HOUR, last_review_at: NOW - HOUR, reps: 1, lapses: 0,
      scheduled_days: 0, learning_steps: -1,
    },
    reviewedAt: NOW - HOUR,
  });
  await new ReviewLogRepository(db).markUndone({ userId }, undone.eventId, NOW - 30 * 60_000);
  const sessions = new StudySessionRepository(db);
  await sessions.create({ userId }, {
    sessionId: "sess-active",
    mode: "NEW_WORDS",
    releaseId: RELEASE_A,
    queueSnapshot: queueSnapshot(RELEASE_A, []),
    createdAt: NOW - HOUR,
    expiresAt: NOW + 23 * HOUR, // unexpired pin
  });
  await sessions.create({ userId }, {
    sessionId: "sess-expired",
    mode: "REVIEW",
    releaseId: RELEASE_B,
    queueSnapshot: queueSnapshot(RELEASE_B, []),
    createdAt: NOW - 2 * DAY,
    expiresAt: NOW - DAY, // expired but still backed up
  });
  return userId;
}

async function createBackupFixture(): Promise<BackupFixture> {
  const env = createMigratedTestDb();
  const db = createSqliteDatabase(env.sqlite);
  await seedReleasesAndContent(db);
  await db.insert(contentKeyAlias).values([
    { releaseId: RELEASE_B, fromKey: "w-old", toKey: "w-harbor", edgeType: "RENAME", canonicalKey: "w-harbor", createdAt: NOW - 2 * DAY },
    { releaseId: RELEASE_B, fromKey: "c-old", toKey: "c-harbor-1", edgeType: "RENAME", canonicalKey: "c-harbor-1", createdAt: NOW - 2 * DAY },
  ]);
  await seedUserData(db);
  return { env, db, bucket: new FakeBackupBucket() };
}

/** Gunzip helper mirroring the exporter's CompressionStream pipeline. */
async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).text();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

interface BackupBundleOptions {
  words: Array<{ word_key: string; headword: string }>;
  previousReleaseId?: string;
}

/**
 * Builds a minimal but fully verifiable immutable release bundle: manifest
 * hashes re-computed from the actual bytes, schema-valid ReleaseManifest JSON,
 * deterministic content SQL the drill imports.
 */
async function writeBundle(bundleDir: string, releaseId: string, options: BackupBundleOptions): Promise<void> {
  const provenance = '{"source_pdf_sha256":"' + "a".repeat(64) + '","page_number":1}';
  const contentLines = [
    `-- LexiLoop release ${releaseId}: synthetic fixture content.`,
    `INSERT INTO book (release_id, book_key, title, edition, provenance_json) VALUES ('${releaseId}', 'bk-1', 'Fixture Book', '1st', '${provenance}');`,
    `INSERT INTO unit (release_id, unit_key, book_key, level, unit_order, title, provenance_json) VALUES ('${releaseId}', 'u-1', 'bk-1', 1, 1, 'Fixture Unit', '${provenance}');`,
  ];
  for (const entry of options.words) {
    contentLines.push(
      `INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) ` +
        `VALUES ('${releaseId}', '${entry.word_key}', 'u-1', '${entry.headword}', NULL, 'CORE', 1, '${provenance}');`,
      `INSERT INTO sense (release_id, sense_key, word_key, pos, gloss, sense_order, provenance_json) ` +
        `VALUES ('${releaseId}', 's-${entry.word_key}-1', '${entry.word_key}', 'noun', 'synthetic ${entry.headword}', 1, '${provenance}');`,
    );
  }
  const files: Array<{ path: string; body: string }> = [
    { path: "d1/001-content.sql", body: contentLines.join("\n") + "\n" },
    { path: "d1/002-cards.sql", body: `-- LexiLoop release ${releaseId}: card definitions (none in fixture).\n` },
    {
      path: "d1/003-search.sql",
      body: `-- LexiLoop release ${releaseId}: FTS integrity pass.\nINSERT INTO content_search_fts(content_search_fts) VALUES('rebuild');\n`,
    },
    { path: "qa/unit-status.json", body: `${JSON.stringify({ unit_key: "u-1", status: "PASSED" })}\n` },
    { path: "qa/validation-summary.json", body: `${JSON.stringify({ units: 1, passed: 1 })}\n` },
    {
      path: "rollback.json",
      body: `${JSON.stringify({ version: 1, release_id: releaseId, previous_release_id: options.previousReleaseId ?? null }, null, 2)}\n`,
    },
  ];
  const manifest = {
    release_id: releaseId,
    status: "READY",
    created_at: new Date(NOW - 5 * DAY).toISOString(),
    book: { book_key: "bk-1", edition: "1st" },
    source_pdf_sha256: "a".repeat(64),
    target_units: ["u-1"],
    config_versions: {
      schema_version: "schema-v1",
      watermark_rules_version: "1",
      ocr_config_version: "1",
      prompt_version: "prompt-v1",
      card_rules_version: "v1",
      synthesis_config_version: "scv-1",
    },
    model_config: {
      generation_model_id: "gen",
      review_model_id: "rev",
      repair_model_id: "rep",
      tts_model_id: "tts",
      tts_voice: "voice",
    },
    units: [
      {
        unit_key: "u-1",
        status: "PASSED",
        counts: { words: options.words.length, senses: options.words.length, phrases: 0, examples: 0, explanations: 0, cards: 0 },
      },
    ],
    totals: {
      units: 1,
      units_passed: 1,
      units_blocked: 0,
      words: options.words.length,
      cards: 0,
      audio_assets: 0,
    },
    files: files.map((file) => ({
      path: file.path,
      sha256: createHash("sha256").update(file.body, "utf8").digest("hex"),
      bytes: Buffer.byteLength(file.body, "utf8"),
    })),
    gates: [{ name: "fixture_synthetic", passed: true }],
  };
  mkdirSync(join(bundleDir, "d1"), { recursive: true });
  mkdirSync(join(bundleDir, "qa"), { recursive: true });
  for (const file of files) {
    writeFileSync(join(bundleDir, file.path), file.body, "utf8");
  }
  writeFileSync(join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Writes the fixture bundles named by the exported backup manifest. */
async function writeRequiredBundles(bundleDir: string, manifest: BackupManifest): Promise<void> {
  const ids = manifest.required_releases.map((entry) => entry.release_id).sort();
  for (const releaseId of ids) {
    writeBundle(join(bundleDir, releaseId), releaseId, {
      words: releaseId === RELEASE_A
        ? [{ word_key: "w-harbor", headword: "harbor" }]
        : [{ word_key: "w-old", headword: "haven" }],
      previousReleaseId: releaseId === RELEASE_A ? RELEASE_B : undefined,
    });
  }
}

/** Exports the seeded database to a temp backup dir + bundle dir. */
interface DrillPaths {
  backupPath: string;
  manifestPath: string;
  bundleDir: string;
  temporaryDbPath: string;
  root: string;
}

async function exportToDisk(fx: BackupFixture): Promise<{ manifest: BackupManifest; paths: DrillPaths }> {
  const root = mkdtempSync(join(tmpdir(), "lexiloop-backup-test-"));
  const result = await exportUserData({ db: fx.db, bucket: asBucket(fx.bucket), now: NOW });
  const backupDir = join(root, "backup");
  const bundleDir = join(root, "releases");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, "user-data.jsonl.gz");
  writeFileSync(backupPath, result.bytes);
  writeFileSync(join(backupDir, "manifest.json"), `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");
  await writeRequiredBundles(bundleDir, result.manifest);
  return {
    manifest: result.manifest,
    paths: {
      backupPath,
      manifestPath: join(backupDir, "manifest.json"),
      bundleDir,
      temporaryDbPath: join(root, "restore.sqlite"),
      root,
    },
  };
}

describe("exportUserData", () => {
  let fx: BackupFixture;

  beforeEach(async () => {
    fx = await createBackupFixture();
  });

  afterEach(() => {
    fx.env.cleanup();
  });

  it("uploads gzip JSONL of exactly the six user tables plus a manifest", async () => {
    const result = await exportUserData({ db: fx.db, bucket: asBucket(fx.bucket), now: NOW });
    const dateKey = new Date(NOW).toISOString().slice(0, 10);
    expect(fx.bucket.keys()).toEqual([
      `backups/${dateKey}/manifest.json`,
      `backups/${dateKey}/user-data.jsonl.gz`,
    ]);
    expect(result.manifest.object_key).toBe(`backups/${dateKey}/user-data.jsonl.gz`);
    expect(result.manifest.sha256).toBe(await sha256Hex(result.bytes));

    const lines = (await gunzip(result.bytes)).split("\n").filter((line) => line.length > 0);
    const rows = lines.map((line) => JSON.parse(line) as { table: string });
    const tables = new Set(rows.map((row) => row.table));
    expect([...tables].sort()).toEqual([
      "app_user", "card_state", "review_log", "study_session", "user_settings", "word_progress",
    ]);
    // FTS is never a backup source (spec 6.3).
    expect(tables.has("content_search_fts")).toBe(false);
    expect(result.manifest.row_counts).toEqual({
      app_user: 1,
      card_state: 1,
      review_log: 2,
      study_session: 2,
      user_settings: 1,
      word_progress: 2,
    });
    expect(lines).toHaveLength(9);
  });

  it("exports in bounded pages without losing rows", async () => {
    const result = await exportUserData({ db: fx.db, bucket: asBucket(fx.bucket), now: NOW, pageSize: 1 });
    const lines = (await gunzip(result.bytes)).split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(9);
    expect(result.manifest.row_counts.word_progress).toBe(2);
  });

  it("inventories every required release: pointers, sessions, introductions, reviews, aliases", async () => {
    const result = await exportUserData({ db: fx.db, bucket: asBucket(fx.bucket), now: NOW });
    const byId = new Map(result.manifest.required_releases.map((entry) => [entry.release_id, entry]));
    expect(byId.get(RELEASE_A)?.reasons).toEqual([
      "active", "session", "introduced", "review",
    ]);
    expect(byId.get(RELEASE_B)?.reasons).toEqual([
      "previous", "session", "review", "alias",
    ]);
    expect(result.manifest.required_releases).toHaveLength(2);
    expect(result.manifest.active_release_id).toBe(RELEASE_A);
    expect(result.manifest.previous_release_id).toBe(RELEASE_B);
    expect(result.manifest.alias_edges).toEqual([
      { release_id: RELEASE_B, from_key: "c-old", to_key: "c-harbor-1", edge_type: "RENAME", canonical_key: "c-harbor-1", created_at: NOW - 2 * DAY },
      { release_id: RELEASE_B, from_key: "w-old", to_key: "w-harbor", edge_type: "RENAME", canonical_key: "w-harbor", created_at: NOW - 2 * DAY },
    ]);
  });
});

describe("runScheduledBackup", () => {
  let fx: BackupFixture;

  beforeEach(async () => {
    fx = await createBackupFixture();
  });

  afterEach(() => {
    fx.env.cleanup();
  });

  it("drives the same exporter from the Worker scheduled handler", async () => {
    const logs: string[] = [];
    const manifest = await runScheduledBackup(
      { WORKER_RELEASE_ID: "worker-test" },
      { db: fx.db, bucket: asBucket(fx.bucket), now: NOW, logWrite: (line) => logs.push(line) },
    );
    const dateKey = new Date(NOW).toISOString().slice(0, 10);
    expect(fx.bucket.keys()).toEqual([
      `backups/${dateKey}/manifest.json`,
      `backups/${dateKey}/user-data.jsonl.gz`,
    ]);
    expect(manifest.row_counts.review_log).toBe(2);
    // One structured completion line; no user data in it (spec 13.2).
    expect(logs).toHaveLength(1);
    const entry = JSON.parse(logs[0]!) as { msg: string; release_id?: string; d1_rows_read: number };
    expect(entry.msg).toBe("backup_completed");
    expect(entry.release_id).toBe("worker-test");
    expect(entry.d1_rows_read).toBeGreaterThanOrEqual(0);
  });

  it("is wired to the 0 19 * * * cron (03:00 Asia/Shanghai) and the entry point", async () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..");
    const wranglerConfig = readFileSync(join(repoRoot, "infra", "wrangler", "wrangler.toml.example"), "utf8");
    expect(wranglerConfig).toContain('crons = ["0 19 * * *"]');
    expect(wranglerConfig).toContain("03:00 Asia/Shanghai");
    const entrypoint = (await import("../src/index")) as { default: { scheduled?: unknown } };
    expect(typeof entrypoint.default.scheduled).toBe("function");
  });
});

describe("runRestoreDrill", () => {
  let fx: BackupFixture;
  let exported: { manifest: BackupManifest; paths: DrillPaths };

  beforeEach(async () => {
    fx = await createBackupFixture();
    exported = await exportToDisk(fx);
  });

  afterEach(() => {
    fx.env.cleanup();
    rmSync(exported.paths.root, { recursive: true, force: true });
  });

  it("restores releases, aliases, user data, pointers, and rebuilt FTS into a new database", async () => {
    const result = await runRestoreDrill({
      backupPath: exported.paths.backupPath,
      releaseBundleDir: exported.paths.bundleDir,
      temporaryDbPath: exported.paths.temporaryDbPath,
    });
    expect(result.checks.every((check) => check.passed)).toBe(true);

    const sqlite = new Database(exported.paths.temporaryDbPath, { readonly: true });
    try {
      expect(sqlite.prepare("SELECT active_release_id FROM app_meta WHERE id = 1").get()).toEqual({
        active_release_id: RELEASE_A,
      });
      const statuses = sqlite
        .prepare("SELECT release_id, status FROM content_release ORDER BY release_id")
        .all() as Array<{ release_id: string; status: string }>;
      expect(statuses).toEqual([
        { release_id: RELEASE_A, status: "ACTIVE" },
        { release_id: RELEASE_B, status: "RETIRED" },
      ]);
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM app_user").get()).toEqual({ n: 1 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM word_progress").get()).toEqual({ n: 2 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM card_state").get()).toEqual({ n: 1 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM review_log").get()).toEqual({ n: 2 });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM study_session").get()).toEqual({ n: 2 });
      // FTS rebuilt from content tables: two headwords + two glosses.
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM content_search_fts").get()).toEqual({ n: 4 });
      // "harbor" matches its headword AND its sense gloss (fixture glosses
      // embed the headword).
      expect(
        sqlite.prepare("SELECT COUNT(*) AS n FROM content_search_fts WHERE content_search_fts MATCH 'harbor'").get(),
      ).toEqual({ n: 2 });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }

    // Canonical alias resolution works on the restored database.
    const aliasDb = new Database(exported.paths.temporaryDbPath, { readonly: true });
    try {
      const aliases = new AliasRepository(createSqliteDatabase(aliasDb));
      await expect(aliases.resolve({ releaseId: RELEASE_B, key: "w-old" })).resolves.toBe("w-harbor");
      await expect(aliases.resolve({ releaseId: RELEASE_B, key: "c-old" })).resolves.toBe("c-harbor-1");
    } finally {
      aliasDb.close();
    }
  });

  it("fails when a referenced bundle is missing, before any user row is written", async () => {
    rmSync(join(exported.paths.bundleDir, RELEASE_B), { recursive: true, force: true });
    await expect(runRestoreDrill({
      backupPath: exported.paths.backupPath,
      releaseBundleDir: exported.paths.bundleDir,
      temporaryDbPath: exported.paths.temporaryDbPath,
    })).rejects.toBeInstanceOf(RestoreDrillError);
    expect(readdirSync(exported.paths.bundleDir)).toEqual([RELEASE_A]);
    expect(statSync(exported.paths.temporaryDbPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("fails when an extra ambiguous bundle is present, before any user row is written", async () => {
    writeBundle(join(exported.paths.bundleDir, "rel-backup-stranger"), "rel-backup-stranger", {
      words: [{ word_key: "w-stranger", headword: "stranger" }],
    });
    await expect(runRestoreDrill({
      backupPath: exported.paths.backupPath,
      releaseBundleDir: exported.paths.bundleDir,
      temporaryDbPath: exported.paths.temporaryDbPath,
    })).rejects.toThrow(/rel-backup-stranger/);
    expect(statSync(exported.paths.temporaryDbPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("fails when a bundle file hash no longer matches its manifest", async () => {
    const target = join(exported.paths.bundleDir, RELEASE_A, "d1", "001-content.sql");
    writeFileSync(target, `${readFileSync(target, "utf8")}-- tampered\n`, "utf8");
    await expect(runRestoreDrill({
      backupPath: exported.paths.backupPath,
      releaseBundleDir: exported.paths.bundleDir,
      temporaryDbPath: exported.paths.temporaryDbPath,
    })).rejects.toThrow(/001-content\.sql/);
    expect(statSync(exported.paths.temporaryDbPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  it("replaces an existing file at the explicit temporary path with a fresh database", async () => {
    writeFileSync(exported.paths.temporaryDbPath, "not a database");
    const result = await runRestoreDrill({
      backupPath: exported.paths.backupPath,
      releaseBundleDir: exported.paths.bundleDir,
      temporaryDbPath: exported.paths.temporaryDbPath,
    });
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });
});
