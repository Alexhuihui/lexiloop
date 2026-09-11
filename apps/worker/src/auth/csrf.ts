/**
 * CSRF and Origin protection for write requests (spec 7.2: every write
 * validates Origin AND the CSRF token).
 *
 * The CSRF token is derived statelessly with HMAC-SHA256 keyed by the raw
 * session token (which only the legitimate client holds, thanks to the
 * HttpOnly + SameSite=Strict cookie): `HMAC(rawToken, "lexiloop-csrf:<id>")`.
 * The server recomputes it from the presented cookie on every request, so no
 * extra storage or column is needed and a session-bound token rotates with
 * every login. Login itself has no session yet, so it validates Origin only.
 */

import type { Context, MiddlewareHandler } from "hono";
import { constantTimeEquals, toBase64Url } from "./password";
import { jsonError } from "../observability/request-context";
import type { AppEnv } from "../app";

export const CSRF_HEADER = "x-csrf-token";

const textEncoder = new TextEncoder();

export async function deriveCsrfToken(rawSessionToken: string, sessionId: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(rawSessionToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(`lexiloop-csrf:${sessionId}`));
  return toBase64Url(new Uint8Array(signature));
}

export async function csrfTokenMatches(
  rawSessionToken: string,
  sessionId: string,
  presented: string,
): Promise<boolean> {
  const expected = await deriveCsrfToken(rawSessionToken, sessionId);
  return constantTimeEquals(textEncoder.encode(expected), textEncoder.encode(presented));
}

/** Origins accepted for write requests: configured extras plus the app origin. */
export function allowedOriginsFor(c: Context<AppEnv>): string[] {
  const configured = c.var.deps.allowedOrigins ?? [];
  let requestOrigin: string | undefined;
  try {
    requestOrigin = new URL(c.req.url).origin;
  } catch {
    requestOrigin = undefined;
  }
  return [...new Set([...configured, ...(requestOrigin ? [requestOrigin] : [])])];
}

/** Write-request guard for endpoints that have no session yet (login). */
export function requireValidOrigin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (!origin || !allowedOriginsFor(c).includes(origin)) {
      return jsonError(c, 403, "ORIGIN_INVALID", "Origin header is missing or not allowed");
    }
    await next();
  };
}

/**
 * Write-request guard for authenticated endpoints; must run after
 * `requireAuth` so the session principal (raw token + session id) is set.
 */
export function requireCsrf(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.var.auth;
    const presented = c.req.header(CSRF_HEADER);
    if (!auth || !presented || !(await csrfTokenMatches(auth.rawToken, auth.sessionId, presented))) {
      return jsonError(c, 403, "CSRF_INVALID", "CSRF token is missing or invalid");
    }
    await next();
  };
}
