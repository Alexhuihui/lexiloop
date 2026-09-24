/**
 * The fail-closed generate -> independent review -> deterministic validation
 * loop, with at most three repair-agent + fresh-review cycles (spec 5.6).
 *
 * Flow per Unit: generation, then an independent review (which reads only
 * source evidence, the generated result, and the schema — never the
 * generator's reasoning), then deterministic validation. Flagged fields go to
 * the repair agent, whose mapping must cover exactly the flagged issues; a
 * fresh review and re-validation follow. After three rejected repair rounds a
 * fourth repair is impossible and the whole Unit becomes BLOCKED — there is
 * no flag, bypass, or human step that can clear it.
 *
 * The same state machine drives two consumers:
 * - `reviewUnit(workload, provider)` runs the loop to completion against an
 *   in-process provider (tests, or a future synchronous provider);
 * - the production stages call `assessUnit` per unit and act on the phase, so
 *   each pipeline invocation advances exactly one packet boundary and then
 *   fails closed with SEMANTIC_PACKETS_PENDING until agents answer externally.
 */
import {
  AgentGenerationOutput,
  AgentReviewOutput,
  RepairOutput,
  UnitValidationReport,
} from "@lexiloop/content-schema";
import { z } from "zod";
import {
  SEMANTIC_PROMPT_VERSION,
  WorkPacketError,
  buildGenerationOrder,
  buildRepairOrder,
  buildReviewOrder,
  parseSemanticAgentResult,
  type SemanticGenerationResultT,
  type SemanticQueueEntry,
  type SemanticRepairResultT,
  type SemanticReviewResultT,
  type SemanticAgentResultT,
  validateSemanticResult,
  type UnitWorkload,
  type WorkOrder,
} from "./work-packets";
import type { SemanticAgentProvider } from "./provider";
import {
  flaggedFields,
  parseFieldPath,
  validateUnit,
} from "../validate/unit-validator";

/** Value types of the strict contracts (the schema exports are value-only). */
type AgentGenerationOutputT = z.output<typeof AgentGenerationOutput>;
type AgentReviewOutputT = z.output<typeof AgentReviewOutput>;
type RepairOutputT = z.output<typeof RepairOutput>;
type UnitValidationReportT = z.output<typeof UnitValidationReport>;

/** One initial generation/review plus at most three repair cycles. */
export const MAX_REPAIR_ROUNDS = 3;

/** Error with a stable machine-readable code (see `code`). */
export class ReviewLoopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReviewLoopError";
    this.code = code;
  }
}

/** Why a unit can never pass (recorded in the stage error and CLI status). */
export type BlockedReason =
  | "REVIEW_BLOCK_VERDICT"
  | "REPAIR_ROUNDS_EXHAUSTED"
  | "UNREPAIRABLE_VALIDATION";

export interface ReviewLoopOptions {
  /** compile_run_id recorded in validation reports (defaults to agent-gate). */
  compileRunId?: string;
  /** Versioned forbidden-term list for the deterministic validator. */
  forbiddenTerms?: readonly string[];
}

export interface UnitResultState {
  generation?: { packetHash: string; result: SemanticGenerationResultT };
  reviews: Array<{ round: number; packetHash: string; result: SemanticReviewResultT }>;
  repairs: Array<{ round: number; packetHash: string; result: SemanticRepairResultT }>;
}

/** Group resolved queue entries into per-unit result states. */
export function collectUnitStates(
  entries: readonly SemanticQueueEntry[],
  unitKeys: readonly string[],
): Map<string, UnitResultState> {
  const states = new Map<string, UnitResultState>(
    unitKeys.map((unitKey) => [unitKey, { reviews: [], repairs: [] }]),
  );
  for (const entry of entries) {
    const state = states.get(entry.order.unit_key);
    if (!state || entry.status !== "resolved" || !entry.result) continue;
    if (entry.result.role === "generation") {
      state.generation = { packetHash: entry.packetHash, result: entry.result };
    } else if (entry.result.role === "review") {
      state.reviews.push({ round: entry.order.round, packetHash: entry.packetHash, result: entry.result });
    } else {
      state.repairs.push({ round: entry.order.round, packetHash: entry.packetHash, result: entry.result });
    }
  }
  for (const state of states.values()) {
    state.reviews.sort((a, b) => a.round - b.round);
    state.repairs.sort((a, b) => a.round - b.round);
  }
  return states;
}

/** Provenance of the repair run that authored a revised generation output. */
export interface RepairMeta {
  packetHash: string;
  agentRunId: string;
  modelId: string;
  generatedAt: string;
}

/**
 * Apply a repair mapping to a generation output. Only reviewer-flagged fields
 * may be rewritten — a mapping for a PASSed field, an unmapped flagged issue,
 * or a path that names no real field fails closed. The revised output keeps
 * the stable keys and every untouched field, and carries the repair run as
 * its new provenance (so the fresh review must answer a distinct run).
 */
export function applyRepairs(
  generation: AgentGenerationOutputT,
  review: AgentReviewOutputT,
  repairs: RepairOutputT,
  meta: RepairMeta,
): AgentGenerationOutputT {
  const flagged = new Map<string, number>();
  for (const field of flaggedFields(review, generation).filter((field) => field.verdict === "REPAIR")) {
    const key = `${field.field_path}\u0000${field.issue_code}`;
    flagged.set(key, (flagged.get(key) ?? 0) + 1);
  }
  const mapped = new Map<string, number>();
  for (const action of repairs.repairs) {
    const key = `${action.field_path}\u0000${action.issue_code}`;
    if (!flagged.has(key)) {
      throw new ReviewLoopError(
        "REPAIR_OUT_OF_SCOPE",
        `repair touches a field the reviewer did not flag: ${action.field_path}`,
      );
    }
    mapped.set(key, (mapped.get(key) ?? 0) + 1);
  }
  for (const [key, count] of flagged) {
    if ((mapped.get(key) ?? 0) < count) {
      throw new ReviewLoopError(
        "REPAIR_INCOMPLETE",
        `flagged issue has no repair mapping: ${key.replace("\u0000", " / ")}`,
      );
    }
  }

  const explanations = generation.explanations.map((explanation) =>
    structuredClone(explanation) as AgentGenerationOutputT["explanations"][number],
  );
  for (const action of repairs.repairs) {
    const resolved = parseFieldPath(action.field_path);
    // Flagged fields are resolution-checked upstream (see flaggedFields);
    // this remains as an internal assertion for direct misuse.
    if (!resolved || resolved.index >= explanations.length) {
      throw new ReviewLoopError(
        "REPAIR_FIELD_UNKNOWN",
        `repair path does not resolve to a generated field: ${action.field_path}`,
      );
    }
    const target = explanations[resolved.index]! as unknown as Record<string, unknown>;
    target[resolved.field] = action.revised_value;
  }

  const parsed = AgentGenerationOutput.safeParse({
    ...generation,
    explanations,
    input_hash: meta.packetHash,
    prompt_version: SEMANTIC_PROMPT_VERSION,
    model_id: meta.modelId,
    agent_run_id: meta.agentRunId,
    generated_at: meta.generatedAt,
  });
  if (!parsed.success) {
    throw new ReviewLoopError(
      "OUTPUT_SCHEMA_INVALID",
      `repaired generation violates the strict contract: ${parsed.error.issues[0]?.message}`,
    );
  }
  return parsed.data;
}

/** Fold the applied repairs into the current generation output + run id. */
function foldGeneration(
  state: UnitResultState,
  throughRepairs: number,
): { generation: AgentGenerationOutputT; runId: string } {
  if (!state.generation) throw new ReviewLoopError("SEMANTIC_STATE_INVALID", "no generation result");
  let generation = state.generation.result.output;
  let runId = generation.agent_run_id;
  const reviewsByRound = new Map(state.reviews.map((entry) => [entry.round, entry]));
  for (let round = 1; round <= throughRepairs; round += 1) {
    const reviewEntry = reviewsByRound.get(round - 1);
    const repairEntry = state.repairs[round - 1];
    if (!reviewEntry || !repairEntry || repairEntry.round !== round) {
      throw new ReviewLoopError(
        "SEMANTIC_STATE_INVALID",
        `repair round ${round} has no matching review round ${round - 1}`,
      );
    }
    if (repairEntry.result.output.review_id !== reviewEntry.result.output.review_id) {
      throw new ReviewLoopError("REPAIR_TARGET_MISMATCH", `repair round ${round} answers a foreign review`);
    }
    if (reviewEntry.result.output.reviewed_agent_run_id !== runId) {
      throw new ReviewLoopError("REVIEW_TARGET_MISMATCH", `review round ${round - 1} answers a foreign generation`);
    }
    generation = applyRepairs(
      generation,
      reviewEntry.result.output,
      repairEntry.result.output,
      {
        packetHash: repairEntry.packetHash,
        agentRunId: repairEntry.result.agent_run_id,
        modelId: repairEntry.result.model_id,
        generatedAt: repairEntry.result.created_at,
      },
    );
    runId = repairEntry.result.agent_run_id;
  }
  return { generation, runId };
}

export type UnitAssessment =
  | { phase: "awaiting_generation"; order: WorkOrder }
  | { phase: "awaiting_review"; order: WorkOrder }
  | {
      phase: "awaiting_repair";
      order: WorkOrder;
      round: number;
      report: UnitValidationReportT;
    }
  | {
      phase: "passed";
      generation: AgentGenerationOutputT;
      review: AgentReviewOutputT;
      report: UnitValidationReportT;
    }
  | {
      phase: "blocked";
      reason: BlockedReason;
      generation: AgentGenerationOutputT;
      review: AgentReviewOutputT;
      report: UnitValidationReportT;
    };

/**
 * Decide what the unit's state machine needs next. Pure and deterministic:
 * the production stages call this per unit on every invocation, and the phase
 * alone decides whether the stage enqueues a packet, passes, or fails.
 */
export function assessUnit(
  workload: UnitWorkload,
  state: UnitResultState,
  options: ReviewLoopOptions = {},
): UnitAssessment {
  if (!state.generation) {
    return { phase: "awaiting_generation", order: buildGenerationOrder(workload) };
  }
  if (state.generation.result.output.input_hash !== state.generation.packetHash) {
    throw new ReviewLoopError(
      "INPUT_HASH_MISMATCH",
      `stored generation for ${workload.unitKey} does not answer its packet`,
    );
  }
  const folded = foldGeneration(state, state.repairs.length);
  const round = state.repairs.length;
  const reviewEntry = state.reviews.find((candidate) => candidate.round === round);
  if (!reviewEntry || reviewEntry.result.output.reviewed_agent_run_id !== folded.runId) {
    return { phase: "awaiting_review", order: buildReviewOrder(workload, folded.generation, round) };
  }
  const review = reviewEntry.result.output;
  const report = validateUnit({
    unitKey: workload.unitKey,
    source: workload.source,
    generation: folded.generation,
    review,
    expectedInputHash: folded.generation.input_hash,
    compileRunId: options.compileRunId ?? "agent-gate",
    repairRounds: round,
    forbiddenTerms: options.forbiddenTerms,
  });
  const flags = flaggedFields(review, folded.generation);
  const settled = { generation: folded.generation, review, report };

  // A blocked Unit's report must say BLOCKED even when the deterministic
  // findings alone would pass it (e.g. a reviewer BLOCK verdict or an
  // exhausted repair budget): the block is recorded as its own ERROR finding.
  const blockedReport = (reason: BlockedReason): UnitValidationReportT =>
    UnitValidationReport.parse({
      ...report,
      status: "BLOCKED",
      findings: [
        ...report.findings,
        {
          check: reason,
          severity: "ERROR",
          message: `unit blocked by the agent review loop: ${reason}`,
        },
      ],
    });

  if (review.unit_verdict === "BLOCK" || flags.some((flag) => flag.verdict === "BLOCK")) {
    return { phase: "blocked", reason: "REVIEW_BLOCK_VERDICT", ...settled, report: blockedReport("REVIEW_BLOCK_VERDICT") };
  }
  const hasErrors = report.findings.some((item) => item.severity === "ERROR");
  if (!hasErrors && flags.length === 0 && review.unit_verdict === "PASS") {
    return { phase: "passed", ...settled };
  }
  if (hasErrors) {
    // Repairs may only address reviewer-flagged issues; an ERROR finding on a
    // field nobody flagged can never be repaired by protocol (findings carry
    // the canonical field path, so a repairable finding always implies a
    // REPAIR flag on the same path).
    const unflagged = !flags.some((flag) => flag.verdict === "REPAIR");
    if (unflagged) {
      return {
        phase: "blocked",
        reason: "UNREPAIRABLE_VALIDATION",
        ...settled,
        report: blockedReport("UNREPAIRABLE_VALIDATION"),
      };
    }
  }
  // A fourth repair is impossible: the whole Unit becomes BLOCKED.
  if (round >= MAX_REPAIR_ROUNDS) {
    return {
      phase: "blocked",
      reason: "REPAIR_ROUNDS_EXHAUSTED",
      ...settled,
      report: blockedReport("REPAIR_ROUNDS_EXHAUSTED"),
    };
  }
  return {
    phase: "awaiting_repair",
    order: buildRepairOrder(workload, folded.generation, review, round + 1),
    round: round + 1,
    report,
  };
}

export interface RepairAttempt {
  round: number;
  /** The rejected review this repair answers. */
  review: AgentReviewOutputT;
  repairs: RepairOutputT;
  /** Deterministic validation of the generation/review pair before repair. */
  report: UnitValidationReportT;
}

export interface UnitReviewResult {
  unitKey: string;
  status: "PASSED" | "BLOCKED";
  blockedReason: BlockedReason | null;
  repairRounds: number;
  repairAttempts: RepairAttempt[];
  generation: AgentGenerationOutputT;
  review: AgentReviewOutputT;
  report: UnitValidationReportT;
}

/**
 * Normalize one provider dispatch result into the strict result record.
 *
 * The provider seam accepts either the complete strict result (the filesystem
 * provider returns the stored queue record, with role/packet hashes and run
 * metadata) or just the strict output itself — a generation output carries its
 * own provenance (agent_run_id, model_id, generated_at), so an in-process
 * provider may return it directly and the dispatch metadata fills in the rest.
 * The source hash is a queue-ingest concern (`ingestSemanticResult` checks it
 * against the compile source), so the synthesized record carries a placeholder.
 * Any raw object carrying a `role` key must be a complete record and is
 * validated as-is, so an agent cannot half-answer a packet.
 */
const SYNTHETIC_SOURCE_HASH = "0".repeat(64);

function toDispatchResult(
  order: WorkOrder["order"],
  packetHash: string,
  raw: unknown,
): unknown {
  if (typeof raw === "object" && raw !== null && "role" in raw) return raw;
  const output = (raw ?? {}) as Record<string, unknown>;
  return {
    role: order.role,
    packet_id: order.packet_id,
    packet_hash: packetHash,
    source_hash: SYNTHETIC_SOURCE_HASH,
    agent_run_id: typeof output.agent_run_id === "string" ? output.agent_run_id : `bare:${order.packet_id}`,
    model_id: typeof output.model_id === "string" ? output.model_id : "in-process",
    created_at: typeof output.generated_at === "string" ? output.generated_at : new Date(0).toISOString(),
    output: raw,
  };
}

/**
 * Validate one dispatched result against THE shared fail-closed boundary
 * (`validateSemanticResult`), using the loop's own state: packet identity,
 * loop-scoped run distinctness, and role-specific target binding (review
 * answers the current folded generation run; repair answers the latest
 * review with a mapping covering exactly its resolvable flagged issues).
 * `WorkPacketError` from the shared validator is re-typed as
 * `ReviewLoopError` so this module keeps one public error surface.
 */
function validateDispatch(
  workload: UnitWorkload,
  state: UnitResultState,
  request: { order: WorkOrder["order"]; packetHash: string },
  phase: "awaiting_generation" | "awaiting_review" | "awaiting_repair",
  raw: unknown,
  seenRunIds: ReadonlySet<string>,
): SemanticAgentResultT {
  try {
    const parsed = parseSemanticAgentResult(toDispatchResult(request.order, request.packetHash, raw));
    const folded =
      phase === "awaiting_generation" ? null : foldGeneration(state, state.repairs.length);
    const lastReview = state.reviews[state.reviews.length - 1];
    validateSemanticResult(parsed, {
      role: request.order.role,
      packetId: request.order.packet_id,
      packetHash: request.packetHash,
      unitKey: workload.unitKey,
      seenRunIds,
      currentGenerationRunId: phase === "awaiting_review" ? folded!.runId : null,
      lastReviewId: lastReview ? lastReview.result.output.review_id : null,
      ...(phase === "awaiting_repair" && lastReview
        ? { flaggedIssues: flaggedFields(lastReview.result.output, folded!.generation) }
        : {}),
    });
    return parsed;
  } catch (err) {
    if (err instanceof WorkPacketError) throw new ReviewLoopError(err.code, err.message);
    throw err;
  }
}

function buildRepairAttempts(
  workload: UnitWorkload,
  state: UnitResultState,
  options: ReviewLoopOptions,
): RepairAttempt[] {
  const attempts: RepairAttempt[] = [];
  for (let round = 1; round <= state.repairs.length; round += 1) {
    const before = foldGeneration(state, round - 1);
    const reviewEntry = state.reviews.find((candidate) => candidate.round === round - 1)!;
    const repairEntry = state.repairs[round - 1]!;
    const report = validateUnit({
      unitKey: workload.unitKey,
      source: workload.source,
      generation: before.generation,
      review: reviewEntry.result.output,
      expectedInputHash: before.generation.input_hash,
      compileRunId: options.compileRunId ?? "agent-gate",
      repairRounds: round - 1,
    });
    attempts.push({
      round,
      review: reviewEntry.result.output,
      repairs: repairEntry.result.output,
      report,
    });
  }
  return attempts;
}

/**
 * Drive one unit's loop to a terminal verdict against a provider. The
 * provider either returns the strict result for the dispatched packet or
 * throws `AgentDispatchPendingError` (production filesystem provider), which
 * propagates so callers can fail the stage closed until agents answer.
 */
export async function reviewUnit(
  workload: UnitWorkload,
  provider: SemanticAgentProvider,
  options: ReviewLoopOptions = {},
): Promise<UnitReviewResult> {
  const state: UnitResultState = { reviews: [], repairs: [] };
  const seenRunIds = new Set<string>();
  for (;;) {
    const assessment = assessUnit(workload, state, options);
    if (assessment.phase === "passed" || assessment.phase === "blocked") {
      return {
        unitKey: workload.unitKey,
        status: assessment.phase === "passed" ? "PASSED" : "BLOCKED",
        blockedReason: assessment.phase === "blocked" ? assessment.reason : null,
        repairRounds: assessment.report.repair_rounds,
        repairAttempts: buildRepairAttempts(workload, state, options),
        generation: assessment.generation,
        review: assessment.review,
        report: assessment.report,
      };
    }
    const request = {
      order: assessment.order.order,
      packet: assessment.order.packet,
      packetHash: assessment.order.packetHash,
    };
    const raw = await provider.dispatch(request);
    const result = validateDispatch(workload, state, request, assessment.phase, raw, seenRunIds);
    seenRunIds.add(result.agent_run_id);
    if (assessment.phase === "awaiting_generation") {
      state.generation = { packetHash: request.packetHash, result: result as SemanticGenerationResultT };
    } else if (assessment.phase === "awaiting_review") {
      state.reviews.push({
        round: request.order.round,
        packetHash: request.packetHash,
        result: result as SemanticReviewResultT,
      });
    } else {
      state.repairs.push({
        round: request.order.round,
        packetHash: request.packetHash,
        result: result as SemanticRepairResultT,
      });
    }
  }
}
