import { z } from "zod";

/**
 * Typed, release-aware stable-key alias edges (spec 5.5/6.4).
 *
 * An alias edge declares that one stable key in one release is the same
 * semantic entity as another stable key in another release, and names the
 * canonical root key that user learning state references:
 *
 *   { entity_type: "word" | "card",
 *     from_release_id, from_key, to_release_id, to_key, canonical_key }
 *
 * Edges are strictly one-to-one (at most one outgoing and one incoming edge
 * per key), so every connected component is a simple chain whose unique sink
 * is its canonical root. Activation may import only edge sets that satisfy
 * every rule here; anything else would redirect or split user progress and
 * fails loudly with a machine-readable code instead.
 */

export const AliasEntityTypeSchema = z.enum(["word", "card"]);

export const AliasEdgeSchema = z.strictObject({
  entity_type: AliasEntityTypeSchema,
  from_release_id: z.string().min(1),
  from_key: z.string().min(1),
  to_release_id: z.string().min(1),
  to_key: z.string().min(1),
  canonical_key: z.string().min(1),
});

export type AliasEdge = z.output<typeof AliasEdgeSchema>;

/** Machine-readable alias validation failure (fail-closed, spec 6.4). */
export class AliasGraphError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AliasGraphError";
    this.code = code;
  }
}

/** One connected alias component and its unique canonical root. */
export interface AliasComponent {
  /** Every stable key of the component (both ends of every edge). */
  keys: string[];
  /** The unique sink key user state references (spec 6.4). */
  canonicalKey: string;
}

export interface AliasGraph {
  edges: AliasEdge[];
  components: AliasComponent[];
  /** Maps every component key to its canonical root. */
  canonicalByKey: ReadonlyMap<string, string>;
}

function fail(code: string, message: string): never {
  throw new AliasGraphError(code, message);
}

/**
 * Validate a full alias edge set (the batch an activation would import).
 * Returns the component decomposition plus the canonical root per key.
 */
export function validateAliasEdges(edges: readonly unknown[]): AliasGraph {
  const parsed: AliasEdge[] = [];
  for (const raw of edges) {
    const result = AliasEdgeSchema.safeParse(raw);
    if (!result.success) {
      fail(
        "ALIAS_EDGE_INVALID",
        `alias edge violates the contract: ${result.error.issues[0]?.message ?? result.error.message}`,
      );
    }
    parsed.push(result.data);
  }

  // Structural single-edge rules.
  const seen = new Set<string>();
  const entityTypeByKey = new Map<string, "word" | "card">();
  const outgoing = new Map<string, AliasEdge>();
  const incoming = new Map<string, AliasEdge>();
  for (const edge of parsed) {
    if (edge.from_key === edge.to_key) {
      fail("ALIAS_SELF_REFERENCE", `alias edge ${edge.from_key} -> ${edge.to_key} is self-referential`);
    }
    const duplicateKey = `${edge.from_release_id}:${edge.from_key}->${edge.to_release_id}:${edge.to_key}`;
    if (seen.has(duplicateKey)) {
      fail("ALIAS_DUPLICATE_EDGE", `duplicate alias edge ${duplicateKey}`);
    }
    seen.add(duplicateKey);

    for (const [, key] of [
      [edge.from_release_id, edge.from_key],
      [edge.to_release_id, edge.to_key],
    ] as const) {
      const known = entityTypeByKey.get(key);
      if (known !== undefined && known !== edge.entity_type) {
        fail(
          "ALIAS_TYPE_CONFLICT",
          `key ${key} is declared as both ${known} and ${edge.entity_type}: the two ends of an edge must have matching entity types`,
        );
      }
      entityTypeByKey.set(key, edge.entity_type);
    }

    const existingOut = outgoing.get(edge.from_key);
    if (existingOut && (existingOut.to_key !== edge.to_key || existingOut.to_release_id !== edge.to_release_id)) {
      fail(
        "ALIAS_ONE_TO_MANY",
        `key ${edge.from_key} maps to both ${existingOut.to_key} and ${edge.to_key}: one presented key must have exactly one successor`,
      );
    }
    outgoing.set(edge.from_key, edge);

    const existingIn = incoming.get(edge.to_key);
    if (existingIn && (existingIn.from_key !== edge.from_key || existingIn.from_release_id !== edge.from_release_id)) {
      fail(
        "ALIAS_MANY_TO_ONE",
        `key ${edge.to_key} is targeted by both ${existingIn.from_key} and ${edge.from_key}: one key must have exactly one predecessor`,
      );
    }
    incoming.set(edge.to_key, edge);
  }

  // Per-component walk: acyclicity, single canonical root at the sink.
  // Every component is a simple chain (in/out degree <= 1), entered from its
  // origin — the one node with no incoming edge — so overlapping walks are
  // impossible regardless of edge order.
  const canonicalByKey = new Map<string, string>();
  const components: AliasComponent[] = [];
  const visitedEdges = new Set<AliasEdge>();
  for (const edge of parsed) {
    if (visitedEdges.has(edge)) continue;

    // Walk backwards to the chain origin.
    let origin = edge.from_key;
    const seenBack = new Set<string>([origin]);
    for (;;) {
      const prev = incoming.get(origin);
      if (!prev || seenBack.has(prev.from_key)) break;
      origin = prev.from_key;
      seenBack.add(origin);
    }

    // Walk forward from the origin to the unique sink.
    const keys: string[] = [];
    const visited = new Set<string>([origin]);
    let current = origin;
    for (;;) {
      keys.push(current);
      const next = outgoing.get(current);
      if (!next) break;
      visitedEdges.add(next);
      if (visited.has(next.to_key)) {
        fail("ALIAS_CYCLE", `alias graph cycle through key ${next.to_key}`);
      }
      visited.add(next.to_key);
      current = next.to_key;
    }
    const sink = keys[keys.length - 1]!;
    for (const key of keys) {
      const declaredCanonical = outgoing.get(key)?.canonical_key;
      if (declaredCanonical !== undefined && declaredCanonical !== sink) {
        fail(
          "ALIAS_CANONICAL_MISMATCH",
          `edge from ${key} declares canonical root ${declaredCanonical}, but the component sink is ${sink}`,
        );
      }
      canonicalByKey.set(key, sink);
    }
    components.push({ keys, canonicalKey: sink });
  }

  return { edges: parsed, components, canonicalByKey };
}
