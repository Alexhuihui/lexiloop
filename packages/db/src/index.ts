/**
 * LexiLoop D1 schema, migrations contract, and repositories (spec 6).
 *
 * The SQL files in infra/migrations are the DDL source of truth; this package
 * mirrors them as Drizzle tables for typed access and provides thin,
 * release-scoped / user-scoped repositories with envelope-validated JSON
 * blobs. Business logic (FSRS math, queue algorithms) lives elsewhere.
 *
 * Error convention (review decision): drivers surface SQLite constraint
 * violations as raw driver errors (better-sqlite3 `SqliteError`, D1 query
 * errors). This package never wraps or rewrites them; callers that need
 * stable behavior must check the driver error class and message. The API
 * routes (Task 11) explicitly map the known UNIQUE violations —
 * app_user.normalized_username and auth_session.token_hash — to 409/401
 * responses and treat any other violation as a 5xx.
 */
export * from "./schema";
export * from "./envelopes";
export * from "./sqlite-driver";
export * from "./repositories/context";
export * from "./repositories/content";
export * from "./repositories/releases";
export * from "./repositories/alias-repository";
export * from "./repositories/study";
export * from "./repositories/users";
