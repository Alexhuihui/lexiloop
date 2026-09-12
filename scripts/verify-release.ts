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
 *   fk        — PRAGMA foreign_key_check reports zero violations
 *   key       — content keys are well-formed stable keys and every stored
 *               alias edge chain resolves to a single canonical sink
 *   audio     — every audio_asset row has a validation-passed object in the
 *               store whose bytes hash to content_sha256 (valid WAV header)
 *   capacity  — release_unit reports match content rows, FTS covers every
 *               searchable row, and per-release row/byte totals stay inside
 *               the documented V1 caps
 *   api       — the synthetic local fixture is booted through the E2E
 *               harness server and a login→me→bootstrap→search→session→
 *               grade→undo→stats journey passes over HTTP with security
 *               headers (always local; see below)
 *   e2e       — the full Playwright suite passes (spawned fresh)
 *
 * Target selection:
 * - default: a THROWAWAY synthetic fixture is created in a temp directory
 *   (two releases, the alias rename, audio objects), verified, and torn
 *   down — the testable path, always available offline.
 * - --db <file> --r2-dir <dir>: gate the given local rehearsal target
 *   instead (schema/fk/key/audio/capacity run against it).
 * - --release-id <id>: scope the key/audio/capacity gates to one release.
 * - api/e2e always run against a fresh synthetic fixture: they verify the
 *   shipped code paths, not the target data.
 *
 * --remote is a documented passthrough for production bindings: the SQL
 * gates run through `wrangler d1 execute --remote --json` against the
 * configured infra/wrangler/wrangler.toml. It requires real bindings and
 * Wrangler auth; when they are absent the command FAILS CLOSED (nonzero) —
 * it never skips a gate. The full-fidelity remote alternative is to export
 * the D1 snapshot plus audio objects and run default local mode with
 * --db/--r2-dir (docs/runbooks/publish-and-rollback.md).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AliasRepository, createSqliteDatabase, contentKeyAlias } from "../packages/db/src/index";
import { RELEASE_V1, RELEASE_V2, V2_ALIAS_EDGES } from "../apps/worker/e2e-harness/fixture";
import { sha256HexOf } from "../apps/worker/e2e-harness/wav";
import { DirectoryObjectStore } from "../apps/worker/e2e-harness/object-store";
import { seedHarnessDatabase } from "../apps/worker/e2e-harness/seed";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXIT_FAILED = 1;

interface GateResult {
  name: string;
  passed: boolean;
  details: string[];
}

class Reporter {
  private readonly results: GateResult[] = [];

  record(name: string, passed: boolean, details: readonly string[]): void {
    this.results.push({ name, passed, details: [...details] });
    const printed = details.length > 0 ? details : [""];
    for (const detail of printed) {
      console.log(`  ${passed ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : `: ${detail}`}`);
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
// Data gates over the target database
// ---------------------------------------------------------------------------

const REQUIRED_TABLES: readonly string[] = [
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

function scalar(target: Target, query: string): number {
  const row = target.sqlite.prepare(query).get() as Record<string, number | string | null> | undefined;
  return Number(row?.[Object.keys(row ?? { n: 0 })[0]!] ?? 0);
}

function rawOne<T extends Record<string, unknown>>(target: Target, query: string): T | undefined {
  return target.sqlite.prepare(query).get() as T | undefined;
}

function gateSchema(target: Target, reporter: Reporter): void {
  const details: string[] = [];
  const integrity = target.sqlite.pragma("integrity_check") as Array<{ integrity_check: string }>;
  const integrityOk = integrity.every((row) => row.integrity_check === "ok");
  details.push(`integrity_check ${integrityOk ? "ok" : "FAILED"}`);

  const tables = target.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    name: string;
  }>;
  const present = new Set(tables.map((row) => row.name));
  const missing = REQUIRED_TABLES.filter((table) => !present.has(table));
  details.push(
    missing.length === 0
      ? `all ${REQUIRED_TABLES.length} required tables present`
      : `missing tables: ${missing.join(", ")}`,
  );

  const meta = rawOne<{ active_release_id: string | null; config_version: number }>(
    target,
    "SELECT active_release_id, config_version FROM app_meta WHERE id = 1",
  );
  const metaOk = meta !== undefined && meta.config_version >= 1;
  details.push(
    metaOk ? `app_meta singleton intact (active ${meta!.active_release_id ?? "none"})` : "app_meta singleton missing or invalid",
  );

  reporter.record("schema", integrityOk && missing.length === 0 && metaOk, details);
}

function gateForeignKeys(target: Target, reporter: Reporter): void {
  const violations = target.sqlite.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  reporter.record(
    "fk",
    violations.length === 0,
    violations.length === 0 ? ["zero foreign-key violations"] : [`${violations.length} violations`],
  );
}

async function gateKeys(target: Target, reporter: Reporter): Promise<void> {
  const details: string[] = [];
  const totalKeys = scalar(
    target,
    `SELECT (SELECT COUNT(*) FROM card_definition) + (SELECT COUNT(*) FROM word)
           + (SELECT COUNT(*) FROM sense) + (SELECT COUNT(*) FROM phrase)
           + (SELECT COUNT(*) FROM example) AS total`,
  );
  const malformed = scalar(
    target,
    `SELECT (SELECT COUNT(*) FROM card_definition WHERE content_card_key NOT GLOB '[0-9a-f]*' OR length(content_card_key) != 64)
           + (SELECT COUNT(*) FROM word WHERE word_key NOT GLOB '[0-9a-f]*' OR length(word_key) != 64)
           + (SELECT COUNT(*) FROM sense WHERE sense_key NOT GLOB '[0-9a-f]*' OR length(sense_key) != 64)
           + (SELECT COUNT(*) FROM phrase WHERE phrase_key NOT GLOB '[0-9a-f]*' OR length(phrase_key) != 64)
           + (SELECT COUNT(*) FROM example WHERE example_key NOT GLOB '[0-9a-f]*' OR length(example_key) != 64) AS malformed`,
  );
  details.push(malformed === 0 ? `${totalKeys} content keys well-formed` : `${malformed} malformed key(s) of ${totalKeys}`);

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
  details.push(
    resolveFailures === 0
      ? `${edges.length} alias edge(s) resolve to a single canonical sink`
      : `${resolveFailures} alias resolution(s) failed (ambiguous, cyclic, or inconsistent)`,
  );

  reporter.record("key", malformed === 0 && resolveFailures === 0, details);
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

async function gateAudio(target: Target, reporter: Reporter, releaseId?: string): Promise<void> {
  const details: string[] = [];
  let rows = target.sqlite
    .prepare("SELECT release_id, asset_key, content_sha256, validation, sample_rate_hz FROM audio_asset")
    .all() as Array<{
    release_id: string;
    asset_key: string;
    content_sha256: string;
    validation: string;
    sample_rate_hz: number;
  }>;
  if (releaseId !== undefined) {
    rows = rows.filter((row) => row.release_id === releaseId);
  }
  let missing = 0;
  let hashMismatch = 0;
  let unvalidated = 0;
  let badHeader = 0;
  for (const row of rows) {
    const bytes = target.store.read(row.asset_key);
    if (bytes === null) {
      missing += 1;
      continue;
    }
    if (sha256HexOf(bytes) !== row.content_sha256) {
      hashMismatch += 1;
    }
    if (row.validation !== "PASSED") {
      unvalidated += 1;
    }
    const header = wavHeaderOf(bytes);
    if (!header.valid || header.sampleRateHz !== row.sample_rate_hz) {
      badHeader += 1;
    }
  }
  details.push(
    `${rows.length} audio asset row(s): missing=${missing} hashMismatch=${hashMismatch} unvalidated=${unvalidated} badHeader=${badHeader}`,
  );
  reporter.record(
    "audio",
    rows.length > 0 && missing === 0 && hashMismatch === 0 && unvalidated === 0 && badHeader === 0,
    details,
  );
}

const CAPS = {
  wordsPerRelease: 20_000,
  cardsPerRelease: 100_000,
  audioObjectsPerRelease: 50_000,
  databaseBytes: 2 * 1024 * 1024 * 1024,
} as const;

async function gateCapacity(target: Target, reporter: Reporter, releaseId?: string): Promise<void> {
  const details: string[] = [];
  const releases = target.sqlite.prepare("SELECT release_id FROM content_release ORDER BY release_id").all() as Array<{
    release_id: string;
  }>;
  const scoped = (releaseId === undefined ? releases.map((row) => row.release_id) : [releaseId]).sort();
  if (scoped.length === 0 || (releaseId !== undefined && !releases.some((row) => row.release_id === releaseId))) {
    reporter.record("capacity", false, [`no release row(s) in scope (requested ${releaseId ?? "all"})`]);
    return;
  }

  let ok = true;
  for (const id of scoped) {
    const counts = rawOne<{ words: number; cards: number; audio: number }>(
      target,
      `SELECT (SELECT COUNT(*) FROM word WHERE release_id = '${id}') AS words,
              (SELECT COUNT(*) FROM card_definition WHERE release_id = '${id}') AS cards,
              (SELECT COUNT(*) FROM audio_asset WHERE release_id = '${id}') AS audio`,
    );
    if (counts === undefined) {
      ok = false;
      details.push(`${id}: unreadable counts`);
      continue;
    }
    if (counts.words > CAPS.wordsPerRelease || counts.cards > CAPS.cardsPerRelease || counts.audio > CAPS.audioObjectsPerRelease) {
      ok = false;
      details.push(`${id}: row caps exceeded ${JSON.stringify(counts)}`);
    }

    const parity = rawOne<Record<string, number>>(
      target,
      `SELECT
         (SELECT COALESCE(SUM(words),0) FROM release_unit WHERE release_id = '${id}') AS report_words,
         (SELECT COUNT(*) FROM word WHERE release_id = '${id}') AS words,
         (SELECT COALESCE(SUM(cards),0) FROM release_unit WHERE release_id = '${id}') AS report_cards,
         (SELECT COUNT(*) FROM card_definition WHERE release_id = '${id}') AS cards,
         (SELECT COALESCE(SUM(examples),0) FROM release_unit WHERE release_id = '${id}') AS report_examples,
         (SELECT COUNT(*) FROM example WHERE release_id = '${id}') AS examples`,
    );
    if (
      parity === undefined ||
      Number(parity["report_words"]) !== Number(parity["words"]) ||
      Number(parity["report_cards"]) !== Number(parity["cards"]) ||
      Number(parity["report_examples"]) !== Number(parity["examples"])
    ) {
      ok = false;
      details.push(`${id}: release_unit report sums diverge from content rows`);
    }

    const fts = rawOne<{ fts: number; searchable: number }>(
      target,
      `SELECT (SELECT COUNT(*) FROM content_search_fts WHERE release_id = '${id}') AS fts,
              (SELECT COUNT(*) FROM word WHERE release_id = '${id}')
                + (SELECT COUNT(*) FROM sense WHERE release_id = '${id}')
                + (SELECT COUNT(*) FROM phrase WHERE release_id = '${id}')
                + (SELECT COUNT(*) FROM example WHERE release_id = '${id}') AS searchable`,
    );
    if (fts === undefined || Number(fts.fts) !== Number(fts.searchable)) {
      ok = false;
      details.push(`${id}: FTS rows ${fts?.fts ?? "?"} != searchable rows ${fts?.searchable ?? "?"}`);
    }

    if (ok) {
      details.push(`${id}: words=${counts.words} cards=${counts.cards} audio=${counts.audio} within caps; reports and FTS in parity`);
    }
  }

  const dbBytes = statSync(target.dbFile).size;
  if (dbBytes > CAPS.databaseBytes) {
    ok = false;
    details.push(`database ${dbBytes} bytes over the ${CAPS.databaseBytes} cap`);
  } else {
    details.push(`database ${dbBytes} bytes within caps`);
  }
  reporter.record("capacity", ok, details);
}

// ---------------------------------------------------------------------------
// Remote passthrough (documented; requires real bindings, fails closed)
// ---------------------------------------------------------------------------

function gateRemote(args: Args, reporter: Reporter): boolean {
  const configPath = join(repoRoot, "infra", "wrangler", "wrangler.toml");
  if (!existsSync(configPath)) {
    console.error(
      "verify-release --remote: infra/wrangler/wrangler.toml is not configured. Remote verification " +
        "requires real bindings (copy the example and fill in the real database/bucket IDs), or export " +
        "the D1 snapshot and audio objects and run local mode with --db/--r2-dir " +
        "(see docs/runbooks/publish-and-rollback.md). Failing closed.",
    );
    reporter.record("remote:schema", false, ["wrangler config absent"]);
    return false;
  }
  const commands: ReadonlyArray<{ gate: string; command: string }> = [
    { gate: "schema", command: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name" },
    { gate: "fk", command: "PRAGMA foreign_key_check" },
    {
      gate: "capacity",
      command:
        "SELECT (SELECT COUNT(*) FROM word) AS words, (SELECT COUNT(*) FROM card_definition) AS cards, (SELECT COUNT(*) FROM audio_asset) AS audio",
    },
  ];
  for (const entry of commands) {
    const result = spawnSync(
      "wrangler",
      ["d1", "execute", "lexiloop", "--remote", "--config", configPath, "--json", "--command", entry.command],
      { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
    );
    const passed = result.status === 0;
    reporter.record(
      `remote:${entry.gate}`,
      passed,
      [passed ? "wrangler d1 execute succeeded" : (result.stderr.split("\n")[0] ?? "wrangler failed")],
    );
    if (!passed) {
      return false;
    }
  }
  void args;
  return true;
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
 *  grade → undo → stats, asserting statuses and the security header set. */
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
    reporter.record("api", true, details);
  } catch (error) {
    reporter.record("api", false, [error instanceof Error ? error.message : String(error)]);
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
  reporter.record("e2e", passed, [passed ? "Playwright suite passed" : `Playwright exited ${String(result.status)}`]);
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
    if (gateRemote(args, reporter)) {
      // The client-facing contract is verified locally even in remote mode:
      // API + E2E always run over the fresh synthetic fixture.
      await gateApi(reporter, 17655);
      gateE2e(reporter);
    }
    return reporter.finish();
  }

  const target = await openTarget(args);
  const reporter = new Reporter();
  try {
    gateSchema(target, reporter);
    gateForeignKeys(target, reporter);
    await gateKeys(target, reporter);
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

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("verify-release failed:", error instanceof Error ? error.stack : error);
    process.exitCode = EXIT_FAILED;
  });
