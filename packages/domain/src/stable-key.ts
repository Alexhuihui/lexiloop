import { createHash } from "node:crypto";

/**
 * Stable logical key rules (spec 5.5).
 *
 * A stable key identifies a content entity across releases: it is a SHA-256
 * digest over canonical JSON of `book_key + unit_key + entity_type +
 * source_ordinal + normalized_headword` — sorted keys, NFC-normalized strings,
 * and no release identifier. Only explicit alias migration may relate a new
 * key to an old one; user learning state references these keys forever.
 */

export interface StableKeyInput {
  /** Book-edition key, e.g. "llcy-2024". */
  book: string;
  /** Unit key within the book, e.g. "u01". */
  unit: string;
  /** Entity type, e.g. "word", "sense", "phrase", "example", "card". */
  type: string;
  /** Source ordinal of the entity within its unit. */
  ordinal: number;
  /** Normalized semantic headword/slug. */
  slug: string;
}

function requireNonEmpty(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`stableKey: ${name} must be a non-empty string`);
  }
  return value;
}

function canonicalJson(record: Record<string, string | number>): string {
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(record[key])}`);
  return `{${parts.join(",")}}`;
}

export function stableKey(input: StableKeyInput): string {
  const book = requireNonEmpty("book", input?.book);
  const unit = requireNonEmpty("unit", input?.unit);
  const type = requireNonEmpty("type", input?.type);
  if (!/^[a-z][a-z0-9_]*$/.test(type)) {
    throw new TypeError(`stableKey: type must be a lowercase entity type, got ${JSON.stringify(type)}`);
  }
  const { ordinal } = input ?? {};
  if (typeof ordinal !== "number" || !Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new TypeError(`stableKey: ordinal must be a non-negative safe integer, got ${String(ordinal)}`);
  }
  const slug = requireNonEmpty("slug", input?.slug);

  // Canonical form: NFC-normalized strings, keys sorted at serialization.
  const canonical = canonicalJson({
    book: book.normalize("NFC"),
    ordinal,
    slug: slug.normalize("NFC"),
    type,
    unit: unit.normalize("NFC"),
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
