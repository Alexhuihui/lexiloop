/**
 * Deterministic validator for one Unit's generated content (spec 5.6 role 3).
 *
 * The reviewer judges semantics against source evidence; this validator never
 * judges meaning. It mechanically checks what a machine can check: schema,
 * enums, lengths, required coverage, foreign keys, stable keys, cited source
 * provenance, source-field immutability (outputs must answer the exact
 * dispatched packet), forbidden terms, and cross-field consistency — including
 * that review verdicts resolve to real generated fields and that repair
 * mappings cover exactly the issues the reviewer flagged. Findings carry the
 * canonical field path (`explanations[i].<field>`) so an ERROR finding is
 * directly comparable to the review's field verdicts. Any ERROR finding fails
 * the unit closed; a fourth repair can never fix it silently.
 */
import {
  AgentGenerationOutput,
  AgentReviewOutput,
  Explanation,
  RepairOutput,
  SourceSnapshot,
  UnitValidationReport,
} from "@lexiloop/content-schema";
import { z } from "zod";

/** Value types of the strict contracts (the schema exports are value-only). */
type AgentGenerationOutputT = z.output<typeof AgentGenerationOutput>;
type AgentReviewOutputT = z.output<typeof AgentReviewOutput>;
type RepairOutputT = z.output<typeof RepairOutput>;
type SourceSnapshotT = z.output<typeof SourceSnapshot>;
type UnitValidationReportT = z.output<typeof UnitValidationReport>;

/** The generated fields of every explanation (the review's field granularity). */
export const EXPLANATION_FIELDS = [
  "syntax_notes",
  "translation_hints",
  "pitfalls",
  "context_meanings",
  "discrimination_candidates",
] as const;

export type ExplanationField = (typeof EXPLANATION_FIELDS)[number];

/** Canonical field path for one generated field, e.g. `explanations[0].pitfalls`. */
export function fieldPathFor(index: number, field: ExplanationField): string {
  return `explanations[${index}].${field}`;
}

const FIELD_PATH_PATTERN = /^explanations\[(\d+)\]\.([a-z_]+)$/;

/** Resolve a review/repair field path; null when it cannot name a real field. */
export function parseFieldPath(fieldPath: string): { index: number; field: string } | null {
  const match = FIELD_PATH_PATTERN.exec(fieldPath);
  if (!match) return null;
  const index = Number.parseInt(match[1]!, 10);
  const field = match[2]!;
  if (!Number.isSafeInteger(index) || index < 0) return null;
  if (!(EXPLANATION_FIELDS as readonly string[]).includes(field)) return null;
  return { index, field };
}

export interface FlaggedField {
  field_path: string;
  issue_code: string;
  verdict: "REPAIR" | "BLOCK";
}

/**
 * Fields the reviewer flagged (everything but PASS with an issue code). When
 * the generation output is supplied, flags whose `field_path` does not
 * resolve to a real generated field — a malformed path or an out-of-range
 * explanation index — are excluded: no repair protocol can address them, so
 * they must surface as unrepairable validation findings (REVIEW_FIELD_UNKNOWN)
 * instead of sending the state machine into an unresolvable repair round.
 * BLOCK is terminal and never repairable, but is included so callers can
 * detect it.
 */
export function flaggedFields(
  review: AgentReviewOutputT,
  generation?: AgentGenerationOutputT,
): FlaggedField[] {
  const explanationCount = generation?.explanations.length;
  return review.field_verdicts
    .filter((verdict) => {
      if (verdict.verdict === "PASS" || verdict.issue_code === undefined) return false;
      const resolved = parseFieldPath(verdict.field_path);
      if (!resolved) return false;
      return explanationCount === undefined || resolved.index < explanationCount;
    })
    .map((verdict) => ({
      field_path: verdict.field_path,
      issue_code: verdict.issue_code!,
      verdict: verdict.verdict as "REPAIR" | "BLOCK",
    }));
}

export interface UnitValidatorInput {
  unitKey: string;
  source: SourceSnapshotT;
  generation: AgentGenerationOutputT;
  review: AgentReviewOutputT;
  /** Hash of the generation packet the output must answer (immutability). */
  expectedInputHash: string;
  compileRunId: string;
  /** Completed repair rounds so far (0..3), recorded in the report. */
  repairRounds: number;
  /** The repair mapping to check against this review, when one exists. */
  repairs?: RepairOutputT | null;
  /** Versioned forbidden-term list (compile configuration, never source text). */
  forbiddenTerms?: readonly string[];
}

function generatedStrings(generation: AgentGenerationOutputT): string[] {
  const strings: string[] = [];
  for (const explanation of generation.explanations) {
    strings.push(...explanation.syntax_notes);
    strings.push(explanation.translation_hints);
    strings.push(...explanation.pitfalls);
    for (const meaning of explanation.context_meanings) strings.push(meaning.gloss);
    for (const candidate of explanation.discrimination_candidates) strings.push(candidate.note);
  }
  return strings;
}

export function validateUnit(input: UnitValidatorInput): UnitValidationReportT {
  const { unitKey, source, generation, review } = input;
  const findings: UnitValidationReportT["findings"] = [];
  const finding = (
    check: string,
    severity: "ERROR" | "WARNING",
    message: string,
    fieldPath?: string,
  ): void => {
    findings.push({
      check,
      severity,
      ...(fieldPath !== undefined ? { field_path: fieldPath } : {}),
      message,
    });
  };

  // --- schema boundary (enums, lengths, required fields, unknown keys) -----
  const parsed = AgentGenerationOutput.safeParse(generation);
  if (!parsed.success) {
    finding("GENERATION_SCHEMA_INVALID", "ERROR", parsed.error.issues[0]?.message ?? "invalid generation output");
  }
  for (const [index, explanation] of generation.explanations.entries()) {
    // Findings carry the canonical field path (`explanations[i].<field>`) so
    // callers can compare them directly against review field_verdicts paths.
    const explanationPath = `explanations[${index}]`;
    const explanationParsed = Explanation.safeParse(explanation);
    if (!explanationParsed.success) {
      finding(
        "GENERATION_SCHEMA_INVALID",
        "ERROR",
        `explanation ${explanation.explanation_key}: ${explanationParsed.error.issues[0]?.message ?? "invalid"}`,
        explanationPath,
      );
    }
  }

  // --- source-field immutability: the output answers the dispatched packet --
  if (generation.input_hash !== input.expectedInputHash) {
    finding(
      "SOURCE_FIELD_IMMUTABLE",
      "ERROR",
      "generation input_hash does not match the dispatched packet; source evidence must never be mutated or swapped",
    );
  }

  // --- unit scope, stable keys, coverage -----------------------------------
  const unitWords = source.words.filter((word) => word.unit_key === unitKey);
  const wordsByKey = new Map(source.words.map((word) => [word.word_key, word]));
  const examplesByKey = new Map(source.examples.map((example) => [example.example_key, example]));
  const explanationsByWord = new Map<string, number>();
  for (const [index, explanation] of generation.explanations.entries()) {
    const explanationPath = `explanations[${index}]`;
    explanationsByWord.set(explanation.word_key, (explanationsByWord.get(explanation.word_key) ?? 0) + 1);
    if (explanation.unit_key !== unitKey) {
      finding(
        "UNIT_SCOPE_MISMATCH",
        "ERROR",
        `explanation ${explanation.explanation_key} claims unit ${explanation.unit_key}`,
        explanationPath,
      );
    }
    if (explanation.explanation_key !== `exp.${explanation.word_key}`) {
      finding(
        "STABLE_KEY_INVALID",
        "ERROR",
        `explanation key must be the stable derivation exp.<word_key>, got ${explanation.explanation_key}`,
        explanationPath,
      );
    }
    if (!wordsByKey.has(explanation.word_key)) {
      finding(
        "FOREIGN_KEY_UNKNOWN",
        "ERROR",
        `explanation references word ${explanation.word_key} outside the unit's source evidence`,
        explanationPath,
      );
    }
    for (const meaning of explanation.context_meanings) {
      const example = examplesByKey.get(meaning.example_key);
      if (!example) {
        finding(
          "FOREIGN_KEY_UNKNOWN",
          "ERROR",
          `cited example ${meaning.example_key} does not exist in the unit's source evidence`,
          fieldPathFor(index, "context_meanings"),
        );
        continue;
      }
      if (example.word_key !== explanation.word_key) {
        finding(
          "CITATION_SCOPE_MISMATCH",
          "ERROR",
          `context meaning cites example ${meaning.example_key} of another word (${example.word_key})`,
          fieldPathFor(index, "context_meanings"),
        );
      }
      if (example.source_pdf_sha256 !== source.unit.source_pdf_sha256) {
        finding(
          "CITATION_SCOPE_MISMATCH",
          "ERROR",
          `cited example ${meaning.example_key} carries provenance from a different source`,
          fieldPathFor(index, "context_meanings"),
        );
      }
    }
    for (const candidate of explanation.discrimination_candidates) {
      const against = wordsByKey.get(candidate.against_word_key);
      if (!against) {
        finding(
          "FOREIGN_KEY_UNKNOWN",
          "ERROR",
          `discrimination candidate ${candidate.against_word_key} does not exist in the unit's source evidence`,
          fieldPathFor(index, "discrimination_candidates"),
        );
      } else if (candidate.against_word_key === explanation.word_key) {
        finding(
          "CITATION_SCOPE_MISMATCH",
          "ERROR",
          "discrimination candidate targets the explained word itself",
          fieldPathFor(index, "discrimination_candidates"),
        );
      }
    }
    if (explanation.translation_hints.length > 2000) {
      finding(
        "FIELD_LENGTH_EXCESSIVE",
        "WARNING",
        `translation_hints is ${explanation.translation_hints.length} characters (advisory limit 2000)`,
        fieldPathFor(index, "translation_hints"),
      );
    }
  }
  for (const term of input.forbiddenTerms ?? []) {
    if (term.length > 0 && generatedStrings(generation).some((text) => text.includes(term))) {
      finding("FORBIDDEN_TERM_PRESENT", "ERROR", "generated content contains a forbidden term");
      break;
    }
  }
  for (const word of unitWords) {
    const count = explanationsByWord.get(word.word_key) ?? 0;
    if (count === 0) {
      finding("EXPLANATION_COVERAGE_MISSING", "ERROR", `word ${word.headword} (${word.word_key}) has no explanation`);
    } else if (count > 1) {
      finding("EXPLANATION_DUPLICATE", "ERROR", `word ${word.word_key} has ${count} explanations`);
    }
  }

  // --- review consistency ---------------------------------------------------
  if (review.unit_key !== unitKey) {
    finding("REVIEW_SCOPE_MISMATCH", "ERROR", `review claims unit ${review.unit_key}`);
  }
  if (review.reviewed_agent_run_id !== generation.agent_run_id) {
    finding(
      "REVIEW_TARGET_MISMATCH",
      "ERROR",
      "review does not reference the current generation run",
    );
  }
  const verdictsByPath = new Map<string, number>();
  for (const verdict of review.field_verdicts) {
    verdictsByPath.set(verdict.field_path, (verdictsByPath.get(verdict.field_path) ?? 0) + 1);
    const resolved = parseFieldPath(verdict.field_path);
    if (!resolved || resolved.index >= generation.explanations.length) {
      finding("REVIEW_FIELD_UNKNOWN", "ERROR", `verdict path does not resolve to a generated field: ${verdict.field_path}`, verdict.field_path);
    }
  }
  for (const [path, count] of verdictsByPath) {
    if (count > 1) {
      finding("REVIEW_FIELD_DUPLICATE", "ERROR", `field carries ${count} verdicts`, path);
    }
  }
  for (let index = 0; index < generation.explanations.length; index += 1) {
    for (const field of EXPLANATION_FIELDS) {
      const path = fieldPathFor(index, field);
      if (!verdictsByPath.has(path)) {
        finding("REVIEW_COVERAGE_MISSING", "ERROR", `generated field has no review verdict`, path);
      }
    }
  }
  const repairFlags = review.field_verdicts.filter((verdict) => verdict.verdict === "REPAIR").length;
  const blockFlags = review.field_verdicts.filter((verdict) => verdict.verdict === "BLOCK").length;
  const verdictConsistent =
    (review.unit_verdict === "PASS" && repairFlags === 0 && blockFlags === 0) ||
    (review.unit_verdict === "REPAIR" && repairFlags > 0) ||
    (review.unit_verdict === "BLOCK" && blockFlags > 0);
  if (!verdictConsistent) {
    finding(
      "REVIEW_VERDICT_INCONSISTENT",
      "ERROR",
      `unit_verdict ${review.unit_verdict} contradicts the per-field verdicts`,
    );
  }

  // --- repair mapping scope (only when a repair answers this review) -------
  if (input.repairs) {
    if (input.repairs.review_id !== review.review_id) {
      finding("REPAIR_TARGET_MISMATCH", "ERROR", "repair mapping answers a different review");
    }
    const flaggedCounts = new Map<string, number>();
    for (const field of flaggedFields(review).filter((field) => field.verdict === "REPAIR")) {
      const key = `${field.field_path}\u0000${field.issue_code}`;
      flaggedCounts.set(key, (flaggedCounts.get(key) ?? 0) + 1);
    }
    const mappedCounts = new Map<string, number>();
    for (const action of input.repairs.repairs) {
      const key = `${action.field_path}\u0000${action.issue_code}`;
      mappedCounts.set(key, (mappedCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of mappedCounts) {
      if (count > (flaggedCounts.get(key) ?? 0)) {
        finding("REPAIR_OUT_OF_SCOPE", "ERROR", `repair touches a field the reviewer did not flag: ${key.replace("\u0000", " / ")}`);
      }
    }
    for (const [key, count] of flaggedCounts) {
      if ((mappedCounts.get(key) ?? 0) < count) {
        finding("REPAIR_INCOMPLETE", "ERROR", `flagged issue has no repair mapping: ${key.replace("\u0000", " / ")}`);
      }
    }
  }

  const status = findings.some((item) => item.severity === "ERROR") ? "BLOCKED" : "PASSED";
  return UnitValidationReport.parse({
    unit_key: unitKey,
    compile_run_id: input.compileRunId,
    status,
    repair_rounds: input.repairRounds,
    findings,
  });
}
