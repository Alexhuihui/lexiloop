/**
 * The deterministic local E2E harness server (plan Task 18 step 3).
 *
 * Hosts the REAL deps-injectable Worker app (apps/worker/src/app.ts) on Node
 * over a D1-shaped better-sqlite3 database plus a directory-backed private
 * object store, and serves the freshly built PWA from apps/web/dist — all
 * from ONE localhost origin, so the browser exercises cookies, CSRF, the
 * Service Worker, and the API exactly as it would in production.
 *
 * Why not `wrangler dev`: the harness must be deterministic, fast, and
 * hermetic per run. The better-sqlite3 driver is the established D1-shaped
 * local stand-in across this repo's whole test suite, and the deps seam the
 * app was built for makes this hosting swap a configuration change, not a
 * fork. Specs stay hosting-agnostic (base-URL injection only).
 *
 * Lifecycle: every run gets a fresh mkdtemp root (sqlite file + audio
 * store). Teardown (SIGTERM/SIGINT) removes EXACTLY that directory and the
 * state file — nothing else. The state file carries the generated synthetic
 * credentials; they are never committed.
 *
 * Harness-only control endpoints (`/__harness/*`, never exposed beyond
 * localhost) drive the REAL release lifecycle functions and an injectable
 * clock so the activation/rollback/expiry journeys are testable end to end.
 *
 * Type-universe note: the worker sources are written against Cloudflare
 * Workers types and the compiler sources against plain Node types; the two
 * global sets cannot coexist in one tsc program. This harness is a pure Node
 * program, so it loads the worker app and the publish module through
 * COMPUTED dynamic import specifiers — tsc keeps them opaque (no cross-type
 * pollution) while tsx runs the authentic code. The seams they cover are
 * exactly what the E2E suite continuously proves at runtime.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createSqliteDatabase, type LexiloopDatabase } from "@lexiloop/db";
import type { AliasEdge } from "@lexiloop/domain";
import { DirectoryObjectStore } from "./object-store";
import { seedHarnessDatabase, type HarnessUser } from "./seed";
import { E2E_PORT, e2eStateFile } from "../../web/e2e/support/runtime";

/** Structural mirror of the subset of WorkerDeps the harness provides. */
interface HarnessWorkerDeps {
  db: LexiloopDatabase;
  loginRateLimiter: { limit(key: string): Promise<{ success: boolean }> };
  /** DirectoryObjectStore satisfies the R2 surface the worker uses. */
  audioBucket: unknown;
  allowedOrigins?: readonly string[];
  sessionIdleHours?: number;
  now?: () => number;
  logWrite?: (line: string) => void;
  releaseId?: string;
}

interface WorkerAppLike {
  fetch(request: Request): Promise<Response>;
}

/** buildApp + the security-header applier, from the real worker module. */
interface WorkerAppModule {
  buildApp(deps: HarnessWorkerDeps): WorkerAppLike;
  applySecurityHeaders(headers: Headers): void;
}

const workerAppPromise: Promise<WorkerAppModule> = (async () => {
  const specifier = "../src/app";
  return (await import(specifier)) as unknown as WorkerAppModule;
})();

/**
 * The REAL release lifecycle functions, loaded through a computed specifier
 * for the same reason (the compiler project has its own type universe).
 */
interface PublishModule {
  activateRelease(input: {
    db: LexiloopDatabase;
    releaseId: string;
    aliases?: readonly unknown[];
    now: number;
  }): Promise<{ releaseId: string; previousReleaseId: string | null; aliasesImported: number }>;
  rollbackRelease(input: {
    db: LexiloopDatabase;
    releaseId: string;
    now: number;
  }): Promise<{ releaseId: string; previousReleaseId: string | null; aliasesImported: number }>;
}

const publishPromise: Promise<PublishModule> = (async () => {
  const specifier = "../../../tools/content-compiler/src/release/publish";
  return (await import(specifier)) as unknown as PublishModule;
})();

const moduleDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(moduleDir, "../../../infra/migrations");

interface Args {
  port: number;
  stateFile: string;
  webDist: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    port: E2E_PORT,
    stateFile: process.env["LEXILOOP_E2E_STATE_FILE"] ?? e2eStateFile(),
    webDist: resolve(moduleDir, "../../web/dist"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--port":
        args.port = Number(value);
        index += 1;
        break;
      case "--state-file":
        args.stateFile = resolve(value!);
        index += 1;
        break;
      case "--web-dist":
        args.webDist = resolve(value!);
        index += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// Every byte the run writes lands under this one explicitly created
// directory; teardown removes exactly it.
const tempRoot = mkdtempSync(join(tmpdir(), "lexiloop-e2e-run-"));
const dbFile = join(tempRoot, "d1.sqlite");
const r2Root = join(tempRoot, "r2-private");

const sqlite = new Database(dbFile);
const store = new DirectoryObjectStore(r2Root);

/** Injectable clock: epoch is the seed time; controls move it deterministically. */
const clock = { baseMs: Date.now(), offsetMs: 0 };
function now(): number {
  return clock.baseMs + clock.offsetMs;
}

/** Set at startup from the real worker module (see workerAppPromise). */
let securityHeadersApplier: (headers: Headers) => void = (headers) => void headers;

// The login rate limiter binding is permissive here: the E2E journey list
// exercises no rate-limit path, and the production Cloudflare rate-limit
// binding cannot exist locally. Every OTHER guard (origin, CSRF, stateful
// sessions) is fully real.
const permissiveRateLimiter = {
  async limit(): Promise<{ success: boolean }> {
    return { success: true };
  },
};

void (async () => {
  const seed = await seedHarnessDatabase({ sqlite, migrationsDir, store });
  clock.baseMs = seed.startedAt;

  const workerModule = await workerAppPromise;
  securityHeadersApplier = workerModule.applySecurityHeaders;

  const db = createSqliteDatabase(sqlite);
  // The worker consumes only `get`/`head` of the R2 surface; the store's
  // put/delete back the harness controls. Same documented cast shape as the
  // repositories' sync-driver seam.
  const app = workerModule.buildApp({
    db,
    loginRateLimiter: permissiveRateLimiter,
    audioBucket: store,
    now,
    logWrite: () => {}, // structured logs are unit-tested; keep harness output clean
  });

  const server = createServer((req, res) => {
    void handle(req, res, app);
  });

  await new Promise<void>((resolveListen) => {
    server.listen(args.port, "127.0.0.1", resolveListen);
  });

  // Publish the per-run state (credentials live here and in the temp root
  // ONLY — this file is under the OS temp dir, never the repository).
  mkdirSync(dirname(args.stateFile), { recursive: true });
  writeFileSync(
    args.stateFile,
    JSON.stringify(
      {
        baseUrl: `http://127.0.0.1:${args.port}`,
        pid: process.pid,
        users: seed.users satisfies HarnessUser[],
      },
      null,
      2,
    ),
  );

  let shuttingDown = false;
  const finish = (): void => {
    sqlite.close();
    rmSync(tempRoot, { recursive: true, force: true });
    rmSync(args.stateFile, { force: true });
    process.exit(0);
  };
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`e2e-harness: ${signal} received; tearing down ${tempRoot}`);
    server.close(() => finish());
    // Hard fallback if a socket lingers.
    setTimeout(finish, 3000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  console.log(`e2e-harness: ready on http://127.0.0.1:${args.port} (state ${args.stateFile})`);
})().catch((error: unknown) => {
  console.error("e2e-harness failed to start:", error instanceof Error ? error.stack : error);
  rmSync(tempRoot, { recursive: true, force: true });
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Request handling: harness controls, Worker API, static PWA shell
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse, app: WorkerAppLike): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${args.port}`);
  try {
    if (url.pathname.startsWith("/__harness/")) {
      await handleControl(req, res, url.pathname);
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const webRequest = await toWebRequest(req);
      const webResponse = await app.fetch(webRequest);
      await writeWebResponse(webResponse, res);
      return;
    }
    serveStatic(url.pathname, res);
  } catch (error) {
    // Never leak internals; keep the harness alive for the rest of the run.
    console.error("e2e-harness request error:", error instanceof Error ? error.message : error);
    if (!res.headersSent) {
      sendJson(res, 500, { code: "HARNESS_INTERNAL" });
    } else {
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Harness control endpoints (never exposed beyond localhost)
// ---------------------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function handleControl(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, code: "METHOD_NOT_ALLOWED" });
    return;
  }
  const db = createSqliteDatabase(sqlite);
  const action = pathname.slice("/__harness/".length);
  const body = await readJsonBody(req);
  const publish = await publishPromise;

  switch (action) {
    case "activate": {
      const releaseId = String(body["releaseId"] ?? "");
      const aliases = (body["aliases"] as readonly AliasEdge[] | undefined) ?? [];
      try {
        const result = await publish.activateRelease({ db, releaseId, aliases, now: now() });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendPublishError(res, error);
      }
      return;
    }
    case "rollback": {
      const releaseId = String(body["releaseId"] ?? "");
      try {
        const result = await publish.rollbackRelease({ db, releaseId, now: now() });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendPublishError(res, error);
      }
      return;
    }
    case "clock": {
      const advance = Number(body["advanceMs"] ?? 0);
      const set = Number(body["setMs"] ?? Number.NaN);
      if (Number.isFinite(set)) {
        clock.offsetMs = set;
      }
      if (Number.isFinite(advance) && advance !== 0) {
        clock.offsetMs += advance;
      }
      sendJson(res, 200, { ok: true, now: now() });
      return;
    }
    case "r2-delete": {
      const key = String(body["key"] ?? "");
      sendJson(res, 200, { ok: await store.delete(key) });
      return;
    }
    case "state": {
      sendJson(res, 200, { ok: true, now: now() });
      return;
    }
    default:
      sendJson(res, 404, { ok: false, code: "UNKNOWN_CONTROL" });
  }
}

/** Maps PublishError onto the control contract with its machine code. */
function sendPublishError(res: ServerResponse, error: unknown): void {
  const code = (error as { code?: string }).code ?? "PUBLISH_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, 409, { ok: false, code, message });
}

// ---------------------------------------------------------------------------
// Node <-> Web adapter (the @hono/node-server role, minimal and local)
// ---------------------------------------------------------------------------

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? `127.0.0.1:${args.port}`;
  const url = `http://${host}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        headers.append(key, entry);
      }
    } else {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  return new Request(url, { method, headers, ...(body.length > 0 ? { body } : {}) });
}

async function writeWebResponse(web: Response, res: ServerResponse): Promise<void> {
  web.headers.forEach((value, key) => {
    if (key !== "set-cookie") {
      res.setHeader(key, value);
    }
  });
  const setCookies = web.headers.getSetCookie();
  if (setCookies.length > 0) {
    res.setHeader("set-cookie", setCookies);
  }
  if (web.status === 204 || web.status === 304) {
    res.statusCode = web.status;
    res.end();
    return;
  }
  const body = Buffer.from(await web.arrayBuffer());
  res.setHeader("content-length", String(body.length));
  res.statusCode = web.status;
  res.end(body);
}

// ---------------------------------------------------------------------------
// Static PWA serving (built dist) with deployment-parity security headers
// ---------------------------------------------------------------------------

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** The production deployment applies the security header set to the static
 * shell too; the harness mirrors that so E2E assertions stay honest. */
function applySecurityHeadersTo(res: ServerResponse): void {
  const headers = new Headers();
  securityHeadersApplier(headers);
  headers.forEach((value, key) => res.setHeader(key, value));
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^([\\/])+/, "");
  let filePath = resolve(args.webDist, safePath);
  if (!filePath.startsWith(resolve(args.webDist))) {
    sendJson(res, 403, { code: "FORBIDDEN" });
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // SPA fallback: extension-less routes serve the shell document.
    if (extname(safePath) === "") {
      filePath = join(args.webDist, "index.html");
    } else {
      sendJson(res, 404, { code: "NOT_FOUND" });
      return;
    }
  }
  const bytes = readFileSync(filePath);
  const mime = MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.setHeader("content-type", mime);
  res.setHeader("content-length", String(bytes.length));
  applySecurityHeadersTo(res);
  res.statusCode = 200;
  res.end(bytes);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(bytes.length));
  applySecurityHeadersTo(res);
  res.statusCode = status;
  res.end(bytes);
}
