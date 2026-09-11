import { z } from "zod";
import { Explanation, GeneratedProvenance } from "./generated";
import {
  Confidence,
  Example,
  LexicalRelation,
  LogicalKey,
  NormalizedBbox,
  Phrase,
  Sense,
  Sha256Hex,
  Unit,
  Word,
} from "./source";

/**
 * Compile-time agent protocol contracts (spec 5.6).
 *
 * Four isolated roles: generation, independent review, repair, plus the
 * deterministic validator (whose report lives in release.ts). Strict objects
 * guarantee the roles cannot smuggle fields across boundaries: generated
 * output cannot patch source fields, and repair output can only carry
 * per-issue mappings for fields the reviewer flagged.
 */

export const AgentRole = z.enum(["generation", "review", "repair"]);

/** Structured issue code, e.g. SOURCE_FIELD_IMMUTABLE. */
export const IssueCode = z.string().regex(/^[A-Z][A-Z0-9_]*$/, "must be an ISSUE_CODE");

/** The full source content of one unit, as read-only evidence for agents. */
export const SourceSnapshot = z.strictObject({
  unit: Unit,
  words: z.array(Word),
  senses: z.array(Sense),
  phrases: z.array(Phrase),
  examples: z.array(Example),
  relations: z.array(LexicalRelation),
});

/**
 * Output of the generation agent for one unit (spec 5.6 role 1). Strict
 * parsing rejects any unknown key, so attempts to patch source fields (e.g. a
 * `sourcePatch` key) fail at the contract boundary.
 */
export const AgentGenerationOutput = z.strictObject({
  unit_key: LogicalKey,
  /** Work packet this output answers; matches GeneratedProvenance.input_hash. */
  packet_id: z.string().min(1),
  ...GeneratedProvenance.shape,
  explanations: z.array(Explanation).min(1),
});

export const ReviewVerdict = z.enum(["PASS", "REPAIR", "BLOCK"]);

/** Verdict for one generated field, with a structured issue code + evidence. */
export const FieldVerdict = z.strictObject({
  field_path: z.string().min(1),
  verdict: ReviewVerdict,
  issue_code: IssueCode.optional(),
  /** Source evidence only; the reviewer never sees generator reasoning. */
  evidence: z.string().min(1),
});

/**
 * Output of the independent review agent for one unit (spec 5.6 role 2):
 * per-field PASS | REPAIR | BLOCK verdicts plus an aggregate unit verdict.
 */
export const AgentReviewOutput = z.strictObject({
  review_id: z.string().min(1),
  unit_key: LogicalKey,
  /** agent_run_id of the generation output under review. */
  reviewed_agent_run_id: z.string().min(1),
  unit_verdict: ReviewVerdict,
  field_verdicts: z.array(FieldVerdict).min(1),
});

/** One flagged field, its issue code, and the revised value. */
export const RepairAction = z.strictObject({
  field_path: z.string().min(1),
  issue_code: IssueCode,
  revised_value: z.json(),
});

/**
 * Output of the repair agent (spec 5.6 role 4): a per-issue repair mapping.
 * Empty mappings are rejected; rewriting fields the reviewer passed is left to
 * the deterministic validator, which compares this mapping against the review.
 */
export const RepairOutput = z.strictObject({
  repair_id: z.string().min(1),
  unit_key: LogicalKey,
  /** Review output this mapping answers. */
  review_id: z.string().min(1),
  repairs: z.array(RepairAction).min(1),
});

const packetBase = {
  packet_id: z.string().min(1),
  unit_key: LogicalKey,
  prompt_version: z.string().min(1),
  source: SourceSnapshot,
};

export const GenerationWorkPacket = z.strictObject({
  role: z.literal("generation"),
  ...packetBase,
});

export const ReviewWorkPacket = z.strictObject({
  role: z.literal("review"),
  ...packetBase,
  generation: AgentGenerationOutput,
});

export const RepairWorkPacket = z.strictObject({
  role: z.literal("repair"),
  ...packetBase,
  generation: AgentGenerationOutput,
  review: AgentReviewOutput,
});

export const AgentWorkPacket = z.discriminatedUnion("role", [
  GenerationWorkPacket,
  ReviewWorkPacket,
  RepairWorkPacket,
]);

// ---------------------------------------------------------------------------
// Visual OCR agent protocol (spec 5.4/5.6)
//
// When the normalizer meets a critical field (headword/phonetic) it cannot
// accept deterministically (low OCR confidence or an OCR-confusion pattern),
// it must never guess: the field is routed to an externally-dispatched visual
// agent as a packet bound to the exact page region. The agent answers with a
// strict result; corrections are stored as separate provenance records and
// raw OCR evidence is never mutated.
// ---------------------------------------------------------------------------

/** Critical source fields that route to visual review when untrusted. */
export const VisualOcrField = z.enum(["headword", "phonetic"]);

/**
 * One review request for a single critical field. `bbox` + `page_image_sha256`
 * let the agent crop the exact region; `packet_id` embeds the round so a
 * re-review after a rejected repair is a distinct packet.
 */
export const VisualOcrPacket = z.strictObject({
  role: z.literal("visual_ocr"),
  packet_id: z.string().min(1),
  unit_key: LogicalKey,
  /** Versioned review prompt; changes here invalidate in-flight packets. */
  prompt_version: z.string().min(1),
  /** Repair round: 1 = initial review, up to MAX (three) rounds total. */
  round: z.number().int().min(1),
  field: VisualOcrField,
  page_number: z.number().int().min(1),
  page_image_sha256: Sha256Hex,
  bbox: NormalizedBbox,
  /** The OCR text under review (never rewritten by ingestion). */
  current_text: z.string().min(1),
  ocr_confidence: Confidence,
  /** Structured evidence for why the field needs review, e.g.
   *  LOW_CONFIDENCE_CRITICAL_FIELD or OCR_CONFUSION_DIGIT_IN_PHONETIC. */
  evidence_codes: z.array(IssueCode).min(1),
});
/** Value + type share the name so callers can both parse and annotate. */
export type VisualOcrPacket = z.output<typeof VisualOcrPacket>;

/** Verdict of the visual OCR agent for one packet (reuses the review verdicts). */
export const VisualOcrVerdict = ReviewVerdict;

/**
 * Strict response for one packet. A REPAIR must carry the corrected
 * normalized text (and optionally the corrected bbox); PASS and BLOCK must
 * not carry corrections — an agent cannot half-affirm a field.
 */
export const VisualOcrResult = z.strictObject({
  packet_id: z.string().min(1),
  /** SHA-256 of the packet this result answers (tamper detection). */
  packet_hash: Sha256Hex,
  source_hash: Sha256Hex,
  /** Must be distinct across the whole queue (no batch rubber-stamping). */
  agent_run_id: z.string().min(1),
  verdict: VisualOcrVerdict,
  corrected_text: z.string().min(1).optional(),
  corrected_bbox: NormalizedBbox.optional(),
  evidence_codes: z.array(IssueCode).min(1),
  reviewed_at: z.string().min(1),
});
/** Value + type share the name so callers can both parse and annotate. */
export type VisualOcrResult = z.output<typeof VisualOcrResult>;
