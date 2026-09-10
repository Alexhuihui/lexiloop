import { and, eq, sql } from "drizzle-orm";
import type { LexiloopDatabase } from "../schema";
import { appUser, authSession, userSettings, type AppUserRow, type AuthSessionRow, type UserSettingsRow } from "../schema";
import type { UserContext } from "./context";

export type AppUserStatus = "ACTIVE" | "DISABLED";

export interface CreateUserInput {
  userId: string;
  normalizedUsername: string;
  passwordSalt: string;
  passwordVerifier: string;
  status?: AppUserStatus;
  sessionVersion?: number;
  createdAt: number;
}

export interface UpsertSettingsInput {
  startUnitKey?: string | null;
  newWordsPerGroup?: number;
  dailyGoal?: number;
  timezone?: string;
  displayPreferencesJson?: string;
}

/**
 * Seeded account rows (spec 7.1). Verifiers/salts are opaque storage here;
 * hashing lives in the worker. No generic list method exists on purpose.
 */
export class UserRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  create(input: CreateUserInput): AppUserRow {
    const row = this.db
      .insert(appUser)
      .values({
        userId: input.userId,
        normalizedUsername: input.normalizedUsername,
        passwordSalt: input.passwordSalt,
        passwordVerifier: input.passwordVerifier,
        status: input.status ?? "ACTIVE",
        sessionVersion: input.sessionVersion ?? 1,
        createdAt: input.createdAt,
      })
      .returning()
      .get();
    if (!row) {
      throw new Error(`app_user insert returned no row (user_id=${input.userId})`);
    }
    return row;
  }

  getById(userId: string): AppUserRow | undefined {
    return this.db.select().from(appUser).where(eq(appUser.userId, userId)).get();
  }

  /** Login lookup by normalized username (spec 6.3 unique index). */
  getByNormalizedUsername(normalizedUsername: string): AppUserRow | undefined {
    return this.db
      .select()
      .from(appUser)
      .where(eq(appUser.normalizedUsername, normalizedUsername))
      .get();
  }

  setStatus(ctx: UserContext, status: AppUserStatus): boolean {
    const result = this.db
      .update(appUser)
      .set({ status })
      .where(eq(appUser.userId, ctx.userId))
      .run();
    return result.changes > 0;
  }

  /** Disabling an account or changing its password bumps session_version so
   * all outstanding sessions stop matching (spec 7.1/7.2). */
  bumpSessionVersion(ctx: UserContext): boolean {
    const result = this.db
      .update(appUser)
      .set({ sessionVersion: sql`${appUser.sessionVersion} + 1` })
      .where(eq(appUser.userId, ctx.userId))
      .run();
    return result.changes > 0;
  }
}

export interface CreateAuthSessionInput {
  sessionId: string;
  tokenHash: string;
  issuedAt: number;
  expiresAt: number;
  /** session_version at issuance (spec 7.2). */
  sessionVersion?: number;
}

/**
 * Server-side auth sessions (spec 7.2). Token-hash lookup is the one global
 * path (login happens before an identity is known); every other method is
 * scoped to the authenticated user context.
 */
export class AuthSessionRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  create(ctx: UserContext, input: CreateAuthSessionInput): AuthSessionRow {
    const row = this.db
      .insert(authSession)
      .values({
        sessionId: input.sessionId,
        tokenHash: input.tokenHash,
        userId: ctx.userId,
        sessionVersion: input.sessionVersion ?? 1,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
      })
      .returning()
      .get();
    if (!row) {
      throw new Error(`auth_session insert returned no row (session_id=${input.sessionId})`);
    }
    return row;
  }

  /** Resolution of a presented cookie token to its session row. */
  getByTokenHash(tokenHash: string): AuthSessionRow | undefined {
    return this.db.select().from(authSession).where(eq(authSession.tokenHash, tokenHash)).get();
  }

  get(ctx: UserContext, sessionId: string): AuthSessionRow | undefined {
    return this.db
      .select()
      .from(authSession)
      .where(and(eq(authSession.sessionId, sessionId), eq(authSession.userId, ctx.userId)))
      .get();
  }

  touch(ctx: UserContext, sessionId: string, lastUsedAt: number): boolean {
    const result = this.db
      .update(authSession)
      .set({ lastUsedAt })
      .where(and(eq(authSession.sessionId, sessionId), eq(authSession.userId, ctx.userId)))
      .run();
    return result.changes > 0;
  }

  /** Logout / explicit invalidation (spec 7.2). */
  revoke(ctx: UserContext, sessionId: string, revokedAt: number): boolean {
    const result = this.db
      .update(authSession)
      .set({ revokedAt })
      .where(and(eq(authSession.sessionId, sessionId), eq(authSession.userId, ctx.userId)))
      .run();
    return result.changes > 0;
  }
}

/**
 * Per-user display and study configuration (spec 6.2). One row per user,
 * created lazily on first upsert.
 */
export class UserSettingsRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  get(ctx: UserContext): UserSettingsRow | undefined {
    return this.db.select().from(userSettings).where(eq(userSettings.userId, ctx.userId)).get();
  }

  upsert(ctx: UserContext, input: UpsertSettingsInput): UserSettingsRow {
    const row = this.db
      .insert(userSettings)
      .values({
        userId: ctx.userId,
        startUnitKey: input.startUnitKey ?? null,
        newWordsPerGroup: input.newWordsPerGroup,
        dailyGoal: input.dailyGoal,
        timezone: input.timezone,
        displayPreferencesJson: input.displayPreferencesJson ?? "{}",
      })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: {
          ...(input.startUnitKey !== undefined ? { startUnitKey: input.startUnitKey } : {}),
          ...(input.newWordsPerGroup !== undefined ? { newWordsPerGroup: input.newWordsPerGroup } : {}),
          ...(input.dailyGoal !== undefined ? { dailyGoal: input.dailyGoal } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
          ...(input.displayPreferencesJson !== undefined
            ? { displayPreferencesJson: input.displayPreferencesJson }
            : {}),
        },
      })
      .returning()
      .get();
    if (!row) {
      throw new Error(`user_settings upsert returned no row (user_id=${ctx.userId})`);
    }
    return row;
  }
}
