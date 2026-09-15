/**
 * Alias-edge handling for the publishing lifecycle (spec 5.5/6.4).
 *
 * The pure graph rules live in @lexiloop/domain (validateAliasEdges); this
 * module is the compiler-side glue that turns a declared edge file into the
 * validated batch the activation transaction imports: structure, cross-
 * activation fan-out against already-stored edges, endpoint existence in the
 * declared releases, and the user-state collapse check must ALL pass before
 * anything touches content_key_alias or app_meta.
 *
 * The gates themselves are pure over data (stored rows, an endpoint lookup,
 * fetched user-state rows) so the local path (drizzle over SQLite) and the
 * remote publish path (the same rows fetched over wrangler) run the SAME
 * rules — `prepareAliasBatch` and `prepareAliasBatchFromData` are two data
 * sources behind one implementation.
 */
import { AliasEdgeSchema, validateAliasEdges, type AliasGraph } from "@lexiloop/domain";
import {
  ContentRepository,
  cardState,
  contentKeyAlias,
  wordProgress,
  stateConflictsFromRows,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { PublishError } from "./publish";

/** Declared alias edges for one activation (`release activate --aliases`). */
export const AliasFileSchema = z.strictObject({
  version: z.literal(1),
  edges: z.array(AliasEdgeSchema),
});

/** One stored `content_key_alias` row, as the union gate consumes it. */
export interface StoredAliasEdge {
  releaseId: string;
  fromKey: string;
  toKey: string;
  canonicalKey: string;
}

/** Existence probe for one edge endpoint in its declared release. */
export type AliasEndpointLookup = (
  entityType: "word" | "card",
  releaseId: string,
  key: string,
) => Promise<boolean>;

/**
 * The data the alias gates need, fetched lazily behind narrow ports: drizzle
 * over a local database, or remote SQL over the wrangler CLI.
 */
export interface AliasValidationSource {
  storedEdges(): Promise<readonly StoredAliasEdge[]>;
  endpointExists: AliasEndpointLookup;
  /** word_progress/card_state rows under the component keys. */
  stateRows(keys: readonly string[]): Promise<{
    progress: ReadonlyArray<{ userId: string; wordKey: string }>;
    cards: ReadonlyArray<{ userId: string; contentCardKey: string }>;
  }>;
}

/**
 * Validate a full edge set against the data source and map it to the
 * release-scoped rows the activation batch imports. Every edge is stored
 * under the release that DECLARES it (`from_release_id`), so the presenting
 * release's own rows resolve its renamed keys (spec 6.4). This is the ONE
 * implementation of the activation gates; `prepareAliasBatch` feeds it from
 * a local database.
 */
export async function prepareAliasBatchFromData(
  edges: readonly unknown[],
  source: AliasValidationSource,
  now: number,
): Promise<Array<{ releaseId: string; fromKey: string; toKey: string; canonicalKey: string; createdAt: number }>> {
  let graph: AliasGraph;
  try {
    graph = validateAliasEdges(edges);
  } catch (err) {
    const code = (err as { code?: string }).code ?? "ALIAS_INVALID";
    throw new PublishError(code, err instanceof Error ? err.message : String(err));
  }
  assertNoCrossActivationConflicts(await source.storedEdges(), graph);
  await assertAliasEndsExist(source.endpointExists, graph);
  const { progress, cards } = await source.stateRows([...graph.canonicalByKey.keys()]);
  const conflicts = stateConflictsFromRows(graph.canonicalByKey, progress, cards);
  if (conflicts.length > 0) {
    const detail = conflicts
      .map((conflict) => `${conflict.userId}/${conflict.table}/${conflict.key} (canonical ${conflict.canonicalKey})`)
      .join("; ");
    throw new PublishError(
      "ALIAS_STATE_COLLISION",
      `existing user state would collapse under the declared alias roots: ${detail}`,
    );
  }
  return graph.edges.map((edge) => ({
    releaseId: edge.from_release_id,
    fromKey: edge.from_key,
    toKey: edge.to_key,
    canonicalKey: edge.canonical_key,
    createdAt: now,
  }));
}

/** The drizzle-backed data source (local rehearsal/tests). */
export function drizzleAliasSource(db: LexiloopDatabase): AliasValidationSource {
  const content = new ContentRepository(db);
  return {
    async storedEdges() {
      return (await db.select().from(contentKeyAlias)) as StoredAliasEdge[];
    },
    async endpointExists(entityType, releaseId, key) {
      const found =
        entityType === "word" ? await content.getWord(releaseId, key) : await content.getCard(releaseId, key);
      return found !== undefined;
    },
    async stateRows(keys) {
      if (keys.length === 0) return { progress: [], cards: [] };
      const progress = (await db
        .select()
        .from(wordProgress)
        .where(inArray(wordProgress.wordKey, keys))) as Array<{ userId: string; wordKey: string }>;
      const cards = (await db
        .select()
        .from(cardState)
        .where(inArray(cardState.contentCardKey, keys))) as Array<{ userId: string; contentCardKey: string }>;
      return { progress, cards };
    },
  };
}

/** Local-database entry point (same gates as `prepareAliasBatchFromData`). */
export async function prepareAliasBatch(
  db: LexiloopDatabase,
  edges: readonly unknown[],
  now: number,
): Promise<Array<{ releaseId: string; fromKey: string; toKey: string; canonicalKey: string; createdAt: number }>> {
  return prepareAliasBatchFromData(edges, drizzleAliasSource(db), now);
}

/** Both ends of every alias edge must exist in their declared releases. */
async function assertAliasEndsExist(lookup: AliasEndpointLookup, graph: AliasGraph): Promise<void> {
  for (const edge of graph.edges) {
    for (const [releaseId, key] of [
      [edge.from_release_id, edge.from_key],
      [edge.to_release_id, edge.to_key],
    ] as const) {
      if (!(await lookup(edge.entity_type, releaseId, key))) {
        throw new PublishError(
          "ALIAS_END_MISSING",
          `alias ${edge.entity_type} endpoint (${releaseId}, ${key}) does not exist in its declared release`,
        );
      }
    }
  }
}

/**
 * Cross-activation fan-out gate (spec 6.4: one-to-many/many-to-one are
 * rejected at activation, never discovered afterwards) — pure over the
 * stored rows so local and remote paths apply the same rule.
 *
 * The schema's uniqueness is per release (`UNIQUE (release_id, from_key)` /
 * `UNIQUE (release_id, to_key)`), so the stored rows cannot see a conflict
 * declared by a different release: importing `(rel-3: k2→k4)` next to a
 * stored `(rel-2: k2→k3)` would satisfy every constraint and still leave
 * `resolve(k2)` ambiguous for every later grade. This gate re-validates the
 * UNION of stored and declared edges that reach the batch's keys (transitive
 * closure through stored edges) with the same rules: at most one successor
 * and one predecessor per key, no cycles, and every walk terminating at the
 * single declared canonical root.
 *
 * Supersession: a declared edge whose (from_release_id, from_key, to_key)
 * exactly matches a stored edge replaces it in the union — `activateBatch`
 * upserts the refresh, so a chained rename may refresh the canonical root of
 * an earlier migration (k2→k3 canonical k3, later k3→k4 with the k2 edge
 * redeclared to canonical k4). A redeclaration under a DIFFERENT declaring
 * release does not supersede: both rows would coexist and leave `resolve`
 * ambiguous, so the stale stored canonical stays in the union and rejects.
 */
export function assertNoCrossActivationConflicts(
  stored: readonly StoredAliasEdge[],
  graph: AliasGraph,
): void {
  if (stored.length === 0) return;

  // Transitively collect every stored edge reachable from the batch's keys,
  // in both directions, so walks never stop mid-chain.
  const reached = new Set<string>();
  for (const edge of graph.edges) {
    reached.add(edge.from_key);
    reached.add(edge.to_key);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of stored) {
      if (reached.has(row.fromKey) && !reached.has(row.toKey)) {
        reached.add(row.toKey);
        grew = true;
      } else if (reached.has(row.toKey) && !reached.has(row.fromKey)) {
        reached.add(row.fromKey);
        grew = true;
      }
    }
  }
  // (from, to, canonical) union: relevant stored edges + the declared batch.
  const supersededByBatch = new Set(
    graph.edges.map((edge) => `${edge.from_release_id}\u0000${edge.from_key}\u0000${edge.to_key}`),
  );
  const union: Array<{ from: string; to: string; canonical: string; origin: string }> = [];
  for (const row of stored) {
    if (!reached.has(row.fromKey)) continue;
    if (supersededByBatch.has(`${row.releaseId}\u0000${row.fromKey}\u0000${row.toKey}`)) continue;
    union.push({ from: row.fromKey, to: row.toKey, canonical: row.canonicalKey, origin: `stored(${row.releaseId})` });
  }
  for (const edge of graph.edges) {
    union.push({ from: edge.from_key, to: edge.to_key, canonical: edge.canonical_key, origin: "declared" });
  }

  const successors = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  const record = (map: Map<string, Set<string>>, key: string, other: string): void => {
    const set = map.get(key);
    if (set) set.add(other);
    else map.set(key, new Set([other]));
  };
  for (const edge of union) {
    record(successors, edge.from, edge.to);
    record(predecessors, edge.to, edge.from);
  }
  for (const [key, targets] of successors) {
    if (targets.size > 1) {
      throw new PublishError(
        "ALIAS_ONE_TO_MANY",
        `key ${key} would migrate to multiple keys across stored and declared edges ` +
          `(${[...targets].sort().join(", ")}); one presented key must have exactly one successor`,
      );
    }
  }
  for (const [key, sources] of predecessors) {
    if (sources.size > 1) {
      throw new PublishError(
        "ALIAS_MANY_TO_ONE",
        `key ${key} would be targeted by multiple keys across stored and declared edges ` +
          `(${[...sources].sort().join(", ")}); one key must have exactly one predecessor`,
      );
    }
  }

  for (const edge of union) {
    const visited = new Set<string>([edge.from]);
    let current = edge.from;
    for (;;) {
      const nextSet = successors.get(current);
      const next = nextSet?.values().next().value;
      if (next === undefined) break;
      if (visited.has(next)) {
        throw new PublishError("ALIAS_CYCLE", `union alias graph cycles through key ${next}`);
      }
      visited.add(next);
      current = next;
    }
    if (edge.canonical !== current) {
      throw new PublishError(
        "ALIAS_CANONICAL_MISMATCH",
        `edge from ${edge.from} (${edge.origin}) declares canonical root ${edge.canonical}, ` +
          `but the union chain ends at ${current}`,
      );
    }
  }
}
