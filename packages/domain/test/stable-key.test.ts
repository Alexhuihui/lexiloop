import { describe, expect, it } from "vitest";
import { stableKey } from "../src/stable-key";
import type { StableKeyInput } from "../src/stable-key";

const baseInput: StableKeyInput = {
  book: "llcy-2024",
  unit: "u01",
  type: "word",
  ordinal: 3,
  slug: "abandon",
};

/** Shallow copy without one key, for missing-field rejection tests. */
function without<T extends object, K extends keyof T & string>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete (copy as Record<string, unknown>)[key];
  return copy as Omit<T, K>;
}

// Widen the signature so missing-key cases can be expressed without casts.
const stableKeyUnsafe = stableKey as (input: unknown) => string;

describe("stableKey", () => {
  it("generates the same card key across releases", () => {
    const a = stableKey({ book: "llcy-2024", unit: "u01", type: "word", ordinal: 3, slug: "abandon" });
    const b = stableKey({ book: "llcy-2024", unit: "u01", type: "word", ordinal: 3, slug: "abandon" });
    expect(a).toBe(b);
    expect(a).not.toContain("release");
  });

  it("returns a 64-character lowercase hex digest", () => {
    expect(stableKey(baseInput)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("normalizes Unicode: NFC and NFD slugs collide", () => {
    const nfc = "caf\u00e9"; // U+00E9 precomposed
    const nfd = "cafe\u0301"; // e + U+0301 combining acute
    expect(stableKey({ ...baseInput, slug: nfc })).toBe(stableKey({ ...baseInput, slug: nfd }));
  });

  it("changes when any component changes", () => {
    const reference = stableKey(baseInput);
    expect(stableKey({ ...baseInput, book: "llcy-2025" })).not.toBe(reference);
    expect(stableKey({ ...baseInput, unit: "u02" })).not.toBe(reference);
    expect(stableKey({ ...baseInput, type: "sense" })).not.toBe(reference);
    expect(stableKey({ ...baseInput, ordinal: 4 })).not.toBe(reference);
    expect(stableKey({ ...baseInput, slug: "abandoned" })).not.toBe(reference);
  });

  it("rejects missing or empty components", () => {
    expect(() => stableKeyUnsafe(without(baseInput, "book"))).toThrow();
    expect(() => stableKey({ ...baseInput, book: "" })).toThrow();
    expect(() => stableKeyUnsafe(without(baseInput, "unit"))).toThrow();
    expect(() => stableKeyUnsafe(without(baseInput, "type"))).toThrow();
    expect(() => stableKeyUnsafe(without(baseInput, "ordinal"))).toThrow();
    expect(() => stableKey({ ...baseInput, ordinal: undefined as unknown as number })).toThrow();
    expect(() => stableKeyUnsafe(without(baseInput, "slug"))).toThrow();
    expect(() => stableKey({ ...baseInput, slug: "" })).toThrow();
  });

  it("rejects malformed ordinals and entity types", () => {
    expect(() => stableKey({ ...baseInput, ordinal: Number.NaN })).toThrow();
    expect(() => stableKey({ ...baseInput, ordinal: 1.5 })).toThrow();
    expect(() => stableKey({ ...baseInput, ordinal: -1 })).toThrow();
    expect(() => stableKey({ ...baseInput, type: "Word" })).toThrow();
    expect(() => stableKey({ ...baseInput, type: "word-card" })).toThrow();
  });
});
