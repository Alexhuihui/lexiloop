import { z } from "zod";

/**
 * Source-side content contracts (spec 5.4/5.5).
 *
 * Every source entity is scanned from the PDF and therefore carries the full
 * provenance base: PDF SHA-256, page number, page image hash, normalized bbox,
 * a private hash reference to the raw OCR text, the normalized text, and OCR +
 * structure confidences. Source entities never carry `generated_*` or
 * release-scoped fields; generated content lives in generated.ts and is kept
 * physically separate (spec 4.1).
 */

/** Lowercase hex SHA-256 digest. */
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be a lowercase 64-character hex SHA-256 digest");

/** Stable logical key: release-independent, produced by the stable-key rules. */
export const LogicalKey = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/, "must be a stable logical key");

/** Confidence in [0, 1]. */
export const Confidence = z.number().min(0).max(1);

/** Page coordinates normalized to the page image, [0,1] x [0,1]. */
export const NormalizedBbox = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .superRefine(([x0, y0, x1, y1], ctx) => {
    for (const value of [x0, y0, x1, y1]) {
      if (value < 0 || value > 1) {
        ctx.addIssue({ code: "custom", message: "bbox coordinates must lie in [0,1]" });
      }
    }
    if (x1 < x0) {
      ctx.addIssue({ code: "custom", message: "bbox x1 must be >= x0" });
    }
    if (y1 < y0) {
      ctx.addIssue({ code: "custom", message: "bbox y1 must be >= y0" });
    }
  });

/** Provenance shared by every source entity (spec 5.5). */
export const SourceProvenance = z.strictObject({
  source_pdf_sha256: Sha256Hex,
  page_number: z.number().int().min(1),
  page_image_sha256: Sha256Hex,
  bbox: NormalizedBbox,
  /** Hash reference to the raw OCR text; the raw text itself stays private. */
  source_raw_ref_hash: Sha256Hex,
  source_normalized_text: z.string().min(1),
  ocr_confidence: Confidence,
  structure_confidence: Confidence,
});

/** Layout role assigned by structure recovery (spec 5.4). */
export const LayoutRole = z.enum([
  "unit_title",
  "word_entry",
  "phonetic",
  "sense",
  "phrase",
  "example",
  "note",
  "page_furniture",
  "other",
]);

/** A normalized text block recovered from layout analysis + OCR. */
export const SourceBlock = z.strictObject({
  block_key: LogicalKey,
  layout_role: LayoutRole,
  ...SourceProvenance.shape,
});

export const Book = z.strictObject({
  book_key: LogicalKey,
  title: z.string().min(1),
  edition: z.string().min(1),
  ...SourceProvenance.shape,
});

export const Unit = z.strictObject({
  unit_key: LogicalKey,
  book_key: LogicalKey,
  /** Hierarchy depth of the unit within the book. */
  level: z.number().int().min(1),
  /** Textbook order of the unit; new-word study follows this order. */
  unit_order: z.number().int().min(1),
  title: z.string().min(1),
  ...SourceProvenance.shape,
});

/** Vocabulary tier/layer of the textbook (分层). */
export const WordTier = z
  .string()
  .min(1)
  .regex(/^[a-z0-9_-]+$/, "must be a normalized tier label");

export const Word = z.strictObject({
  word_key: LogicalKey,
  unit_key: LogicalKey,
  headword: z.string().min(1),
  phonetic: z.string().min(1).optional(),
  tier: WordTier,
  /** Textbook order of the word inside its unit. */
  source_order: z.number().int().min(1),
  ...SourceProvenance.shape,
});

export const PartOfSpeech = z.enum([
  "n",
  "v",
  "vi",
  "vt",
  "adj",
  "adv",
  "prep",
  "conj",
  "pron",
  "interj",
  "art",
  "num",
  "aux",
  "modal",
  "phrase",
  "abbr",
  "other",
]);

export const Sense = z.strictObject({
  sense_key: LogicalKey,
  word_key: LogicalKey,
  pos: PartOfSpeech,
  gloss: z.string().min(1),
  /** Order of the sense within its word. */
  sense_order: z.number().int().min(1),
  ...SourceProvenance.shape,
});

export const Phrase = z.strictObject({
  phrase_key: LogicalKey,
  word_key: LogicalKey,
  /** Sense the phrase belongs to, when the book scopes it to one sense. */
  sense_key: LogicalKey.optional(),
  text: z.string().min(1),
  gloss: z.string().min(1),
  source_order: z.number().int().min(1),
  ...SourceProvenance.shape,
});

export const ExampleOrigin = z.enum(["exam", "textbook"]);

/** Half-open character span [start, end) of the target word inside the sentence. */
export const TargetSpan = z
  .tuple([z.number().int().min(0), z.number().int().min(0)])
  .superRefine(([start, end], ctx) => {
    if (end <= start) {
      ctx.addIssue({ code: "custom", message: "target span end must be greater than start" });
    }
  });

export const Example = z.strictObject({
  example_key: LogicalKey,
  word_key: LogicalKey,
  sense_key: LogicalKey.optional(),
  phrase_key: LogicalKey.optional(),
  origin: ExampleOrigin,
  /** Exam paper or passage reference, e.g. "2019 阅读 Text 2". */
  source_ref: z.string().min(1).optional(),
  text: z.string().min(1),
  target_span: TargetSpan,
  source_order: z.number().int().min(1),
  ...SourceProvenance.shape,
});

export const RelationType = z.enum(["synonym", "antonym", "derivative", "confusable"]);

export const LexicalRelation = z.strictObject({
  relation_key: LogicalKey,
  from_word_key: LogicalKey,
  to_word_key: LogicalKey,
  relation_type: RelationType,
  ...SourceProvenance.shape,
});
