import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ReleaseRepository, createSqliteDatabase, type LexiloopDatabase } from "../src";
import { createMigratedTestDb, type TestDatabase } from "./helpers";

/**
 * Finding 1 (final review): release activation/rollback must compose D1's
 * ONLY atomic primitive — `batch()` — because D1 rejects interactive
 * `BEGIN TRANSACTION`/`COMMIT`/`SAVEPOINT`. The D1-shaped fake below models
 * the real production structure: a drizzle-style handle whose raw client
 * (`$client`) prepares bound statements and runs them through
 * `client.batch(...)` against better-sqlite3 inside ONE real transaction —
 * a failure in any statement rolls back the whole batch, exactly D1's
 * atomicity contract. Driving `ReleaseRepository` end to end through this
 * fake proves activation is usable on remote D1 (the sync better-sqlite3
 * transaction path is covered by the compiler package tests).
 */

/** A bound, not-yet-executed statement — the shape D1's client hands to batch(). */
interface BoundStatement {
  sql: string;
  params: unknown[];
}

interface D1ShapedHandle {
  db: LexiloopDatabase;
  /** Number of raw client batch() invocations (the atomic units). */
  batchCalls: number;
}

function createD1ShapedDatabase(sqlite: Database.Database): D1ShapedHandle {
  const sync = createSqliteDatabase(sqlite);
  let batchCalls = 0;
  const client = {
    prepare(query: string) {
      return { bind: (...params: unknown[]) => ({ sql: query, params }) };
    },
    async batch(statements: readonly unknown[]): Promise<unknown> {
      batchCalls += 1;
      // D1's contract: every statement of the batch runs inside ONE implicit
      // transaction — a failure anywhere rolls back all of them.
      const runAll = (): unknown[] =>
        (statements as BoundStatement[]).map((statement) => sqlite.prepare(statement.sql).run(...statement.params));
      return sqlite.transaction(runAll)();
    },
  };
  const handle = new Proxy(sync, {
    get(target, prop) {
      if (prop === "$client" || prop === "batch") return prop === "$client" ? client : client.batch.bind(client);
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    db: handle as unknown as LexiloopDatabase,
    get batchCalls(): number {
      return batchCalls;
    },
  };
}

const BASE = {
  sourcePdfSha256: "a".repeat(64),
  schemaVersion: "schema-v1",
  promptVersion: "prompt-v1",
  modelConfigJson: "{}",
  createdAt: 1_700_000_000_000,
  manifestSha256: "b".repeat(64),
};

async function seedReadyRelease(releases: ReleaseRepository, releaseId: string): Promise<void> {
  await releases.create({ releaseId, ...BASE, status: "READY" });
}

function aliasCount(env: TestDatabase): number {
  return (env.sqlite.prepare("SELECT COUNT(*) AS n FROM content_key_alias").get() as { n: number }).n;
}

describe("release activation on a D1-shaped driver (batch-native)", () => {
  it("activates through ONE client batch: aliases imported, previous release retired, pointer switched", async () => {
    const env = createMigratedTestDb();
    try {
      const shaped = createD1ShapedDatabase(env.sqlite);
      const releases = new ReleaseRepository(shaped.db);
      await seedReadyRelease(releases, "rel-a");
      await seedReadyRelease(releases, "rel-b");
      await releases.setActive("rel-a", 1_700_000_000_000);
      expect((await releases.getMeta())?.configVersion).toBe(2);
      const batchesBefore = shaped.batchCalls;

      await releases.activateBatch({
        releaseId: "rel-b",
        activatedAt: 1_700_000_000_000 + 1,
        aliasRows: [
          { releaseId: "rel-a", fromKey: "w-old", toKey: "w-new", canonicalKey: "w-new", createdAt: 1_700_000_000_000 },
          { releaseId: "rel-a", fromKey: "k-old", toKey: "k-new", canonicalKey: "k-new", createdAt: 1_700_000_000_000 },
        ],
      });

      // The whole activation was composed as one atomic batch call.
      expect(shaped.batchCalls - batchesBefore).toBe(1);
      const target = await releases.getById("rel-b");
      expect(target).toMatchObject({ status: "ACTIVE", activatedAt: 1_700_000_000_000 + 1 });
      expect((await releases.getById("rel-a"))?.status).toBe("RETIRED");
      expect((await releases.getMeta())).toMatchObject({ activeReleaseId: "rel-b", configVersion: 3 });
      expect(aliasCount(env)).toBe(2);
      expect(
        env.sqlite.prepare("SELECT canonical_key FROM content_key_alias WHERE from_key = 'w-old'").get(),
      ).toMatchObject({ canonical_key: "w-new" });
    } finally {
      env.cleanup();
    }
  });

  it("rolls the whole batch back when a statement fails mid-batch", async () => {
    const env = createMigratedTestDb();
    try {
      const shaped = createD1ShapedDatabase(env.sqlite);
      const releases = new ReleaseRepository(shaped.db);
      await seedReadyRelease(releases, "rel-a");
      await seedReadyRelease(releases, "rel-b");
      await releases.setActive("rel-a", 1_700_000_000_000);
      const batchesBefore = shaped.batchCalls;

      // The second alias row violates content_key_alias's release FK: on D1
      // the failing statement aborts the whole batch.
      await expect(
        releases.activateBatch({
          releaseId: "rel-b",
          activatedAt: 1_700_000_000_000 + 1,
          aliasRows: [
            { releaseId: "rel-a", fromKey: "w-ok", toKey: "w-ok-2", canonicalKey: "w-ok-2", createdAt: 1_700_000_000_000 },
            { releaseId: "missing-release", fromKey: "x", toKey: "y", canonicalKey: "y", createdAt: 1_700_000_000_000 },
          ],
        }),
      ).rejects.toThrow();

      // Atomic: exactly one batch attempt; pointer, statuses, and the alias
      // table are unchanged.
      expect(shaped.batchCalls - batchesBefore).toBe(1);
      expect((await releases.getMeta())?.activeReleaseId).toBe("rel-a");
      expect((await releases.getById("rel-b"))?.status).toBe("READY");
      expect((await releases.getById("rel-a"))?.status).toBe("ACTIVE");
      expect(aliasCount(env)).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it("re-activates a RETIRED release (rollback) through the same batch", async () => {
    const env = createMigratedTestDb();
    try {
      const shaped = createD1ShapedDatabase(env.sqlite);
      const releases = new ReleaseRepository(shaped.db);
      await seedReadyRelease(releases, "rel-a");
      await seedReadyRelease(releases, "rel-b");
      await releases.setActive("rel-a", 1_700_000_000_000);
      await releases.activateBatch({ releaseId: "rel-b", activatedAt: 1_700_000_000_000 + 1, aliasRows: [] });
      expect((await releases.getById("rel-a"))?.status).toBe("RETIRED");
      const batchesBefore = shaped.batchCalls;

      // Rollback: re-activation demotes the undone release and switches the
      // pointer back — still one atomic batch.
      await releases.activateBatch({ releaseId: "rel-a", activatedAt: 1_700_000_000_000 + 2, aliasRows: [] });
      expect(shaped.batchCalls - batchesBefore).toBe(1);
      expect((await releases.getById("rel-a"))).toMatchObject({ status: "ACTIVE", activatedAt: 1_700_000_000_000 + 2 });
      expect((await releases.getById("rel-b"))?.status).toBe("RETIRED");
      expect((await releases.getMeta())).toMatchObject({ activeReleaseId: "rel-a", configVersion: 4 });
    } finally {
      env.cleanup();
    }
  });

  it("runs setActive (pointer-only switch) through one batch too", async () => {
    const env = createMigratedTestDb();
    try {
      const shaped = createD1ShapedDatabase(env.sqlite);
      const releases = new ReleaseRepository(shaped.db);
      await seedReadyRelease(releases, "rel-a");
      await seedReadyRelease(releases, "rel-b");
      await releases.setActive("rel-a", 1_700_000_000_000);
      const batchesBefore = shaped.batchCalls;

      await releases.setActive("rel-b", 1_700_000_000_000 + 1);

      expect(shaped.batchCalls - batchesBefore).toBe(1);
      expect((await releases.getMeta())?.activeReleaseId).toBe("rel-b");
      expect((await releases.getById("rel-a"))?.status).toBe("RETIRED");
      expect((await releases.getById("rel-b"))?.status).toBe("ACTIVE");
    } finally {
      env.cleanup();
    }
  });
});
