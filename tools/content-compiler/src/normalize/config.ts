/**
 * Versioned normalization configuration (spec 5.4).
 *
 * These are deterministic structure-recovery rules for the llcy-2024 raster:
 * unit titles, part-of-speech markers, the exam-example marker, note leads,
 * and the confidence thresholds that route critical fields to visual review.
 * Values are embedded in the LAYOUT_OCR/STRUCTURE_NORMALIZE stage
 * `configVersion`, so changing them invalidates downstream stages.
 */

export interface NormalizeBookConfig {
  book_key: string;
  book_title: string;
  book_edition: string;
  /** Tier assigned to words the book does not mark explicitly. */
  default_tier: string;
  /** Anchored regexes detecting a unit-title block; group 1 = unit number. */
  unit_title_patterns: string[];
  /** Part-of-speech markers, longest-first matching (trailing dot included). */
  pos_markers: string[];
  /** Block prefix marking an exam-derived example, e.g. 真. */
  exam_marker: string;
  /** Anchored regexes detecting note blocks (word roots, synonyms, ...). */
  note_patterns: string[];
  /** Critical fields (headword/phonetic) below this confidence need review. */
  critical_confidence_min: number;
  /** Non-critical content below this confidence is dropped (unreliable OCR). */
  non_critical_confidence_min: number;
}

/** Locked normalization rules for the LLRC 6500 (llcy-2024) source. */
export const LLCY_2024_NORMALIZE_CONFIG: NormalizeBookConfig = {
  book_key: "llcy-2024",
  book_title: "LLRC 6500",
  book_edition: "2024",
  default_tier: "core",
  unit_title_patterns: ["^Unit\\s+(\\d+)"],
  pos_markers: [
    "n.",
    "v.",
    "vi.",
    "vt.",
    "adj.",
    "adv.",
    "prep.",
    "conj.",
    "pron.",
    "interj.",
    "art.",
    "num.",
    "aux.",
    "modal.",
    "abbr.",
    "phr.",
  ],
  exam_marker: "真",
  note_patterns: ["^词根记忆", "^词根", "^同根词", "^相关词", "^近义词", "^反义词", "^注释"],
  critical_confidence_min: 0.9,
  non_critical_confidence_min: 0.5,
};
