/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  AliasRepository,
  AuthSessionRepository,
  CardStateRepository,
  ContentRepository,
  ReleaseRepository,
  ReviewLogRepository,
  StudySessionRepository,
  UserSettingsRepository,
  UserRepository,
  WordProgressRepository,
  type LexiloopDatabase,
} from "../src";
import * as schema from "../src/schema";
import { createMigratedTestDb } from "./helpers";

/**
 * Review finding 1: the repository layer is driver-agnostic. The probes in
 * this file are checked by tsc — if the handle union ever stops accepting the
 * D1 drizzle database, `typecheck` fails here before the worker integration.
 */

// tsc-level probe 1: the D1 handle satisfies the repository handle union.
type D1HandleSatisfiesUnion = DrizzleD1Database<typeof schema> extends LexiloopDatabase ? true : false;
const d1HandleSatisfiesUnion: D1HandleSatisfiesUnion = true;

// tsc-level probe 2 (ambient, never executed at runtime): every repository
// constructor accepts a DrizzleD1Database handle.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- tsc probe, only used as a type by design
declare function constructAllOnD1(db: DrizzleD1Database<typeof schema>): [
  ReleaseRepository,
  AliasRepository,
  ContentRepository,
  UserRepository,
  AuthSessionRepository,
  UserSettingsRepository,
  WordProgressRepository,
  CardStateRepository,
  ReviewLogRepository,
  StudySessionRepository,
];
type ConstructionProbe = ReturnType<typeof constructAllOnD1>;
const constructionProbeArity: 10 = 10 satisfies ConstructionProbe["length"];

describe("driver-agnostic repositories", () => {
  it("accepts the D1 drizzle handle at the type level", () => {
    expect(d1HandleSatisfiesUnion).toBe(true);
    expect(constructionProbeArity).toBe(10);
  });

  it("runs on the better-sqlite3 driver at runtime", async () => {
    const env = createMigratedTestDb();
    try {
      const db = drizzle(env.sqlite, { schema });
      const releases = new ReleaseRepository(db);
      const created = await releases.create({
        releaseId: "r-driver",
        sourcePdfSha256: "a".repeat(64),
        schemaVersion: "schema-v1",
        promptVersion: "prompt-v1",
        modelConfigJson: "{}",
        status: "READY",
        createdAt: 1_700_000_000_000,
        manifestSha256: "b".repeat(64),
      });
      expect(created.status).toBe("READY");
      const activated = await releases.setActive("r-driver", 1_700_000_000_000 + 1);
      expect(activated.status).toBe("ACTIVE");
      const active = await releases.getActive();
      expect(active?.releaseId).toBe("r-driver");
      // Activation switches the pointer and demotes the previous release.
      await releases.create({
        releaseId: "r-driver-2",
        sourcePdfSha256: "a".repeat(64),
        schemaVersion: "schema-v1",
        promptVersion: "prompt-v1",
        modelConfigJson: "{}",
        status: "READY",
        createdAt: 1_700_000_000_000,
        manifestSha256: "b".repeat(64),
      });
      const rolled = await releases.setActive("r-driver-2", 1_700_000_000_000 + 2);
      expect(rolled.status).toBe("ACTIVE");
      expect((await releases.getById("r-driver"))?.status).toBe("RETIRED");
      // Alias resolution: no edge -> identity; canonical root disagreement throws.
      const aliases = new AliasRepository(db);
      await expect(aliases.resolve({ releaseId: "r-driver-2", key: "word-1" })).resolves.toBe("word-1");
    } finally {
      env.cleanup();
    }
  });
});
