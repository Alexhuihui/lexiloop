/**
 * Auth routes (spec 8.1): `POST /api/auth/login`, `POST /api/auth/logout`,
 * `GET /api/auth/me`. Accounts are preseeded only — there is no registration,
 * OAuth, or recovery path anywhere in the system (spec 7.1).
 *
 * Login validates Origin (no session exists yet) and is rate limited through
 * the injectable adapter backed by the Cloudflare Rate Limiting binding in
 * production. Logout is a write: it requires a valid session, a same Origin,
 * and the session-derived CSRF token, then writes `revoked_at` and clears
 * the cookie. Client-supplied `user_id` values are stripped by the request
 * schema — ownership always comes from the valid session.
 */

import type { Context, Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { z, flattenError } from "zod";
import { zValidator } from "@hono/zod-validator";
import { AuthSessionRepository, UserRepository, UserSettingsRepository } from "@lexiloop/db";
import { hashPassword, normalizeUsername, verifyPassword, type HashedPassword } from "./password";
import { DEFAULT_SESSION_IDLE_HOURS, issueSession, SESSION_COOKIE } from "./session";
import { deriveCsrfToken, requireCsrf, requireValidOrigin } from "./csrf";
import { requireAuth } from "../middleware/auth";
import { jsonError } from "../observability/request-context";
import type { AppEnv, LoginRateLimiter } from "../app";

/** Cloudflare Rate Limiting binding shape (wrangler.toml: LOGIN_RATE_LIMITER). */
export interface RateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

/** Production adapter: the binding behind the injectable interface. */
export function createLoginRateLimiter(binding: RateLimitBinding): LoginRateLimiter {
  return {
    limit: (key: string) => binding.limit({ key }),
  };
}

const loginSchema = z.object({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
});

/** Memoized verifier so unknown usernames burn the same PBKDF2 work. */
let dummyHash: Promise<HashedPassword> | undefined;
function timingEqualizerHash(): Promise<HashedPassword> {
  return (dummyHash ??= hashPassword("lexiloop:timing-equalizer"));
}

const validateLoginJson = zValidator("json", loginSchema, (result, c) => {
  if (!result.success) {
    return jsonError(c as Context<AppEnv>, 400, "VALIDATION_FAILED", "Request body failed schema validation", flattenError(result.error));
  }
  return undefined;
});

export function registerAuthRoutes(app: Hono<AppEnv>): void {
  app.post(
    "/api/auth/login",
    requireValidOrigin(),
    validateLoginJson,
    async (c) => {
      const deps = c.var.deps;
      const { username, password } = c.req.valid("json");
      const normalized = normalizeUsername(username);

      const verdict = await deps.loginRateLimiter.limit(`login:${normalized}`);
      if (!verdict.success) {
        return jsonError(c, 429, "RATE_LIMITED", "Too many login attempts; try again later");
      }

      const users = new UserRepository(deps.db);
      const user = await users.getByNormalizedUsername(normalized);
      const stored = user
        ? { salt: user.passwordSalt, verifier: user.passwordVerifier }
        : await timingEqualizerHash();
      const verified = await verifyPassword(password, stored);
      if (!user || !verified) {
        return jsonError(c, 401, "AUTH_INVALID_CREDENTIALS", "Invalid username or password");
      }
      if (user.status !== "ACTIVE") {
        return jsonError(c, 403, "AUTH_ACCOUNT_DISABLED", "Account is disabled");
      }

      const now = deps.now?.() ?? Date.now();
      const idleHours = deps.sessionIdleHours ?? DEFAULT_SESSION_IDLE_HOURS;
      const issued = await issueSession(deps.db, user, { now, idleHours });
      const csrfToken = await deriveCsrfToken(issued.token, issued.sessionId);

      setCookie(c, SESSION_COOKIE, issued.token, {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        maxAge: idleHours * 60 * 60,
      });
      return c.json(
        {
          user: { user_id: user.userId, username: user.normalizedUsername, status: user.status },
          session: { expires_at: issued.expiresAt },
          csrf_token: csrfToken,
        },
        200,
        { "cache-control": "no-store" },
      );
    },
  );

  app.post("/api/auth/logout", requireAuth(), requireValidOrigin(), requireCsrf(), async (c) => {
    const deps = c.var.deps;
    const auth = c.var.auth;
    const now = deps.now?.() ?? Date.now();
    await new AuthSessionRepository(deps.db).revoke({ userId: auth.userId }, auth.sessionId, now);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ user_id: auth.userId }, 200, { "cache-control": "no-store" });
  });

  app.get("/api/auth/me", requireAuth(), async (c) => {
    const deps = c.var.deps;
    const auth = c.var.auth;
    const settings = await new UserSettingsRepository(deps.db).get({ userId: auth.userId });
    return c.json(
      {
        user: {
          user_id: auth.user.userId,
          username: auth.user.normalizedUsername,
          status: auth.user.status,
          session_version: auth.user.sessionVersion,
        },
        session: { expires_at: auth.session.expiresAt },
        settings: settings
          ? {
              start_unit_key: settings.startUnitKey,
              new_words_per_group: settings.newWordsPerGroup,
              daily_goal: settings.dailyGoal,
              timezone: settings.timezone,
            }
          : null,
      },
      200,
      { "cache-control": "no-store" },
    );
  });
}
