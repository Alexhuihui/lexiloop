import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** Absolute path of the D1 SQL migrations (repo-root relative). */
export const migrationsDir = resolve(
  // String overload: workers-types (referenced by driver.test.ts) replaces the
  // global URL type, so only the string overload is compatible with both.
  dirname(fileURLToPath(import.meta.url)),
  "../../../infra/migrations",
);

export interface TestDatabase {
  sqlite: Database.Database;
  /** Closes the database and deletes the temporary directory. */
  cleanup: () => void;
}

/**
 * Creates a throwaway SQLite database under the OS temp dir and applies every
 * D1 migration in filename order, mirroring how wrangler applies
 * `infra/migrations/*.sql` to a real D1 database. Foreign keys are enforced.
 */
export function createMigratedTestDb(): TestDatabase {
  const dir = join(tmpdir(), `lexiloop-db-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const sqlite = new Database(join(dir, "d1.sqlite"));
  sqlite.pragma("foreign_keys = ON");
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`no SQL migrations found in ${migrationsDir}`);
  }
  try {
    for (const file of files) {
      sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
  } catch (cause) {
    // Never leak a half-migrated temp database when a migration fails.
    sqlite.close();
    rmSync(dir, { recursive: true, force: true });
    throw cause;
  }
  return {
    sqlite,
    cleanup: () => {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Timestamp helper: all stored times are UTC epoch milliseconds. */
export const T0 = 1_700_000_000_000;
