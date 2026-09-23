/**
 * Release publishing (spec 5.9/6.4/11.3): verify -> stage -> smoke ->
 * activate | rollback.
 *
 * Lifecycle and invariants enforced here:
 * - `stageBundle` verifies the bundle (manifest hashes), imports an INACTIVE
 *   D1 release with status IMPORTING plus its unit reports and content SQL,
 *   and uploads content-addressed audio to private R2 idempotently (existing
 *   objects are reused by key/hash). app_meta is NEVER touched.
 * - `smokeRelease` is the only IMPORTING -> VALIDATING -> READY path; its
 *   pre-activation checks (release_unit totals vs content rows, orphan
 *   foreign keys, FTS/content parity, audio objects in R2) mark the release
 *   FAILED and never move the active pointer.
 * - `activateRelease` is the ONLY pointer writer, and only for READY: the
 *   activation batch imports validated alias edges and switches app_meta in
 *   one transaction — any failure leaves state and pointer unchanged.
 * - `rollbackRelease` re-activates a RETIRED release. User state
 *   (word_progress, card_state, review_log) is never rewritten anywhere.
 *
 * Dependencies arrive through narrow ports: a drizzle `LexiloopDatabase`
 * (better-sqlite3 in tests/scripts, D1 in the worker) and an `R2AudioStore`
 * object store, so every command is testable with injected fakes.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import {
  ReleaseRepository,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { AudioManifestRowSchema, type AudioManifestRow } from "../tts/cache";
import { readJsonl } from "../media";
import { verifyBundle } from "./validate";
import { prepareAliasBatch } from "./aliases";

// Alias-edge declaration/validation lives in ./aliases; re-exported so the
// CLI keeps a single publishing import surface.
export { AliasFileSchema } from "./aliases";

/** Fail-closed publish error with a machine-readable code. */
export class PublishError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PublishError";
    this.code = code;
  }
}

/** Minimal private-bucket port used for content-addressed audio objects. */
export interface R2AudioStore {
  head(objectKey: string): Promise<{ size: number } | null>;
  put(objectKey: string, body: Uint8Array): Promise<void>;
}

export interface UploadResult {
  uploaded: number;
  reused: number;
}

/**
 * Upload content-addressed audio to private R2, idempotent by hash: an
 * object whose key already exists is reused, never re-put (identical text +
 * config share one object across releases). Local bytes are verified against
 * the manifest's SHA-256 before any upload. `onProgress` (optional) reports
 * `done/total` after every asset — the remote driver uses it for operator
 * visibility on long uploads.
 */
export async function uploadAudioAssets(
  r2: R2AudioStore,
  rows: readonly AudioManifestRow[],
  audioRoot: string,
  onProgress?: (done: number, total: number) => void,
  concurrency = 1,
): Promise<UploadResult> {
  const total = rows.length;
  let done = 0;
  let uploaded = 0;
  let reused = 0;
  let cursor = 0;
  let failure: unknown;
  const report = (): void => {
    done += 1;
    onProgress?.(done, total);
  };
  const worker = async (): Promise<void> => {
    while (failure === undefined) {
      const index = cursor;
      cursor += 1;
      if (index >= rows.length) return;
      const row = rows[index]!;
      try {
        if (await r2.head(row.object_key)) {
          reused += 1;
          report();
          continue;
        }
        const filePath = path.join(audioRoot, row.object_key);
        let bytes: Buffer;
        try {
          bytes = await readFile(filePath);
        } catch {
          throw new PublishError("RELEASE_AUDIO_MISSING", `audio asset ${row.cache_key.slice(0, 12)} missing: ${filePath}`);
        }
        const actualSha = createHash("sha256").update(bytes).digest("hex");
        if (actualSha !== row.sha256) {
          throw new PublishError(
            "RELEASE_AUDIO_HASH_MISMATCH",
            `audio asset ${row.cache_key.slice(0, 12)} bytes changed (${actualSha.slice(0, 12)} != ${row.sha256.slice(0, 12)})`,
          );
        }
        await r2.put(row.object_key, bytes);
        uploaded += 1;
        report();
      } catch (err) {
        failure ??= err;
      }
    }
  };
  const requestedConcurrency = Number.isFinite(concurrency) ? Math.trunc(concurrency) : 1;
  const workerCount = Math.max(1, Math.min(requestedConcurrency, rows.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failure !== undefined) throw failure;
  return { uploaded, reused };
}

export interface StageBundleResult extends UploadResult {
  releaseId: string;
}

async function executeImportFile(db: LexiloopDatabase, filePath: string): Promise<number> {
  const text = await readFile(filePath, "utf8");
  let executed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // One statement per generated line; comments and blanks are skipped.
    if (!trimmed.startsWith("INSERT")) continue;
    await db.run(sql.raw(trimmed));
    executed += 1;
  }
  return executed;
}

/**
 * Verify + stage a bundle as an INACTIVE release (status IMPORTING). Never
 * touches app_meta — only `activateRelease` may move the active pointer.
 */
export async function stageBundle(input: {
  db: LexiloopDatabase;
  r2: R2AudioStore;
  /** Verified bundle directory (contains manifest.json). */
  bundleDir: string;
  /** Work directory holding the private audio files (`work/<source-hash>`). */
  audioRoot: string;
  now: number;
}): Promise<StageBundleResult> {
  const { db, r2, bundleDir, audioRoot, now } = input;
  const verified = await verifyBundle(bundleDir);
  if (!verified.ok || !verified.manifest || !verified.manifestSha256) {
    const details = verified.errors.map((error) => `${error.path}: ${error.reason}`).join("; ");
    throw new PublishError("BUNDLE_VERIFY_FAILED", `bundle at ${bundleDir} failed verification: ${details}`);
  }
  const manifest = verified.manifest;
  const releaseId = manifest.release_id;
  const releases = new ReleaseRepository(db);

  if (await releases.getById(releaseId)) {
    throw new PublishError("RELEASE_ALREADY_STAGED", `release ${releaseId} is already staged in D1`);
  }

  await releases.create({
    releaseId,
    sourcePdfSha256: manifest.source_pdf_sha256,
    schemaVersion: manifest.config_versions.schema_version,
    promptVersion: manifest.config_versions.prompt_version,
    modelConfigJson: JSON.stringify(manifest.model_config),
    status: "IMPORTING",
    createdAt: now,
    manifestSha256: verified.manifestSha256,
  });
  for (const unit of manifest.units) {
    await releases.insertUnitReport(releaseId, {
      unitKey: unit.unit_key,
      status: unit.status,
      words: unit.counts.words,
      senses: unit.counts.senses,
      phrases: unit.counts.phrases,
      examples: unit.counts.examples,
      explanations: unit.counts.explanations,
      cards: unit.counts.cards,
    });
  }

  for (const file of ["d1/001-content.sql", "d1/002-cards.sql", "d1/003-search.sql"]) {
    await executeImportFile(db, path.join(bundleDir, file));
  }

  const audioRows = await readJsonl(
    path.join(bundleDir, "r2", "audio-manifest.jsonl"),
    AudioManifestRowSchema,
  );
  const upload = await uploadAudioAssets(r2, audioRows, audioRoot);
  return { releaseId, ...upload };
}

async function scalar(db: LexiloopDatabase, query: SQL): Promise<number> {
  const rows = (await db.all(query)) as Array<{ n?: number | string | null }>;
  return Number(rows[0]?.n ?? 0);
}

export interface SmokeCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

// -- Shared smoke criteria -------------------------------------------------
//
// The pre-activation checks are ONE set of SQL builders and ONE evaluator,
// used by the local driver (drizzle over SQLite) and the remote driver (the
// same statements rendered to literal SQL and run over wrangler) — no
// divergent copies (spec 17).

/** release_unit reports exist for the release. */
export function smokeUnitCountQuery(releaseId: string): SQL {
  return sql`SELECT COUNT(*) AS n FROM release_unit WHERE release_id = ${releaseId}`;
}

/** Per-metric totals the unit reports claim. */
export function smokeExpectedSumsQuery(releaseId: string): SQL {
  return sql`SELECT COALESCE(SUM(words),0) AS words, COALESCE(SUM(senses),0) AS senses,
      COALESCE(SUM(phrases),0) AS phrases, COALESCE(SUM(examples),0) AS examples,
      COALESCE(SUM(explanations),0) AS explanations, COALESCE(SUM(cards),0) AS cards
      FROM release_unit WHERE release_id = ${releaseId}`;
}

/** Per-metric content rows actually imported for the release. */
export function smokeActualCountsQuery(releaseId: string): SQL {
  return sql`SELECT
        (SELECT COUNT(*) FROM word WHERE release_id = ${releaseId}) AS words,
        (SELECT COUNT(*) FROM sense WHERE release_id = ${releaseId}) AS senses,
        (SELECT COUNT(*) FROM phrase WHERE release_id = ${releaseId}) AS phrases,
        (SELECT COUNT(*) FROM example WHERE release_id = ${releaseId}) AS examples,
        (SELECT COUNT(*) FROM explanation WHERE release_id = ${releaseId}) AS explanations,
        (SELECT COUNT(*) FROM card_definition WHERE release_id = ${releaseId}) AS cards`;
}

/** Orphan foreign keys (spec 17: zero dangling references). */
export function smokeOrphansQuery(releaseId: string): SQL {
  return sql`SELECT
        (SELECT COUNT(*) FROM unit c LEFT JOIN book p ON p.release_id = c.release_id AND p.book_key = c.book_key
           WHERE c.release_id = ${releaseId} AND p.book_key IS NULL) AS unit_book,
        (SELECT COUNT(*) FROM word c LEFT JOIN unit p ON p.release_id = c.release_id AND p.unit_key = c.unit_key
           WHERE c.release_id = ${releaseId} AND p.unit_key IS NULL) AS word_unit,
        (SELECT COUNT(*) FROM sense c LEFT JOIN word p ON p.release_id = c.release_id AND p.word_key = c.word_key
           WHERE c.release_id = ${releaseId} AND p.word_key IS NULL) AS sense_word,
        (SELECT COUNT(*) FROM phrase c LEFT JOIN word p ON p.release_id = c.release_id AND p.word_key = c.word_key
           WHERE c.release_id = ${releaseId} AND p.word_key IS NULL) AS phrase_word,
        (SELECT COUNT(*) FROM example c LEFT JOIN word p ON p.release_id = c.release_id AND p.word_key = c.word_key
           WHERE c.release_id = ${releaseId} AND p.word_key IS NULL) AS example_word,
        (SELECT COUNT(*) FROM explanation c LEFT JOIN word p ON p.release_id = c.release_id AND p.word_key = c.word_key
           WHERE c.release_id = ${releaseId} AND p.word_key IS NULL) AS explanation_word,
        (SELECT COUNT(*) FROM card_definition c LEFT JOIN word p ON p.release_id = c.release_id AND p.word_key = c.word_key
           WHERE c.release_id = ${releaseId} AND p.word_key IS NULL) AS card_word,
        (SELECT COUNT(*) FROM content_audio_link c LEFT JOIN audio_asset p ON p.release_id = c.release_id AND p.asset_key = c.asset_key
           WHERE c.release_id = ${releaseId} AND p.asset_key IS NULL) AS link_asset`;
}

/** FTS index rows for the release (parity is judged against content rows). */
export function smokeFtsCountQuery(releaseId: string): SQL {
  return sql`SELECT COUNT(*) AS n FROM content_search_fts WHERE release_id = ${releaseId}`;
}

/** The release's audio asset rows (presence + gate judged per row). */
export function smokeAudioRowsQuery(releaseId: string): SQL {
  return sql`SELECT asset_key, validation FROM audio_asset WHERE release_id = ${releaseId}`;
}

export interface SmokeChecksInput {
  unitReportCount: number;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  orphans: Record<string, unknown>;
  ftsCount: number;
  audio: { missing: number; unvalidated: number };
}

/**
 * The pre-activation verdicts (spec 17) over raw query results: unit report
 * presence, report/content row parity, orphan FKs, FTS parity, and audio
 * object presence + gate. Both drivers feed this the same way.
 */
export function evaluateSmokeChecks(data: SmokeChecksInput): SmokeCheck[] {
  const { expected, actual } = data;
  const checks: SmokeCheck[] = [];
  const check = (name: string, passed: boolean, detail?: string): void => {
    checks.push({ name, passed, ...(detail !== undefined ? { detail } : {}) });
  };

  // release_unit totals vs content rows (spec 17: zero partial units).
  check("unit_reports_present", data.unitReportCount > 0);
  for (const metric of ["words", "senses", "phrases", "examples", "explanations", "cards"] as const) {
    check(
      `row_counts_${metric}`,
      Number(expected[metric] ?? 0) === Number(actual[metric] ?? 0),
      `release_unit sums ${Number(expected[metric] ?? 0)} vs content rows ${Number(actual[metric] ?? 0)}`,
    );
  }

  // Orphan foreign keys (spec 17: zero dangling references).
  let orphanTotal = 0;
  for (const value of Object.values(data.orphans)) {
    orphanTotal += Number(value ?? 0);
  }
  check(
    "foreign_keys",
    orphanTotal === 0,
    orphanTotal === 0 ? undefined : `dangling references: ${JSON.stringify(data.orphans)}`,
  );

  // FTS parity (spec 6.3: index must cover headwords, glosses, phrases, examples).
  const searchable =
    Number(actual["words"] ?? 0) + Number(actual["senses"] ?? 0) + Number(actual["phrases"] ?? 0) + Number(actual["examples"] ?? 0);
  check("fts_sync", data.ftsCount === searchable, `index rows ${data.ftsCount} vs searchable content ${searchable}`);

  // Audio: every asset present in private R2 and gate-passed (spec 5.8/17).
  check(
    "audio_objects",
    data.audio.missing === 0 && data.audio.unvalidated === 0,
    data.audio.missing === 0 && data.audio.unvalidated === 0
      ? undefined
      : `${data.audio.missing} object(s) missing from R2, ${data.audio.unvalidated} not gate-passed`,
  );
  return checks;
}

/**
 * Pre-activation validation (spec 17): row totals, foreign keys, FTS parity,
 * and audio object presence. IMPORTING -> VALIDATING -> READY on success,
 * FAILED on any failure; the active pointer is never touched.
 */
export async function smokeRelease(input: {
  db: LexiloopDatabase;
  r2: R2AudioStore;
  releaseId: string;
}): Promise<{ releaseId: string; checks: SmokeCheck[] }> {
  const { db, r2, releaseId } = input;
  const releases = new ReleaseRepository(db);
  const release = await releases.getById(releaseId);
  if (!release) {
    throw new PublishError("RELEASE_NOT_FOUND", `release ${releaseId} is not staged`);
  }
  if (release.status !== "IMPORTING") {
    throw new PublishError("RELEASE_BAD_STATUS", `release ${releaseId} is ${release.status}, expected IMPORTING`);
  }
  await releases.updateStatus(releaseId, "VALIDATING");

  const unitReportCount = await scalar(db, smokeUnitCountQuery(releaseId));
  const expected = (
    (await db.all(smokeExpectedSumsQuery(releaseId))) as Array<Record<string, number | string | null>>
  )[0] ?? {};
  const actual = (
    (await db.all(smokeActualCountsQuery(releaseId))) as Array<Record<string, number | string | null>>
  )[0] ?? {};
  const orphans = ((await db.all(smokeOrphansQuery(releaseId))) as Array<Record<string, number | string | null>>)[0] ?? {};
  const ftsCount = await scalar(db, smokeFtsCountQuery(releaseId));

  // Audio: every asset present in private R2 and gate-passed (spec 5.8/17).
  const assets = (await db.all(smokeAudioRowsQuery(releaseId))) as Array<{
    asset_key: string;
    validation: string;
  }>;
  let missingAudio = 0;
  let unvalidatedAudio = 0;
  for (const asset of assets) {
    if (!(await r2.head(asset["asset_key"]))) missingAudio += 1;
    if (asset["validation"] !== "PASSED") unvalidatedAudio += 1;
  }

  const checks = evaluateSmokeChecks({
    unitReportCount,
    expected,
    actual,
    orphans,
    ftsCount,
    audio: { missing: missingAudio, unvalidated: unvalidatedAudio },
  });
  const failed = checks.filter((candidate) => !candidate.passed);
  if (failed.length > 0) {
    await releases.updateStatus(releaseId, "FAILED");
    throw new PublishError(
      "SMOKE_FAILED",
      `release ${releaseId} failed pre-activation checks: ${failed.map((candidate) => candidate.name).join(", ")}`,
    );
  }
  await releases.updateStatus(releaseId, "READY");
  return { releaseId, checks };
}

export interface ActivateResult {
  releaseId: string;
  previousReleaseId: string | null;
  aliasesImported: number;
}

/**
 * The ONLY active-pointer writer (spec 6.4/11.3): target must be READY.
 * When alias edges are provided they are validated (structure, endpoint
 * existence, user-state collapse) BEFORE the atomic activation batch imports
 * them and switches app_meta; any failure leaves state and pointer unchanged.
 */
export async function activateRelease(input: {
  db: LexiloopDatabase;
  releaseId: string;
  /** Explicitly declared typed alias edges (validated before the batch). */
  aliases?: readonly unknown[];
  now: number;
}): Promise<ActivateResult> {
  const { db, releaseId, now } = input;
  const releases = new ReleaseRepository(db);
  const release = await releases.getById(releaseId);
  if (!release) {
    throw new PublishError("RELEASE_NOT_FOUND", `release ${releaseId} is not staged`);
  }
  if (release.status !== "READY") {
    throw new PublishError("RELEASE_NOT_READY", `release ${releaseId} is ${release.status}, expected READY`);
  }

  const aliasRows =
    input.aliases !== undefined ? await prepareAliasBatch(db, input.aliases, now) : [];

  const previousReleaseId = (await releases.getMeta())?.activeReleaseId ?? null;
  try {
    await releases.activateBatch({ releaseId, activatedAt: now, aliasRows });
  } catch (err) {
    throw new PublishError(
      "ACTIVATION_FAILED",
      `activation batch for ${releaseId} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { releaseId, previousReleaseId, aliasesImported: aliasRows.length };
}

/**
 * Rollback (spec 6.4/11.3): re-activate a RETIRED release. No user state is
 * rewritten and no new aliases are declared — pinned and new sessions simply
 * present the older keys again, and both resolve to the same canonical state.
 */
export async function rollbackRelease(input: {
  db: LexiloopDatabase;
  releaseId: string;
  now: number;
}): Promise<ActivateResult> {
  const { db, releaseId, now } = input;
  const releases = new ReleaseRepository(db);
  const release = await releases.getById(releaseId);
  if (!release) {
    throw new PublishError("RELEASE_NOT_FOUND", `release ${releaseId} is not staged`);
  }
  if (release.status !== "RETIRED") {
    throw new PublishError("RELEASE_NOT_RETIRED", `release ${releaseId} is ${release.status}, expected RETIRED`);
  }
  const previousReleaseId = (await releases.getMeta())?.activeReleaseId ?? null;
  try {
    await releases.activateBatch({ releaseId, activatedAt: now, aliasRows: [] });
  } catch (err) {
    throw new PublishError(
      "ACTIVATION_FAILED",
      `rollback batch for ${releaseId} failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { releaseId, previousReleaseId, aliasesImported: 0 };
}
