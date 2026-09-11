/**
 * Alias-edge handling for the publishing lifecycle (spec 5.5/6.4).
 *
 * The pure graph rules live in @lexiloop/domain (validateAliasEdges); this
 * module is the compiler-side glue that turns a declared edge file into the
 * validated batch the activation transaction imports: structure, endpoint
 * existence in the declared releases, and the user-state collapse check must
 * ALL pass before anything touches content_key_alias or app_meta.
 */
import { AliasEdgeSchema, validateAliasEdges, type AliasGraph } from "@lexiloop/domain";
import { AliasRepository, ContentRepository, type LexiloopDatabase } from "@lexiloop/db";
import { z } from "zod";
import { PublishError } from "./publish";

/** Declared alias edges for one activation (`release activate --aliases`). */
export const AliasFileSchema = z.strictObject({
  version: z.literal(1),
  edges: z.array(AliasEdgeSchema),
});

/**
 * Validate a full edge set against the database and map it to the
 * release-scoped rows the activation batch imports. Every edge is stored
 * under the release that DECLARES it (`from_release_id`), so the presenting
 * release's own rows resolve its renamed keys (spec 6.4).
 */
export async function prepareAliasBatch(
  db: LexiloopDatabase,
  edges: readonly unknown[],
  now: number,
): Promise<Array<{ releaseId: string; fromKey: string; toKey: string; canonicalKey: string; createdAt: number }>> {
  let graph: AliasGraph;
  try {
    graph = validateAliasEdges(edges);
  } catch (err) {
    const code = (err as { code?: string }).code ?? "ALIAS_INVALID";
    throw new PublishError(code, err instanceof Error ? err.message : String(err));
  }
  await assertAliasEndsExist(db, graph);
  const conflicts = await new AliasRepository(db).findStateConflicts(graph);
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

/** Both ends of every alias edge must exist in their declared releases. */
async function assertAliasEndsExist(db: LexiloopDatabase, graph: AliasGraph): Promise<void> {
  const content = new ContentRepository(db);
  for (const edge of graph.edges) {
    for (const [releaseId, key] of [
      [edge.from_release_id, edge.from_key],
      [edge.to_release_id, edge.to_key],
    ] as const) {
      const found =
        edge.entity_type === "word"
          ? await content.getWord(releaseId, key)
          : await content.getCard(releaseId, key);
      if (!found) {
        throw new PublishError(
          "ALIAS_END_MISSING",
          `alias ${edge.entity_type} endpoint (${releaseId}, ${key}) does not exist in its declared release`,
        );
      }
    }
  }
}
