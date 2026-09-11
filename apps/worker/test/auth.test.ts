import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UserRepository,
  UserSettingsRepository,
  createSqliteDatabase,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { createMigratedTestDb, type TestDatabase } from "../../../packages/db/test/helpers";
import { applySecurityHeaders, buildApp, type LoginRateLimiter, type WorkerDeps } from "../src/app";
import { hashPassword, normalizeUsername, verifyPassword } from "../src/auth/password";
import { SESSION_COOKIE, sha256Hex } from "../src/auth/session";
import { deriveCsrfToken } from "../src/auth/csrf";
import { instrumentD1, instrumentR2 } from "../src/observability/request-context";

/**
 * Task 11 acceptance tests (spec 7/8.1): preseeded accounts, stateful
 * sessions, CSRF/Origin protection, security headers, and structured-log
 * hygiene. The app runs against the established better-sqlite3 temp database
 * (packages/db/test pattern) with an injectable rate limiter and clock, so
 * every check exercises real repository/D1-shaped behavior.
 */

const T0 = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;
const ORIGIN = "https://lexiloop.example";
const PASSWORD = "correct horse battery staple";
const SESSION_IDLE_HOURS = 168;

interface Fixture {
  env: TestDatabase;
  db: LexiloopDatabase;
  logs: string[];
  rateLimiter: FakeRateLimiter;
  deps: WorkerDeps;
  app: ReturnType<typeof buildApp>;
  clock: { now: number };
  alice: { userId: string; username: string };
  bob: { userId: string; username: string };
}

class FakeRateLimiter implements LoginRateLimiter {
  public keys: string[] = [];
  constructor(private readonly success: boolean | ((key: string) => boolean) = true) {}
  async limit(key: string): Promise<{ success: boolean }> {
    this.keys.push(key);
    const verdict = typeof this.success === "function" ? this.success(key) : this.success;
    return { success: verdict };
  }
}

async function seedUser(
  db: LexiloopDatabase,
  username: string,
  password: string,
  status: "ACTIVE" | "DISABLED" = "ACTIVE",
): Promise<{ userId: string; username: string }> {
  const hashed = await hashPassword(password);
  const userId = `user-${username}`;
  await new UserRepository(db).create({
    userId,
    normalizedUsername: username,
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    status,
    createdAt: T0,
  });
  return { userId, username };
}

async function login(
  app: Fixture["app"],
  username: string,
  password: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...extraHeaders },
    body: JSON.stringify({ username, password }),
  });
}

function sessionCookieOf(res: Response): string | undefined {
  return res.headers.get("set-cookie")?.split(",").find((cookie) => cookie.trim().startsWith(SESSION_COOKIE));
}

async function createFixture(overrides: Partial<WorkerDeps> = {}): Promise<Fixture> {
  const env = createMigratedTestDb();
  const db = createSqliteDatabase(env.sqlite);
  const logs: string[] = [];
  const rateLimiter = (overrides.loginRateLimiter as FakeRateLimiter | undefined) ?? new FakeRateLimiter();
  const clock = { now: T0 };
  const deps: WorkerDeps = {
    db,
    loginRateLimiter: rateLimiter,
    allowedOrigins: [ORIGIN],
    logWrite: (line: string) => logs.push(line),
    now: () => clock.now,
    ...overrides,
  };
  const alice = await seedUser(db, "alice", PASSWORD);
  const bob = await seedUser(db, "bob", "bob-own-password-9");
  return { env, db, logs, rateLimiter, deps, app: buildApp(deps), clock, alice, bob };
}

let fx: Fixture;

beforeEach(async () => {
  fx = await createFixture();
});

afterEach(() => {
  fx.env.cleanup();
});

describe("password hashing (PBKDF2-SHA256, Web Crypto)", () => {
  it("verifies the correct password and rejects a wrong one", async () => {
    const hashed = await hashPassword(PASSWORD);
    await expect(verifyPassword(PASSWORD, hashed)).resolves.toBe(true);
    await expect(verifyPassword("wrong password entirely", hashed)).resolves.toBe(false);
  });

  it("gives every account an independent random salt for the same password", async () => {
    const first = await hashPassword(PASSWORD);
    const second = await hashPassword(PASSWORD);
    expect(first.salt).not.toEqual(second.salt);
    expect(first.verifier).not.toEqual(second.verifier);
    await expect(verifyPassword(PASSWORD, second)).resolves.toBe(true);
  });

  it("stores a versioned verifier envelope and never the plaintext", async () => {
    const hashed = await hashPassword(PASSWORD);
    expect(hashed.verifier).toMatch(/^pbkdf2-sha256\$1\$/);
    expect(hashed.verifier).not.toContain(PASSWORD);
    expect(hashed.salt).not.toContain(PASSWORD);
  });

  it("fails closed on an unknown params version or malformed envelope", async () => {
    const hashed = await hashPassword(PASSWORD);
    const futureVersion = hashed.verifier.replace("$1$", "$99$");
    await expect(verifyPassword(PASSWORD, { salt: hashed.salt, verifier: futureVersion })).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, { salt: hashed.salt, verifier: "not-an-envelope" })).resolves.toBe(false);
  });

  it("normalizes usernames deterministically for login and seeding", () => {
    expect(normalizeUsername("  Alice ")).toBe("alice");
    expect(normalizeUsername("BOB")).toBe("bob");
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with correct credentials and sets a stateful session cookie", async () => {
    const res = await login(fx.app, "alice", PASSWORD);
    expect(res.status).toBe(200);

    const cookie = sessionCookieOf(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_IDLE_HOURS * 60 * 60}`);

    const body = (await res.json()) as { user: { user_id: string }; csrf_token: string; session: { expires_at: number } };
    expect(body.user.user_id).toBe(fx.alice.userId);
    expect(body.session.expires_at).toBe(T0 + SESSION_IDLE_HOURS * HOUR);
    expect(body.csrf_token).not.toBe("");
  });

  it("rejects a wrong password with 401 and no cookie", async () => {
    const res = await login(fx.app, "alice", "totally wrong password");
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = (await res.json()) as { code: string; message: string; request_id: string };
    expect(body.code).toBe("AUTH_INVALID_CREDENTIALS");
    expect(body.request_id).not.toBe("");
  });

  it("answers 401 for an unknown username with the same stable code", async () => {
    const res = await login(fx.app, "nobody", PASSWORD);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_INVALID_CREDENTIALS");
  });

  it("generates a fresh opaque 256-bit token per login", async () => {
    const first = sessionCookieOf(await login(fx.app, "alice", PASSWORD));
    const second = sessionCookieOf(await login(fx.app, "alice", PASSWORD));
    const tokenOf = (cookie: string | undefined): string => cookie!.split(";")[0]!.split("=")[1]!;
    const firstToken = tokenOf(first);
    const secondToken = tokenOf(second);
    expect(firstToken).not.toEqual(secondToken);
    // 256 bits of raw entropy, base64url-encoded -> 32 bytes.
    expect(Buffer.from(firstToken, "base64url").length).toBe(32);
  });

  it("stores only the SHA-256 token hash in D1, never the raw token", async () => {
    const res = await login(fx.app, "alice", PASSWORD);
    const cookie = sessionCookieOf(res)!;
    const rawToken = cookie.split(";")[0]!.split("=")[1]!;

    const row = fx.env.sqlite
      .prepare("SELECT token_hash FROM auth_session WHERE user_id = ?")
      .get(fx.alice.userId) as { token_hash: string };
    expect(row.token_hash).toBe(await sha256Hex(rawToken));
    expect(row.token_hash).not.toBe(rawToken);
    const stored = JSON.stringify(fx.env.sqlite.prepare("SELECT * FROM auth_session").all());
    expect(stored).not.toContain(rawToken);
  });

  it("derives the issued CSRF token from the raw session token", async () => {
    const res = await login(fx.app, "alice", PASSWORD);
    const rawToken = sessionCookieOf(res)!.split(";")[0]!.split("=")[1]!;
    const body = (await res.json()) as { csrf_token: string };
    const row = fx.env.sqlite
      .prepare("SELECT session_id FROM auth_session WHERE user_id = ?")
      .get(fx.alice.userId) as { session_id: string };
    expect(body.csrf_token).toBe(await deriveCsrfToken(rawToken, row.session_id));
  });

  it("rejects disabled accounts at login", async () => {
    await seedUser(fx.db, "carol", PASSWORD, "DISABLED");
    const res = await login(fx.app, "carol", PASSWORD);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_ACCOUNT_DISABLED");
  });

  it("answers 429 through the injectable rate-limit adapter before creating a session", async () => {
    const limited = await createFixture({ loginRateLimiter: new FakeRateLimiter(() => false) });
    try {
      const res = await login(limited.app, "alice", PASSWORD);
      expect(res.status).toBe(429);
      expect(((await res.json()) as { code: string }).code).toBe("RATE_LIMITED");
      expect(limited.rateLimiter.keys).toEqual(["login:alice"]);
      const sessions = limited.env.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_session").get() as { n: number };
      expect(sessions.n).toBe(0);
    } finally {
      limited.env.cleanup();
    }
  });

  it("ignores a client-supplied user_id and binds the session to the authenticated username", async () => {
    const res = await fx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ username: "alice", password: PASSWORD, user_id: fx.bob.userId }),
    });
    expect(res.status).toBe(200);
    const row = fx.env.sqlite.prepare("SELECT user_id FROM auth_session").get() as { user_id: string };
    expect(row.user_id).toBe(fx.alice.userId);
  });

  it("returns 400 VALIDATION_FAILED for a malformed body", async () => {
    const res = await fx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ username: 42 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
  });

  it("validates the Origin header on this write endpoint", async () => {
    const noOrigin = await fx.app.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: PASSWORD }),
    });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { code: string }).code).toBe("ORIGIN_INVALID");

    const evilOrigin = await login(fx.app, "alice", PASSWORD, { origin: "https://evil.example" });
    expect(evilOrigin.status).toBe(403);
    expect(((await evilOrigin.json()) as { code: string }).code).toBe("ORIGIN_INVALID");
  });
});

describe("session validation on every authenticated request", () => {
  async function loginAlice(): Promise<{ token: string; csrf: string }> {
    const res = await login(fx.app, "alice", PASSWORD);
    const token = sessionCookieOf(res)!.split(";")[0]!.split("=")[1]!;
    const body = (await res.json()) as { csrf_token: string };
    return { token, csrf: body.csrf_token };
  }

  it("serves GET /api/auth/me from the session cookie with account and preferences", async () => {
    await new UserSettingsRepository(fx.db).upsert({ userId: fx.alice.userId }, {
      newWordsPerGroup: 8,
      dailyGoal: 25,
      timezone: "Asia/Shanghai",
    });
    const { token } = await loginAlice();
    const res = await fx.app.request("/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { user_id: string; username: string; status: string };
      settings: { new_words_per_group: number; timezone: string } | null;
    };
    expect(body.user.user_id).toBe(fx.alice.userId);
    expect(body.user.username).toBe("alice");
    expect(body.user.status).toBe("ACTIVE");
    expect(body.settings?.new_words_per_group).toBe(8);
    expect(body.settings?.timezone).toBe("Asia/Shanghai");
  });

  it("rejects a missing cookie", async () => {
    const res = await fx.app.request("/api/auth/me");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });

  it("rejects a tampered token", async () => {
    await loginAlice();
    const res = await fx.app.request("/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=forged-token-value` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });

  it("expires sessions after the idle window", async () => {
    const { token } = await loginAlice();
    expect((await fx.app.request("/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } })).status).toBe(200);
    fx.clock.now = T0 + SESSION_IDLE_HOURS * HOUR + 1;
    const res = await fx.app.request("/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_EXPIRED");
  });

  it("stops accepting sessions whose session_version no longer matches the account", async () => {
    const { token } = await loginAlice();
    await new UserRepository(fx.db).bumpSessionVersion({ userId: fx.alice.userId });
    const res = await fx.app.request("/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });

  it("stops accepting sessions of a disabled account", async () => {
    const { token } = await loginAlice();
    await new UserRepository(fx.db).setStatus({ userId: fx.alice.userId }, "DISABLED");
    const res = await fx.app.request("/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });

  it("resolves ownership only from the session, ignoring a client user_id", async () => {
    const { token } = await loginAlice();
    const res = await fx.app.request(`/api/auth/me?user_id=${fx.bob.userId}`, {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    const body = (await res.json()) as { user: { user_id: string } };
    expect(body.user.user_id).toBe(fx.alice.userId);
  });

  it("touches last_used_at on authenticated requests", async () => {
    const { token } = await loginAlice();
    fx.clock.now = T0 + 5 * 60 * 1000;
    await fx.app.request("/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    const row = fx.env.sqlite.prepare("SELECT last_used_at FROM auth_session").get() as { last_used_at: number | null };
    expect(row.last_used_at).toBe(T0 + 5 * 60 * 1000);
  });
});

describe("logout (POST /api/auth/logout)", () => {
  async function loginAlice(): Promise<{ token: string; csrf: string }> {
    const res = await login(fx.app, "alice", PASSWORD);
    const token = sessionCookieOf(res)!.split(";")[0]!.split("=")[1]!;
    const body = (await res.json()) as { csrf_token: string };
    return { token, csrf: body.csrf_token };
  }

  async function logoutRequest(token: string, headers: Record<string, string>): Promise<Response> {
    return await fx.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: ORIGIN, ...headers },
    });
  }

  it("revokes the session, clears the cookie, and invalidates reuse", async () => {
    const { token, csrf } = await loginAlice();
    const res = await logoutRequest(token, { "x-csrf-token": csrf });
    expect(res.status).toBe(200);

    const cleared = res.headers.get("set-cookie") ?? "";
    expect(cleared).toContain(`${SESSION_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");

    const row = fx.env.sqlite.prepare("SELECT revoked_at FROM auth_session").get() as { revoked_at: number | null };
    expect(row.revoked_at).toBe(T0);

    const reuse = await fx.app.request("/api/auth/me", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
    expect(reuse.status).toBe(401);
    expect(((await reuse.json()) as { code: string }).code).toBe("AUTH_SESSION_INVALID");
  });

  it("requires the Origin header on logout", async () => {
    const { token } = await loginAlice();
    const res = await fx.app.request("/api/auth/logout", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("ORIGIN_INVALID");
  });

  it("rejects a missing CSRF token", async () => {
    const { token } = await loginAlice();
    const res = await logoutRequest(token, {});
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("CSRF_INVALID");
  });

  it("rejects a wrong CSRF token", async () => {
    const { token } = await loginAlice();
    const res = await logoutRequest(token, { "x-csrf-token": "forged-csrf-value" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("CSRF_INVALID");
  });

  it("rejects logout without a session", async () => {
    const res = await fx.app.request("/api/auth/logout", {
      method: "POST",
      headers: { origin: ORIGIN, "x-csrf-token": "whatever" },
    });
    expect(res.status).toBe(401);
  });
});

describe("security headers on success and error responses", () => {
  const expectedCsp =
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "media-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

  function expectSecurityHeaders(res: Response): void {
    expect(res.headers.get("content-security-policy")).toBe(expectedCsp);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=()");
    expect(res.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  }

  it("stamps headers on a success response", async () => {
    expectSecurityHeaders(await login(fx.app, "alice", PASSWORD));
  });

  it("stamps headers on an authentication error response", async () => {
    expectSecurityHeaders(await login(fx.app, "alice", "wrong password again"));
  });

  it("stamps headers on a 404 and keeps the JSON error shape", async () => {
    const res = await fx.app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
    const body = (await res.json()) as { code: string; message: string; request_id: string };
    expect(body.code).toBe("NOT_FOUND");
    expect(body.request_id).not.toBe("");
  });

  it("stamps headers on a thrown error (500) without leaking internals", async () => {
    // Simulate a storage failure: the route's repository queries blow up.
    fx.env.sqlite.exec("DROP TABLE app_user");
    const res = await login(fx.app, "alice", PASSWORD);
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("INTERNAL");
    expect(body.message).toBe("Internal Server Error");
    // No driver message or stack in the body, and only the stable error class
    // (never the raw driver text) in the logs.
    expect(JSON.stringify(body)).not.toContain("app_user");
    expect(fx.logs.join("\n")).not.toContain("no such table");
  });

  it("exposes applySecurityHeaders as the single header source", () => {
    const headers = new Headers();
    applySecurityHeaders(headers);
    expect(headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("request context, structured logs, and redaction", () => {
  function parsedLogs(): Array<Record<string, unknown>> {
    return fx.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("propagates a client request id through response, error body, and logs", async () => {
    const res = await login(fx.app, "alice", "wrong password", { "x-request-id": "client-request-id-123" });
    expect(res.headers.get("x-request-id")).toBe("client-request-id-123");
    expect(((await res.json()) as { request_id: string }).request_id).toBe("client-request-id-123");
    const logs = parsedLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]!["request_id"]).toBe("client-request-id-123");
  });

  it("generates a request id when the client sends none or an unusable one", async () => {
    const generated = await login(fx.app, "alice", PASSWORD);
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);

    const replaced = await login(fx.app, "alice", PASSWORD, { "x-request-id": "not a valid id!! " });
    expect(replaced.headers.get("x-request-id")).toMatch(/^[0-9a-f]{32}$/);
    expect(replaced.headers.get("x-request-id")).not.toBe("not a valid id!! ");
  });

  it("emits one structured JSON log line with the required fields per request", async () => {
    await login(fx.app, "alice", PASSWORD);
    const logs = parsedLogs();
    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry["msg"]).toBe("request");
    expect(entry["method"]).toBe("POST");
    expect(entry["route"]).toBe("/api/auth/login");
    expect(entry["status"]).toBe(200);
    expect(typeof entry["duration_ms"]).toBe("number");
    expect(entry["duration_ms"] as number).toBeGreaterThanOrEqual(0);
    expect(entry["d1_rows_read"]).toBe(0);
    expect(entry["d1_rows_written"]).toBe(0);
    expect(entry["r2_operations"]).toBe(0);
    expect(entry).not.toHaveProperty("release_id");
  });

  it("includes the release id in the log line when known", async () => {
    const withRelease = await createFixture({ releaseId: "rel-test-1" });
    try {
      await login(withRelease.app, "alice", PASSWORD);
      const entry = withRelease.logs.map((line) => JSON.parse(line) as Record<string, unknown>)[0]!;
      expect(entry["release_id"]).toBe("rel-test-1");
    } finally {
      withRelease.env.cleanup();
    }
  });

  it("logs a stable error code for expected failures and thrown errors", async () => {
    await login(fx.app, "alice", "wrong password");
    fx.env.sqlite.exec("DROP TABLE app_user");
    await login(fx.app, "alice", PASSWORD);
    const entries = parsedLogs();
    expect(entries).toHaveLength(2);
    expect(entries[0]!["error_code"]).toBe("AUTH_INVALID_CREDENTIALS");
    expect(entries[0]!["level"]).toBe("warn");
    expect(entries[1]!["error_code"]).toBe("INTERNAL");
    expect(entries[1]!["status"]).toBe(500);
    expect(entries[1]!["level"]).toBe("error");
  });

  it("never writes secrets into the logs (normal, failed, and thrown paths)", async () => {
    const issued = await login(fx.app, "alice", PASSWORD); // normal path (issues token + csrf)
    const rawToken = sessionCookieOf(issued)!.split(";")[0]!.split("=")[1]!;
    const { csrf_token: csrfToken } = (await issued.json()) as { csrf_token: string };
    await login(fx.app, "alice", "wrong password"); // failed login
    await login(fx.app, "bob", "bob-own-password-9");
    fx.env.sqlite.exec("DROP TABLE app_user");
    await login(fx.app, "alice", PASSWORD); // thrown path

    const everything = fx.logs.join("\n");
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain("bob-own-password-9");
    // The raw session token and the derived CSRF secret never reach the logs.
    expect(everything).not.toContain(rawToken);
    expect(everything).not.toContain(csrfToken);
    // No cookie or auth headers are echoed either.
    expect(everything).not.toContain("set-cookie");
    expect(everything).not.toContain("cookie:");
    expect(everything).not.toContain("x-csrf-token");
    // Every captured line is valid JSON with a redaction-safe shape.
    expect(parsedLogs().length).toBe(fx.logs.length);
  });
});

describe("binding usage instrumentation", () => {
  function recorderFor(usage: { d1RowsRead: number; d1RowsWritten: number; r2Operations: number }) {
    return {
      recordD1Read: (rows: number) => {
        usage.d1RowsRead += rows;
      },
      recordD1Write: (rows: number) => {
        usage.d1RowsWritten += rows;
      },
      recordR2Operation: () => {
        usage.r2Operations += 1;
      },
    };
  }

  it("counts D1 rows read/written from statement result metadata", async () => {
    const usage = { d1RowsRead: 0, d1RowsWritten: 0, r2Operations: 0 };
    const statement = {
      bind: () => statement,
      all: async () => ({ results: [{ id: 1 }], meta: { rows_read: 3, rows_written: 0 } }),
      run: async () => ({ results: [], meta: { rows_read: 0, rows_written: 2 } }),
      first: async () => ({ id: 1 }),
    };
    const stubDb = {
      prepare: () => statement,
      batch: async (statements: unknown[]) => statements.map(() => ({ results: [], meta: { rows_read: 1, rows_written: 1 } })),
    } as unknown as D1Database;

    const instrumented = instrumentD1(stubDb, recorderFor(usage));
    await instrumented.prepare("SELECT 1").bind().all();
    await instrumented.prepare("INSERT ...").bind().run();
    await instrumented.batch([statement, statement] as never);

    expect(usage.d1RowsRead).toBe(5);
    expect(usage.d1RowsWritten).toBe(4);
  });

  it("counts R2 operations", async () => {
    const usage = { d1RowsRead: 0, d1RowsWritten: 0, r2Operations: 0 };
    const stubBucket = {
      get: async () => null,
      put: async () => undefined,
      head: async () => null,
    } as unknown as R2Bucket;

    const instrumented = instrumentR2(stubBucket, recorderFor(usage));
    await instrumented.get("audio/1.wav");
    await instrumented.put("audio/1.wav", new ArrayBuffer(0));
    await instrumented.head("audio/1.wav");

    expect(usage.r2Operations).toBe(3);
  });
});

describe("scripts/seed-users.ts", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  function runSeed(args: string[]): ReturnType<typeof spawnSync> {
    const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    return spawnSync(process.execPath, [tsxCli, join(repoRoot, "scripts", "seed-users.ts"), ...args], {
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 120_000,
    });
  }

  it("seeds accounts from a private input file, prints only ids/status, and rotates on re-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "lexiloop-seed-"));
    try {
      const dbFile = join(dir, "d1.sqlite");
      const inputFile = join(dir, "users.private.txt");
      writeFileSync(inputFile, ["# private input, never committed", "Alice:seeded-password-1", "bob:seeded-password-2", ""].join("\n"));

      const first = runSeed(["--db", dbFile, "--input", inputFile]);
      expect(first.status).toBe(0);
      const stdout = first.stdout ?? "";
      expect(stdout).not.toContain("seeded-password");
      expect(stdout).toContain("username=alice");
      expect(stdout).toContain("status=created");
      expect(stdout).toMatch(/user_id=user-[0-9a-f]{16}/);

      const db = new Database(dbFile);
      const rows = db
        .prepare("SELECT user_id, normalized_username, session_version, password_verifier FROM app_user ORDER BY normalized_username")
        .all() as Array<{ user_id: string; normalized_username: string; session_version: number; password_verifier: string }>;
      expect(rows.map((row) => row.normalized_username)).toEqual(["alice", "bob"]);
      expect(rows.every((row) => row.session_version === 1)).toBe(true);
      const aliceBefore = rows.find((row) => row.normalized_username === "alice")!;

      writeFileSync(inputFile, "alice:rotated-password-3\n");
      const second = runSeed(["--db", dbFile, "--input", inputFile]);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain("status=upserted");
      expect(second.stdout).toContain(`user_id=${aliceBefore.user_id}`);

      const after = db
        .prepare("SELECT password_verifier, session_version FROM app_user WHERE normalized_username = 'alice'")
        .get() as { password_verifier: string; session_version: number };
      expect(after.session_version).toBe(2);
      expect(after.password_verifier).not.toBe(aliceBefore.password_verifier);
      expect(after.password_verifier.startsWith("pbkdf2-sha256$1$")).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run without an input file and never accepts credentials as arguments", () => {
    const dir = mkdtempSync(join(tmpdir(), "lexiloop-seed-"));
    try {
      const dbFile = join(dir, "d1.sqlite");
      const noInput = runSeed(["--db", dbFile]);
      expect(noInput.status).not.toBe(0);
      expect(noInput.stderr).toContain("interactive");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
