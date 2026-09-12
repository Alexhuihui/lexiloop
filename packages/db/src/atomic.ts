/**
 * One atomic write unit shared by every multi-statement workflow (spec 8.3:
 * one grade = one D1 batch; spec 11.3: one activation = one D1 batch). Any
 * statement failure rolls back the whole unit. Statements are prebuilt
 * drizzle `SQL` — all decisions are made BEFORE the unit runs, and
 * conditional flips are expressed as guarded UPDATE statements so every
 * entry stays a single SQL statement the batch can compose.
 *
 * - D1 (production): `batch()` is D1's ONLY atomic primitive (D1 rejects
 *   `BEGIN TRANSACTION`/`COMMIT`/`SAVEPOINT`). The statements are rendered
 *   and bound through drizzle's dialect and handed to the raw D1 client's
 *   `batch()`, which executes them as one implicit transaction.
 * - better-sqlite3 (tests/scripts): one interactive `transaction()`.
 */

import type { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { schema, type LexiloopDatabase } from "./schema";

export interface AtomicBatchRunner {
  run(statements: readonly SQL[]): Promise<void>;
}

/** Structural surface of the raw D1 client behind a drizzle D1 handle. */
interface D1ClientLike {
  prepare(query: string): { bind(...params: unknown[]): unknown };
  batch(statements: readonly unknown[]): Promise<unknown>;
}

export function createAtomicBatchRunner(db: LexiloopDatabase): AtomicBatchRunner {
  // Feature detection: only drizzle's D1 driver exposes `batch()` on the
  // handle and a D1 client (`$client`) with a batch primitive behind it.
  const d1 = db as unknown as { batch?: unknown; $client?: unknown };
  const client = d1.$client as D1ClientLike | undefined;
  if (
    typeof d1.batch === "function" &&
    client !== undefined &&
    typeof client.batch === "function" &&
    typeof client.prepare === "function"
  ) {
    const dialect = new SQLiteSyncDialect();
    return {
      async run(statements) {
        // D1's atomic primitive: the prepared statements run as ONE implicit
        // transaction — a failure anywhere rolls back every statement.
        await client.batch(
          statements.map((statement) => {
            const query = dialect.sqlToQuery(statement);
            return client.prepare(query.sql).bind(...query.params);
          }),
        );
      },
    };
  }
  // The sync better-sqlite3 driver (tests, compiler scripts) has no batch:
  // the unit runs inside one interactive transaction instead.
  const syncHandle = db as unknown as BetterSQLite3Database<typeof schema>;
  return {
    async run(statements) {
      syncHandle.transaction((tx) => {
        for (const statement of statements) {
          tx.run(statement);
        }
      });
    },
  };
}
