/**
 * Agent-only semantic content gates (spec 5.6): the four isolated roles
 * (generation, independent review, deterministic validator, repair) plus the
 * fail-closed three-round state machine, the semantic packet queue, the
 * production stage handlers, and the CLI wiring.
 *
 * Fail-closed guarantees under test:
 * - immediate pass, repair-then-pass, repeated repair, and the hard block
 *   after three rejected repair rounds (a fourth repair is impossible);
 * - generation output cannot patch source fields (strict schema boundary);
 * - generation and review require distinct agent_run_id values;
 * - invalid structured output is rejected before it can advance anything;
 * - dangling source citations fail the deterministic validator;
 * - a BLOCKED target Unit can never reach the card/audio/package stages.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentGenerationOutput,
  AgentReviewOutput,
  AgentWorkPacket,
  Example,
  Phrase,
  RepairOutput,
  Sense,
  SourceSnapshot,
  Unit,
  Word,
} from "@lexiloop/content-schema";
import { z } from "zod";

/** Value types of the strict contracts (the schema exports are value-only). */
type AgentGenerationOutputT = z.output<typeof AgentGenerationOutput>;
type AgentReviewOutputT = z.output<typeof AgentReviewOutput>;
type AgentWorkPacketT = z.output<typeof AgentWorkPacket>;
type RepairOutputT = z.output<typeof RepairOutput>;
import { buildCli, type CliDeps } from "../../src/cli";
import { createFileLedger } from "../../src/ledger";
import { silentLogger } from "../../src/logging";
import { runPipeline } from "../../src/pipeline";
import type { AgentDispatchRequest, SemanticAgentProvider } from "../../src/agents/provider";
import {
  SEMANTIC_PROMPT_VERSION,
  SEMANTIC_QUEUE_DIR,
  buildGenerationOrder,
  enqueueOrders,
  buildRepairOrder,
  buildReviewOrder,
  ingestSemanticResult,
  loadSemanticQueue,
  loadUnitWorkloads,
  semanticQueueStatus,
  type UnitWorkload,
  type WorkOrder,
} from "../../src/agents/work-packets";
import { MAX_REPAIR_ROUNDS, reviewUnit } from "../../src/agents/review-loop";
import {
  createAgentEnrichStage,
  createAgentReviewStage,
  createDeterministicValidateStage,
  createRepairLoopStage,
  getProductionStages,
} from "../../src/stage-registry";
import { validateUnit } from "../../src/validate/unit-validator";
import type { AnyStage } from "../../src/stage";

// ---------------------------------------------------------------------------
// Fixtures: one Unit of strict source evidence (spec 5.5 provenance).
// ---------------------------------------------------------------------------

const SOURCE_HASH = "c3".repeat(32);
const PDF_HASH = createHash("sha256").update("source.pdf").digest("hex");
const CREATED_AT = "2026-09-11T00:00:00.000Z";

const sha = (label: string): string => createHash("sha256").update(label).digest("hex");

function provenance(page: number, text: string) {
  return {
    source_pdf_sha256: PDF_HASH,
    page_number: page,
    bbox: [0.1, 0.2, 0.5, 0.6] as [number, number, number, number],
    page_image_sha256: sha(`page-${page}`),
    source_raw_ref_hash: sha(`raw-${page}`),
    source_normalized_text: text,
    ocr_confidence: 0.98,
    structure_confidence: 0.97,
  };
}

function makeWorkload(unitKey = "u01"): UnitWorkload {
  const unit = Unit.parse({
    unit_key: unitKey,
    book_key: "llcy",
    level: 1,
    unit_order: 1,
    title: `Unit ${unitKey}`,
    ...provenance(12, `Unit ${unitKey}`),
  });
  const word1 = Word.parse({
    word_key: `${unitKey}-abandon`,
    unit_key: unitKey,
    headword: "abandon",
    phonetic: "/əˈbændən/",
    tier: "core",
    source_order: 1,
    ...provenance(12, "abandon vt. 放弃；抛弃"),
  });
  const word2 = Word.parse({
    word_key: `${unitKey}-ability`,
    unit_key: unitKey,
    headword: "ability",
    tier: "core",
    source_order: 2,
    ...provenance(12, "ability n. 能力"),
  });
  const sense = Sense.parse({
    sense_key: `${unitKey}-abandon-s1`,
    word_key: word1.word_key,
    pos: "vt",
    gloss: "放弃；抛弃",
    sense_order: 1,
    ...provenance(12, "放弃；抛弃"),
  });
  const phrase = Phrase.parse({
    phrase_key: `${unitKey}-abandon-p1`,
    word_key: word1.word_key,
    text: "abandon oneself to",
    gloss: "沉溺于",
    source_order: 1,
    ...provenance(12, "abandon oneself to 沉溺于"),
  });
  const example = Example.parse({
    example_key: `${unitKey}-abandon-ex1`,
    word_key: word1.word_key,
    origin: "exam",
    source_ref: "2019 阅读 Text 2",
    text: "He abandoned the plan without a second thought.",
    target_span: [4, 13],
    source_order: 1,
    ...provenance(12, "He abandoned the plan without a second thought."),
  });
  const source = SourceSnapshot.parse({
    unit,
    words: [word1, word2],
    senses: [sense],
    phrases: [phrase],
    examples: [example],
    relations: [],
  });
  return { unitKey, source };
}

const EXPLANATION_FIELDS = [
  "syntax_notes",
  "translation_hints",
  "pitfalls",
  "context_meanings",
  "discrimination_candidates",
] as const;

interface GenerationOverrides {
  /** Replace every explanation's context meanings (e.g. a dangling citation). */
  contextMeanings?: Array<{ example_key: string; gloss: string }>;
}

/** Deterministic generation output answering the given generation packet. */
function generationOutputFor(
  workload: UnitWorkload,
  packetId: string,
  packetHash: string,
  agentRunId: string,
  overrides: GenerationOverrides = {},
): AgentGenerationOutputT {
  const explanations = workload.source.words.map((word) => {
    const examples = workload.source.examples.filter((candidate) => candidate.word_key === word.word_key);
    const contextMeanings =
      overrides.contextMeanings ??
      examples.map((example) => ({ example_key: example.example_key, gloss: "（语境中）放弃了计划" }));
    return {
      explanation_key: `exp.${word.word_key}`,
      word_key: word.word_key,
      unit_key: workload.unitKey,
      syntax_notes: [`及物动词，后接名词作宾语 (${word.headword})`],
      translation_hints: `放弃；中止 (${word.headword})`,
      pitfalls: [`易与近似词混淆 (${word.headword})`],
      context_meanings: contextMeanings,
      discrimination_candidates: [],
      input_hash: packetHash,
      prompt_version: SEMANTIC_PROMPT_VERSION,
      model_id: "generation-model",
      agent_run_id: agentRunId,
      generated_at: CREATED_AT,
    };
  });
  return AgentGenerationOutput.parse({
    unit_key: workload.unitKey,
    packet_id: packetId,
    input_hash: packetHash,
    prompt_version: SEMANTIC_PROMPT_VERSION,
    model_id: "generation-model",
    agent_run_id: agentRunId,
    generated_at: CREATED_AT,
    explanations,
  });
}

/** The generation embedded in a review work packet (what was reviewed). */
function reviewedGeneration(request: AgentDispatchRequest): AgentGenerationOutputT {
  if (request.packet.role !== "review") throw new Error(`expected a review packet, got ${request.packet.role}`);
  return request.packet.generation;
}

/** The review embedded in a repair work packet (what is being repaired). */
function repairedReview(request: AgentDispatchRequest): AgentReviewOutputT {
  if (request.packet.role !== "repair") throw new Error(`expected a repair packet, got ${request.packet.role}`);
  return request.packet.review;
}

/** Full-coverage review; per-field overrides replace individual verdicts. */
function reviewOutputFor(
  workload: UnitWorkload,
  generation: AgentGenerationOutputT,
  agentRunId: string,
  overrides: Record<string, { verdict: "REPAIR" | "BLOCK"; issueCode: string }> = {},
): AgentReviewOutputT {
  const fieldVerdicts = generation.explanations.flatMap((_, index) =>
    EXPLANATION_FIELDS.map((field) => {
      const fieldPath = `explanations[${index}].${field}`;
      const override = overrides[fieldPath];
      return {
        field_path: fieldPath,
        verdict: (override ? override.verdict : "PASS") as "PASS" | "REPAIR" | "BLOCK",
        ...(override ? { issue_code: override.issueCode } : {}),
        evidence: `源证据核对：${workload.source.unit.unit_key} ${fieldPath}`,
      };
    }),
  );
  const anyRepair = fieldVerdicts.some((verdict) => verdict.verdict === "REPAIR");
  const anyBlock = fieldVerdicts.some((verdict) => verdict.verdict === "BLOCK");
  return {
    review_id: `rev-${agentRunId}`,
    unit_key: workload.unitKey,
    reviewed_agent_run_id: generation.agent_run_id,
    unit_verdict: anyBlock ? "BLOCK" : anyRepair ? "REPAIR" : "PASS",
    field_verdicts: fieldVerdicts,
  };
}

/** Repair mapping covering exactly the reviewer-flagged fields. */
function repairOutputFor(
  workload: UnitWorkload,
  review: AgentReviewOutputT,
  agentRunId: string,
  revisedValue: RepairOutputT["repairs"][number]["revised_value"] = "放弃；终止（已修订）",
): RepairOutputT {
  return {
    repair_id: `fix-${agentRunId}`,
    unit_key: workload.unitKey,
    review_id: review.review_id,
    repairs: review.field_verdicts
      .filter((verdict) => verdict.verdict === "REPAIR")
      .map((verdict) => ({
        field_path: verdict.field_path,
        issue_code: verdict.issue_code!,
        revised_value: revisedValue,
      })),
  };
}

interface EnvelopeOverrides {
  packetId?: string;
  packetHash?: string;
  sourceHash?: string;
}

/** Strict result envelope for one packet (what an agent writes to disk). */
function envelopeFor(
  packet: { order: { role: "generation" | "review" | "repair"; packet_id: string }; packetHash: string },
  agentRunId: string,
  output: unknown,
  overrides: EnvelopeOverrides = {},
) {
  return {
    role: packet.order.role,
    packet_id: overrides.packetId ?? packet.order.packet_id,
    packet_hash: overrides.packetHash ?? packet.packetHash,
    source_hash: overrides.sourceHash ?? SOURCE_HASH,
    agent_run_id: agentRunId,
    model_id: "agent-model",
    created_at: CREATED_AT,
    output,
  };
}

type RoleHandler = (request: AgentDispatchRequest) => unknown;

/** A provider stub that synthesizes one strict result per dispatched role. */
function stubProvider(handlers: {
  generation: RoleHandler;
  review: RoleHandler;
  repair?: RoleHandler;
  onDispatch?: (role: "generation" | "review" | "repair") => void;
}): SemanticAgentProvider {
  return {
    async dispatch(request) {
      handlers.onDispatch?.(request.order.role);
      const handler =
        request.order.role === "generation"
          ? handlers.generation
          : request.order.role === "review"
            ? handlers.review
            : handlers.repair;
      if (!handler) throw new Error(`unexpected ${request.order.role} dispatch`);
      return handler(request);
    },
  };
}

/**
 * The brief's always-repair provider: every review rejects the same field and
 * every repair maps it — the loop must block after exactly three rounds.
 */
function providerAlwaysReturningRepair(workload: UnitWorkload): SemanticAgentProvider {
  let reviews = 0;
  let repairs = 0;
  const flagged = { "explanations[0].translation_hints": { verdict: "REPAIR" as const, issueCode: "TRANSLATION_HINT_MISMATCH" } };
  return stubProvider({
    generation: (request) =>
      generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen"),
    review: (request) => {
      reviews += 1;
      const runId = `run-review-${reviews}`;
      return envelopeFor(request, runId, reviewOutputFor(workload, reviewedGeneration(request), runId, flagged));
    },
    repair: (request) => {
      repairs += 1;
      const runId = `run-fix-${repairs}`;
      return envelopeFor(request, runId, repairOutputFor(workload, repairedReview(request), runId, `修订 ${repairs}`));
    },
  });
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Write the normalized.jsonl artifact STRUCTURE_NORMALIZE would have produced. */
async function writeNormalizedArtifact(workDir: string, workload: UnitWorkload): Promise<void> {
  const { unit, words, senses, phrases, examples } = workload.source;
  const rows = [
    { entity_type: "unit" as const, ...unit },
    ...words.map((word) => ({ entity_type: "word" as const, ...word })),
    ...senses.map((sense) => ({ entity_type: "sense" as const, ...sense })),
    ...phrases.map((phrase) => ({ entity_type: "phrase" as const, ...phrase })),
    ...examples.map((example) => ({ entity_type: "example" as const, ...example })),
  ];
  await writeFile(
    path.join(workDir, "normalized.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Review loop state machine (spec 5.6)
// ---------------------------------------------------------------------------

describe("review loop (spec 5.6)", () => {
  it("caps the repair budget at three rounds (initial review + three repairs)", () => {
    expect(MAX_REPAIR_ROUNDS).toBe(3);
  });

  it("passes a unit on the first review without repairs", async () => {
    const workload = makeWorkload();
    let reviews = 0;
    const provider = stubProvider({
      generation: (request) =>
        generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen"),
      review: (request) => {
        reviews += 1;
        return envelopeFor(request, "run-review", reviewOutputFor(workload, reviewedGeneration(request), "run-review"));
      },
    });

    const result = await reviewUnit(workload, provider, { compileRunId: "run-1" });

    expect(reviews).toBe(1);
    expect(result.status).toBe("PASSED");
    expect(result.blockedReason).toBeNull();
    expect(result.repairRounds).toBe(0);
    expect(result.repairAttempts).toHaveLength(0);
    expect(result.report.status).toBe("PASSED");
    expect(result.generation.agent_run_id).toBe("run-gen");
  });

  it("repairs one flagged field, then passes a fresh review", async () => {
    const workload = makeWorkload();
    let reviews = 0;
    const flagged = { "explanations[0].translation_hints": { verdict: "REPAIR" as const, issueCode: "TRANSLATION_HINT_MISMATCH" } };
    const provider = stubProvider({
      generation: (request) =>
        generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen"),
      review: (request) => {
        reviews += 1;
        const runId = `run-review-${reviews}`;
        const overrides = reviews === 1 ? flagged : {};
        return envelopeFor(request, runId, reviewOutputFor(workload, reviewedGeneration(request), runId, overrides));
      },
      repair: (request) =>
        envelopeFor(request, "run-fix-1", repairOutputFor(workload, repairedReview(request), "run-fix-1")),
    });

    const result = await reviewUnit(workload, provider, { compileRunId: "run-1" });

    expect(reviews).toBe(2);
    expect(result.status).toBe("PASSED");
    expect(result.repairRounds).toBe(1);
    expect(result.repairAttempts).toHaveLength(1);
    expect(result.repairAttempts[0]!.round).toBe(1);
    expect(result.repairAttempts[0]!.review.field_verdicts.some((verdict) => verdict.verdict === "REPAIR")).toBe(true);
    expect(result.repairAttempts[0]!.repairs.repairs[0]!.revised_value).toBe("放弃；终止（已修订）");
    // The repaired field carries the revised value; the untouched word is unchanged.
    expect(result.generation.explanations[0]!.translation_hints).toBe("放弃；终止（已修订）");
    expect(result.generation.explanations[1]!.translation_hints).toBe("放弃；中止 (ability)");
    // The revised generation is authored by the repair run and bound to the repair packet.
    expect(result.generation.agent_run_id).toBe("run-fix-1");
    expect(result.report.status).toBe("PASSED");
  });

  it("blocks after three rejected repair rounds", async () => {
    const workload = makeWorkload();
    const provider = providerAlwaysReturningRepair(workload);

    const result = await reviewUnit(workload, provider);

    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReason).toBe("REPAIR_ROUNDS_EXHAUSTED");
    expect(result.repairAttempts).toHaveLength(3);
    expect(result.repairAttempts.map((attempt) => attempt.round)).toEqual([1, 2, 3]);
    expect(result.report.status).toBe("BLOCKED");
    expect(result.report.repair_rounds).toBe(3);
  });

  it("rejects generation output that carries a source patch", async () => {
    const workload = makeWorkload();
    const provider = stubProvider({
      generation: (request) => {
        const output = generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen");
        return envelopeFor(request, "run-gen", { ...output, sourcePatch: { headword: "mutated" } });
      },
      review: (request) =>
        envelopeFor(request, "run-review", reviewOutputFor(workload, reviewedGeneration(request), "run-review")),
    });

    await expect(reviewUnit(workload, provider)).rejects.toMatchObject({
      code: "OUTPUT_SCHEMA_INVALID",
    });
  });

  it("rejects a reviewer that reuses the generation agent_run_id", async () => {
    const workload = makeWorkload();
    const provider = stubProvider({
      generation: (request) =>
        generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen"),
      review: (request) => {
        const generation = reviewedGeneration(request);
        return envelopeFor(request, "run-gen", reviewOutputFor(workload, generation, "run-gen"));
      },
    });

    await expect(reviewUnit(workload, provider)).rejects.toMatchObject({
      code: "AGENT_RUN_NOT_DISTINCT",
    });
  });

  it("rejects invalid structured output before it can advance the unit", async () => {
    const workload = makeWorkload();
    const provider = stubProvider({
      generation: (request) =>
        generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen"),
      review: (request) => {
        const review = reviewOutputFor(workload, reviewedGeneration(request), "run-review");
        return envelopeFor(request, "run-review", { ...review, field_verdicts: "all good, trust me" });
      },
    });

    await expect(reviewUnit(workload, provider)).rejects.toMatchObject({
      code: "OUTPUT_SCHEMA_INVALID",
    });
  });

  it("blocks immediately on a reviewer BLOCK verdict without wasting a repair", async () => {
    const workload = makeWorkload();
    let repairDispatches = 0;
    const provider = stubProvider({
      generation: (request) =>
        generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen"),
      review: (request) => {
        const generation = reviewedGeneration(request);
        return envelopeFor(request, "run-review", reviewOutputFor(workload, generation, "run-review", {
          "explanations[1].context_meanings": { verdict: "BLOCK", issueCode: "SOURCE_EVIDENCE_INSUFFICIENT" },
        }));
      },
      repair: () => {
        repairDispatches += 1;
        return {};
      },
    });

    const result = await reviewUnit(workload, provider);

    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReason).toBe("REVIEW_BLOCK_VERDICT");
    expect(result.repairAttempts).toHaveLength(0);
    expect(repairDispatches).toBe(0);
  });

  it("flags dangling source citations and repairs them", async () => {
    const workload = makeWorkload();
    const overrides: GenerationOverrides = {
      contextMeanings: [{ example_key: "ex-does-not-exist", gloss: "（语境中）放弃了计划" }],
    };
    let reviews = 0;
    const provider = stubProvider({
      generation: (request) =>
        generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen", overrides),
      review: (request) => {
        reviews += 1;
        const runId = `run-review-${reviews}`;
        // Round 0: the reviewer flags every dangling citation for repair; the
        // fresh round-1 review must then pass the repaired generation. A unit
        // whose re-validation still reports ERROR findings can never exit the
        // gates as PASSED (fail-closed, spec 5.6).
        const flagged = (
          reviews === 1
            ? {
                "explanations[0].context_meanings": { verdict: "REPAIR" as const, issueCode: "CONTEXT_CITATION_DANGLING" },
                "explanations[1].context_meanings": { verdict: "REPAIR" as const, issueCode: "CONTEXT_CITATION_DANGLING" },
              }
            : {}
        ) as Record<string, { verdict: "REPAIR" | "BLOCK"; issueCode: string }>;
        return envelopeFor(request, runId, reviewOutputFor(workload, reviewedGeneration(request), runId, flagged));
      },
      repair: (request) => {
        const review = repairedReview(request);
        // Per-issue mapping: the abandon citation resolves to a real example,
        // the ability explanation ends up with no context citation at all.
        const revisedFor = (fieldPath: string): unknown =>
          fieldPath === "explanations[1].context_meanings"
            ? []
            : [{ example_key: `${workload.unitKey}-abandon-ex1`, gloss: "（语境中）放弃了计划" }];
        return envelopeFor(request, "run-fix-1", {
          repair_id: "fix-run-fix-1",
          unit_key: workload.unitKey,
          review_id: review.review_id,
          repairs: review.field_verdicts
            .filter((verdict) => verdict.verdict === "REPAIR")
            .map((verdict) => ({
              field_path: verdict.field_path,
              issue_code: verdict.issue_code!,
              revised_value: revisedFor(verdict.field_path),
            })),
        });
      },
    });

    const result = await reviewUnit(workload, provider, { compileRunId: "run-1" });

    expect(result.status).toBe("PASSED");
    expect(result.repairAttempts).toHaveLength(1);
    expect(result.repairAttempts[0]!.report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "FOREIGN_KEY_UNKNOWN" })]),
    );
    expect(result.generation.explanations[0]!.context_meanings[0]!.example_key).toBe(
      `${workload.unitKey}-abandon-ex1`,
    );
  });

  it("blocks when the validator fails a field the reviewer passed (unrepairable)", async () => {
    const workload = makeWorkload();
    const overrides: GenerationOverrides = {
      contextMeanings: [{ example_key: "ex-does-not-exist", gloss: "（语境中）放弃了计划" }],
    };
    const provider = stubProvider({
      generation: (request) =>
        generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen", overrides),
      review: (request) =>
        envelopeFor(request, "run-review", reviewOutputFor(workload, reviewedGeneration(request), "run-review")),
      repair: () => {
        throw new Error("repair must never be dispatched for unflagged findings");
      },
    });

    const result = await reviewUnit(workload, provider);

    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReason).toBe("UNREPAIRABLE_VALIDATION");
    expect(result.repairAttempts).toHaveLength(0);
    expect(result.report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "FOREIGN_KEY_UNKNOWN" })]),
    );
  });

  it("blocks terminally when the reviewer flags a nonexistent field path", async () => {
    const workload = makeWorkload();
    const provider = stubProvider({
      generation: (request) =>
        generationOutputFor(workload, request.order.packet_id, request.packetHash, "run-gen"),
      review: (request) => {
        const generation = reviewedGeneration(request);
        const review = reviewOutputFor(workload, generation, "run-review");
        // A schema-valid but malformed reviewer verdict: the flagged path
        // resolves to no generated field, so no repair protocol can address
        // it. The unit must consume the normal flow into a terminal BLOCKED —
        // never an unresolvable repair round and never an exception loop.
        review.field_verdicts.push({
          field_path: "explanations[9].translation_hints",
          verdict: "REPAIR",
          issue_code: "TRANSLATION_HINT_MISMATCH",
          evidence: "越界路径",
        });
        return envelopeFor(request, "run-review", review);
      },
      repair: () => {
        throw new Error("repair must never be dispatched for an unresolvable flag");
      },
    });

    const result = await reviewUnit(workload, provider);

    expect(result.status).toBe("BLOCKED");
    expect(result.blockedReason).toBe("UNREPAIRABLE_VALIDATION");
    expect(result.repairAttempts).toHaveLength(0);
    expect(result.report.status).toBe("BLOCKED");
    expect(result.report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "REVIEW_FIELD_UNKNOWN" })]),
    );
  });
});

// ---------------------------------------------------------------------------
// Deterministic validator (spec 5.6 role 3)
// ---------------------------------------------------------------------------

describe("deterministic validator", () => {
  function build(workload: UnitWorkload) {
    const order = buildGenerationOrder(workload);
    const generation = generationOutputFor(workload, order.order.packet_id, order.packetHash, "run-gen");
    const review = reviewOutputFor(workload, generation, "run-review");
    return { order, generation, review };
  }

  function validate(
    workload: UnitWorkload,
    generation: AgentGenerationOutputT,
    review: AgentReviewOutputT,
    expectedInputHash: string,
    extra: { repairs?: RepairOutputT; forbiddenTerms?: readonly string[] } = {},
  ) {
    return validateUnit({
      unitKey: workload.unitKey,
      source: workload.source,
      generation,
      review,
      expectedInputHash,
      compileRunId: "run-1",
      repairRounds: 0,
      ...extra,
    });
  }

  it("reports BLOCKED with ERROR findings and PASSED without them", () => {
    const workload = makeWorkload();
    const { order, generation, review } = build(workload);
    expect(validate(workload, generation, review, order.packetHash).status).toBe("PASSED");
    const report = validate(workload, generation, review, "not-the-packet-hash");
    expect(report.status).toBe("BLOCKED");
    expect(report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "SOURCE_FIELD_IMMUTABLE" })]),
    );
  });

  it("enforces stable explanation keys, unit scope, and word coverage", () => {
    const workload = makeWorkload();
    const { order, generation, review } = build(workload);
    const badKey = {
      ...generation,
      explanations: generation.explanations.map((explanation, index) =>
        index === 0 ? { ...explanation, explanation_key: "my-own-key" } : explanation,
      ),
    };
    expect(validate(workload, badKey as AgentGenerationOutputT, review, order.packetHash).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "STABLE_KEY_INVALID" })]),
    );

    const badScope = {
      ...generation,
      explanations: generation.explanations.map((explanation, index) =>
        index === 0 ? { ...explanation, unit_key: "u02" } : explanation,
      ),
    };
    expect(validate(workload, badScope as AgentGenerationOutputT, review, order.packetHash).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "UNIT_SCOPE_MISMATCH" })]),
    );

    const missingCoverage = { ...generation, explanations: [generation.explanations[0]] };
    expect(
      validate(workload, missingCoverage as AgentGenerationOutputT, review, order.packetHash).findings,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ check: "EXPLANATION_COVERAGE_MISSING" })]));
  });

  it("flags forbidden terms as findings", () => {
    const workload = makeWorkload();
    const { order, generation, review } = build(workload);
    const tainted = {
      ...generation,
      explanations: generation.explanations.map((explanation) => ({
        ...explanation,
        translation_hints: "这里有禁止词 watermark 混入",
      })),
    };
    const report = validate(workload, tainted as AgentGenerationOutputT, review, order.packetHash, {
      forbiddenTerms: ["watermark"],
    });
    expect(report.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "FORBIDDEN_TERM_PRESENT" })]),
    );
  });

  it("requires every generated field to carry exactly one resolvable review verdict", () => {
    const workload = makeWorkload();
    const { order, generation, review } = build(workload);
    const partial = { ...review, field_verdicts: review.field_verdicts.slice(0, 3) };
    expect(validate(workload, generation, partial, order.packetHash).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "REVIEW_COVERAGE_MISSING" })]),
    );

    const unknownField = {
      ...review,
      field_verdicts: [
        ...review.field_verdicts,
        {
          field_path: "explanations[99].translation_hints",
          verdict: "REPAIR" as const,
          issue_code: "TRANSLATION_HINT_MISMATCH",
          evidence: "越界路径",
        },
      ],
    };
    expect(validate(workload, generation, unknownField, order.packetHash).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: "REVIEW_FIELD_UNKNOWN" })]),
    );
  });

  it("checks repair mappings against exactly the flagged fields", () => {
    const workload = makeWorkload();
    const { order, generation } = build(workload);
    const review = reviewOutputFor(workload, generation, "run-review", {
      "explanations[0].translation_hints": { verdict: "REPAIR", issueCode: "TRANSLATION_HINT_MISMATCH" },
      "explanations[0].pitfalls": { verdict: "REPAIR", issueCode: "PITFALL_UNFOUNDED" },
    });
    const repairs: RepairOutputT = {
      repair_id: "fix-1",
      unit_key: workload.unitKey,
      review_id: review.review_id,
      repairs: [
        {
          field_path: "explanations[0].translation_hints",
          issue_code: "TRANSLATION_HINT_MISMATCH",
          revised_value: "x",
        },
      ],
    };
    expect(
      validate(workload, generation, review, order.packetHash, { repairs }).findings,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ check: "REPAIR_INCOMPLETE" })]));

    const extra: RepairOutputT = {
      ...repairs,
      repairs: [
        ...repairs.repairs,
        { field_path: "explanations[1].syntax_notes", issue_code: "TRANSLATION_HINT_MISMATCH", revised_value: "y" },
      ],
    };
    expect(
      validate(workload, generation, review, order.packetHash, { repairs: extra }).findings,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ check: "REPAIR_OUT_OF_SCOPE" })]));
  });
});

// ---------------------------------------------------------------------------
// Semantic packet queue boundary (ingest validates hashes + role/run separation)
// ---------------------------------------------------------------------------

describe("semantic packet queue", () => {
  let queueDir = "";

  async function setup(): Promise<void> {
    queueDir = await makeTempDir("sem-queue-");
  }

  function generationResultFor(
    workload: UnitWorkload,
    order: WorkOrder,
    agentRunId: string,
    overrides: GenerationOverrides = {},
  ) {
    return envelopeFor(
      order,
      agentRunId,
      generationOutputFor(workload, order.order.packet_id, order.packetHash, agentRunId, overrides),
    );
  }

  it("round-trips packets and resolves each exactly once", async () => {
    await setup();
    const workload = makeWorkload();
    const order = buildGenerationOrder(workload);
    expect(order.order.role).toBe("generation");
    expect(order.order.unit_key).toBe(workload.unitKey);
    expect(order.order.prompt_version).toBe(SEMANTIC_PROMPT_VERSION);
    expect(order.order.output_path).toContain(SEMANTIC_QUEUE_DIR);
    expect(order.order.schema_ref).toBe("AgentGenerationOutput");
    expect(order.order.requested_fields).toContain("translation_hints");
    expect(Object.keys(order.order.schema)).toContain("properties");

    expect(await loadSemanticQueue(queueDir)).toEqual([]);
    await enqueueOrders(queueDir, [order]);
    await enqueueOrders(queueDir, [order]); // idempotent upsert
    const entries = await loadSemanticQueue(queueDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.status).toBe("pending");
    expect(await semanticQueueStatus(queueDir)).toMatchObject({ total: 1, pending: 1, resolved: 0 });

    await ingestSemanticResult(queueDir, SOURCE_HASH, generationResultFor(workload, order, "run-gen"));
    await expect(
      ingestSemanticResult(queueDir, SOURCE_HASH, generationResultFor(workload, order, "run-gen-again")),
    ).rejects.toMatchObject({ code: "RESULT_ALREADY_RESOLVED" });
    expect(await semanticQueueStatus(queueDir)).toMatchObject({ total: 1, pending: 0, resolved: 1 });
  });

  it("rejects unknown packets, tampered packet hashes, and wrong sources", async () => {
    await setup();
    const workload = makeWorkload("u02");
    const order = buildGenerationOrder(workload);
    await enqueueOrders(queueDir, [order]);

    const valid = generationOutputFor(workload, order.order.packet_id, order.packetHash, "run-a");
    await expect(
      ingestSemanticResult(queueDir, SOURCE_HASH, envelopeFor(order, "run-a", valid, { packetId: "sem.gen.nope.r0.deadbeef" })),
    ).rejects.toMatchObject({ code: "PACKET_NOT_FOUND" });
    await expect(
      ingestSemanticResult(queueDir, SOURCE_HASH, envelopeFor(order, "run-b", valid, { packetHash: "0".repeat(64) })),
    ).rejects.toMatchObject({ code: "PACKET_HASH_MISMATCH" });
    await expect(
      ingestSemanticResult(queueDir, "f0".repeat(32), generationResultFor(workload, order, "run-c")),
    ).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
  });

  it("rejects reused agent run ids across units", async () => {
    await setup();
    const order1 = buildGenerationOrder(makeWorkload("u01"));
    const order2 = buildGenerationOrder(makeWorkload("u02"));
    await enqueueOrders(queueDir, [order1, order2]);
    await ingestSemanticResult(queueDir, SOURCE_HASH, generationResultFor(makeWorkload("u01"), order1, "run-A"));
    await expect(
      ingestSemanticResult(queueDir, SOURCE_HASH, generationResultFor(makeWorkload("u02"), order2, "run-A")),
    ).rejects.toMatchObject({ code: "AGENT_RUN_NOT_DISTINCT" });
  });

  it("enforces role/run separation: a review must answer the current generation run", async () => {
    await setup();
    const workload = makeWorkload();
    const genOrder = buildGenerationOrder(workload);
    const generation = generationOutputFor(workload, genOrder.order.packet_id, genOrder.packetHash, "run-gen");
    const reviewOrder = buildReviewOrder(workload, generation, 0);
    await enqueueOrders(queueDir, [genOrder, reviewOrder]);

    // Review before its generation exists.
    await expect(
      ingestSemanticResult(
        queueDir,
        SOURCE_HASH,
        envelopeFor(reviewOrder, "run-review", reviewOutputFor(workload, generation, "run-review")),
      ),
    ).rejects.toMatchObject({ code: "REVIEW_TARGET_MISMATCH" });

    // Generation lands, but the reviewer reuses its run id.
    await ingestSemanticResult(queueDir, SOURCE_HASH, generationResultFor(workload, genOrder, "run-gen"));
    await expect(
      ingestSemanticResult(
        queueDir,
        SOURCE_HASH,
        envelopeFor(reviewOrder, "run-gen", reviewOutputFor(workload, generation, "run-gen")),
      ),
    ).rejects.toMatchObject({ code: "AGENT_RUN_NOT_DISTINCT" });

    // Review pointing at a foreign generation run.
    await expect(
      ingestSemanticResult(
        queueDir,
        SOURCE_HASH,
        envelopeFor(reviewOrder, "run-review", {
          ...reviewOutputFor(workload, generation, "run-review"),
          reviewed_agent_run_id: "run-someone-else",
        }),
      ),
    ).rejects.toMatchObject({ code: "REVIEW_TARGET_MISMATCH" });
  });

  it("rejects REPAIR/BLOCK verdicts without structured issue codes", async () => {
    await setup();
    const workload = makeWorkload();
    const genOrder = buildGenerationOrder(workload);
    const generation = generationOutputFor(workload, genOrder.order.packet_id, genOrder.packetHash, "run-gen");
    const reviewOrder = buildReviewOrder(workload, generation, 0);
    await enqueueOrders(queueDir, [genOrder, reviewOrder]);
    await ingestSemanticResult(queueDir, SOURCE_HASH, generationResultFor(workload, genOrder, "run-gen"));

    const review = reviewOutputFor(workload, generation, "run-review", {
      "explanations[0].translation_hints": { verdict: "REPAIR", issueCode: "TRANSLATION_HINT_MISMATCH" },
    });
    const stripped = {
      ...review,
      field_verdicts: review.field_verdicts.map((verdict) =>
        verdict.verdict === "REPAIR" ? { ...verdict, issue_code: undefined } : verdict,
      ),
    };
    await expect(
      ingestSemanticResult(queueDir, SOURCE_HASH, envelopeFor(reviewOrder, "run-review", stripped)),
    ).rejects.toMatchObject({ code: "RESULT_INVALID" });
  });

  it("requires the repair mapping to cover exactly the flagged issues", async () => {
    await setup();
    const workload = makeWorkload();
    const genOrder = buildGenerationOrder(workload);
    const generation = generationOutputFor(workload, genOrder.order.packet_id, genOrder.packetHash, "run-gen");
    const review = reviewOutputFor(workload, generation, "run-review", {
      "explanations[0].translation_hints": { verdict: "REPAIR", issueCode: "TRANSLATION_HINT_MISMATCH" },
      "explanations[0].pitfalls": { verdict: "REPAIR", issueCode: "PITFALL_UNFOUNDED" },
    });
    const reviewOrder = buildReviewOrder(workload, generation, 0);
    const repairOrder = buildRepairOrder(workload, generation, review, 1);
    await enqueueOrders(queueDir, [genOrder, reviewOrder, repairOrder]);
    await ingestSemanticResult(queueDir, SOURCE_HASH, generationResultFor(workload, genOrder, "run-gen"));
    await ingestSemanticResult(queueDir, SOURCE_HASH, envelopeFor(reviewOrder, "run-review", review));

    const mapping = (revised: unknown, pick: (index: number) => boolean) => ({
      repair_id: "fix-1",
      unit_key: workload.unitKey,
      review_id: review.review_id,
      repairs: review.field_verdicts
        .filter((verdict) => verdict.verdict === "REPAIR")
        .map((verdict) => ({ field_path: verdict.field_path, issue_code: verdict.issue_code!, revised_value: revised }))
        .filter((_, index) => pick(index)),
    });

    // Wrong review_id.
    await expect(
      ingestSemanticResult(queueDir, SOURCE_HASH, envelopeFor(repairOrder, "run-fix", {
        ...mapping("x", () => true),
        review_id: "rev-someone-else",
      })),
    ).rejects.toMatchObject({ code: "REPAIR_TARGET_MISMATCH" });

    // Incomplete mapping (one of two flagged fields).
    await expect(
      ingestSemanticResult(queueDir, SOURCE_HASH, envelopeFor(repairOrder, "run-fix", mapping("x", (index) => index === 0))),
    ).rejects.toMatchObject({ code: "REPAIR_INCOMPLETE" });

    // Mapping a field the reviewer passed.
    await expect(
      ingestSemanticResult(queueDir, SOURCE_HASH, envelopeFor(repairOrder, "run-fix", {
        repair_id: "fix-1",
        unit_key: workload.unitKey,
        review_id: review.review_id,
        repairs: [
          { field_path: "explanations[0].syntax_notes", issue_code: "TRANSLATION_HINT_MISMATCH", revised_value: "x" },
        ],
      })),
    ).rejects.toMatchObject({ code: "REPAIR_OUT_OF_SCOPE" });

    // Complete mapping resolves the packet.
    const entry = await ingestSemanticResult(
      queueDir,
      SOURCE_HASH,
      envelopeFor(repairOrder, "run-fix", mapping("x", () => true)),
    );
    expect(entry.status).toBe("resolved");
  });

  it("loads unit workloads from normalized.jsonl and validates the release scope", async () => {
    await setup();
    const workDir = await makeTempDir("sem-work-");
    await mkdir(workDir, { recursive: true });
    await writeNormalizedArtifact(workDir, makeWorkload());

    const workloads = await loadUnitWorkloads(workDir);
    expect(workloads.map((workload) => workload.unitKey)).toEqual(["u01"]);
    expect(workloads[0]!.source.words).toHaveLength(2);

    const scoped = await loadUnitWorkloads(workDir, { units: ["u01"] });
    expect(scoped).toHaveLength(1);
    await expect(loadUnitWorkloads(workDir, { units: ["uZZ"] })).rejects.toMatchObject({
      code: "UNIT_SCOPE_UNKNOWN",
    });
  });
});

// ---------------------------------------------------------------------------
// Production stage handlers: CARD_GENERATE stays unreachable unless every
// target Unit exits the four agent gates as PASSED.
// ---------------------------------------------------------------------------

describe("semantic agent stages (production registry)", () => {
  async function makeCompileFixture() {
    const privateRoot = await makeTempDir("sem-private-");
    const workDir = path.join(privateRoot, "work", SOURCE_HASH);
    const queueDir = path.join(workDir, SEMANTIC_QUEUE_DIR);
    await mkdir(workDir, { recursive: true });
    const workload = makeWorkload();
    await writeNormalizedArtifact(workDir, workload);
    const ledger = createFileLedger({ directory: await makeTempDir("sem-ledger-") });
    const options = { privateRoot };
    const stages: AnyStage[] = [
      createAgentEnrichStage(options),
      createAgentReviewStage(options),
      createDeterministicValidateStage(options),
      createRepairLoopStage(options),
    ];
    return { privateRoot, workDir, queueDir, ledger, stages, workload };
  }

  function cardSpyStage(calls: string[]): AnyStage {
    const passthrough = { parse: (value: unknown) => value };
    return {
      name: "CARD_GENERATE",
      configVersion: "1",
      inputSchema: passthrough,
      outputSchema: passthrough,
      computeInputHash: () => "card-input",
      run: async () => {
        calls.push("CARD_GENERATE");
        return { ran: true };
      },
    } as unknown as AnyStage;
  }

  /**
   * Resolve every pending packet the way an external Codex supervisor would:
   * one fresh agent (and one fresh agent_run_id) per pending packet. Run ids
   * derive from the packet's unit + round so they stay distinct across the
   * whole queue exactly as the global run-id rule requires.
   */
  async function ingestPending(
    queueDir: string,
    workload: UnitWorkload,
    mode: "pass" | "always-repair",
  ): Promise<void> {
    for (;;) {
      const entries = await loadSemanticQueue(queueDir);
      const pending = entries.filter((entry) => entry.status === "pending");
      if (pending.length === 0) break;
      for (const entry of pending) {
        if (entry.order.role === "generation") {
          await ingestSemanticResult(
            queueDir,
            SOURCE_HASH,
            envelopeFor(entry, "run-gen", generationOutputFor(workload, entry.order.packet_id, entry.packetHash, "run-gen")),
          );
        } else if (entry.order.role === "review") {
          const packet = entry.packet as Extract<AgentWorkPacketT, { role: "review" }>;
          const runId = `run-review-${entry.order.unit_key}-r${entry.order.round}`;
          const flagged = { "explanations[0].translation_hints": { verdict: "REPAIR" as const, issueCode: "TRANSLATION_HINT_MISMATCH" } };
          const overrides = mode === "always-repair" ? flagged : {};
          await ingestSemanticResult(
            queueDir,
            SOURCE_HASH,
            envelopeFor(entry, runId, reviewOutputFor(workload, packet.generation, runId, overrides)),
          );
        } else {
          const packet = entry.packet as Extract<AgentWorkPacketT, { role: "repair" }>;
          const runId = `run-fix-${entry.order.unit_key}-r${entry.order.round}`;
          await ingestSemanticResult(
            queueDir,
            SOURCE_HASH,
            envelopeFor(entry, runId, repairOutputFor(workload, packet.review, runId, "修订")),
          );
        }
      }
    }
  }

  it("advances a fully-passed Unit through REPAIR_LOOP and only then runs CARD_GENERATE", async () => {
    const { queueDir, ledger, stages, workload } = await makeCompileFixture();
    const cardCalls: string[] = [];
    const allStages = [...stages, cardSpyStage(cardCalls)];
    let runIndex = 0;
    const runOnce = async () =>
      runPipeline(allStages, ledger, { sourceHash: SOURCE_HASH, runId: `run-${runIndex++}` });

    // Run 1: generation packets pending; nothing downstream may start.
    let report = await runOnce();
    expect(report.status).toBe("FAILED");
    expect(report.stoppedAt).toBe("AGENT_ENRICH");
    expect(report.results.find((outcome) => outcome.name === "AGENT_ENRICH")).toMatchObject({
      error_code: "SEMANTIC_PACKETS_PENDING",
    });
    expect(report.results.find((outcome) => outcome.name === "CARD_GENERATE")).toBeUndefined();
    await ingestPending(queueDir, workload, "pass");

    // Run 2: review packets pending.
    report = await runOnce();
    expect(report.stoppedAt).toBe("AGENT_REVIEW");
    expect(report.results.find((outcome) => outcome.name === "AGENT_REVIEW")).toMatchObject({
      error_code: "SEMANTIC_PACKETS_PENDING",
    });
    await ingestPending(queueDir, workload, "pass");

    // Run 3: generation + review + validation all green -> REPAIR_LOOP passes -> card.
    report = await runOnce();
    expect(report.status).toBe("COMPLETED");
    expect(cardCalls).toEqual(["CARD_GENERATE"]);
    expect(await ledger.load("REPAIR_LOOP")).toMatchObject({ status: "PASSED" });
  });

  it("blocks a Unit after three rejected repair rounds before any card/audio/package stage", async () => {
    const { queueDir, ledger, stages, workload } = await makeCompileFixture();
    const cardCalls: string[] = [];
    const allStages = [...stages, cardSpyStage(cardCalls)];

    for (let index = 0; index < 20; index += 1) {
      const report = await runPipeline(allStages, ledger, {
        sourceHash: SOURCE_HASH,
        runId: `run-block-${index}`,
      });
      await ingestPending(queueDir, workload, "always-repair");
      if (report.status === "BLOCKED") {
        expect(report.stoppedAt).toBe("REPAIR_LOOP");
        expect(report.results.find((outcome) => outcome.name === "REPAIR_LOOP")).toMatchObject({
          status: "BLOCKED",
          error_code: "UNIT_BLOCKED",
        });
        expect(cardCalls).toEqual([]);
        expect(await ledger.load("REPAIR_LOOP")).toMatchObject({ status: "BLOCKED", error_code: "UNIT_BLOCKED" });
        return;
      }
      // While agents work externally every run fails closed with pending packets.
      expect(report.status).toBe("FAILED");
    }
    throw new Error("the three-round state machine never blocked the unit");
  });
});

// ---------------------------------------------------------------------------
// CLI wiring: agents semantic packets|ingest|status + agents resume
// ---------------------------------------------------------------------------

describe("cli: agents semantic + agents resume", () => {
  function makeDeps(workRoot: string, out: string[]): CliDeps & { exitCode: number | undefined } {
    // The exit code is captured in a holder exposed through a real accessor
    // (defineProperty — Object.assign would copy the accessor's VALUE once).
    const state: { exitCode: number | undefined } = { exitCode: undefined };
    const deps: CliDeps = {
      workRoot,
      stages: getProductionStages({ privateRoot: path.join(workRoot, "private") }),
      createLedger: (sourceHash) => createFileLedger({ directory: path.join(workRoot, sourceHash, "ledger") }),
      logger: silentLogger,
      writeLine: (line) => out.push(line),
      exit: (code) => {
        state.exitCode = code;
      },
    };
    return Object.defineProperty(deps, "exitCode", {
      get: () => state.exitCode,
      enumerable: true,
    }) as CliDeps & { exitCode: number | undefined };
  }

  it("lists packets, ingests results, reports status, and resumes the pipeline", async () => {
    const workRoot = await makeTempDir("sem-cli-");
    const out: string[] = [];
    const deps = makeDeps(workRoot, out);
    const cli = buildCli(deps);
    const workDir = path.join(workRoot, SOURCE_HASH);
    await mkdir(path.join(workDir, SEMANTIC_QUEUE_DIR), { recursive: true });

    const workload = makeWorkload();
    const order = buildGenerationOrder(workload);
    await enqueueOrders(path.join(workDir, SEMANTIC_QUEUE_DIR), [order]);

    out.length = 0;
    await cli.parseAsync(["agents", "semantic", "packets", "--source-hash", SOURCE_HASH], { from: "user" });
    expect(out.join("\n")).toContain(order.order.packet_id);
    expect(out.join("\n")).toContain("pending");

    out.length = 0;
    const resultPath = path.join(workDir, "result.json");
    await writeFile(
      resultPath,
      JSON.stringify(
        envelopeFor(order, "run-gen", generationOutputFor(workload, order.order.packet_id, order.packetHash, "run-gen")),
      ),
      "utf8",
    );
    await cli.parseAsync(
      ["agents", "semantic", "ingest", "--source-hash", SOURCE_HASH, "--result", resultPath],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("ingest OK");
    expect(deps.exitCode).toBeUndefined();

    out.length = 0;
    await cli.parseAsync(["agents", "semantic", "status", "--source-hash", SOURCE_HASH], { from: "user" });
    expect(out.join("\n")).toContain("pending=0");
    expect(out.join("\n")).toContain("resolved=1");

    // agents resume runs the same resumable pipeline (first stage still fail-closed).
    out.length = 0;
    await cli.parseAsync(["agents", "resume", "--source-hash", SOURCE_HASH], { from: "user" });
    expect(out.join("\n")).toContain("SOURCE_FINGERPRINT FAILED");
    expect(deps.exitCode).toBe(1);
  });

  it("fails ingest closed on invalid results", async () => {
    const workRoot = await makeTempDir("sem-cli-bad-");
    const out: string[] = [];
    const deps = makeDeps(workRoot, out);
    const cli = buildCli(deps);
    const resultPath = path.join(workRoot, "bad-result.json");
    await writeFile(resultPath, JSON.stringify({ role: "generation" }), "utf8");

    await cli.parseAsync(
      ["agents", "semantic", "ingest", "--source-hash", SOURCE_HASH, "--result", resultPath],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("agents semantic ingest failed");
    expect(deps.exitCode).toBe(1);
  });
});
