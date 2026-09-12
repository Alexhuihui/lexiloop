/**
 * Generator for the committed restore-drill fixtures (all SYNTHETIC content):
 *
 *   tests/fixtures/releases/retained-set/<release-id>/  — two minimal, fully
 *     verifiable immutable release bundles (manifest hashes computed from the
 *     real bytes);
 *   tests/fixtures/backup/minimal.jsonl.gz + manifest.json — a real backup
 *     produced by the production exporter (apps/worker/src/backups/export.ts)
 *     from a seeded synthetic database, so the format is guaranteed
 *     compatible with scripts/restore-drill.ts.
 *
 * The seeded story: release `fixrel-prev` was activated, then `fixrel-active`
 * replaced it (prev is RETIRED). Alias edges under fixrel-prev rename
 * w-haven -> w-harbor and c-haven -> c-harbor-1. The user learned w-harbor,
 * still has pre-rename progress under w-haven, reviewed a card presented by
 * fixrel-prev, and owns an unexpired session pinned to fixrel-active plus an
 * expired session pinned to fixrel-prev — so BOTH releases are required by
 * the backup manifest (pointers, sessions, introduction, review, aliases).
 *
 * Re-run from the repo root after changing the generator:
 *   pnpm tsx tests/fixtures/backup/generate-fixture.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import Database from "better-sqlite3";
import {
  CardStateRepository,
  ReleaseRepository,
  ReviewLogRepository,
  StudySessionRepository,
  UserRepository,
  UserSettingsRepository,
  WordProgressRepository,
  contentKeyAlias,
  createSqliteDatabase,
} from "@lexiloop/db";
import { queueSnapshot } from "@lexiloop/domain";
import { createMigratedTestDb } from "../../../packages/db/test/helpers";
import { exportUserData } from "../../../apps/worker/src/backups/export";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BUNDLE_ROOT = join(REPO_ROOT, "tests/fixtures/releases/retained-set");
const BACKUP_DIR = join(REPO_ROOT, "tests/fixtures/backup");

/** Frozen generation time (UTC epoch ms); fixtures are deterministic. */
const NOW = Date.parse("2026-03-10T19:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const ACTIVE = "fixrel-active";
const PREV = "fixrel-prev";

const SOURCE_SHA = "1".repeat(64);
const MANIFEST_PLACEHOLDER = "2".repeat(64);

interface FixtureWord {
  word_key: string;
  headword: string;
}

function buildBundleFiles(releaseId: string, words: FixtureWord[], previousReleaseId: string | null): Map<string, string> {
  const provenance = `{"source_pdf_sha256":"${SOURCE_SHA}","page_number":1}`;
  const contentLines = [
    `-- LexiLoop release ${releaseId}: synthetic fixture content (no real textbook data).`,
    `INSERT INTO book (release_id, book_key, title, edition, provenance_json) VALUES ('${releaseId}', 'bk-1', 'Synthetic Fixture Book', '1st', '${provenance}');`,
    `INSERT INTO unit (release_id, unit_key, book_key, level, unit_order, title, provenance_json) VALUES ('${releaseId}', 'u-1', 'bk-1', 1, 1, 'Fixture Unit', '${provenance}');`,
  ];
  for (const word of words) {
    contentLines.push(
      `INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) ` +
        `VALUES ('${releaseId}', '${word.word_key}', 'u-1', '${word.headword}', NULL, 'CORE', 1, '${provenance}');`,
      `INSERT INTO sense (release_id, sense_key, word_key, pos, gloss, sense_order, provenance_json) ` +
        `VALUES ('${releaseId}', 's-${word.word_key}-1', '${word.word_key}', 'noun', 'synthetic ${word.headword}', 1, '${provenance}');`,
    );
  }
  const files = new Map<string, string>([
    ["d1/001-content.sql", contentLines.join("\n") + "\n"],
    ["d1/002-cards.sql", `-- LexiLoop release ${releaseId}: card definitions (none in fixture).\n`],
    [
      "d1/003-search.sql",
      `-- LexiLoop release ${releaseId}: FTS integrity pass.\nINSERT INTO content_search_fts(content_search_fts) VALUES('rebuild');\n`,
    ],
    ["qa/unit-status.json", `${JSON.stringify({ unit_key: "u-1", status: "PASSED" })}\n`],
    ["qa/validation-summary.json", `${JSON.stringify({ units: 1, passed: 1, blocked: 0 })}\n`],
    [
      "rollback.json",
      `${JSON.stringify({ version: 1, release_id: releaseId, previous_release_id: previousReleaseId }, null, 2)}\n`,
    ],
  ]);
  return files;
}

function writeBundle(bundleDir: string, releaseId: string, words: FixtureWord[], previousReleaseId: string | null): void {
  const files = buildBundleFiles(releaseId, words, previousReleaseId);
  const manifest = {
    release_id: releaseId,
    status: "READY",
    created_at: new Date(NOW - 5 * DAY).toISOString(),
    book: { book_key: "bk-1", edition: "1st" },
    source_pdf_sha256: SOURCE_SHA,
    config_versions: {
      schema_version: "schema-v1",
      watermark_rules_version: "1",
      ocr_config_version: "1",
      prompt_version: "prompt-v1",
      card_rules_version: "v1",
      synthesis_config_version: "scv-1",
    },
    model_config: {
      generation_model_id: "agent-generation-fixture",
      review_model_id: "agent-review-fixture",
      repair_model_id: "agent-repair-fixture",
      tts_model_id: "tts-fixture",
      tts_voice: "voice-fixture",
    },
    units: [
      {
        unit_key: "u-1",
        status: "PASSED",
        counts: { words: words.length, senses: words.length, phrases: 0, examples: 0, explanations: 0, cards: 0 },
      },
    ],
    totals: {
      units: 1,
      units_passed: 1,
      units_blocked: 0,
      words: words.length,
      cards: 0,
      audio_assets: 0,
    },
    files: [...files.entries()]
      .map(([path, body]) => ({
        path,
        sha256: createHash("sha256").update(body, "utf8").digest("hex"),
        bytes: Buffer.byteLength(body, "utf8"),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    gates: [{ name: "fixture_synthetic", passed: true }],
  };
  rmSync(bundleDir, { recursive: true, force: true });
  mkdirSync(join(bundleDir, "d1"), { recursive: true });
  mkdirSync(join(bundleDir, "qa"), { recursive: true });
  for (const [path, body] of files) {
    writeFileSync(join(bundleDir, path), body, "utf8");
  }
  writeFileSync(join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** Executes one bundle's D1 import files into the seeded source database. */
function executeImportFile(sqlite: Database.Database, filePath: string): void {
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("INSERT")) continue;
    sqlite.exec(trimmed);
  }
}

async function main(): Promise<void> {
  // -- 1. The two immutable bundles. ---------------------------------------
  writeBundle(join(BUNDLE_ROOT, ACTIVE), ACTIVE, [{ word_key: "w-harbor", headword: "harbor" }], PREV);
  writeBundle(join(BUNDLE_ROOT, PREV), PREV, [{ word_key: "w-haven", headword: "haven" }], null);

  // -- 2. A synthetic source database that used both releases. -------------
  const env = createMigratedTestDb();
  const sqlite = env.sqlite;
  const db = createSqliteDatabase(sqlite);
  const releases = new ReleaseRepository(db);
  const base = {
    sourcePdfSha256: SOURCE_SHA,
    schemaVersion: "schema-v1",
    promptVersion: "prompt-v1",
    modelConfigJson: "{}",
    createdAt: NOW - 5 * DAY,
    manifestSha256: MANIFEST_PLACEHOLDER,
  };
  for (const releaseId of [PREV, ACTIVE]) {
    const bundleDir = join(BUNDLE_ROOT, releaseId);
    const manifestSha = createHash("sha256")
      .update(readFileSync(join(bundleDir, "manifest.json"), "utf8"))
      .digest("hex");
    await releases.create({ releaseId, ...base, status: "READY", manifestSha256: manifestSha });
    await releases.insertUnitReport(releaseId, {
      unitKey: "u-1",
      status: "PASSED",
      words: 1,
      senses: 1,
    });
    for (const file of ["d1/001-content.sql", "d1/002-cards.sql", "d1/003-search.sql"]) {
      executeImportFile(sqlite, join(bundleDir, file));
    }
  }
  // fixrel-prev ACTIVE first, then fixrel-active replaces it (prev RETIRED).
  await releases.setActive(PREV, NOW - 4 * DAY);
  await releases.setActive(ACTIVE, NOW - 2 * DAY);
  await db.insert(contentKeyAlias).values([
    { releaseId: PREV, fromKey: "w-haven", toKey: "w-harbor", edgeType: "RENAME", canonicalKey: "w-harbor", createdAt: NOW - 2 * DAY },
    { releaseId: PREV, fromKey: "c-haven", toKey: "c-harbor-1", edgeType: "RENAME", canonicalKey: "c-harbor-1", createdAt: NOW - 2 * DAY },
  ]);

  // -- 3. The synthetic user. ----------------------------------------------
  const userId = "fixture-user";
  const hashed = {
    salt: "0".repeat(43),
    verifier: "0".repeat(43),
  };
  await new UserRepository(db).create({
    userId,
    normalizedUsername: "fixture",
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    status: "ACTIVE",
    createdAt: NOW - 5 * DAY,
  });
  await new UserSettingsRepository(db).upsert({ userId }, { timezone: "Asia/Shanghai", dailyGoal: 20 });
  await new WordProgressRepository(db).upsert({ userId }, {
    wordKey: "w-harbor",
    stage: "INTRODUCED",
    initialFamiliarity: "KNOWN",
    firstSeenAt: NOW - 3 * DAY,
    lastSeenAt: NOW - DAY,
    introducedReleaseId: ACTIVE,
    introducedAt: NOW - DAY,
  });
  await new WordProgressRepository(db).upsert({ userId }, {
    wordKey: "w-haven",
    stage: "IN_PROGRESS",
    initialFamiliarity: "RECOGNIZABLE",
    firstSeenAt: NOW - 4 * DAY,
    lastSeenAt: NOW - 2 * DAY,
  });
  await new CardStateRepository(db).upsert({ userId }, {
    contentCardKey: "c-harbor-1",
    state: {
      version: 1,
      state: "Review",
      stability: 6,
      difficulty: 5.2,
      due_at: NOW + 2 * DAY,
      last_review_at: NOW - DAY,
      reps: 4,
      lapses: 1,
      scheduled_days: 3,
      learning_steps: -1,
    },
    updatedAt: NOW - DAY,
  });
  await new ReviewLogRepository(db).append({ userId }, {
    eventId: "evt-fixture-1",
    contentCardKey: "c-harbor-1",
    presentedCardKey: "c-haven",
    presentedReleaseId: PREV,
    rating: 3,
    beforeState: null,
    afterState: {
      version: 1,
      state: "Review",
      stability: 4,
      difficulty: 5.4,
      due_at: NOW - HOUR,
      last_review_at: NOW - 2 * DAY,
      reps: 3,
      lapses: 1,
      scheduled_days: 2,
      learning_steps: -1,
    },
    reviewedAt: NOW - 2 * DAY,
  });
  const sessions = new StudySessionRepository(db);
  await sessions.create({ userId }, {
    sessionId: "sess-fixture-active",
    mode: "NEW_WORDS",
    releaseId: ACTIVE,
    queueSnapshot: queueSnapshot(ACTIVE, []),
    createdAt: NOW - HOUR,
    expiresAt: NOW + 23 * HOUR,
  });
  await sessions.create({ userId }, {
    sessionId: "sess-fixture-prev",
    mode: "REVIEW",
    releaseId: PREV,
    queueSnapshot: queueSnapshot(PREV, []),
    createdAt: NOW - 2 * DAY,
    expiresAt: NOW - DAY,
  });

  // -- 4. Run the production exporter; copy its outputs into the fixtures. --
  const staging = mkdtempSync(join(tmpdir(), "lexiloop-fixture-gen-"));
  const result = await exportUserData({
    db,
    bucket: {
      async put(objectKey: string, body: Uint8Array): Promise<void> {
        const filePath = join(staging, objectKey);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, body);
      },
    },
    now: NOW,
  });
  const dateKey = new Date(NOW).toISOString().slice(0, 10);
  mkdirSync(BACKUP_DIR, { recursive: true });
  rmSync(join(BACKUP_DIR, "minimal.jsonl.gz"), { force: true });
  rmSync(join(BACKUP_DIR, "manifest.json"), { force: true });
  writeFileSync(join(BACKUP_DIR, "minimal.jsonl.gz"), readFileSync(join(staging, `backups/${dateKey}/user-data.jsonl.gz`)));
  writeFileSync(
    join(BACKUP_DIR, "manifest.json"),
    readFileSync(join(staging, `backups/${dateKey}/manifest.json`)),
    "utf8",
  );
  env.cleanup();
  rmSync(staging, { recursive: true, force: true });

  process.stdout.write(
    `fixtures regenerated:\n` +
      `  ${BUNDLE_ROOT} (${readdirSync(BUNDLE_ROOT).sort().join(", ")})\n` +
      `  ${join(BACKUP_DIR, "minimal.jsonl.gz")} (sha256 ${result.manifest.sha256.slice(0, 12)}...)\n` +
      `  required releases: ${result.manifest.required_releases.map((entry) => entry.release_id).join(", ")}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`fixture generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
