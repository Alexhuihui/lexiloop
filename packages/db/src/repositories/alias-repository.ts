import { and, eq, inArray } from "drizzle-orm";
import type { AliasGraph } from "@lexiloop/domain";
import { contentKeyAlias, cardState, wordProgress, type ContentKeyAliasRow } from "../schema";
import type { LexiloopDatabase } from "../schema";

export interface ResolveAliasInput {
  releaseId: string;
  /** Any historical stable key. */
  key: string;
}

/** One row of the release-scoped `content_key_alias` table (insert shape). */
export interface AliasRowInput {
  /**
   * The release that DECLARES the edge: the release the presented (from) key
   * belongs to (`from_release_id`). Edges are therefore resolvable from the
   * presenting release's own rows (spec 6.4: pinned sessions keep presenting
   * old keys while grading resolves the same canonical state).
   */
  releaseId: string;
  fromKey: string;
  toKey: string;
  canonicalKey: string;
  createdAt: number;
}

/** A user-state row that would collapse under a declared alias component. */
export interface AliasStateConflict {
  userId: string;
  table: "word_progress" | "card_state";
  key: string;
  canonicalKey: string;
}

/**
 * Stable-key alias resolution (spec 5.5/6.4).
 *
 * `resolve` walks the one-to-one edges from a presented key to the canonical
 * root in EITHER direction: a key may sit on the from side (an old key whose
 * release renamed it) or on the to side (a key merged into an older canonical
 * root). Edges are stored under the release that declares them, but the walk
 * itself is release-independent by design — canonical user state is global, so
 * a key resolves to the same root no matter which release presented it (pinned
 * sessions, rollback, spec 6.4). Cycles, ambiguous fan-out (one key with
 * several successors across releases) and stored canonical roots that disagree
 * with the walked sink fail loudly; alias data must never silently redirect
 * progress.
 */
export class AliasRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async resolve(input: ResolveAliasInput): Promise<string> {
    const { releaseId, key } = input;
    let current = key;
    let canonical: string | null = null;
    const visited = new Set<string>([key]);
    for (;;) {
      const edges = await this.db
        .select()
        .from(contentKeyAlias)
        .where(eq(contentKeyAlias.fromKey, current));
      if (edges.length > 1) {
        throw new Error(
          `content_key_alias: key ${current} has ${edges.length} outgoing edges across releases; ` +
            "refusing ambiguous alias resolution",
        );
      }
      const edge = edges[0];
      if (!edge) break;
      canonical ??= edge.canonicalKey;
      if (edge.canonicalKey !== canonical) {
        throw new Error(
          `content_key_alias inconsistency at key ${current}: stored canonical root ` +
            `${edge.canonicalKey} disagrees with the component root ${canonical}`,
        );
      }
      if (visited.has(edge.toKey)) {
        throw new Error(`content_key_alias cycle detected at key ${edge.toKey} in release ${releaseId}`);
      }
      visited.add(edge.toKey);
      current = edge.toKey;
    }
    if (canonical !== null && canonical !== current) {
      throw new Error(
        `content_key_alias inconsistency in release ${releaseId}: stored canonical root ` +
          `${canonical} != walked sink ${current}`,
      );
    }
    return current;
  }

  /** Reads one edge without walking; mostly for verification tooling. */
  async getEdge(releaseId: string, fromKey: string): Promise<ContentKeyAliasRow | undefined> {
    return await this.db
      .select()
      .from(contentKeyAlias)
      .where(and(eq(contentKeyAlias.releaseId, releaseId), eq(contentKeyAlias.fromKey, fromKey)))
      .get();
  }

  /**
   * Keys whose user state does NOT live under the declared canonical root.
   * A component whose key already carries word_progress/card_state rows under
   * any other key would collapse two distinct progress roots into one the
   * moment the edge is imported — such batches are rejected before activation.
   */
  async findStateConflicts(graph: AliasGraph): Promise<AliasStateConflict[]> {
    const conflicts: AliasStateConflict[] = [];
    const keys = [...graph.canonicalByKey.keys()];
    if (keys.length === 0) return conflicts;

    const progressRows = await this.db
      .select()
      .from(wordProgress)
      .where(inArray(wordProgress.wordKey, keys));
    for (const row of progressRows) {
      const canonicalKey = graph.canonicalByKey.get(row.wordKey);
      if (canonicalKey !== undefined && canonicalKey !== row.wordKey) {
        conflicts.push({ userId: row.userId, table: "word_progress", key: row.wordKey, canonicalKey });
      }
    }
    const cardRows = await this.db
      .select()
      .from(cardState)
      .where(inArray(cardState.contentCardKey, keys));
    for (const row of cardRows) {
      const canonicalKey = graph.canonicalByKey.get(row.contentCardKey);
      if (canonicalKey !== undefined && canonicalKey !== row.contentCardKey) {
        conflicts.push({ userId: row.userId, table: "card_state", key: row.contentCardKey, canonicalKey });
      }
    }
    return conflicts;
  }
}
