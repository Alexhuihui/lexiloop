/**
 * verify-release — the release verification gate (plan Task 18 step 3).
 *
 * Runs EVERY gate, in order, and exits nonzero when ANY gate fails. There is
 * deliberately no bypass/skip flag: a release is verified or it is not.
 *
 *   tsx scripts/verify-release.ts [--db <sqlite-file> --r2-dir <dir>]
 *                                 [--release-id <id>] [--remote]
 *
 * Gates (all must pass):
 *   schema    — integrity_check, every required table present (incl. the FTS
 *               table), app_meta singleton intact
 *   fk        — foreign_key_check reports zero violations
 *   key       — content keys are well-formed stable keys and every stored
 *               alias edge chain resolves to a single canonical sink
 *   audio     — every audio_asset row has a validation-passed object whose
 *               bytes hash to content_sha256 (valid WAV header)
 *   capacity  — release_unit reports match content rows, FTS covers every
 *               searchable row, and per-release row/byte totals stay inside
 *               the documented V1 caps
 *   api       — the synthetic local fixture is booted through the E2E
 *               harness server and a login→me→bootstrap→search→session→
 *               grade→replay→undo→stats journey passes over HTTP with
 *               security headers
 *   e2e       — the full Playwright suite passes (spawned fresh)
 *
 * EXACTLY what --remote does and does not cover (it never skips a gate and
 * never passes a gate it did not run):
 * - schema/fk/key/capacity run the SAME SQL and the SAME shared evaluators
 *   as local mode, against the configured D1 via
 *   `wrangler d1 execute lexiloop --remote --json`. Result rows are parsed
 *   and judged; a command that cannot execute records a NAMED SKIP that
 *   counts as a gate FAILURE (fail closed).
 * - key: the malformed-key SQL is identical to local; alias-chain integrity
 *   is judged by a recursive-CTE probe (ambiguity / cycle / sink mismatch)
 *   through the same evaluator local mode feeds its resolve() failures into.
 * - audio: every audio_asset row is fetched from the private bucket via
 *   `wrangler r2 object get <bucket>/<key> --pipe` and judged by the same
 *   per-object checker as local mode (hash, WAV header, validation). More
 *   than REMOTE_AUDIO_BUDGET (1000) rows is a gate FAILURE directing the
 *   operator to the documented export path, never a silent truncation; a
 *   bucket that cannot be configured is a NAMED SKIP counted as a failure.
 * - api/e2e always run locally over a fresh synthetic fixture (they verify
 *   the shipped code paths, not the target data).
 * - The database file-size sub-check is local-only (a remote target has no
 *   file); it is reported as such in the capacity details, never skipped
 *   silently.
 *
 * Target selection:
 * - default: a THROWAWAY synthetic fixture is created in a temp directory
 *   (two releases, the alias rename, audio objects), verified, and torn
 *   down — the testable path, always available offline.
 * - --db <file> --r2-dir <dir>: gate the given local rehearsal target
 *   instead (schema/fk/key/audio/capacity run against it).
 * - --release-id <id>: scope the key/audio/capacity gates to one release.
 *
 * The full-fidelity alternative for a remote release remains: export the D1
 * snapshot plus audio objects and run default local mode with --db/--r2-dir
 * (docs/runbooks/publish-and-rollback.md).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { AliasRepository, createSqliteDatabase, contentKeyAlias } from "../packages/db/src/index";
import { RELEASE_V1, RELEASE_V2, V2_ALIAS_EDGES } from "../apps/worker/e2e-harness/fixture";
import { sha256HexOf } from "../apps/worker/e2e-harness/wav";
import { DirectoryObjectStore } from "../apps/worker/e2e-harness/object-store";
import { seedHarnessDatabase } from "../apps/worker/e2e-harness/seed";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXIT_FAILED = 1;
const REMOTE_AUDIO_BUDGET = 1_000;

// ---------------------------------------------------------------------------
// Shared gate criteria: SQL + pure evaluators used by BOTH modes
// ---------------------------------------------------------------------------

export const REQUIRED_TABLES: readonly string[] = [
  "app_meta",
  "auth_session",
  "book",
  "card_definition",
  "card_state",
  "content_audio_link",
  "content_key_alias",
  "content_release",
  "content_search_fts",
  "example",
  "explanation",
  "lexical_relation",
  "phrase",
  "release_unit",
  "review_log",
  "sense",
  "study_session",
  "unit",
  "user_settings",
  "word",
  "word_progress",
];

/** The same malformed-stable-key probe local and remote modes run. */
function sqlMalformedKeyCount(releaseId?: string): string {
  const scope = releaseId === undefined ? "" : ` WHERE release_id = '${releaseId}'`;
  return `SELECT
     (SELECT COUNT(*) FROM card_definition${scope} WHERE content_card_key NOT GLOB '[0-9a-f]*' OR length(content_card_key) != 64)
   + (SELECT COUNT(*) FROM word${scope} WHERE word_key NOT GLOB '[0-9a-f]*' OR length(word_key) != 64)
   + (SELECT COUNT(*) FROM sense${scope} WHERE sense_key NOT GLOB '[0-9a-f]*' OR length(sense_key) != 64)
   + (SELECT COUNT(*) FROM phrase${scope} WHERE phrase_key NOT GLOB '[0-9a-f]*' OR length(phrase_key) != 64)
   + (SELECT COUNT(*) FROM example${scope} WHERE example_key NOT GLOB '[0-9a-f]*' OR length(example_key) != 64) AS malformed,
   (SELECT COUNT(*) FROM card_definition${scope}) + (SELECT COUNT(*) FROM word${scope})
   + (SELECT COUNT(*) FROM sense${scope}) + (SELECT COUNT(*) FROM phrase${scope})
   + (SELECT COUNT(*) FROM example${scope}) AS total`;
}

const SQL_AUDIO_ROWS = "SELECT asset_key, content_sha256, validation, sample_rate_hz FROM audio_asset";

function sqlCapacityCounts(releaseId: string): string {
  return `SELECT (SELECT COUNT(*) FROM word WHERE release_id = '${releaseId}') AS words,
                 (SELECT COUNT(*) FROM card_definition WHERE release_id = '${releaseId}') AS cards,
                 (SELECT COUNT(*) FROM audio_asset WHERE release_id = '${releaseId}') AS audio`;
}

function sqlCapacityParity(releaseId: string): string {
  return `SELECT
     (SELECT COALESCE(SUM(words),0) FROM release_unit WHERE release_id = '${releaseId}') AS report_words,
     (SELECT COUNT(*) FROM word WHERE release_id = '${releaseId}') AS words,
     (SELECT COALESCE(SUM(cards),0) FROM release_unit WHERE release_id = '${releaseId}') AS report_cards,
     (SELECT COUNT(*) FROM card_definition WHERE release_id = '${releaseId}') AS cards,
     (SELECT COALESCE(SUM(examples),0) FROM release_unit WHERE release_id = '${releaseId}') AS report_examples,
     (SELECT COUNT(*) FROM example WHERE release_id = '${releaseId}') AS examples`;
}

function sqlCapacityFts(releaseId: string): string {
  return `SELECT (SELECT COUNT(*) FROM content_search_fts WHERE release_id = '${releaseId}') AS fts,
                 (SELECT COUNT(*) FROM word WHERE release_id = '${releaseId}')
                   + (SELECT COUNT(*) FROM sense WHERE release_id = '${releaseId}')
                   + (SELECT COUNT(*) FROM phrase WHERE release_id = '${releaseId}')
                   + (SELECT COUNT(*) FROM example WHERE release_id = '${releaseId}') AS searchable`;
}

/**
 * Remote-only alias probe (local mode walks with AliasRepository.resolve):
 * one-to-many fan-out, runaway walks (cycles), and walks whose terminal key
 * is not the stored canonical root.
 */
const SQL_ALIAS_INTEGRITY = `WITH RECURSIVE chain(origin, current, canonical, depth) AS (
     SELECT from_key, to_key, canonical_key, 0 FROM content_key_alias
     UNION ALL
     SELECT c.origin, e.to_key, c.canonical, c.depth + 1
     FROM chain c JOIN content_key_alias e ON e.from_key = c.current
     WHERE c.depth < 64
   )
   SELECT
     (SELECT COUNT(*) FROM (SELECT from_key FROM content_key_alias GROUP BY from_key HAVING COUNT(*) > 1)) AS ambiguous,
     (SELECT COUNT(*) FROM chain WHERE depth >= 64) AS cyclic,
     (SELECT COUNT(*) FROM chain c
        WHERE c.depth >= 1
          AND NOT EXISTS (SELECT 1 FROM content_key_alias n WHERE n.from_key = c.current)
          AND c.current != c.canonical) AS bad_sink`;

export interface GateVerdict {
  passed: boolean;
  details: string[];
}

/** Shared schema criteria: integrity, required tables, app_meta singleton. */
export function evaluateSchema(input: {
  integrityOk: boolean;
  tableNames: string[];
  meta: { active_release_id: string | null; config_version: number } | null;
}): GateVerdict {
  const details: string[] = [];
  details.push(`integrity_check ${input.integrityOk ? "ok" : "FAILED"}`);
  const present = new Set(input.tableNames);
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  details.push(
    missing.length === 0
      ? `all ${REQUIRED_TABLES.length} required tables present`
      : `missing tables: ${missing.join(", ")}`,
  );
  const metaOk = input.meta !== null && input.meta.config_version >= 1;
  details.push(
    metaOk
      ? `app_meta singleton intact (active ${input.meta!.active_release_id ?? "none"})`
      : "app_meta singleton missing or invalid",
  );
  return { passed: input.integrityOk && missing.length === 0 && metaOk, details };
}

/** Shared FK criteria: zero foreign-key violations. */
export function evaluateForeignKeys(violationCount: number): GateVerdict {
  return {
    passed: violationCount === 0,
    details: [violationCount === 0 ? "zero foreign-key violations" : `${violationCount} violations`],
  };
}

/**
 * Shared key criteria: well-formed stable keys and alias chains that all
 * resolve to a single canonical sink. Local mode counts resolve() failures
 * through AliasRepository; remote mode maps its CTE probe (ambiguity, cycle,
 * sink mismatch) into the same aliasFailureCount.
 */
export function evaluateKeys(input: {
  totalKeys: number;
  malformed: number;
  aliasFailureCount: number;
  aliasFailureDetail: string;
}): GateVerdict {
  const details: string[] = [];
  details.push(
    input.malformed === 0
      ? `${input.totalKeys} content keys well-formed`
      : `${input.malformed} malformed key(s) of ${input.totalKeys}`,
  );
  details.push(
    input.aliasFailureCount === 0
      ? input.aliasFailureDetail
      : `${input.aliasFailureCount} alias resolution failure(s): ${input.aliasFailureDetail}`,
  );
  return {
    passed: input.malformed === 0 && input.aliasFailureCount === 0,
    details,
  };
}

/** Minimal WAV header parse: RIFF/WAVE + PCM fmt chunk; also reads rate. */
function wavHeaderOf(bytes: Uint8Array): { valid: boolean; sampleRateHz: number } {
  if (bytes.length < 44) {
    return { valid: false, sampleRateHz: 0 };
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    valid:
      buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WAVE" &&
      buffer.toString("ascii", 12, 16) === "fmt " &&
      buffer.readUInt16LE(20) === 1,
    sampleRateHz: buffer.readUInt32LE(24),
  };
}

/** One audio row's verdict — the SAME check local and remote modes apply. */
function audioRowProblem(
  bytes: Uint8Array | null,
  row: { content_sha256: string; validation: string; sample_rate_hz: number },
): string | null {
  if (bytes === null) {
    return "missing";
  }
  if (sha256HexOf(bytes) !== row.content_sha256) {
    return "hashMismatch";
  }
  if (row.validation !== "PASSED") {
    return "unvalidated";
  }
  const header = wavHeaderOf(bytes);
  if (!header.valid || header.sampleRateHz !== row.sample_rate_hz) {
    return "badHeader";
  }
  return null;
}

/** Shared audio criteria over per-row problems. */
export function evaluateAudio(
  rows: number,
  problems: { missing: number; hashMismatch: number; unvalidated: number; badHeader: number },
): GateVerdict {
  const details = [
    `${rows} audio asset row(s): missing=${problems.missing} hashMismatch=${problems.hashMismatch} ` +
      `unvalidated=${problems.unvalidated} badHeader=${problems.badHeader}`,
  ];
  return {
    passed: rows > 0 && problems.missing === 0 && problems.hashMismatch === 0 && problems.unvalidated === 0 && problems.badHeader === 0,
    details,
  };
}

const CAPS = {
  wordsPerRelease: 20_000,
  cardsPerRelease: 100_000,
  audioObjectsPerRelease: 50_000,
  databaseBytes: 2 * 1024 * 1024 * 1024,
} as const;

export interface CapacityReleaseCheck {
  releaseId: string;
  counts: { words: number; cards: number; audio: number };
  parity: Record<string, number> | null;
  fts: { fts: number; searchable: number } | null;
}

/** Shared capacity criteria over per-release checks (+ local-only size). */
export function evaluateCapacity(
  releases: readonly CapacityReleaseCheck[],
  dbBytes: number | null,
): GateVerdict {
  const details: string[] = [];
  let ok = releases.length > 0;
  if (releases.length === 0) {
    details.push("no release row(s) in scope");
  }
  for (const release of releases) {
    if (
      release.counts.words > CAPS.wordsPerRelease ||
      release.counts.cards > CAPS.cardsPerRelease ||
      release.counts.audio > CAPS.audioObjectsPerRelease
    ) {
      ok = false;
      details.push(`${release.releaseId}: row caps exceeded ${JSON.stringify(release.counts)}`);
    }
    if (
      release.parity === null ||
      Number(release.parity["report_words"]) !== Number(release.parity["words"]) ||
      Number(release.parity["report_cards"]) !== Number(release.parity["cards"]) ||
      Number(release.parity["report_examples"]) !== Number(release.parity["examples"])
    ) {
      ok = false;
      details.push(`${release.releaseId}: release_unit report sums diverge from content rows`);
    }
    if (release.fts === null || Number(release.fts.fts) !== Number(release.fts.searchable)) {
      ok = false;
      details.push(
        `${release.releaseId}: FTS rows ${release.fts?.fts ?? "?"} != searchable rows ${release.fts?.searchable ?? "?"}`,
      );
    }
    if (ok) {
      details.push(
        `${release.releaseId}: words=${release.counts.words} cards=${release.counts.cards} audio=${release.counts.audio} within caps; reports and FTS in parity`,
      );
    }
  }
  if (dbBytes === null) {
    details.push("database file-size check: local mode only (a remote target has no file)");
  } else if (dbBytes > CAPS.databaseBytes) {
    ok = false;
    details.push(`database ${dbBytes} bytes over the ${CAPS.databaseBytes} cap`);
  } else {
    details.push(`database ${dbBytes} bytes within caps`);
  }
  return { passed: ok, details };
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

interface GateResult {
  name: string;
  passed: boolean;
  details: string[];
}

class Reporter {
  private readonly results: GateResult[] = [];

  record(name: string, verdict: GateVerdict): void {
    this.results.push({ name, passed: verdict.passed, details: verdict.details });
    const printed = verdict.details.length > 0 ? verdict.details : [""];
    for (const detail of printed) {
      console.log(`  ${verdict.passed ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`);
    }
  }

  recordVerdicts(prefix: string, verdicts: ReadonlyArray<{ gate: string; verdict: GateVerdict }>): void {
    for (const { gate, verdict } of verdicts) {
      this.record(`${prefix}:${gate}`, verdict);
    }
  }

  finish(): number {
    const failed = this.results.filter((result) => !result.passed);
    console.log("");
    console.log(`verify-release: ${this.results.length - failed.length}/${this.results.length} gates passed`);
    for (const result of failed) {
      console.log(`  GATE FAILED: ${result.name}`);
    }
    return failed.length === 0 ? 0 : EXIT_FAILED;
  }
}

/** A gate that could not execute: a NAMED SKIP that counts as a FAILURE. */
function namedSkip(gate: string, reason: string): { gate: string; verdict: GateVerdict } {
  return { gate, verdict: { passed: false, details: [`SKIP (${gate}): ${reason} — failing closed`] } };
}

// ---------------------------------------------------------------------------
// Arguments and target handling
// ---------------------------------------------------------------------------

interface Args {
  db?: string;
  r2Dir?: string;
  releaseId?: string;
  remote: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { remote: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--db":
        args.db = resolve(value!);
        index += 1;
        break;
      case "--r2-dir":
        args.r2Dir = resolve(value!);
        index += 1;
        break;
      case "--release-id":
        args.releaseId = value;
        index += 1;
        break;
      case "--remote":
        args.remote = true;
        break;
      default:
        console.error(`verify-release: unknown argument ${String(argv[index])}`);
        process.exit(2);
    }
  }
  if ((args.db === undefined) !== (args.r2Dir === undefined)) {
    console.error("verify-release: --db and --r2-dir must be given together");
    process.exit(2);
  }
  return args;
}

interface Target {
  dbFile: string;
  sqlite: Database.Database;
  store: DirectoryObjectStore;
  /** Directory to remove on teardown (absent for an explicit --db target). */
  tempDir?: string;
}

async function openTarget(args: Args): Promise<Target> {
  if (args.db !== undefined && args.r2Dir !== undefined) {
    if (!existsSync(args.db)) {
      throw new Error(`target database not found: ${args.db}`);
    }
    return {
      dbFile: args.db,
      sqlite: new Database(args.db),
      store: new DirectoryObjectStore(args.r2Dir),
    };
  }
  // Default: a throwaway synthetic fixture (the testable path), including
  // the stored alias edges an activated v2 leaves behind.
  const tempDir = mkdtempSync(join(tmpdir(), "lexiloop-verify-"));
  const dbFile = join(tempDir, "d1.sqlite");
  const sqlite = new Database(dbFile);
  const store = new DirectoryObjectStore(join(tempDir, "r2-private"));
  const seeded = await seedHarnessDatabase({
    sqlite,
    migrationsDir: join(repoRoot, "infra", "migrations"),
    store,
  });
  const insertEdge = sqlite.prepare(
    "INSERT OR IGNORE INTO content_key_alias (release_id, from_key, to_key, edge_type, canonical_key, created_at) VALUES (?, ?, ?, 'RENAME', ?, ?)",
  );
  sqlite.transaction(() => {
    for (const edge of V2_ALIAS_EDGES) {
      insertEdge.run(edge.from_release_id, edge.from_key, edge.to_key, edge.canonical_key, seeded.startedAt);
    }
  })();
  return { dbFile, sqlite, store, tempDir };
}

// ---------------------------------------------------------------------------
// Local (sqlite + directory store) data gates — shared criteria above
// ---------------------------------------------------------------------------

function gateSchema(target: Target, reporter: Reporter): void {
  const integrity = target.sqlite.pragma("integrity_check") as Array<{ integrity_check: string }>;
  const tables = target.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const meta = target.sqlite.prepare("SELECT active_release_id, config_version FROM app_meta WHERE id = 1").get() as
    | { active_release_id: string | null; config_version: number }
    | undefined;
  reporter.record(
    "schema",
    evaluateSchema({
      integrityOk: integrity.every((row) => row.integrity_check === "ok"),
      tableNames: tables.map((row) => row.name),
      meta: meta ?? null,
    }),
  );
}

function gateForeignKeys(target: Target, reporter: Reporter): void {
  const violations = target.sqlite.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  reporter.record("fk", evaluateForeignKeys(violations.length));
}

function firstNumber(row: Record<string, unknown> | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

async function gateKeys(target: Target, reporter: Reporter, releaseId?: string): Promise<void> {
  // The SAME shared SQL the remote mode runs (identical criteria).
  const keyRow = target.sqlite.prepare(sqlMalformedKeyCount(releaseId)).get() as
    | Record<string, number>
    | undefined;

  const db = createSqliteDatabase(target.sqlite);
  const edges = (await db.select().from(contentKeyAlias)) as Array<{ fromKey: string; toKey: string }>;
  const aliases = new AliasRepository(db);
  const probeKeys = new Set<string>();
  for (const edge of edges) {
    probeKeys.add(edge.fromKey);
    probeKeys.add(edge.toKey);
  }
  let resolveFailures = 0;
  for (const key of probeKeys) {
    try {
      await aliases.resolve({ releaseId: "", key });
    } catch {
      resolveFailures += 1;
    }
  }

  reporter.record(
    "key",
    evaluateKeys({
      totalKeys: firstNumber(keyRow, "total"),
      malformed: firstNumber(keyRow, "malformed"),
      aliasFailureCount: resolveFailures,
      aliasFailureDetail: `${edges.length} alias edge(s) resolve to a single canonical sink`,
    }),
  );
}

async function gateAudio(target: Target, reporter: Reporter, releaseId?: string): Promise<void> {
  const rows = (target.sqlite
    .prepare(releaseId === undefined ? SQL_AUDIO_ROWS : `${SQL_AUDIO_ROWS} WHERE release_id = ?`)
    .all(...(releaseId === undefined ? [] : [releaseId]))) as Array<{
    asset_key: string;
    content_sha256: string;
    validation: string;
    sample_rate_hz: number;
  }>;
  const problems = { missing: 0, hashMismatch: 0, unvalidated: 0, badHeader: 0 };
  for (const row of rows) {
    const problem = audioRowProblem(target.store.read(row.asset_key), row);
    if (problem !== null) {
      problems[problem as keyof typeof problems] += 1;
    }
  }
  reporter.record("audio", evaluateAudio(rows.length, problems));
}

async function gateCapacity(target: Target, reporter: Reporter, releaseId?: string): Promise<void> {
  const releases = target.sqlite.prepare("SELECT release_id FROM content_release ORDER BY release_id").all() as Array<{
    release_id: string;
  }>;
  const scoped = releaseId === undefined ? releases.map((row) => row.release_id) : [releaseId];
  if (releaseId !== undefined && !releases.some((row) => row.release_id === releaseId)) {
    reporter.record("capacity", { passed: false, details: [`no release row(s) in scope (requested ${releaseId})`] });
    return;
  }
  const checks: CapacityReleaseCheck[] = [];
  for (const id of scoped) {
    const counts = (target.sqlite.prepare(sqlCapacityCounts(id)).get() ?? {}) as Record<string, number>;
    const parity = target.sqlite.prepare(sqlCapacityParity(id)).get() as Record<string, number> | undefined;
    const fts = target.sqlite.prepare(sqlCapacityFts(id)).get() as Record<string, number> | undefined;
    checks.push({
      releaseId: id,
      counts: { words: firstNumber(counts, "words"), cards: firstNumber(counts, "cards"), audio: firstNumber(counts, "audio") },
      parity: parity ?? null,
      fts: fts ? { fts: firstNumber(fts, "fts"), searchable: firstNumber(fts, "searchable") } : null,
    });
  }
  reporter.record("capacity", evaluateCapacity(checks, statSync(target.dbFile).size));
}

// ---------------------------------------------------------------------------
// Remote mode: same criteria over wrangler d1/r2, injected runner seam
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

/**
 * The remote invocation boundary. Production wires the real wrangler CLI
 * (createWranglerRunner); tests inject fakes — the same process-injection
 * style the rest of this repo's tests use.
 */
export interface RemoteRunner {
  /** Executes one SQL statement and returns its rows as objects. */
  d1(sql: string): Promise<Row[]>;
  /** Fetches one private-bucket object's bytes, or null when absent. */
  r2Get(key: string): Promise<Uint8Array | null>;
}

/**
 * Runs the schema/fk/key/audio/capacity gates against a remote target and
 * returns every verdict. A command that cannot execute becomes a NAMED SKIP
 * counted as a gate failure — this function never passes a gate it did not
 * run. (api/e2e stay with the caller; they are always local.)
 */
export async function runRemoteDataGates(input: {
  releaseId?: string;
  runner: RemoteRunner;
}): Promise<Array<{ gate: string; verdict: GateVerdict }>> {
  const out: Array<{ gate: string; verdict: GateVerdict }> = [];
  const { runner } = input;
  const commandFailed = (gate: string, error: unknown) =>
    namedSkip(gate, `wrangler command failed: ${error instanceof Error ? error.message : String(error)}`);

  // schema
  try {
    const integrityRows = await runner.d1("PRAGMA integrity_check");
    const integrityOk = integrityRows.length > 0 && integrityRows.every((row) => Object.values(row)[0] === "ok");
    const tableRows = await runner.d1("SELECT name FROM sqlite_master WHERE type = 'table'");
    const metaRows = await runner.d1("SELECT active_release_id, config_version FROM app_meta WHERE id = 1");
    const metaRow = metaRows[0];
    out.push({
      gate: "schema",
      verdict: evaluateSchema({
        integrityOk,
        tableNames: tableRows.map((row) => String(row["name"])),
        meta: metaRow
          ? {
              active_release_id: (metaRow["active_release_id"] as string | null) ?? null,
              config_version: Number(metaRow["config_version"] ?? 0),
            }
          : null,
      }),
    });
  } catch (error) {
    out.push(commandFailed("schema", error));
  }

  // fk
  try {
    const rows = await runner.d1("PRAGMA foreign_key_check");
    out.push({ gate: "fk", verdict: evaluateForeignKeys(rows.length) });
  } catch (error) {
    out.push(commandFailed("fk", error));
  }

  // key
  try {
    const keyRows = await runner.d1(sqlMalformedKeyCount(input.releaseId));
    const keyRow = keyRows[0];
    const aliasRows = await runner.d1(SQL_ALIAS_INTEGRITY);
    const aliasRow = aliasRows[0] ?? {};
    const ambiguous = firstNumber(aliasRow, "ambiguous");
    const cyclic = firstNumber(aliasRow, "cyclic");
    const badSink = firstNumber(aliasRow, "bad_sink");
    out.push({
      gate: "key",
      verdict: evaluateKeys({
        totalKeys: firstNumber(keyRow, "total"),
        malformed: firstNumber(keyRow, "malformed"),
        aliasFailureCount: ambiguous + cyclic + badSink,
        aliasFailureDetail: `remote CTE probe: ambiguous=${ambiguous} cyclic=${cyclic} badSink=${badSink}`,
      }),
    });
  } catch (error) {
    out.push(commandFailed("key", error));
  }

  // audio
  try {
    // Same shared statement as local mode (which appends the same scope).
    const rows = (await runner.d1(
      input.releaseId === undefined ? SQL_AUDIO_ROWS : `${SQL_AUDIO_ROWS} WHERE release_id = '${input.releaseId}'`,
    )) as Array<{
      asset_key: string;
      content_sha256: string;
      validation: string;
      sample_rate_hz: number;
    }>;
    if (rows.length > REMOTE_AUDIO_BUDGET) {
      out.push(
        namedSkip(
          "audio",
          `${rows.length} audio rows exceed the remote verification budget of ${REMOTE_AUDIO_BUDGET}; ` +
            "export the D1 snapshot and audio objects and run local mode with --db/--r2-dir",
        ),
      );
    } else {
      const problems = { missing: 0, hashMismatch: 0, unvalidated: 0, badHeader: 0 };
      for (const row of rows) {
        const bytes = await runner.r2Get(String(row["asset_key"]));
        const problem = audioRowProblem(bytes, {
          content_sha256: String(row["content_sha256"] ?? ""),
          validation: String(row["validation"] ?? ""),
          sample_rate_hz: Number(row["sample_rate_hz"] ?? 0),
        });
        if (problem !== null) {
          problems[problem as keyof typeof problems] += 1;
        }
      }
      out.push({ gate: "audio", verdict: evaluateAudio(rows.length, problems) });
    }
  } catch (error) {
    out.push(commandFailed("audio", error));
  }

  // capacity
  try {
    const releaseRows = await runner.d1("SELECT release_id FROM content_release ORDER BY release_id");
    const releaseIds = releaseRows.map((row) => String(row["release_id"]));
    const scoped = input.releaseId === undefined ? releaseIds : [input.releaseId];
    if (input.releaseId !== undefined && !releaseIds.includes(input.releaseId)) {
      out.push({
        gate: "capacity",
        verdict: { passed: false, details: [`no release row(s) in scope (requested ${input.releaseId})`] },
      });
    } else {
      const checks: CapacityReleaseCheck[] = [];
      for (const id of scoped) {
        const counts = (await runner.d1(sqlCapacityCounts(id)))[0] ?? {};
        const parity = (await runner.d1(sqlCapacityParity(id)))[0] ?? null;
        const fts = (await runner.d1(sqlCapacityFts(id)))[0] ?? null;
        checks.push({
          releaseId: id,
          counts: {
            words: firstNumber(counts, "words"),
            cards: firstNumber(counts, "cards"),
            audio: firstNumber(counts, "audio"),
          },
          parity: parity as Record<string, number> | null,
          fts: fts ? { fts: firstNumber(fts, "fts"), searchable: firstNumber(fts, "searchable") } : null,
        });
      }
      out.push({ gate: "capacity", verdict: evaluateCapacity(checks, null) });
    }
  } catch (error) {
    out.push(commandFailed("capacity", error));
  }

  return out;
}

interface WranglerConfig {
  configPath: string;
  bucket: string | null;
}

function loadWranglerConfig(): WranglerConfig | null {
  const configPath = join(repoRoot, "infra", "wrangler", "wrangler.toml");
  if (!existsSync(configPath)) {
    return null;
  }
  const content = readFileSync(configPath, "utf8");
  const bucket = /bucket_name\s*=\s*"([^"]+)"/.exec(content)?.[1] ?? null;
  return { configPath, bucket };
}

/** First JSON array found in wrangler's mixed output, parsed as rows. */
function parseWranglerRows(stdout: string): Row[] {
  const start = stdout.indexOf("[");
  if (start === -1) {
    throw new Error("no JSON payload in wrangler output");
  }
  const parsed: unknown = JSON.parse(stdout.slice(start, stdout.lastIndexOf("]") + 1));
  if (!Array.isArray(parsed)) {
    throw new Error("unexpected wrangler JSON shape");
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

/** Production runner: the real wrangler CLI against real bindings. */
function createWranglerRunner(config: WranglerConfig): RemoteRunner {
  return {
    async d1(sql: string): Promise<Row[]> {
      const result = spawnSync(
        "wrangler",
        ["d1", "execute", "lexiloop", "--remote", "--config", config.configPath, "--json", "--command", sql],
        { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
      );
      if (result.status !== 0 || result.error) {
        throw new Error((result.stderr || result.stdout || "wrangler failed").trim().split("\n")[0]);
      }
      return parseWranglerRows(result.stdout);
    },
    async r2Get(key: string): Promise<Uint8Array | null> {
      if (config.bucket === null) {
        throw new Error("no r2 bucket configured in wrangler.toml");
      }
      const result = spawnSync(
        "wrangler",
        ["r2", "object", "get", `${config.bucket}/${key}`, "--config", config.configPath, "--pipe"],
        { cwd: repoRoot, encoding: "buffer", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      );
      if (result.status !== 0 || result.error) {
        return null;
      }
      return new Uint8Array(result.stdout);
    },
  };
}

// ---------------------------------------------------------------------------
// API + E2E gates (always local, against a fresh synthetic fixture)
// ---------------------------------------------------------------------------

interface HarnessProcess {
  child: ReturnType<typeof spawn>;
  stateFile: string;
  logs: Buffer[];
}

const TSX_CLI = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

async function startHarness(port: number): Promise<HarnessProcess> {
  const stateFile = join(tmpdir(), `lexiloop-verify-state-${port}.json`);
  rmSync(stateFile, { force: true });
  const child = spawn(process.execPath, [TSX_CLI, "apps/worker/e2e-harness/server.ts", "--port", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LEXILOOP_E2E_STATE_FILE: stateFile },
  });
  const logs: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => logs.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => logs.push(chunk));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`harness exited early (${child.exitCode}):\n${Buffer.concat(logs).toString("utf8")}`);
    }
    if (existsSync(stateFile)) {
      break;
    }
    if (Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`harness not ready in time:\n${Buffer.concat(logs).toString("utf8")}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return { child, stateFile, logs };
}

/** The API gate journey: login → me → bootstrap → search → session →
 *  grade → replay → undo → stats, asserting statuses and security headers. */
async function gateApi(reporter: Reporter, port: number): Promise<void> {
  const details: string[] = [];
  const harness = await startHarness(port);
  try {
    const state = JSON.parse(readFileSync(harness.stateFile, "utf8")) as {
      baseUrl: string;
      users: Array<{ username: string; password: string }>;
    };
    const user = state.users[0]!;
    let cookie: string | null = null;
    let csrf = "";

    const call = async (path: string, body?: unknown): Promise<{ status: number; body: unknown; headers: Headers }> => {
      const headers: Record<string, string> = { origin: state.baseUrl };
      if (cookie !== null) {
        headers["cookie"] = cookie;
      }
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        headers["x-csrf-token"] = csrf;
      }
      const response = await fetch(`${state.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const setCookie = response.headers.get("set-cookie");
      if (setCookie !== null) {
        const match = /lexiloop_session=([^;]+)/.exec(setCookie);
        if (match) {
          cookie = `lexiloop_session=${match[1]!}`;
        }
      }
      const text = await response.text();
      return { status: response.status, body: text === "" ? null : JSON.parse(text), headers: response.headers };
    };

    const expectStatus = (label: string, actual: number, expected: number): void => {
      if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
      }
    };

    const unauth = await call("/api/stats/overview");
    expectStatus("unauthenticated stats", unauth.status, 401);
    if (unauth.headers.get("content-security-policy") === null) {
      throw new Error("security headers missing on API error response");
    }

    const login = await call("/api/auth/login", { username: user.username, password: user.password });
    expectStatus("login", login.status, 200);
    csrf = (login.body as { csrf_token: string }).csrf_token;

    expectStatus("me", (await call("/api/auth/me")).status, 200);

    const bootstrap = (await call("/api/content/bootstrap")) as unknown as {
      status: number;
      body: { release_id: string; units: Array<{ title: string }> };
    };
    expectStatus("bootstrap", bootstrap.status, 200);
    if (bootstrap.body.release_id !== RELEASE_V1) {
      throw new Error(`bootstrap release ${bootstrap.body.release_id} != ${RELEASE_V1}`);
    }

    const search = (await call("/api/content/search?q=anchor")) as unknown as {
      status: number;
      body: { hits: Array<{ headword: string }> };
    };
    expectStatus("search", search.status, 200);
    if (search.body.hits.length === 0) {
      throw new Error("search returned no hits for the seeded headword");
    }

    const session = (await call("/api/study/sessions", { mode: "NEW_WORDS" })) as unknown as {
      status: number;
      body: { session_id: string; cards: Array<{ presented_card_key: string }> };
    };
    expectStatus("study session", session.status, 201);

    const grade = (await call("/api/reviews/grade", {
      event_id: "verify-api-grade",
      session_id: session.body.session_id,
      card_key: session.body.cards[0]!.presented_card_key,
      rating: 3,
    })) as unknown as { status: number; body: { event_id: string; card_key: string; replayed: boolean } };
    expectStatus("grade", grade.status, 200);
    if (grade.body.replayed) {
      throw new Error("fresh grade reported replayed=true");
    }

    const replay = (await call("/api/reviews/grade", {
      event_id: "verify-api-grade",
      session_id: session.body.session_id,
      card_key: session.body.cards[0]!.presented_card_key,
      rating: 3,
    })) as unknown as { status: number; body: { replayed: boolean } };
    expectStatus("grade replay", replay.status, 200);
    if (!replay.body.replayed) {
      throw new Error("duplicate grade did not replay idempotently");
    }

    const undo = (await call(`/api/reviews/verify-api-grade/undo`, {})) as unknown as { status: number };
    expectStatus("undo", undo.status, 200);

    expectStatus("stats", (await call("/api/stats/overview")).status, 200);

    details.push(`api journey passed over ${RELEASE_V1} (+${RELEASE_V2} staged) at port ${port}`);
    reporter.record("api", { passed: true, details });
  } catch (error) {
    reporter.record("api", { passed: false, details: [error instanceof Error ? error.message : String(error)] });
  } finally {
    harness.child.kill("SIGTERM");
    await new Promise((resolveExit) => harness.child.once("exit", resolveExit));
    rmSync(harness.stateFile, { force: true });
  }
}

/** The E2E gate: the full Playwright suite, freshly spawned. */
function gateE2e(reporter: Reporter): number {
  console.log("  running pnpm exec playwright test (six spec files, fresh harness)…");
  const result = spawnSync("pnpm", ["exec", "playwright", "test"], {
    cwd: join(repoRoot, "apps", "web"),
    stdio: "inherit",
    timeout: 20 * 60_000,
  });
  const passed = result.status === 0;
  reporter.record("e2e", {
    passed,
    details: [passed ? "Playwright suite passed" : `Playwright exited ${String(result.status)}`],
  });
  return passed ? 0 : EXIT_FAILED;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  console.log("verify-release: starting (no bypass flag exists; every gate must pass)");

  if (args.remote) {
    const reporter = new Reporter();
    const config = loadWranglerConfig();
    if (config === null) {
      console.error(
        "verify-release --remote: infra/wrangler/wrangler.toml is not configured. Remote verification " +
          "requires real bindings (copy the example and fill in the real database/bucket IDs), or export " +
          "the D1 snapshot and audio objects and run local mode with --db/--r2-dir " +
          "(see docs/runbooks/publish-and-rollback.md). Failing closed.",
      );
      for (const gate of ["schema", "fk", "key", "audio", "capacity"]) {
        reporter.recordVerdicts("remote", [namedSkip(gate, "wrangler config absent")]);
      }
    } else {
      if (config.bucket === null) {
        console.error("verify-release --remote: no r2 bucket_name in wrangler.toml — the audio gate will fail closed.");
      }
      const verdicts = await runRemoteDataGates({ runner: createWranglerRunner(config), releaseId: args.releaseId });
      reporter.recordVerdicts("remote", verdicts);
    }
    // The client-facing contract is verified locally even in remote mode.
    await gateApi(reporter, 17655);
    gateE2e(reporter);
    return reporter.finish();
  }

  const target = await openTarget(args);
  const reporter = new Reporter();
  try {
    gateSchema(target, reporter);
    gateForeignKeys(target, reporter);
    await gateKeys(target, reporter, args.releaseId);
    await gateAudio(target, reporter, args.releaseId);
    await gateCapacity(target, reporter, args.releaseId);
    await gateApi(reporter, 17654);
    const e2eExit = gateE2e(reporter);
    const code = reporter.finish();
    return code === 0 ? e2eExit : code;
  } finally {
    target.sqlite.close();
    if (target.tempDir !== undefined) {
      rmSync(target.tempDir, { recursive: true, force: true });
    }
  }
}

// Run only when executed directly (tests import this module's gates).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error("verify-release failed:", error instanceof Error ? error.stack : error);
      process.exitCode = EXIT_FAILED;
    });
}
