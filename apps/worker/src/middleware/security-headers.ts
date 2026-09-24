/**
 * Global security headers (plan Task 11): restrictive CSP compatible with the
 * built PWA, nosniff, strict referrer/permissions policies, and production
 * HSTS. Installed BEFORE any route; applied to the finalized response so both
 * success AND error responses carry them (never trusted to deployment
 * defaults).
 */

import type { Env, MiddlewareHandler } from "hono";

/**
 * PWA-friendly restrictive CSP: everything defaults to same-origin; explicit
 * script/style/connect/media/img/font directives; manifest and service
 * worker are same-origin; no objects, framing, or base hijacking.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "media-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";
export const REFERRER_POLICY = "no-referrer";
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=()";

/** Single source of truth for the security header set. */
export function applySecurityHeaders(headers: Headers): void {
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", REFERRER_POLICY);
  headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  headers.set("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
}

/** Runs first for every route; stamps headers on whatever response comes back. */
export function securityHeadersMiddleware<E extends Env>(): MiddlewareHandler<E> {
  return async (c, next) => {
    await next();
    // Hono catches handler errors inside the dispatch, so next() returns even
    // for thrown errors and c.res is the final (error) response.
    applySecurityHeaders(c.res.headers);
  };
}
