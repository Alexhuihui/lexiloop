/**
 * Remote release publishing through the Wrangler CLI (spec 5.9/6.4/11.3/17,
 * Task 19): the SAME verify -> stage -> smoke -> activate | rollback lifecycle
 * as publish.ts, applied to the production Cloudflare bindings — D1 via
 * `wrangler d1 execute --remote` and the private audio bucket via
 * `wrangler r2 object`.
 *
 * Invariants carried over from the local flow, unchanged:
 * - `verify` stays local: the bundle manifest is re-hashed on disk before any
 *   remote call (the manifest is the root of trust).
 * - `stage` uploads every manifest audio asset (content-addressed keys, so an
 *   object is never written under two different byte streams) and imports the
 *   bundle SQL as a NEW release in IMPORTING status with a release row +
 *   release_unit preamble identical to `ReleaseRepository.create`/
 *   `insertUnitReport`; app_meta is NEVER touched.
 * - `smoke` runs the pre-activation checks as remote SQL through the SAME
 *   statement builders and the SAME evaluator as local mode
 *   (evaluateSmokeChecks). Audio needs no object traffic: stage JUST
 *   uploaded every manifest asset with verified success (exit status,
 *   retried), so the check verifies every imported audio_asset row is
 *   gate-passed and backed by a manifest asset of this verified bundle.
 *   Any failure records FAILED and never moves the pointer.
 * - `activate`/`rollback` render the EXACT statement list of the activation
 *   batch (buildActivationBatchStatements) and apply it sequentially, pointer
 *   switch LAST: a failure anywhere stops BEFORE the pointer switch, so the
 *   previous release keeps serving. wrangler has no batch mode — D1's batch()
 *   atomicity exists only inside the Worker at runtime; the publish-time
 *   window between promotion and pointer switch is documented in
 *   docs/runbooks/publish-and-rollback.md and a failed-then-resumed
 *   activation (target ACTIVE, pointer not yet moved) completes the switch.
 * - There is no --force and no status override: every status move is judged
 *   against the same legal transition table `ReleaseRepository.updateStatus`
 *   uses, and every wrangler invocation's result is parsed — a command that
 *   fails or returns unparseable output is a NAMED failure, never a pass.
 *
 * R2 idempotence note: wrangler has no `r2 object head`; an
 * existence/etag probe would mean downloading every object. Uploads are
 * therefore UNCONDITIONAL — keys are content-addressed (sha-256 of the WAV,
 * verified against the manifest before upload), so a re-upload writes
 * identical bytes and the operation stays idempotent end to end. `reused` is
 * always 0 in remote mode. Each put retries up to 3 attempts with a short
 * backoff (5s/15s); three consecutive failures abort the run fail-closed
 * (nothing has been staged yet at upload time, and no pointer can move).
 * Upload progress prints one line per 50 assets (`uploaded K/total`).
 *
 * The wrangler spawn boundary is injected (`WranglerCli`: argument arrays in,
 * structured results out); production wires spawnSync over the repo-local
 * wrangler binary, tests inject fakes.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import {
  assertStatusTransition,
  buildActivationBatchStatements,
  sqlUpdateReleaseStatus,
  type ActivationAliasRow,
} from "@lexiloop/db";
import { AudioManifestRowSchema } from "../tts/cache";
import { readJsonl } from "../media";
import {
  PublishError,
  evaluateSmokeChecks,
  smokeActualCountsQuery,
  smokeAudioRowsQuery,
  smokeExpectedSumsQuery,
  smokeFtsCountQuery,
  smokeOrphansQuery,
  smokeUnitCountQuery,
  uploadAudioAssets,
  type ActivateResult,
  type R2AudioStore,
  type SmokeCheck,
} from "./publish";
import { verifyBundle } from "./validate";
import {
  prepareAliasBatchFromData,
  type AliasValidationSource,
  type StoredAliasEdge,
} from "./aliases";

export type Row = Record<string, unknown>;

/** One wrangler invocation's observable outcome (spawn boundary). */
export interface WranglerResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * The wrangler invocation boundary. Production wires the real CLI
 * (createWranglerCli); tests inject fakes at exactly this seam.
 */
export interface WranglerCli {
  run(argv: readonly string[], input?: Uint8Array): Promise<WranglerResult>;
}

/** The remote bindings publish tooling talks to (from infra/wrangler/wrangler.toml). */
export interface RemoteTarget {
  configPath: string;
  d1Database: string;
  r2Bucket: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const WRANGLER_BIN = join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const WRANGLER_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// wrangler output parsing (the one parser for every d1 --json invocation)
// ---------------------------------------------------------------------------

/** First JSON array found in wrangler's mixed output, or null if absent. */
function extractJsonArray(stdout: string): unknown[] | null {
  const start = stdout.indexOf("[");
  if (start === -1) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, stdout.lastIndexOf("]") + 1));
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * Result rows of `wrangler d1 execute --json`: both wrangler output shapes
 * (per-statement `results` object arrays and column/row tuples) flatten to
 * plain row objects.
 */
export function parseWranglerRows(stdout: string): Row[] {
  const parsed = extractJsonArray(stdout);
  if (parsed === null) {
    throw new Error("no JSON payload in wrangler output");
  }
  const rows: Row[] = [];
  for (const element of parsed) {
    const results = (element as { results?: unknown }).results;
    if (Array.isArray(results)) {
      for (const row of results) {
        if (typeof row === "object" && row !== null) {
          rows.push(row as Row);
        }
      }
    } else if (results !== undefined && typeof results === "object" && results !== null) {
      const shaped = results as { columns?: string[]; rows?: unknown[][] };
      const columns = shaped.columns ?? [];
      for (const tuple of shaped.rows ?? []) {
        const row: Row = {};
        columns.forEach((column, index) => {
          row[column] = tuple[index];
        });
        rows.push(row);
      }
    }
  }
  return rows;
}

/** Per-statement success flags of a `wrangler d1 execute --file --json` run. */
function parseWranglerExecutions(stdout: string): Array<{ success: boolean }> {
  const parsed = extractJsonArray(stdout);
  if (parsed === null) {
    throw new Error("no JSON payload in wrangler output");
  }
  return parsed.map((element) => ({
    success: (element as { success?: unknown } | null)?.success !== false,
  }));
}

// ---------------------------------------------------------------------------
// SQL rendering: drizzle statements (the same objects the repositories build)
// rendered to literal SQL text D1 executes identically.
// ---------------------------------------------------------------------------

const DIALECT = new SQLiteSyncDialect();

function renderLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  throw new PublishError(
    "REMOTE_SQL_RENDER_FAILED",
    `cannot render parameter of type ${typeof value} into remote SQL`,
  );
}

/**
 * Renders a drizzle statement to literal SQL for `d1 execute --command`.
 * Safe here because every statement this module renders binds only
 * strings/numbers (ids, keys, counts) — inlined with single-quote doubling,
 * exactly the bytes D1's driver would bind.
 */
export function renderSqlText(statement: SQL): string {
  const query = DIALECT.sqlToQuery(statement);
  if (!query.sql.includes("?")) {
    return query.sql;
  }
  let out = "";
  let paramIndex = 0;
  for (const character of query.sql) {
    if (character === "?") {
      out += renderLiteral(query.params[paramIndex]);
      paramIndex += 1;
      continue;
    }
    out += character;
  }
  return out;
}

// ---------------------------------------------------------------------------
// wrangler invocation helpers (argv arrays, results always parsed)
// ---------------------------------------------------------------------------

const d1ExecuteArgs = (target: RemoteTarget): string[] => [
  "d1",
  "execute",
  target.d1Database,
  "--remote",
  "--config",
  target.configPath,
  "--json",
];

async function requireOk(cli: WranglerCli, argv: readonly string[], input?: Uint8Array): Promise<WranglerResult> {
  const result = await cli.run(argv, input);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "wrangler failed").trim().split("\n")[0];
    throw new PublishError("WRANGLER_FAILED", `wrangler ${argv.slice(0, 3).join(" ")} failed: ${detail}`);
  }
  return result;
}

/** One remote SQL statement; returns its result rows. */
async function remoteD1Query(cli: WranglerCli, target: RemoteTarget, statement: SQL): Promise<Row[]> {
  const text = renderSqlText(statement);
  const result = await requireOk(cli, [...d1ExecuteArgs(target), "--command", text]);
  try {
    return parseWranglerRows(result.stdout);
  } catch (err) {
    throw new PublishError(
      "WRANGLER_OUTPUT_INVALID",
      `wrangler output for "${text.slice(0, 60)}" is not parseable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Applies one bundle SQL file; every statement must report success. */
async function remoteD1File(cli: WranglerCli, target: RemoteTarget, filePath: string): Promise<void> {
  const result = await requireOk(cli, [...d1ExecuteArgs(target), "--file", filePath]);
  let executions: Array<{ success: boolean }>;
  try {
    executions = parseWranglerExecutions(result.stdout);
  } catch (err) {
    throw new PublishError(
      "WRANGLER_OUTPUT_INVALID",
      `wrangler output for import file ${filePath} is not parseable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (executions.some((execution) => !execution.success)) {
    throw new PublishError("WRANGLER_FAILED", `import file ${filePath} reported a failed statement`);
  }
}

/** Unconditional content-addressed upload (`r2 object put --pipe`), retried. */
const PUT_MAX_ATTEMPTS = 3;
const PUT_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000];

const defaultSleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function remoteR2Put(
  cli: WranglerCli,
  target: RemoteTarget,
  objectKey: string,
  body: Uint8Array,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await cli.run(
      ["r2", "object", "put", `${target.r2Bucket}/${objectKey}`, "--remote", "--config", target.configPath, "--pipe"],
      body,
    );
    if (result.status === 0) {
      return;
    }
    if (attempt >= PUT_MAX_ATTEMPTS) {
      const detail = (result.stderr || result.stdout || "wrangler failed").trim().split("\n")[0];
      throw new PublishError(
        "WRANGLER_FAILED",
        `r2 object put ${objectKey} failed after ${attempt} attempts: ${detail}`,
      );
    }
    await sleep(PUT_RETRY_DELAYS_MS[attempt - 1] ?? 0);
  }
}

/** The R2AudioStore port wired to wrangler, so `uploadAudioAssets` is reused verbatim. */
function remoteAudioStore(cli: WranglerCli, target: RemoteTarget, sleep: (ms: number) => Promise<void>): R2AudioStore {
  return {
    // Uploads are unconditional (see module doc): no existence probe exists
    // worth its cost, and stage's verified puts (exit status, retried) are
    // the presence proof this run relies on.
    async head() {
      return null;
    },
    async put(objectKey, body) {
      await remoteR2Put(cli, target, objectKey, body, sleep);
    },
  };
}

// ---------------------------------------------------------------------------
// Remote probes shared by the lifecycle phases
// ---------------------------------------------------------------------------

async function remoteReleaseStatus(cli: WranglerCli, target: RemoteTarget, releaseId: string): Promise<string> {
  const rows = await remoteD1Query(
    cli,
    target,
    sql`SELECT status FROM content_release WHERE release_id = ${releaseId}`,
  );
  const status = rows[0]?.["status"];
  if (typeof status !== "string") {
    throw new PublishError("RELEASE_NOT_FOUND", `release ${releaseId} is not staged`);
  }
  return status;
}

async function remoteActivePointer(cli: WranglerCli, target: RemoteTarget): Promise<string | null> {
  const rows = await remoteD1Query(cli, target, sql`SELECT active_release_id FROM app_meta WHERE id = 1`);
  const pointer = rows[0]?.["active_release_id"];
  return typeof pointer === "string" && pointer.length > 0 ? pointer : null;
}

/** One legal status move (same transition table as `updateStatus`). */
async function remoteTransitionStatus(
  cli: WranglerCli,
  target: RemoteTarget,
  releaseId: string,
  from: string,
  to: string,
): Promise<void> {
  assertStatusTransition(from, to, releaseId);
  await remoteD1Query(cli, target, sqlUpdateReleaseStatus(releaseId, to));
}

// ---------------------------------------------------------------------------
// stage / smoke / activate / rollback
// ---------------------------------------------------------------------------

/** Bundle files applied to remote D1, in order (deterministic bundle layout). */
const IMPORT_FILES = ["d1/001-content.sql", "d1/002-cards.sql", "d1/003-search.sql"] as const;

/** One upload-progress line per N assets (`uploaded K/total`). */
const UPLOAD_PROGRESS_EVERY = 50;

export interface RemoteStageResult {
  releaseId: string;
  manifestSha256: string;
  uploaded: number;
  reused: number;
}

/**
 * Verify + stage the bundle against the remote bindings: uploads every
 * manifest audio asset (unconditional, retried — see `remoteR2Put`), then
 * creates the release row (IMPORTING) and unit reports with the SAME
 * statements the local repositories issue, then applies the three bundle
 * import files in order. app_meta is NEVER touched.
 */
export async function remoteStageBundle(input: {
  cli: WranglerCli;
  target: RemoteTarget;
  bundleDir: string;
  privateRoot: string;
  now: number;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RemoteStageResult> {
  const { cli, target, bundleDir, privateRoot, now } = input;
  const log = input.log ?? (() => {});
  const sleep = input.sleep ?? defaultSleep;
  const verified = await verifyBundle(bundleDir);
  if (!verified.ok || !verified.manifest || !verified.manifestSha256) {
    const details = verified.errors.map((error) => `${error.path}: ${error.reason}`).join("; ");
    throw new PublishError("BUNDLE_VERIFY_FAILED", `bundle at ${bundleDir} failed verification: ${details}`);
  }
  const manifest = verified.manifest;
  const releaseId = manifest.release_id;

  const existing = await remoteD1Query(
    cli,
    target,
    sql`SELECT COUNT(*) AS n FROM content_release WHERE release_id = ${releaseId}`,
  );
  if (Number(existing[0]?.["n"] ?? 0) > 0) {
    throw new PublishError("RELEASE_ALREADY_STAGED", `release ${releaseId} is already staged in D1`);
  }

  const audioRows = await readJsonl(join(bundleDir, "r2", "audio-manifest.jsonl"), AudioManifestRowSchema);
  const audioRoot = join(privateRoot, "work", manifest.source_pdf_sha256);
  const upload = await uploadAudioAssets(remoteAudioStore(cli, target, sleep), audioRows, audioRoot, (done, total) => {
    if (done % UPLOAD_PROGRESS_EVERY === 0 || done === total) {
      log(`uploaded ${done}/${total}`);
    }
  });

  // Release-status preamble: the release row in IMPORTING + its unit reports,
  // the same column list and values ReleaseRepository.create/insertUnitReport
  // write locally.
  await remoteD1Query(
    cli,
    target,
    sql`INSERT INTO content_release (release_id, source_pdf_sha256, schema_version, prompt_version, model_config_json, status, created_at, activated_at, manifest_sha256) VALUES (${releaseId}, ${manifest.source_pdf_sha256}, ${manifest.config_versions.schema_version}, ${manifest.config_versions.prompt_version}, ${JSON.stringify(manifest.model_config)}, 'IMPORTING', ${now}, NULL, ${verified.manifestSha256})`,
  );
  for (const unit of manifest.units) {
    await remoteD1Query(
      cli,
      target,
      sql`INSERT INTO release_unit (release_id, unit_key, status, words, senses, phrases, examples, explanations, cards, qa_summary) VALUES (${releaseId}, ${unit.unit_key}, ${unit.status}, ${unit.counts.words}, ${unit.counts.senses}, ${unit.counts.phrases}, ${unit.counts.examples}, ${unit.counts.explanations}, ${unit.counts.cards}, NULL)`,
    );
  }

  for (const file of IMPORT_FILES) {
    await remoteD1File(cli, target, join(bundleDir, file));
  }
  return { releaseId, manifestSha256: verified.manifestSha256, ...upload };
}

/**
 * Pre-activation validation against the remote bindings (spec 17): the SAME
 * statements and the SAME evaluator as local smoke. The audio check needs no
 * object traffic: stage JUST uploaded every manifest asset with verified
 * success (exit status, retried), so presence is a fact of this run — the
 * check instead verifies every imported audio_asset row is gate-passed and
 * backed by an asset of the verified manifest (a row outside the manifest
 * could not have been uploaded and counts as missing).
 */
export async function remoteSmokeRelease(input: {
  cli: WranglerCli;
  target: RemoteTarget;
  releaseId: string;
  bundleDir: string;
}): Promise<{ releaseId: string; checks: SmokeCheck[] }> {
  const { cli, target, releaseId, bundleDir } = input;
  const status = await remoteReleaseStatus(cli, target, releaseId);
  if (status !== "IMPORTING") {
    throw new PublishError("RELEASE_BAD_STATUS", `release ${releaseId} is ${status}, expected IMPORTING`);
  }
  await remoteTransitionStatus(cli, target, releaseId, "IMPORTING", "VALIDATING");

  const query = async (statement: SQL): Promise<Row[]> => remoteD1Query(cli, target, statement);
  const scalarOf = async (statement: SQL): Promise<number> =>
    Number(((await query(statement))[0]?.["n"]) ?? 0);

  const unitReportCount = await scalarOf(smokeUnitCountQuery(releaseId));
  const expected = (await query(smokeExpectedSumsQuery(releaseId)))[0] ?? {};
  const actual = (await query(smokeActualCountsQuery(releaseId)))[0] ?? {};
  const orphans = (await query(smokeOrphansQuery(releaseId)))[0] ?? {};
  const ftsCount = await scalarOf(smokeFtsCountQuery(releaseId));

  const audioRows = (await query(smokeAudioRowsQuery(releaseId))) as Array<{
    asset_key: unknown;
    validation: unknown;
  }>;
  const verifiedKeys = new Set(
    (await readJsonl(join(bundleDir, "r2", "audio-manifest.jsonl"), AudioManifestRowSchema)).map(
      (row) => row.object_key,
    ),
  );
  let missingAudio = 0;
  let unvalidatedAudio = 0;
  for (const row of audioRows) {
    if (!verifiedKeys.has(String(row["asset_key"]))) missingAudio += 1;
    if (row["validation"] !== "PASSED") unvalidatedAudio += 1;
  }

  // The SAME evaluator local mode feeds (no divergent copies).
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
    await remoteTransitionStatus(cli, target, releaseId, "VALIDATING", "FAILED");
    throw new PublishError(
      "SMOKE_FAILED",
      `release ${releaseId} failed pre-activation checks: ${failed.map((candidate) => candidate.name).join(", ")}`,
    );
  }
  await remoteTransitionStatus(cli, target, releaseId, "VALIDATING", "READY");
  return { releaseId, checks };
}

/**
 * The ONLY remote pointer writer (spec 6.4/11.3): renders the activation
 * batch's statements and applies them sequentially — alias upserts, demotion
 * of the previous ACTIVE release, promotion, pointer switch LAST. Any
 * failure stops before the pointer switch (the previous release keeps
 * serving). A target already ACTIVE whose pointer was not moved is the
 * documented interrupted-activation state and completes the switch.
 */
export async function remoteActivateRelease(input: {
  cli: WranglerCli;
  target: RemoteTarget;
  releaseId: string;
  /** Alias edges (AliasFileSchema-parsed) validated against the remote data. */
  aliases?: readonly unknown[];
  now: number;
}): Promise<ActivateResult> {
  const { cli, target, releaseId, now } = input;
  const status = await remoteReleaseStatus(cli, target, releaseId);
  const previousReleaseId = await remoteActivePointer(cli, target);
  const resuming =
    status === "ACTIVE" && previousReleaseId !== null && previousReleaseId !== releaseId;
  if (status !== "READY" && status !== "RETIRED" && !resuming) {
    throw new PublishError("RELEASE_NOT_READY", `release ${releaseId} is ${status}, expected READY or RETIRED`);
  }

  let aliasRowCount = 0;
  let aliasRows: ActivationAliasRow[] = [];
  if (input.aliases !== undefined) {
    aliasRows = await prepareAliasBatchFromData(input.aliases, remoteAliasSource(cli, target), now);
    aliasRowCount = aliasRows.length;
  }

  // The EXACT statement list the D1 batch runs at runtime — alias upserts
  // first, pointer switch last — applied sequentially (wrangler has no batch
  // mode); a failure anywhere stops before the pointer switch.
  const statements = buildActivationBatchStatements({
    releaseId,
    activatedAt: now,
    previousActiveId: previousReleaseId,
    aliasRows,
  });
  for (const statement of statements) {
    await remoteD1Query(cli, target, statement);
  }

  await assertActivated(cli, target, releaseId);
  return { releaseId, previousReleaseId, aliasesImported: aliasRowCount };
}

/**
 * Rollback (spec 6.4/11.3): re-activate a RETIRED release remotely. Same
 * demote/promote/pointer statements, no new aliases; user state is never
 * rewritten.
 */
export async function remoteRollbackRelease(input: {
  cli: WranglerCli;
  target: RemoteTarget;
  releaseId: string;
  now: number;
}): Promise<ActivateResult> {
  const { cli, target, releaseId, now } = input;
  const status = await remoteReleaseStatus(cli, target, releaseId);
  if (status !== "RETIRED") {
    throw new PublishError("RELEASE_NOT_RETIRED", `release ${releaseId} is ${status}, expected RETIRED`);
  }
  const previousReleaseId = await remoteActivePointer(cli, target);
  const statements = buildActivationBatchStatements({
    releaseId,
    activatedAt: now,
    previousActiveId: previousReleaseId,
    aliasRows: [],
  });
  for (const statement of statements) {
    await remoteD1Query(cli, target, statement);
  }
  await assertActivated(cli, target, releaseId);
  return { releaseId, previousReleaseId, aliasesImported: 0 };
}

/** Post-activation integrity: the pointer and the target status must stick. */
async function assertActivated(cli: WranglerCli, target: RemoteTarget, releaseId: string): Promise<void> {
  const pointer = await remoteActivePointer(cli, target);
  if (pointer !== releaseId) {
    throw new PublishError(
      "ACTIVATION_FAILED",
      `activation of ${releaseId} did not stick: app_meta points at ${pointer ?? "none"}`,
    );
  }
  const status = await remoteReleaseStatus(cli, target, releaseId);
  if (status !== "ACTIVE") {
    throw new PublishError("ACTIVATION_FAILED", `activation of ${releaseId} did not stick: status is ${status}`);
  }
}

/** The alias gates' data source fetched over wrangler (same rules, remote rows). */
function remoteAliasSource(cli: WranglerCli, target: RemoteTarget): AliasValidationSource {
  const source: AliasValidationSource = {
    async storedEdges(): Promise<readonly StoredAliasEdge[]> {
      const rows = await remoteD1Query(
        cli,
        target,
        sql`SELECT release_id, from_key, to_key, canonical_key FROM content_key_alias`,
      );
      return rows.map((row) => ({
        releaseId: String(row["release_id"] ?? ""),
        fromKey: String(row["from_key"] ?? ""),
        toKey: String(row["to_key"] ?? ""),
        canonicalKey: String(row["canonical_key"] ?? ""),
      }));
    },
    endpointExists: async (entityType, releaseId, key) => {
      const table = entityType === "word" ? "word" : "card_definition";
      const keyColumn = entityType === "word" ? "word_key" : "content_card_key";
      const rows = await remoteD1Query(
        cli,
        target,
        sql`SELECT COUNT(*) AS n FROM ${sql.raw(table)} WHERE release_id = ${releaseId} AND ${sql.raw(keyColumn)} = ${key}`,
      );
      return Number(rows[0]?.["n"] ?? 0) > 0;
    },
    async stateRows(keys) {
      if (keys.length === 0) return { progress: [], cards: [] };
      const keysSql = sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `,
      );
      const progress = await remoteD1Query(
        cli,
        target,
        sql`SELECT user_id, word_key FROM word_progress WHERE word_key IN (${keysSql})`,
      );
      const cards = await remoteD1Query(
        cli,
        target,
        sql`SELECT user_id, content_card_key FROM card_state WHERE content_card_key IN (${keysSql})`,
      );
      return {
        progress: progress.map((row) => ({ userId: String(row["user_id"] ?? ""), wordKey: String(row["word_key"] ?? "") })),
        cards: cards.map((row) => ({
          userId: String(row["user_id"] ?? ""),
          contentCardKey: String(row["content_card_key"] ?? ""),
        })),
      };
    },
  };
  return source;
}

// ---------------------------------------------------------------------------
// Lifecycle orchestrator (the script's --remote branch is a thin wrapper)
// ---------------------------------------------------------------------------

export interface RemotePublishOutcome {
  releaseId: string;
  manifestSha256: string;
  uploaded: number;
  reused: number;
  checks: readonly SmokeCheck[];
  activation: ActivateResult | null;
  activeReleaseId: string | null;
}

/**
 * verify -> stage -> smoke -> activate over the remote bindings, with the
 * local flow's ordering and fail-closed semantics. `activate: false`
 * (--no-activate) stops after READY. No check can be skipped and no status
 * override exists.
 */
export async function runRemotePublish(input: {
  cli: WranglerCli;
  target: RemoteTarget;
  bundleDir: string;
  privateRoot: string;
  aliases?: readonly unknown[];
  activate: boolean;
  now: number;
  log?: (line: string) => void;
  /** Retry backoff override (tests); default sleeps 5s/15s between put attempts. */
  sleep?: (ms: number) => Promise<void>;
}): Promise<RemotePublishOutcome> {
  const { cli, target, bundleDir, privateRoot, now } = input;
  const log = input.log ?? (() => {});

  // verify: unchanged, local — the manifest is the root of trust.
  const verified = await verifyBundle(bundleDir);
  if (!verified.ok || !verified.manifest || !verified.manifestSha256) {
    for (const error of verified.errors) {
      log(`verify FAIL ${error.path}: ${error.reason}`);
    }
    throw new PublishError(
      "BUNDLE_VERIFY_FAILED",
      `bundle at ${bundleDir} failed verification: ${verified.errors.map((error) => `${error.path}: ${error.reason}`).join("; ")}`,
    );
  }
  log(
    `verify OK: release ${verified.manifest.release_id} (${verified.manifest.files.length} file(s), ` +
      `manifest ${verified.manifestSha256.slice(0, 12)})`,
  );

  const staged = await remoteStageBundle({ cli, target, bundleDir, privateRoot, now, log, ...(input.sleep !== undefined ? { sleep: input.sleep } : {}) });
  log(
    `stage OK: release ${staged.releaseId} IMPORTING (audio uploaded=${staged.uploaded} reused=${staged.reused}; app_meta untouched)`,
  );

  const smoke = await remoteSmokeRelease({ cli, target, releaseId: staged.releaseId, bundleDir });
  for (const check of smoke.checks) {
    log(`smoke ${check.passed ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  }
  log(`smoke OK: release ${staged.releaseId} READY`);

  if (!input.activate) {
    log("activation skipped (--no-activate); the old release stays ACTIVE");
    return {
      releaseId: staged.releaseId,
      manifestSha256: staged.manifestSha256,
      uploaded: staged.uploaded,
      reused: staged.reused,
      checks: smoke.checks,
      activation: null,
      activeReleaseId: null,
    };
  }

  const activated = await remoteActivateRelease({
    cli,
    target,
    releaseId: staged.releaseId,
    ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
    now,
  });
  log(
    `activate OK: release ${activated.releaseId} ACTIVE (previous ${activated.previousReleaseId ?? "none"}, ` +
      `aliases ${activated.aliasesImported})`,
  );
  const activeReleaseId = await remoteActivePointer(cli, target);
  log(`active release: ${activeReleaseId ?? "none"}`);
  return {
    releaseId: staged.releaseId,
    manifestSha256: staged.manifestSha256,
    uploaded: staged.uploaded,
    reused: staged.reused,
    checks: smoke.checks,
    activation: activated,
    activeReleaseId,
  };
}

// ---------------------------------------------------------------------------
// Production seam: the real wrangler CLI (spawned with argument arrays)
// ---------------------------------------------------------------------------

/** Production runner: the repo-local wrangler binary against real bindings. */
export function createWranglerCli(): WranglerCli {
  return {
    run(argv: readonly string[], input?: Uint8Array): Promise<WranglerResult> {
      const result = spawnSync(process.execPath, [WRANGLER_BIN, ...argv], {
        cwd: REPO_ROOT,
        timeout: WRANGLER_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
        ...(input !== undefined ? { input: Buffer.from(input) } : {}),
      });
      return Promise.resolve({
        status: result.status ?? 1,
        stdout: result.stdout?.toString("utf8") ?? "",
        stderr: result.error !== undefined ? `${String(result.error)}` : (result.stderr?.toString("utf8") ?? ""),
      });
    },
  };
}

/** Remote target from the untracked production wrangler.toml (+ CLI overrides). */
export function readWranglerTarget(
  configPath: string,
  overrides: { d1Database?: string; r2Bucket?: string } = {},
): RemoteTarget {
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new PublishError(
      "REMOTE_CONFIG_MISSING",
      `wrangler config ${configPath} is unreadable (${err instanceof Error ? err.message : String(err)}); ` +
        "remote publishing needs the real bindings (see docs/runbooks/publish-and-rollback.md)",
    );
  }
  const d1Database =
    overrides.d1Database ??
    /database_name\s*=\s*"([^"]+)"/.exec(content)?.[1] ??
    /database_id\s*=\s*"([^"]+)"/.exec(content)?.[1] ??
    null;
  const r2Bucket = overrides.r2Bucket ?? /bucket_name\s*=\s*"([^"]+)"/.exec(content)?.[1] ?? null;
  const missing = [
    d1Database === null ? "D1 database_name (or database_id)" : null,
    r2Bucket === null ? "R2 bucket_name" : null,
  ].filter((entry) => entry !== null);
  if (missing.length > 0) {
    throw new PublishError(
      "REMOTE_CONFIG_MISSING",
      `wrangler config ${configPath} is missing ${missing.join(" and ")}; ` +
        "pass --d1-database/--r2-bucket or fill in infra/wrangler/wrangler.toml",
    );
  }
  return { configPath, d1Database: d1Database!, r2Bucket: r2Bucket! };
}
