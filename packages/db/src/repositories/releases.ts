import { eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { ReleaseStatus } from "@lexiloop/content-schema";
import { z } from "zod";
import { schema, type LexiloopDatabase } from "../schema";
import {
  appMeta,
  contentKeyAlias,
  contentRelease,
  releaseUnit,
  type AppMetaRow,
  type ContentReleaseRow,
  type ReleaseUnitRow,
} from "../schema";

export type ReleaseStatusValue = z.infer<typeof ReleaseStatus>;

export type ReleaseUnitStatusValue = "PASSED" | "BLOCKED";

export interface CreateReleaseInput {
  releaseId: string;
  sourcePdfSha256: string;
  schemaVersion: string;
  promptVersion: string;
  /** Model + voice configuration (spec 5.9 model_config). */
  modelConfigJson: string;
  status?: ReleaseStatusValue;
  createdAt: number;
  manifestSha256: string;
}

export interface InsertUnitReportInput {
  unitKey: string;
  status: ReleaseUnitStatusValue;
  words?: number;
  senses?: number;
  phrases?: number;
  examples?: number;
  explanations?: number;
  cards?: number;
  qaSummary?: string | null;
}

/**
 * Release lifecycle and the app_meta active-release pointer (spec 6.2/11.3).
 * Activation is a pointer switch: the previous ACTIVE release becomes
 * RETIRED and is retained for rollback; nothing is re-imported.
 */
export class ReleaseRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async create(input: CreateReleaseInput): Promise<ContentReleaseRow> {
    const rows = await this.db
      .insert(contentRelease)
      .values({
        releaseId: input.releaseId,
        sourcePdfSha256: input.sourcePdfSha256,
        schemaVersion: input.schemaVersion,
        promptVersion: input.promptVersion,
        modelConfigJson: input.modelConfigJson,
        status: input.status ?? "DRAFT",
        createdAt: input.createdAt,
        activatedAt: null,
        manifestSha256: input.manifestSha256,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`release insert returned no row (release_id=${input.releaseId})`);
    }
    return row;
  }

  async insertUnitReport(releaseId: string, input: InsertUnitReportInput): Promise<ReleaseUnitRow> {
    const rows = await this.db
      .insert(releaseUnit)
      .values({
        releaseId,
        unitKey: input.unitKey,
        status: input.status,
        words: input.words ?? 0,
        senses: input.senses ?? 0,
        phrases: input.phrases ?? 0,
        examples: input.examples ?? 0,
        explanations: input.explanations ?? 0,
        cards: input.cards ?? 0,
        qaSummary: input.qaSummary ?? null,
      })
      .returning();
    const row = rows[0];
    if (!row) {
      throw new Error(`release_unit insert returned no row (unit_key=${input.unitKey})`);
    }
    return row;
  }

  async getById(releaseId: string): Promise<ContentReleaseRow | undefined> {
    return await this.db.select().from(contentRelease).where(eq(contentRelease.releaseId, releaseId)).get();
  }

  async getMeta(): Promise<AppMetaRow | undefined> {
    return await this.db.select().from(appMeta).where(eq(appMeta.id, 1)).get();
  }

  /** The currently ACTIVE release via the app_meta pointer (spec 6.4). */
  async getActive(): Promise<ContentReleaseRow | undefined> {
    const meta = await this.getMeta();
    if (!meta?.activeReleaseId) {
      return undefined;
    }
    return await this.getById(meta.activeReleaseId);
  }

  /**
   * Points app_meta at `releaseId`, demotes the previous ACTIVE release to
   * RETIRED and promotes the target (READY for first activation, RETIRED for
   * rollback — spec 11.3).
   *
   * Transaction note (review finding): interactive `transaction()` callbacks
   * cannot be inferred through the sync/async handle union, so this is the
   * one isolated sync-typed call. At runtime both drivers implement it
   * (drizzle's D1 session issues BEGIN/COMMIT); on D1 the worker may
   * alternatively compose the three statements with `batch()`.
   */
  async setActive(releaseId: string, activatedAt: number): Promise<ContentReleaseRow> {
    const target = await this.getById(releaseId);
    if (!target) {
      throw new Error(`setActive: release ${releaseId} does not exist`);
    }
    const meta = await this.getMeta();
    if (meta?.activeReleaseId === releaseId) {
      return target; // already active; keep activated_at stable
    }
    if (target.status !== "READY" && target.status !== "RETIRED") {
      throw new Error(`setActive: release ${releaseId} is ${target.status}, expected READY or RETIRED`);
    }
    const txDb = this.db as BetterSQLite3Database<typeof schema>;
    txDb.transaction((tx) => {
      if (meta?.activeReleaseId) {
        tx.update(contentRelease)
          .set({ status: "RETIRED" })
          .where(eq(contentRelease.releaseId, meta.activeReleaseId))
          .run();
      }
      tx.update(contentRelease)
        .set({ status: "ACTIVE", activatedAt })
        .where(eq(contentRelease.releaseId, releaseId))
        .run();
      tx.update(appMeta)
        .set({ activeReleaseId: releaseId, configVersion: sql`${appMeta.configVersion} + 1` })
        .where(eq(appMeta.id, 1))
        .run();
    });
    return (await this.getById(releaseId)) ?? target;
  }

  /**
   * Legal status transitions (spec 11.3). There is no manual override: only
   * these edges exist, and activation/rollback go through `activateBatch`.
   */
  private static readonly LEGAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
    DRAFT: ["IMPORTING", "FAILED"],
    IMPORTING: ["VALIDATING", "FAILED"],
    VALIDATING: ["READY", "FAILED"],
    READY: ["ACTIVE"],
    ACTIVE: ["RETIRED"],
    RETIRED: ["ACTIVE"],
  };

  /**
   * Advances the release status along the legal lifecycle (spec 11.3).
   * Import/tooling-internal: there is no CLI flag or manual status override.
   */
  async updateStatus(releaseId: string, status: ReleaseStatusValue): Promise<ContentReleaseRow> {
    const current = await this.getById(releaseId);
    if (!current) {
      throw new Error(`updateStatus: release ${releaseId} does not exist`);
    }
    const allowed = ReleaseRepository.LEGAL_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(status)) {
      throw new Error(`updateStatus: release ${releaseId} cannot move ${current.status} -> ${status}`);
    }
    await this.db.update(contentRelease).set({ status }).where(eq(contentRelease.releaseId, releaseId));
    return (await this.getById(releaseId)) ?? current;
  }

  /**
   * The atomic activation batch (spec 6.4/11.3): imports the validated alias
   * edges, demotes the previous ACTIVE release to RETIRED, promotes the target
   * to ACTIVE and switches the app_meta pointer - all inside one transaction.
   * Any failure (e.g. a malformed alias row violating a constraint) rolls the
   * whole batch back, leaving user state, statuses, and the pointer unchanged.
   * Target must be READY (first activation) or RETIRED (rollback).
   */
  async activateBatch(input: {
    releaseId: string;
    activatedAt: number;
    aliasRows: readonly {
      releaseId: string;
      fromKey: string;
      toKey: string;
      canonicalKey: string;
      createdAt: number;
    }[];
  }): Promise<ContentReleaseRow> {
    const target = await this.getById(input.releaseId);
    if (!target) {
      throw new Error(`activateBatch: release ${input.releaseId} does not exist`);
    }
    if (target.status !== "READY" && target.status !== "RETIRED") {
      throw new Error(`activateBatch: release ${input.releaseId} is ${target.status}, expected READY or RETIRED`);
    }
    const meta = await this.getMeta();
    const txDb = this.db as BetterSQLite3Database<typeof schema>;
    txDb.transaction((tx) => {
      for (const row of input.aliasRows) {
        // Idempotent re-import (rollback + re-activation): the same edge row
        // is updated in place; a genuinely new edge colliding with a stored
        // from_key still violates the unique index and fails the batch.
        tx.insert(contentKeyAlias)
          .values({
            releaseId: row.releaseId,
            fromKey: row.fromKey,
            toKey: row.toKey,
            // Imported migration edges are renames; 'EQUIVALENT' stays
            // reserved for future same-entity declarations.
            edgeType: "RENAME",
            canonicalKey: row.canonicalKey,
            createdAt: row.createdAt,
          })
          .onConflictDoUpdate({
            target: [contentKeyAlias.releaseId, contentKeyAlias.fromKey, contentKeyAlias.toKey],
            set: { canonicalKey: row.canonicalKey, createdAt: row.createdAt },
          })
          .run();
      }
      if (meta?.activeReleaseId && meta.activeReleaseId !== input.releaseId) {
        tx.update(contentRelease)
          .set({ status: "RETIRED" })
          .where(eq(contentRelease.releaseId, meta.activeReleaseId))
          .run();
      }
      tx.update(contentRelease)
        .set({ status: "ACTIVE", activatedAt: input.activatedAt })
        .where(eq(contentRelease.releaseId, input.releaseId))
        .run();
      tx.update(appMeta)
        .set({ activeReleaseId: input.releaseId, configVersion: sql`${appMeta.configVersion} + 1` })
        .where(eq(appMeta.id, 1))
        .run();
    });
    return (await this.getById(input.releaseId)) ?? target;
  }
}
