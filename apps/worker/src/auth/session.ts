/**
 * Stateful auth sessions (spec 7.2). Login issues a 256-bit random opaque
 * token; the cookie carries the raw token and D1 `auth_session` stores only
 * its SHA-256 hash. Every resolution re-checks the full spec chain: not
 * revoked, not expired, account enabled, and `session_version` unchanged
 * since issuance — so password changes and disables kill sessions instantly.
 */

import {
  AuthSessionRepository,
  type AppUserRow,
  type AuthSessionRow,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { randomBytes, toBase64Url, toHex } from "./password";

/** Cookie name for the raw session token. */
export const SESSION_COOKIE = "lexiloop_session";

/** Plan default: SESSION_IDLE_HOURS=168 in .env.example. */
export const DEFAULT_SESSION_IDLE_HOURS = 168;

const TOKEN_BYTES = 32; // 256-bit opaque token
const SESSION_ID_BYTES = 16;

export interface IssuedSession {
  /** Raw token; goes into the cookie only, never the database. */
  token: string;
  tokenHash: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  /** session_version copied from the account at issuance. */
  sessionVersion: number;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

/** Issues a session row for an already-authenticated user. */
export async function issueSession(
  db: LexiloopDatabase,
  user: AppUserRow,
  options: { now: number; idleHours: number },
): Promise<IssuedSession> {
  const token = toBase64Url(randomBytes(TOKEN_BYTES));
  const tokenHash = await sha256Hex(token);
  const sessionId = toHex(randomBytes(SESSION_ID_BYTES));
  const issuedAt = options.now;
  const expiresAt = issuedAt + options.idleHours * 60 * 60 * 1000;
  const row = await new AuthSessionRepository(db).create(
    { userId: user.userId },
    { sessionId, tokenHash, issuedAt, expiresAt, sessionVersion: user.sessionVersion },
  );
  return { token, tokenHash, sessionId: row.sessionId, issuedAt, expiresAt, sessionVersion: row.sessionVersion };
}

export type SessionResolution =
  | { ok: true; session: AuthSessionRow; user: AppUserRow }
  | { ok: false; reason: "INVALID" | "EXPIRED" | "REVOKED" | "DISABLED" | "VERSION_MISMATCH" };

/**
 * Resolves a presented cookie token through the full spec 7.2 chain. Order is
 * stable: unknown -> revoked -> expired -> missing user -> disabled -> stale
 * session_version; the first failure decides the (client-facing) reason.
 */
export async function resolveSession(db: LexiloopDatabase, rawToken: string, now: number): Promise<SessionResolution> {
  const tokenHash = await sha256Hex(rawToken);
  const principal = await new AuthSessionRepository(db).resolveByTokenHash(tokenHash);
  if (!principal) {
    return { ok: false, reason: "INVALID" };
  }
  const { session, user } = principal;
  if (session.revokedAt !== null) {
    return { ok: false, reason: "REVOKED" };
  }
  if (session.expiresAt <= now) {
    return { ok: false, reason: "EXPIRED" };
  }
  if (user.status !== "ACTIVE") {
    return { ok: false, reason: "DISABLED" };
  }
  if (user.sessionVersion !== session.sessionVersion) {
    return { ok: false, reason: "VERSION_MISMATCH" };
  }
  return { ok: true, session, user };
}
