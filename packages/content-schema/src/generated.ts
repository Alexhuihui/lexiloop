import { z } from "zod";
import { LogicalKey, Sha256Hex } from "./source";

/**
 * Generated-side content contracts (spec 4.1/5.5/5.6).
 *
 * Generated entities are produced by the generation agent and are physically
 * separate from source entities: they carry run provenance (input hash, prompt
 * version, model + run identifiers, time) and, being strict objects, reject
 * every source-field key. Agents can therefore never mutate source fields.
 */

/** Provenance shared by every generated entity (spec 5.5). */
export const GeneratedProvenance = z.strictObject({
  /** SHA-256 over the agent work packet this output answers. */
  input_hash: Sha256Hex,
  prompt_version: z.string().min(1),
  model_id: z.string().min(1),
  agent_run_id: z.string().min(1),
  generated_at: z.iso.datetime({ offset: true }),
});

/** Context meaning of the target word inside one example sentence. */
export const ContextMeaning = z.strictObject({
  example_key: LogicalKey,
  gloss: z.string().min(1),
});

/** Candidate confusion pair for a SENSE_DISCRIMINATION card (spec 5.6/5.7). */
export const DiscriminationCandidate = z.strictObject({
  against_word_key: LogicalKey,
  note: z.string().min(1),
});

/**
 * Teacher-style generated notes for one word (spec 6.2 `explanation`).
 * Searchable core fields stay plain columns; everything else is structured.
 */
export const Explanation = z.strictObject({
  explanation_key: LogicalKey,
  word_key: LogicalKey,
  unit_key: LogicalKey,
  syntax_notes: z.array(z.string().min(1)),
  translation_hints: z.string().min(1),
  pitfalls: z.array(z.string().min(1)),
  context_meanings: z.array(ContextMeaning),
  discrimination_candidates: z.array(DiscriminationCandidate),
  ...GeneratedProvenance.shape,
});
