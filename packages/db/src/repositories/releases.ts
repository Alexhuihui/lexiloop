import { eq, sql, type SQL } from "drizzle-orm";
import { ReleaseStatus } from "@lexiloop/content-schema";
import { z } from "zod";
import { createAtomicBatchRunner } from "../atomic";
import type { LexiloopDatabase } from "../schema";
import {
  appMeta,
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
   * The switch is one atomic statement list (see createAtomicBatchRunner):
   * every statement is a single SQL statement over the pre-batch reads
   * (`getById`/`getMeta`), composed by `batch()` on D1 and one transaction
   * on better-sqlite3 — never an interactive transaction, which D1 rejects.
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
    const statements: SQL[] = [];
    if (meta?.activeReleaseId) {
      statements.push(sqlDemoteRelease(meta.activeReleaseId));
    }
    statements.push(sqlActivateRelease(releaseId, activatedAt), sqlSwitchPointer(releaseId));
    await createAtomicBatchRunner(this.db).run(statements);
    return (await this.getById(releaseId)) ?? target;
  }

  /**
   * Legal status transitions (spec 11.3). There is no manual override: only
   * these edges exist, and activation/rollback go through `activateBatch`.
   * Exported so remote publish tooling judges its status moves against the
   * SAME table (never a divergent copy).
   */
  static readonly LEGAL_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
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
    assertStatusTransition(current.status, status, releaseId);
    await this.db.run(sqlUpdateReleaseStatus(releaseId, status));
    return (await this.getById(releaseId)) ?? current;
  }

  /**
   * The atomic activation batch (spec 6.4/11.3): imports the validated alias
   * edges, demotes the previous ACTIVE release to RETIRED, promotes the target
   * to ACTIVE and switches the app_meta pointer - all as ONE statement list
   * executed through D1's only atomic primitive, `batch()` (one transaction
   * on better-sqlite3; D1 itself rejects BEGIN/COMMIT/SAVEPOINT). Every
   * statement is a single SQL statement over the pre-batch reads (`getById`/
   * `getMeta`), so the batch composes them atomically. Any failure (e.g. a
   * malformed alias row violating a constraint) rolls the whole batch back,
   * leaving user state, statuses, and the pointer unchanged. Target must be
   * READY (first activation) or RETIRED (rollback).
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
    await createAtomicBatchRunner(this.db).run(
      buildActivationBatchStatements({
        releaseId: input.releaseId,
        activatedAt: input.activatedAt,
        previousActiveId: meta?.activeReleaseId ?? null,
        aliasRows: input.aliasRows,
      }),
    );
    return (await this.getById(input.releaseId)) ?? target;
  }
}

export type ActivationAliasRow = {
  releaseId: string;
  fromKey: string;
  toKey: string;
  canonicalKey: string;
  createdAt: number;
};

export interface ActivationBatchStatementsInput {
  releaseId: string;
  activatedAt: number;
  /** app_meta.active_release_id read BEFORE the batch (null when unset). */
  previousActiveId: string | null;
  aliasRows: readonly ActivationAliasRow[];
}

/**
 * The exact statement list of one activation (spec 6.4/11.3): alias upserts,
 * demotion of the previous ACTIVE release, promotion of the target, and the
 * app_meta pointer switch — in that order, pointer LAST. `activateBatch` runs
 * it atomically (batch() on D1, one transaction on better-sqlite3); the
 * remote publish tooling renders the SAME statements to literal SQL and
 * applies them sequentially, stopping at the first failure so a broken
 * activation never reaches the pointer switch.
 */
export function buildActivationBatchStatements(input: ActivationBatchStatementsInput): SQL[] {
  const statements: SQL[] = input.aliasRows.map((row) => sqlUpsertAliasEdge(row));
  if (input.previousActiveId !== null && input.previousActiveId !== input.releaseId) {
    statements.push(sqlDemoteRelease(input.previousActiveId));
  }
  statements.push(sqlActivateRelease(input.releaseId, input.activatedAt), sqlSwitchPointer(input.releaseId));
  return statements;
}

/** Single-statement demotion of a release to RETIRED (pre-batch read guard). */
function sqlDemoteRelease(releaseId: string): SQL {
  return sql`UPDATE content_release SET status = 'RETIRED' WHERE release_id = ${releaseId}`;
}

/**
 * Single-statement status move, judged against the SAME legal transition
 * table `updateStatus` enforces (spec 11.3). Shared by the repository and the
 * remote publish tooling so both emit the identical statement.
 */
export function assertStatusTransition(current: string, status: string, releaseId = "(unknown)"): void {
  const allowed = ReleaseRepository.LEGAL_TRANSITIONS[current] ?? [];
  if (!allowed.includes(status)) {
    throw new Error(`updateStatus: release ${releaseId} cannot move ${current} -> ${status}`);
  }
}

export function sqlUpdateReleaseStatus(releaseId: string, status: string): SQL {
  return sql`UPDATE content_release SET status = ${status} WHERE release_id = ${releaseId}`;
}

/** Single-statement promotion of the target release to ACTIVE. */
function sqlActivateRelease(releaseId: string, activatedAt: number): SQL {
  return sql`UPDATE content_release SET status = 'ACTIVE', activated_at = ${activatedAt} WHERE release_id = ${releaseId}`;
}

/** Single-statement app_meta pointer switch with the config_version bump. */
function sqlSwitchPointer(releaseId: string): SQL {
  return sql`UPDATE app_meta SET active_release_id = ${releaseId}, config_version = config_version + 1 WHERE id = 1`;
}

/**
 * Idempotent alias-edge upsert (rollback + re-activation): the same edge row
 * is updated in place; a genuinely new edge colliding with a stored from_key
 * still violates the unique index and fails the batch.
 */
function sqlUpsertAliasEdge(row: {
  releaseId: string;
  fromKey: string;
  toKey: string;
  canonicalKey: string;
  createdAt: number;
}): SQL {
  return sql`INSERT INTO content_key_alias (release_id, from_key, to_key, edge_type, canonical_key, created_at)
    VALUES (${row.releaseId}, ${row.fromKey}, ${row.toKey}, 'RENAME', ${row.canonicalKey}, ${row.createdAt})
    ON CONFLICT (release_id, from_key, to_key) DO UPDATE SET
      canonical_key = excluded.canonical_key, created_at = excluded.created_at`;
}
