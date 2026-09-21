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
  /**
   * Anchored regexes detecting a unit-title block (opener banner); group 1 =
   * unit number. Calibrated on the real raster: the opener banner is a single
   * large "Unit N" block on the unit's first page.
   */
  unit_title_patterns: string[];
  /**
   * Anchored regex for the per-page side-tab number. Calibrated on the full
   * raster: every odd printed page of a unit carries its unit number as a
   * zero-padded two-digit thumb-tab block in the RIGHT rail (the tab slides
   * down the rail as the unit advances; the LEFT rail carries the chapter
   * number). Exactly two digits — every one-character rail digit in the book
   * is a truncation misread ("6" for "19") and must not signal.
   */
  unit_tab_number_pattern: string;
  /** Right-rail x0 at or beyond which a bare number block is a unit tab. */
  unit_tab_x_min: number;
  /**
   * Vertical band a unit tab must start in. Calibrated: tabs slide from
   * y0 ~= 0.18 to ~= 0.86, while the bare digits at the outer bottom corners
   * (y0 >= 0.9) are PAGE numbers and must never signal a unit.
   */
  unit_tab_y_min: number;
  unit_tab_y_max: number;
  /**
   * Anchored regex detecting a chapter-opener block; group 1 = chapter
   * number. Chapter openers establish the authoritative chapter context for
   * all following unit keys.
   */
  chapter_opener_pattern: string;
  /**
   * A chapter-opener candidate must start at or above this y. Calibrated:
   * real openers sit at y0 ~= 0.20, while the contents page's chapter lines
   * start at y0 >= 0.25 and must never open a chapter.
   */
  chapter_opener_y_max: number;
  /** Anchored regexes detecting the back-matter (index) opener block. */
  back_matter_patterns: string[];
  /**
   * A back-matter marker must start at or above this y: the index opener sits
   * mid-page (y0 ~= 0.37) while the contents page's index line sits at the
   * bottom (y0 ~= 0.87) and must not start back matter.
   */
  back_matter_y_max: number;
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
  unit_title_patterns: ["^Unit\\s*(\\d+)$"],
  unit_tab_number_pattern: "^\\d{2}$",
  unit_tab_x_min: 0.9,
  unit_tab_y_min: 0.1,
  unit_tab_y_max: 0.9,
  chapter_opener_pattern: "^Chapter\\s*0?([1-9])$",
  chapter_opener_y_max: 0.25,
  back_matter_patterns: ["^索引$"],
  back_matter_y_max: 0.5,
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
  note_patterns: [
    "^(?:词)?根记忆",
    "^词根",
    "^联想记忆",
    "^同根词",
    "^相关词",
    "^近义词",
    "^反义词",
    "^注释",
    "^串词(?:记忆|成句)",
    "^小词有话说",
    "^英语中表达",
    "^文化休息站$",
    "^易混词辨析$",
    "^本单元资源$",
    "^真题词组小记$",
    "^组合词[：:]",
  ],
  critical_confidence_min: 0.9,
  non_critical_confidence_min: 0.5,
};
