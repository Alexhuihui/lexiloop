import { describe, expect, it } from "vitest";
import { AliasEdgeSchema, AliasGraphError, validateAliasEdges } from "../../src/releases/aliases";

/**
 * Typed, release-aware alias edges (spec 5.5/6.4): strictly one-to-one,
 * acyclic, one canonical root per connected component. User learning state
 * references canonical keys forever, so every structural violation here must
 * fail loudly before any edge reaches content_key_alias.
 */

type EdgeInput = {
  entity_type: "word" | "card";
  from_release_id: string;
  from_key: string;
  to_release_id: string;
  to_key: string;
  canonical_key: string;
};

function edge(overrides: Partial<EdgeInput> = {}): EdgeInput {
  return {
    entity_type: "word",
    from_release_id: "rel-new",
    from_key: "k-new",
    to_release_id: "rel-old",
    to_key: "k-old",
    canonical_key: "k-old",
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AliasGraphError);
    expect((err as AliasGraphError).code).toBe(code);
    return;
  }
  throw new Error(`expected AliasGraphError ${code}, but validation passed`);
}

describe("alias graph validation (spec 5.5/6.4)", () => {
  it("parses strict typed edges", () => {
    const parsed = AliasEdgeSchema.parse(edge());
    expect(parsed).toEqual(edge());
    // Unknown fields are rejected: the edge contract is closed.
    expect(() => AliasEdgeSchema.parse({ ...edge(), extra: 1 })).toThrow();
  });

  it("accepts a single rename edge and derives one component", () => {
    const graph = validateAliasEdges([edge()]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.components).toEqual([
      { keys: ["k-new", "k-old"], canonicalKey: "k-old" },
    ]);
    expect(graph.canonicalByKey.get("k-new")).toBe("k-old");
    expect(graph.canonicalByKey.get("k-old")).toBe("k-old");
  });

  it("accepts a forward chain and pins one canonical root", () => {
    const graph = validateAliasEdges([
      edge({ from_release_id: "rel-1", from_key: "k1", to_release_id: "rel-2", to_key: "k2", canonical_key: "k3" }),
      edge({ from_release_id: "rel-2", from_key: "k2", to_release_id: "rel-2", to_key: "k3", canonical_key: "k3" }),
    ]);
    expect(graph.components).toEqual([{ keys: ["k1", "k2", "k3"], canonicalKey: "k3" }]);
    expect(graph.canonicalByKey.get("k1")).toBe("k3");
    expect(graph.canonicalByKey.get("k2")).toBe("k3");
    expect(graph.canonicalByKey.get("k3")).toBe("k3");
  });

  it("accepts a reverse merge of a new-release key into the old canonical", () => {
    // Rollback direction: the newer release's key is declared equivalent to
    // the older release's canonical key, so both presentations converge.
    const graph = validateAliasEdges([
      edge({ from_release_id: "rel-2", from_key: "k2", to_release_id: "rel-1", to_key: "k1", canonical_key: "k1" }),
    ]);
    expect(graph.canonicalByKey.get("k2")).toBe("k1");
  });

  it("reports independent components separately", () => {
    const graph = validateAliasEdges([
      edge({ from_key: "a-new", to_key: "a-old", canonical_key: "a-old" }),
      edge({ entity_type: "card", from_key: "c-new", to_key: "c-old", canonical_key: "c-old" }),
    ]);
    expect(graph.components).toHaveLength(2);
    expect(graph.components.map((component) => component.canonicalKey).sort()).toEqual(["a-old", "c-old"]);
  });

  it("accepts an empty edge set", () => {
    expect(validateAliasEdges([]).components).toEqual([]);
  });

  it("rejects malformed edges with ALIAS_EDGE_INVALID", () => {
    expectCode(() => validateAliasEdges([{}]), "ALIAS_EDGE_INVALID");
    expectCode(() => validateAliasEdges([edge({ entity_type: "sense" as "word" })]), "ALIAS_EDGE_INVALID");
    expectCode(() => validateAliasEdges(["not-an-edge"]), "ALIAS_EDGE_INVALID");
  });

  it("rejects duplicate edges with ALIAS_DUPLICATE_EDGE", () => {
    expectCode(() => validateAliasEdges([edge(), edge()]), "ALIAS_DUPLICATE_EDGE");
  });

  it("rejects self-referencing edges with ALIAS_SELF_REFERENCE", () => {
    expectCode(
      () => validateAliasEdges([edge({ from_key: "k", to_key: "k", canonical_key: "k" })]),
      "ALIAS_SELF_REFERENCE",
    );
  });

  it("rejects one-to-many fan-out with ALIAS_ONE_TO_MANY", () => {
    // Same presented key mapping to two different targets, even across
    // different declaring releases, would make canonical resolution ambiguous.
    expectCode(
      () =>
        validateAliasEdges([
          edge({ from_key: "k1", to_key: "k2", canonical_key: "k2" }),
          edge({ from_release_id: "rel-3", from_key: "k1", to_key: "k3", canonical_key: "k3" }),
        ]),
      "ALIAS_ONE_TO_MANY",
    );
  });

  it("rejects many-to-one fan-in with ALIAS_MANY_TO_ONE", () => {
    expectCode(
      () =>
        validateAliasEdges([
          edge({ from_key: "k1", to_key: "k3", canonical_key: "k3" }),
          edge({ from_key: "k2", to_key: "k3", canonical_key: "k3" }),
        ]),
      "ALIAS_MANY_TO_ONE",
    );
  });

  it("rejects cycles with ALIAS_CYCLE", () => {
    expectCode(
      () =>
        validateAliasEdges([
          edge({ from_key: "k1", to_key: "k2", canonical_key: "k1" }),
          edge({ from_key: "k2", to_key: "k1", canonical_key: "k1" }),
        ]),
      "ALIAS_CYCLE",
    );
  });

  it("rejects a canonical root that is not the walked sink with ALIAS_CANONICAL_MISMATCH", () => {
    // Chain k1 -> k2 -> k3: the only sink is k3, so declaring k2 (or an
    // unknown key) as the canonical root contradicts the graph.
    expectCode(
      () =>
        validateAliasEdges([
          edge({ from_key: "k1", to_key: "k2", canonical_key: "k2" }),
          edge({ from_key: "k2", to_key: "k3", canonical_key: "k2" }),
        ]),
      "ALIAS_CANONICAL_MISMATCH",
    );
    expectCode(
      () => validateAliasEdges([edge({ from_key: "k1", to_key: "k2", canonical_key: "missing" })]),
      "ALIAS_CANONICAL_MISMATCH",
    );
  });

  it("rejects entity-type conflicts for the same key with ALIAS_TYPE_CONFLICT", () => {
    // k2 is declared a word endpoint in one edge and a card endpoint in
    // another: the two ends of any edge must have matching types.
    expectCode(
      () =>
        validateAliasEdges([
          edge({ from_key: "k1", to_key: "k2", canonical_key: "k2" }),
          edge({ entity_type: "card", from_key: "k3", to_key: "k2", canonical_key: "k2" }),
        ]),
      "ALIAS_TYPE_CONFLICT",
    );
  });
});
