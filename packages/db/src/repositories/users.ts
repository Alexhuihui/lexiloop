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
 *
 * Error convention: a duplicate `normalized_username` surfaces as a raw
 * driver UNIQUE error (see src/index.ts); the API layer maps it to 409.
 */
export class UserRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async create(input: CreateUserInput): Promise<AppUserRow> {
    const rows = await this.db
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
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`app_user insert returned no row (user_id=${input.userId})`);
    }
    return row;
  }

  async getById(userId: string): Promise<AppUserRow | undefined> {
    return await this.db.select().from(appUser).where(eq(appUser.userId, userId)).get();
  }

  /** Login lookup by normalized username (spec 6.3 unique index). */
  async getByNormalizedUsername(normalizedUsername: string): Promise<AppUserRow | undefined> {
    return await this.db
      .select()
      .from(appUser)
      .where(eq(appUser.normalizedUsername, normalizedUsername))
      .get();
  }

  async setStatus(ctx: UserContext, status: AppUserStatus): Promise<boolean> {
    const rows = await this.db
      .update(appUser)
      .set({ status })
      .where(eq(appUser.userId, ctx.userId))
      .returning();
    return rows.length > 0;
  }

  /** Disabling an account or changing its password bumps session_version so
   * all outstanding sessions stop matching (spec 7.1/7.2). */
  async bumpSessionVersion(ctx: UserContext): Promise<boolean> {
    const rows = await this.db
      .update(appUser)
      .set({ sessionVersion: sql`${appUser.sessionVersion} + 1` })
      .where(eq(appUser.userId, ctx.userId))
      .returning();
    return rows.length > 0;
  }

  /**
   * seed-users credential rotation (spec 7.1): installs a freshly generated
   * salt/verifier pair and bumps session_version in one statement, so every
   * outstanding session of the account stops matching immediately.
   */
  async rotateCredentials(
    ctx: UserContext,
    input: { passwordSalt: string; passwordVerifier: string },
  ): Promise<AppUserRow | undefined> {
    const rows = await this.db
      .update(appUser)
      .set({
        passwordSalt: input.passwordSalt,
        passwordVerifier: input.passwordVerifier,
        sessionVersion: sql`${appUser.sessionVersion} + 1`,
      })
      .where(eq(appUser.userId, ctx.userId))
      .returning();
    return rows[0];
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

export interface ResolvedAuthSession {
  session: AuthSessionRow;
  user: AppUserRow;
}

/**
 * Server-side auth sessions (spec 7.2). Token-hash lookup is the one global
 * path (login happens before an identity is known); every other method is
 * scoped to the authenticated user context. A duplicate token hash surfaces
 * as a raw driver UNIQUE error; the API layer maps it to 401.
 */
export class AuthSessionRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async create(ctx: UserContext, input: CreateAuthSessionInput): Promise<AuthSessionRow> {
    const rows = await this.db
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
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`auth_session insert returned no row (session_id=${input.sessionId})`);
    }
    return row;
  }

  /** Resolution of a presented cookie token to its session row. */
  async getByTokenHash(tokenHash: string): Promise<AuthSessionRow | undefined> {
    return await this.db.select().from(authSession).where(eq(authSession.tokenHash, tokenHash)).get();
  }

  /** Resolves the cookie hash and its owning account in one database read. */
  async resolveByTokenHash(tokenHash: string): Promise<ResolvedAuthSession | undefined> {
    const row = await this.db
      .select()
      .from(authSession)
      .innerJoin(appUser, eq(appUser.userId, authSession.userId))
      .where(eq(authSession.tokenHash, tokenHash))
      .get();
    return row ? { session: row.auth_session, user: row.app_user } : undefined;
  }

  async get(ctx: UserContext, sessionId: string): Promise<AuthSessionRow | undefined> {
    return await this.db
      .select()
      .from(authSession)
      .where(and(eq(authSession.sessionId, sessionId), eq(authSession.userId, ctx.userId)))
      .get();
  }

  async touch(ctx: UserContext, sessionId: string, lastUsedAt: number): Promise<boolean> {
    const rows = await this.db
      .update(authSession)
      .set({ lastUsedAt })
      .where(and(eq(authSession.sessionId, sessionId), eq(authSession.userId, ctx.userId)))
      .returning();
    return rows.length > 0;
  }

  /** Logout / explicit invalidation (spec 7.2). */
  async revoke(ctx: UserContext, sessionId: string, revokedAt: number): Promise<boolean> {
    const rows = await this.db
      .update(authSession)
      .set({ revokedAt })
      .where(and(eq(authSession.sessionId, sessionId), eq(authSession.userId, ctx.userId)))
      .returning();
    return rows.length > 0;
  }
}

/**
 * Per-user display and study configuration (spec 6.2). One row per user,
 * created lazily on first upsert.
 */
export class UserSettingsRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async get(ctx: UserContext): Promise<UserSettingsRow | undefined> {
    return await this.db.select().from(userSettings).where(eq(userSettings.userId, ctx.userId)).get();
  }

  async upsert(ctx: UserContext, input: UpsertSettingsInput): Promise<UserSettingsRow> {
    const rows = await this.db
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
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`user_settings upsert returned no row (user_id=${ctx.userId})`);
    }
    return row;
  }
}
