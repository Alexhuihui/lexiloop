import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Users, auth sessions, and settings (spec 6.2 "用户与学习状态", 7.1/7.2).
 * Only the SHA-256 token hash is stored; the cookie keeps the raw token.
 */

export const appUser = sqliteTable("app_user", {
  userId: text("user_id").primaryKey(),
  normalizedUsername: text("normalized_username").notNull().unique(),
  passwordSalt: text("password_salt").notNull(),
  passwordVerifier: text("password_verifier").notNull(),
  status: text("status").notNull().default("ACTIVE"),
  sessionVersion: integer("session_version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
});

export type AppUserRow = typeof appUser.$inferSelect;

export const authSession = sqliteTable(
  "auth_session",
  {
    sessionId: text("session_id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id").notNull().references(() => appUser.userId, { onDelete: "cascade" }),
    /** session_version at issuance; mismatches invalidate the session (spec 7.1). */
    sessionVersion: integer("session_version").notNull(),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [
    index("auth_session_user_expires_idx").on(t.userId, t.expiresAt),
  ],
);

export type AuthSessionRow = typeof authSession.$inferSelect;

export const userSettings = sqliteTable("user_settings", {
  userId: text("user_id").primaryKey().references(() => appUser.userId, { onDelete: "cascade" }),
  startUnitKey: text("start_unit_key"),
  newWordsPerGroup: integer("new_words_per_group").notNull().default(10),
  dailyGoal: integer("daily_goal").notNull().default(20),
  timezone: text("timezone").notNull().default("UTC"),
  displayPreferencesJson: text("display_preferences_json").notNull().default("{}"),
});

export type UserSettingsRow = typeof userSettings.$inferSelect;
