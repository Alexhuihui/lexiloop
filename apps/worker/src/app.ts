/**
 * LexiLoop Worker app (Phase 3 foundation): a deps-injectable Hono app with
 * preseeded-account stateful authentication (spec 7), global security
 * headers, and structured request logging at the outer boundary.
 *
 * Dependencies are injected so tests drive the real app against the
 * established better-sqlite3 temp database and fake bindings (plan: fast,
 * deterministic tests); the production entry point wires the D1/R2/rate
 * limiter bindings in their place. Middleware order is load-bearing: request
 * context/logging outermost, then security headers BEFORE any route, then
 * dependency exposure, then routes.
 */

import { Hono } from "hono";
import { ZodError, flattenError } from "zod";
import type { LexiloopDatabase } from "@lexiloop/db";
import { DEFAULT_SESSION_IDLE_HOURS } from "./auth/session";
import { registerAuthRoutes } from "./auth/routes";
import { registerContentRoutes } from "./content/routes";
import { registerProgressRoutes } from "./progress/routes";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import type { AuthenticatedPrincipal } from "./middleware/auth";
import { jsonError, requestContextMiddleware, type ManagedRequestContext } from "./observability/request-context";
import type { LogWriter } from "./observability/logger";

// Single re-export surface for app consumers: header application lives in the
// middleware module, but buildApp users (and tests) import it from here.
export { applySecurityHeaders, securityHeadersMiddleware } from "./middleware/security-headers";

/** Rate limiter behind the Cloudflare binding (injectable test adapter). */
export interface LoginRateLimiter {
  limit(key: string): Promise<{ success: boolean }>;
}

/** Injectable worker dependencies. */
export interface WorkerDeps {
  /** Drizzle handle over D1 (production) or better-sqlite3 (tests/scripts). */
  db: LexiloopDatabase;
  loginRateLimiter: LoginRateLimiter;
  /**
   * Private R2 bucket backing `/api/audio/*`. The production entry point
   * passes the `AUDIO` binding (wrapped in instrumentR2); tests inject a
   * fake. Routes fail closed with 503 when absent.
   */
  audioBucket?: R2Bucket;
  /**
   * Pre-created per-request log context. The production entry point creates
   * it (with the request id and worker release id) BEFORE wrapping the
   * D1/R2 bindings with instrumentD1/instrumentR2, so binding usage lands in
   * this request's log line; tests omit it and the middleware creates one.
   */
  requestContext?: ManagedRequestContext;
  /** Extra accepted write-request Origins; the request's own origin is always allowed. */
  allowedOrigins?: readonly string[];
  /** Idle session window in hours (plan: SESSION_IDLE_HOURS=168). */
  sessionIdleHours?: number;
  /** Worker release id, stamped into every request log line when known. */
  releaseId?: string;
  /** Injectable clock (epoch ms); defaults to Date.now(). */
  now?: () => number;
  /** Log sink; defaults to console.log. Tests capture JSON lines here. */
  logWrite?: LogWriter;
}

export interface AppEnv {
  Variables: {
    deps: WorkerDeps;
    requestContext: ManagedRequestContext;
    auth: AuthenticatedPrincipal;
  };
}

export type WorkerApp = Hono<AppEnv>;

export function buildApp(deps: WorkerDeps): WorkerApp {
  const resolved: WorkerDeps = {
    ...deps,
    sessionIdleHours: deps.sessionIdleHours ?? DEFAULT_SESSION_IDLE_HOURS,
  };
  const app = new Hono<AppEnv>();

  app.use("*", requestContextMiddleware(resolved));
  app.use("*", securityHeadersMiddleware<AppEnv>());
  app.use("*", async (c, next) => {
    c.set("deps", resolved);
    await next();
  });

  registerAuthRoutes(app);
  registerContentRoutes(app);
  registerProgressRoutes(app);

  app.notFound((c) => jsonError(c, 404, "NOT_FOUND", "Route not found"));

  app.onError((error, c) => {
    if (error instanceof ZodError) {
      return jsonError(c, 400, "VALIDATION_FAILED", "Request body failed schema validation", flattenError(error));
    }
    // Unexpected failure: stable code + error class only. No message, no
    // stack (spec 8: no stacks in production), so secrets in an exception
    // text can never reach the response or the logs.
    const context = c.var.requestContext;
    if (context) {
      context.errorCode = "INTERNAL";
      context.errorType = error.name;
    }
    return jsonError(c, 500, "INTERNAL", "Internal Server Error");
  });

  return app;
}
