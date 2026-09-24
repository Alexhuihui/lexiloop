import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { schema, type LexiloopDatabase } from "./schema";

/**
 * Builds the sync better-sqlite3-backed drizzle handle over an open database
 * (spec 6.1: the compiler's publish tooling and local release rehearsals run
 * against a D1-shaped SQLite file; the worker uses the async D1 driver).
 * Both handles satisfy the `LexiloopDatabase` union every repository accepts.
 */
export function createSqliteDatabase(sqlite: import("better-sqlite3").Database): LexiloopDatabase {
  return drizzleSqlite(sqlite, { schema });
}
