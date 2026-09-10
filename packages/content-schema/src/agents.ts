import { z } from "zod";
import { Explanation, GeneratedProvenance } from "./generated";
import { Example, LexicalRelation, LogicalKey, Phrase, Sense, Unit, Word } from "./source";

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
