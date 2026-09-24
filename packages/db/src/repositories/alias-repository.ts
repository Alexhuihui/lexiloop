import { and, eq, inArray } from "drizzle-orm";
import type { AliasGraph } from "@lexiloop/domain";
import { contentKeyAlias, cardState, wordProgress, type ContentKeyAliasRow } from "../schema";
import type { LexiloopDatabase } from "../schema";

export interface ResolveAliasInput {
  releaseId: string;
  /** Any historical stable key. */
  key: string;
}

/** One immutable alias-table read reused across a grading request. */
export interface AliasSnapshot {
  resolve(key: string): Promise<string>;
  resolveMany(keys: readonly string[]): Promise<Map<string, string>>;
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
    const edgesOf = async (fromKey: string): Promise<ContentKeyAliasRow[]> =>
      await this.db.select().from(contentKeyAlias).where(eq(contentKeyAlias.fromKey, fromKey));
    return await this.walk(input.releaseId, input.key, edgesOf);
  }

  /**
   * Resolves many keys in one pass (queue building: a release's whole
   * teaching order must be matched against canonically keyed user state).
   * The alias table holds only explicitly declared migration edges, so it is
   * read once and every key runs the exact `resolve` walk from that snapshot
   * — same bidirectional semantics and the same loud ambiguity, cycle, and
   * canonical-root failures, without per-key round trips on D1.
   */
  async resolveMany(input: { releaseId: string; keys: readonly string[] }): Promise<Map<string, string>> {
    return await (await this.snapshot(input.releaseId)).resolveMany(input.keys);
  }

  /** Loads the small migration-edge table once so several dependent reads do
   * not each pay another D1 network round trip. */
  async snapshot(releaseId: string): Promise<AliasSnapshot> {
    const byFrom = new Map<string, ContentKeyAliasRow[]>();
    for (const edge of await this.db.select().from(contentKeyAlias)) {
      const edges = byFrom.get(edge.fromKey);
      if (edges) {
        edges.push(edge);
      } else {
        byFrom.set(edge.fromKey, [edge]);
      }
    }
    const resolve = async (key: string): Promise<string> =>
      await this.walk(releaseId, key, async (fromKey) => byFrom.get(fromKey) ?? []);
    return {
      resolve,
      resolveMany: async (keys: readonly string[]): Promise<Map<string, string>> => {
        const resolved = new Map<string, string>();
        for (const key of new Set(keys)) {
          resolved.set(key, await resolve(key));
        }
        return resolved;
      },
    };
  }

  /**
   * The bidirectional edge walk from a presented key to its canonical root:
   * a key may sit on the from side (renamed away) or on the to side (merged
   * into an older root). `edgesOf` returns the outgoing edges of one key —
   * either queried per hop or read from a caller-provided snapshot.
   */
  private async walk(
    releaseId: string,
    start: string,
    edgesOf: (fromKey: string) => Promise<ContentKeyAliasRow[]>,
  ): Promise<string> {
    let current = start;
    let canonical: string | null = null;
    const visited = new Set<string>([start]);
    for (;;) {
      const edges = await edgesOf(current);
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
   * The judgment is `stateConflictsFromRows` (shared with the remote publish
   * tooling, which fetches the same rows over wrangler); this method only
   * fetches them.
   */
  async findStateConflicts(graph: AliasGraph): Promise<AliasStateConflict[]> {
    const keys = [...graph.canonicalByKey.keys()];
    if (keys.length === 0) return [];
    const progressRows = await this.db
      .select()
      .from(wordProgress)
      .where(inArray(wordProgress.wordKey, keys));
    const cardRows = await this.db
      .select()
      .from(cardState)
      .where(inArray(cardState.contentCardKey, keys));
    return stateConflictsFromRows(graph.canonicalByKey, progressRows, cardRows);
  }
}

/**
 * The user-state collapse judgment over already-fetched rows (spec 6.4): a
 * component key that carries word_progress/card_state rows under any key
 * other than its canonical root would collapse two distinct progress roots
 * into one when the edge set is imported. Pure over data so the local
 * repository and the remote publish tooling apply the SAME rule.
 */
export function stateConflictsFromRows(
  canonicalByKey: ReadonlyMap<string, string>,
  progressRows: ReadonlyArray<{ userId: string; wordKey: string }>,
  cardRows: ReadonlyArray<{ userId: string; contentCardKey: string }>,
): AliasStateConflict[] {
  const conflicts: AliasStateConflict[] = [];
  for (const row of progressRows) {
    const canonicalKey = canonicalByKey.get(row.wordKey);
    if (canonicalKey !== undefined && canonicalKey !== row.wordKey) {
      conflicts.push({ userId: row.userId, table: "word_progress", key: row.wordKey, canonicalKey });
    }
  }
  for (const row of cardRows) {
    const canonicalKey = canonicalByKey.get(row.contentCardKey);
    if (canonicalKey !== undefined && canonicalKey !== row.contentCardKey) {
      conflicts.push({ userId: row.userId, table: "card_state", key: row.contentCardKey, canonicalKey });
    }
  }
  return conflicts;
}
