/**
 * Production Worker entry point (spec 6.1): wires the real bindings into the
 * deps-injectable Hono app from src/app.ts —
 *
 * - `DB` (D1): wrapped per request with `instrumentD1` so every statement's
 *   `meta.rows_read/rows_written` lands in THAT request's log line, then
 *   handed to drizzle's D1 driver.
 * - `AUDIO` (R2, private): wrapped with `instrumentR2` for the same reason;
 *   only `/api/audio/*` touches it, after auth + release association checks.
 * - `LOGIN_RATE_LIMITER`: the Cloudflare Rate Limiting binding behind the
 *   same injectable adapter the login route uses.
 *
 * The app (and its instrumented deps) is built per request because the usage
 * counters are per request by design; Workers invoke fetch once per request,
 * so this is one small object graph per request. Optional deployment vars:
 * `ALLOWED_ORIGINS` (comma-separated extra write-request origins),
 * `SESSION_IDLE_HOURS` (default 168), and `WORKER_RELEASE_ID` (stamped into
 * request logs).
 */

import { drizzle } from "drizzle-orm/d1";
import { schema } from "@lexiloop/db";
import { buildApp, type WorkerDeps } from "./app";
import { createLoginRateLimiter, type RateLimitBinding } from "./auth/routes";
import {
  createRequestLogContext,
  instrumentD1,
  instrumentR2,
  requestIdFrom,
} from "./observability/request-context";

/** Bindings and deployment variables (infra/wrangler/wrangler.toml.example). */
export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  LOGIN_RATE_LIMITER: RateLimitBinding;
  /** Comma-separated extra accepted write-request Origins (optional). */
  ALLOWED_ORIGINS?: string;
  /** Idle session window in hours (optional; plan default 168). */
  SESSION_IDLE_HOURS?: string;
  /** Worker release id for request logs (optional). */
  WORKER_RELEASE_ID?: string;
}

function parseIdleHours(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const hours = Number(raw);
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

function parseAllowedOrigins(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  return origins.length > 0 ? origins : undefined;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One log context per request: created before the bindings are wrapped,
    // so the instrumented D1/R2 calls feed exactly the counters this
    // request's log line reports.
    const requestContext = createRequestLogContext(
      requestIdFrom(request.headers.get("x-request-id") ?? undefined),
      env.WORKER_RELEASE_ID,
    );
    const deps: WorkerDeps = {
      db: drizzle(instrumentD1(env.DB, requestContext.usage), { schema }),
      audioBucket: instrumentR2(env.AUDIO, requestContext.usage),
      loginRateLimiter: createLoginRateLimiter(env.LOGIN_RATE_LIMITER),
      allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
      sessionIdleHours: parseIdleHours(env.SESSION_IDLE_HOURS),
      releaseId: env.WORKER_RELEASE_ID,
      requestContext,
    };
    return buildApp(deps).fetch(request);
  },
} satisfies ExportedHandler<Env>;
