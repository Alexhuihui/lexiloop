/**
 * Visual-review quality records shared by normalization and the packet
 * pipeline (spec 5.4/5.6).
 *
 * Critical fields that fail deterministic acceptance are never guessed: they
 * become `FieldReview`s carrying visual-agent packets. Agent decisions come
 * back as `VisualCorrection`s; a still-invalid repair escalates to the next
 * round and a field that exhausts MAX rounds (or is explicitly BLOCKed) ends
 * up in `blockedFields`, which fails the owning Unit closed.
 */

/** How many review rounds a critical field may consume (initial + 2 repairs). */
export const MAX_PACKET_ROUND = 3;

/** Critical fields eligible for visual review. */
export type CriticalField = "headword" | "phonetic";

/** A field awaiting (or escalated to) a visual-agent decision. */
export interface FieldReview {
  /** Stable packet id: `vo.<field>.p<page>.r<round>.<hash8>`. */
  packet_id: string;
  field: CriticalField;
  unit_key: string;
  word_key: string;
  page_number: number;
  page_image_sha256: string;
  bbox: [number, number, number, number];
  /** The text under review (OCR text, or the last rejected repair). */
  current_text: string;
  ocr_confidence: number;
  evidence_codes: string[];
  round: number;
}

/** A visual-agent decision for one packet (strict queue schema mirror). */
export interface VisualCorrection {
  packet_id: string;
  verdict: "PASS" | "REPAIR" | "BLOCK";
  /** Corrected normalized text; required for REPAIR, forbidden otherwise. */
  corrected_text?: string;
  /** Must be distinct per decision (no batch rubber-stamping). */
  agent_run_id: string;
  /** Round of the packet this decision answers. */
  round: number;
}

/** A field that consumed its repair budget or was explicitly BLOCKed. */
export interface BlockedField {
  packet_id: string;
  field: CriticalField;
  unit_key: string;
  word_key: string;
  /** The text that could not be confirmed or repaired. */
  current_text: string;
  round: number;
}

/** A REPAIR decision that passed validation and was applied to the record. */
export interface AppliedCorrection {
  packet_id: string;
  field: CriticalField;
  word_key: string;
  corrected_text: string;
  agent_run_id: string;
  round: number;
}
