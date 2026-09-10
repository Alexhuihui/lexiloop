import { and, eq, sql } from "drizzle-orm";
import { ReleaseStatus } from "@lexiloop/content-schema";
import { z } from "zod";
import type { LexiloopDatabase } from "../schema";
import {
  appMeta,
  contentKeyAlias,
  contentRelease,
  releaseUnit,
  type AppMetaRow,
  type ContentKeyAliasRow,
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

  create(input: CreateReleaseInput): ContentReleaseRow {
    const row = this.db
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
      .returning()
      .get();
    if (!row) {
      throw new Error(`release insert returned no row (release_id=${input.releaseId})`);
    }
    return row;
  }

  insertUnitReport(releaseId: string, input: InsertUnitReportInput): ReleaseUnitRow {
    const row = this.db
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
      .returning()
      .get();
    if (!row) {
      throw new Error(`release_unit insert returned no row (unit_key=${input.unitKey})`);
    }
    return row;
  }

  getById(releaseId: string): ContentReleaseRow | undefined {
    return this.db.select().from(contentRelease).where(eq(contentRelease.releaseId, releaseId)).get();
  }

  getMeta(): AppMetaRow | undefined {
    return this.db.select().from(appMeta).where(eq(appMeta.id, 1)).get();
  }

  /** The currently ACTIVE release via the app_meta pointer (spec 6.4). */
  getActive(): ContentReleaseRow | undefined {
    const meta = this.getMeta();
    if (!meta?.activeReleaseId) {
      return undefined;
    }
    return this.getById(meta.activeReleaseId);
  }

  /**
   * Points app_meta at `releaseId`, demotes the previous ACTIVE release to
   * RETIRED and promotes the target (READY for first activation, RETIRED for
   * rollback — spec 11.3). Runs in one local transaction; on D1 the worker
   * composes the same statements via `batch()`.
   */
  setActive(releaseId: string, activatedAt: number): ContentReleaseRow {
    const target = this.getById(releaseId);
    if (!target) {
      throw new Error(`setActive: release ${releaseId} does not exist`);
    }
    const meta = this.getMeta();
    if (meta?.activeReleaseId === releaseId) {
      return target; // already active; keep activated_at stable
    }
    if (target.status !== "READY" && target.status !== "RETIRED") {
      throw new Error(`setActive: release ${releaseId} is ${target.status}, expected READY or RETIRED`);
    }
    this.db.transaction((tx) => {
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
    return this.getById(releaseId) ?? target;
  }
}

export interface ResolveAliasInput {
  releaseId: string;
  /** Any historical stable key. */
  key: string;
}

/**
 * Stable-key alias resolution (spec 5.5/6.4). Walks typed one-to-one edges of
 * the release to the canonical root key user state references. Cycles and
 * edges whose stored `canonical_key` disagrees with the walked root fail
 * loudly — alias data must never silently redirect progress.
 */
export class AliasRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  resolve(input: ResolveAliasInput): string {
    const { releaseId, key } = input;
    let current = key;
    let firstCanonicalKey: string | null = null;
    const visited = new Set<string>([key]);
    for (;;) {
      const edge = this.db
        .select()
        .from(contentKeyAlias)
        .where(and(eq(contentKeyAlias.releaseId, releaseId), eq(contentKeyAlias.fromKey, current)))
        .get();
      if (!edge) {
        break;
      }
      firstCanonicalKey ??= edge.canonicalKey;
      if (visited.has(edge.toKey)) {
        throw new Error(`content_key_alias cycle detected in release ${releaseId} at key ${edge.toKey}`);
      }
      visited.add(edge.toKey);
      current = edge.toKey;
    }
    if (firstCanonicalKey !== null && firstCanonicalKey !== current) {
      throw new Error(
        `content_key_alias inconsistency in release ${releaseId}: stored canonical root ${firstCanonicalKey} != walked root ${current}`,
      );
    }
    return current;
  }

  /** Reads one edge without walking; mostly for verification tooling. */
  getEdge(releaseId: string, fromKey: string): ContentKeyAliasRow | undefined {
    return this.db
      .select()
      .from(contentKeyAlias)
      .where(and(eq(contentKeyAlias.releaseId, releaseId), eq(contentKeyAlias.fromKey, fromKey)))
      .get();
  }
}
