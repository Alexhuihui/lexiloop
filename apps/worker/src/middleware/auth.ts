/**
 * Authentication middleware (spec 7.2): resolves the raw cookie token through
 * the full stateful session chain (not revoked, not expired, account enabled,
 * `session_version` matching) on EVERY authenticated request, then exposes
 * the principal. Ownership throughout the API comes only from this
 * resolution — client-supplied user ids are ignored by construction.
 */

import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { AuthSessionRepository, type AppUserRow, type AuthSessionRow } from "@lexiloop/db";
import { resolveSession, SESSION_COOKIE } from "../auth/session";
import { jsonError } from "../observability/request-context";
import type { AppEnv } from "../app";

/** Everything a route needs to act as the authenticated user. */
export interface AuthenticatedPrincipal {
  userId: string;
  sessionId: string;
  /** Raw cookie token; kept only to re-derive the session's CSRF token. */
  rawToken: string;
  user: AppUserRow;
  session: AuthSessionRow;
}

/** Audit freshness without turning every high-frequency API call into a D1 write. */
export const AUTH_SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function requireAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.var.deps;
    const rawToken = getCookie(c, SESSION_COOKIE);
    if (!rawToken) {
      return jsonError(c, 401, "AUTH_SESSION_INVALID", "Authentication required");
    }
    const now = deps.now?.() ?? Date.now();
    const resolution = await resolveSession(deps.db, rawToken, now);
    if (!resolution.ok) {
      const code = resolution.reason === "EXPIRED" ? "AUTH_SESSION_EXPIRED" : "AUTH_SESSION_INVALID";
      return jsonError(c, 401, code, "Session is missing, invalid, or no longer active");
    }
    const principal: AuthenticatedPrincipal = {
      userId: resolution.user.userId,
      sessionId: resolution.session.sessionId,
      rawToken,
      user: resolution.user,
      session: resolution.session,
    };
    c.set("auth", principal);
    const lastUsedAt = principal.session.lastUsedAt;
    if (lastUsedAt === null || now - lastUsedAt >= AUTH_SESSION_TOUCH_INTERVAL_MS) {
      await new AuthSessionRepository(deps.db).touch({ userId: principal.userId }, principal.sessionId, now);
    }
    await next();
  };
}
