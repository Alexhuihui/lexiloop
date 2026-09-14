/**
 * Deterministic card generation through the production pipeline (spec 5.7).
 *
 * CARD_GENERATE replaces the fail-closed placeholder: it reads only
 * schema-validated content (normalized.jsonl re-validated per row) plus the
 * review-passed generation results, derives the four card types under the
 * versioned rules in config/cards/v1.json, and writes cards.jsonl whose hash
 * anchors the downstream stages. Fail-closed guarantees under test:
 * - CARD_GENERATE only runs once every target Unit exited the four agent
 *   gates as PASSED, and its input hash covers the card config plus every
 *   validated Unit input (a config change re-runs it);
 * - a learnable word with zero cards blocks the Unit terminally
 *   (WORD_HAS_NO_CARDS) — TTS_SYNTHESIZE / RELEASE_PACKAGE can never skip or
 *   bypass card generation;
 * - reruns are byte-identical and a template-version change never re-keys a
 *   card (stable content_card_key, spec 5.7);
 * - `cards generate` reuses the exact stage handler and ledger semantics.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentGenerationOutput,
  AgentReviewOutput,
  AgentWorkPacket,
  CardDefinition,
  Example,
  Phrase,
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
import { buildCli, type CliDeps } from "../src/cli";
import { createFileLedger, type LedgerStore } from "../src/ledger";
import { silentLogger } from "../src/logging";
import { runPipeline } from "../src/pipeline";
import { SEMANTIC_QUEUE_DIR, ingestSemanticResult, loadSemanticQueue, type UnitWorkload } from "../src/agents/work-packets";
import {
  createAgentEnrichStage,
  createAgentReviewStage,
  createCardGenerateStage,
  createDeterministicValidateStage,
  createRepairLoopStage,
  getProductionStages,
} from "../src/stage-registry";
import { hashJson, type AnyStage, type StageRunContext } from "../src/stage";

// ---------------------------------------------------------------------------
// Fixtures: one Unit of strict source evidence (mirrors review-loop.test.ts
// but gives the second word a sense so every word can carry a card).
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

/** Unit `unitKey` with abandon (sense/phrase/exam example) and ability (sense). */
function makeWorkloadFor(unitKey: string, options: { abilitySense?: boolean } = {}): UnitWorkload {
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
    phonetic: "/\u0259\u02c8b\u00e6nd\u0259n/",
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
  const senses = [
    Sense.parse({
      sense_key: `${unitKey}-abandon-s1`,
      word_key: word1.word_key,
      pos: "vt",
      gloss: "放弃；抛弃",
      sense_order: 1,
      ...provenance(12, "放弃；抛弃"),
    }),
    ...(options.abilitySense ?? true
      ? [
          Sense.parse({
            sense_key: `${unitKey}-ability-s1`,
            word_key: word2.word_key,
            pos: "n",
            gloss: "能力，才能",
            sense_order: 1,
            ...provenance(12, "能力，才能"),
          }),
        ]
      : []),
  ];
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
    senses,
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

/** Deterministic generation output answering the given generation packet. */
function generationOutputFor(
  workload: UnitWorkload,
  packetId: string,
  packetHash: string,
  agentRunId: string,
): AgentGenerationOutputT {
  const words = workload.source.words;
  const explanations = words.map((word, index) => {
    const examples = workload.source.examples.filter((candidate) => candidate.word_key === word.word_key);
    // Review-confirmed confusable candidate: the first word discriminates
    // against its neighbor (verified to exist in the unit's evidence).
    const neighbor = words[index + 1];
    const discriminationCandidates =
      index === 0 && neighbor
        ? [{ against_word_key: neighbor.word_key, note: `与 ${neighbor.headword} 辨析` }]
        : [];
    return {
      explanation_key: `exp.${word.word_key}`,
      word_key: word.word_key,
      unit_key: workload.unitKey,
      syntax_notes: [`语法标注 (${word.headword})`],
      translation_hints: `翻译提示 (${word.headword})`,
      pitfalls: [`易混警示 (${word.headword})`],
      context_meanings: examples.map((example) => ({ example_key: example.example_key, gloss: "（语境中）放弃了计划" })),
      discrimination_candidates: discriminationCandidates,
      input_hash: packetHash,
      prompt_version: "semantic-v1",
      model_id: "generation-model",
      agent_run_id: agentRunId,
      generated_at: CREATED_AT,
    };
  });
  return AgentGenerationOutput.parse({
    unit_key: workload.unitKey,
    packet_id: packetId,
    input_hash: packetHash,
    prompt_version: "semantic-v1",
    model_id: "generation-model",
    agent_run_id: agentRunId,
    generated_at: CREATED_AT,
    explanations,
  });
}

/** Full-coverage PASS review of the given generation output. */
function reviewOutputFor(
  workload: UnitWorkload,
  generation: AgentGenerationOutputT,
  agentRunId: string,
): AgentReviewOutputT {
  const fieldVerdicts = generation.explanations.flatMap((_, index) =>
    EXPLANATION_FIELDS.map((field) => ({
      field_path: `explanations[${index}].${field}`,
      verdict: "PASS" as const,
      evidence: `源证据核对：${workload.source.unit.unit_key} explanations[${index}].${field}`,
    })),
  );
  return {
    review_id: `rev-${agentRunId}`,
    unit_key: workload.unitKey,
    reviewed_agent_run_id: generation.agent_run_id,
    unit_verdict: "PASS",
    field_verdicts: fieldVerdicts,
  };
}

interface EnvelopeSeeds {
  order: { role: "generation" | "review" | "repair"; packet_id: string };
  packetHash: string;
}

/** Strict result envelope for one packet (what an agent writes to disk). */
function envelopeFor(packet: EnvelopeSeeds, agentRunId: string, output: unknown) {
  return {
    role: packet.order.role,
    packet_id: packet.order.packet_id,
    packet_hash: packet.packetHash,
    source_hash: SOURCE_HASH,
    agent_run_id: agentRunId,
    model_id: "agent-model",
    created_at: CREATED_AT,
    output,
  };
}

/**
 * Resolve every pending packet the way an external Codex supervisor would:
 * one fresh agent_run_id per packet (distinct across the whole queue), PASS
 * verdicts everywhere. Results are built from the packet's own unit workload.
 */
async function ingestPending(
  queueDir: string,
  workloads: UnitWorkload | readonly UnitWorkload[],
): Promise<void> {
  const byUnit = new Map(
    (Array.isArray(workloads) ? workloads : [workloads]).map((workload) => [workload.unitKey, workload]),
  );
  for (;;) {
    const entries = await loadSemanticQueue(queueDir);
    const pending = entries.filter((entry) => entry.status === "pending");
    if (pending.length === 0) break;
    for (const entry of pending) {
      const workload = byUnit.get(entry.order.unit_key)!;
      if (entry.order.role === "generation") {
        const runId = `run-gen-${entry.order.unit_key}`;
        await ingestSemanticResult(
          queueDir,
          SOURCE_HASH,
          envelopeFor(entry, runId, generationOutputFor(workload, entry.order.packet_id, entry.packetHash, runId)),
        );
      } else {
        const packet = entry.packet as Extract<AgentWorkPacketT, { role: "review" }>;
        const runId = `run-review-${entry.order.unit_key}-r${entry.order.round}`;
        await ingestSemanticResult(
          queueDir,
          SOURCE_HASH,
          envelopeFor(entry, runId, reviewOutputFor(workload, packet.generation, runId)),
        );
      }
    }
  }
}

/** Write the normalized.jsonl artifact STRUCTURE_NORMALIZE would produce. */
async function writeNormalizedArtifact(
  workDir: string,
  workloads: UnitWorkload | readonly UnitWorkload[],
): Promise<void> {
  const list: readonly UnitWorkload[] = Array.isArray(workloads) ? workloads : [workloads];
  const rows = list.flatMap(
    ({ source: { unit, words, senses, phrases, examples } }) => [
      { entity_type: "unit" as const, ...unit },
      ...words.map((word) => ({ entity_type: "word" as const, ...word })),
      ...senses.map((sense) => ({ entity_type: "sense" as const, ...sense })),
      ...phrases.map((phrase) => ({ entity_type: "phrase" as const, ...phrase })),
      ...examples.map((example) => ({ entity_type: "example" as const, ...example })),
    ],
  );
  await writeFile(
    path.join(workDir, "normalized.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
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

/** A spy stage that records its invocation; used for TTS/release bypass checks. */
function spyStage(name: string, calls: string[]): AnyStage {
  const passthrough = { parse: (value: unknown) => value };
  return {
    name,
    configVersion: "1",
    inputSchema: passthrough,
    outputSchema: passthrough,
    computeInputHash: () => `${name}-input`,
    run: async () => {
      calls.push(name);
      return { ran: true };
    },
  } as unknown as AnyStage;
}

interface CardsFixture {
  privateRoot: string;
  workDir: string;
  queueDir: string;
  cardsConfigPath: string;
  ledger: LedgerStore;
  stages: AnyStage[];
  workload: UnitWorkload;
  workloads: UnitWorkload[];
}

/** Spec of one fixture unit (ability without a sense has zero card evidence). */
interface UnitSpec {
  unitKey: string;
  abilitySense?: boolean;
}

/** Compile fixture: normalized artifact + the four agent gates + CARD_GENERATE. */
async function makeCardsFixture(
  unitSpecs: UnitSpec[] = [{ unitKey: "u01", abilitySense: true }],
): Promise<CardsFixture> {
  const privateRoot = await makeTempDir("cards-private-");
  const workDir = path.join(privateRoot, "work", SOURCE_HASH);
  const queueDir = path.join(workDir, SEMANTIC_QUEUE_DIR);
  await mkdir(workDir, { recursive: true });
  const workloads = unitSpecs.map((spec) => makeWorkloadFor(spec.unitKey, spec));
  await writeNormalizedArtifact(workDir, workloads);
  // A private copy of the versioned rules so tests can revise it.
  const cardsConfigPath = path.join(privateRoot, "cards-v1.json");
  const repoConfig = await readFile(
    fileURLToPath(new URL("../config/cards/v1.json", import.meta.url)),
    "utf8",
  );
  await writeFile(cardsConfigPath, repoConfig, "utf8");
  const ledger = createFileLedger({ directory: await makeTempDir("cards-ledger-") });
  const options = { privateRoot, cardsConfigPath };
  const stages: AnyStage[] = [
    createAgentEnrichStage(options),
    createAgentReviewStage(options),
    createDeterministicValidateStage(options),
    createRepairLoopStage(options),
    createCardGenerateStage(options),
  ];
  return { privateRoot, workDir, queueDir, cardsConfigPath, ledger, stages, workload: workloads[0]!, workloads };
}

/** Drive the fixture to completion (two pending-packet rounds, then done). */
async function runToCards(fixture: CardsFixture, downstream: AnyStage[]): Promise<ReturnType<typeof runPipeline>> {
  const allStages = [...fixture.stages, ...downstream];
  const run = (runId: string) =>
    runPipeline(allStages, fixture.ledger, { sourceHash: SOURCE_HASH, runId });
  await run("run-0");
  await ingestPending(fixture.queueDir, fixture.workloads);
  await run("run-1");
  await ingestPending(fixture.queueDir, fixture.workloads);
  return run("run-2");
}

async function readCards(workDir: string): Promise<z.output<typeof CardDefinition>[]> {
  const raw = await readFile(path.join(workDir, "cards.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => CardDefinition.parse(JSON.parse(line)));
}

/** Run context mirroring the pipeline's upstream provenance for direct runs. */
async function fixtureLedgerContext(fixture: CardsFixture, runId: string): Promise<StageRunContext> {
  const repair = await fixture.ledger.load("REPAIR_LOOP");
  return {
    runId,
    sourceHash: SOURCE_HASH,
    config: {},
    ledger: fixture.ledger,
    logger: silentLogger,
    upstream: repair?.output_hash ? { stage: "REPAIR_LOOP", outputHash: repair.output_hash } : null,
  };
}

// ---------------------------------------------------------------------------
// Production registry integration: gates -> CARD_GENERATE -> downstream
// ---------------------------------------------------------------------------

describe("CARD_GENERATE stage (production registry)", () => {
  it("runs the registry through CARD_GENERATE before TTS_SYNTHESIZE/RELEASE_PACKAGE", async () => {
    const fixture = await makeCardsFixture();
    const ttsCalls: string[] = [];
    const releaseCalls: string[] = [];
    const report = await runToCards(fixture, [
      spyStage("TTS_SYNTHESIZE", ttsCalls),
      spyStage("RELEASE_PACKAGE", releaseCalls),
    ]);

    expect(report.status).toBe("COMPLETED");
    // Downstream stages ran, and only after CARD_GENERATE PASSED.
    expect(ttsCalls).toEqual(["TTS_SYNTHESIZE"]);
    expect(releaseCalls).toEqual(["RELEASE_PACKAGE"]);
    const cardEntry = await fixture.ledger.load("CARD_GENERATE");
    expect(cardEntry).toMatchObject({ status: "PASSED" });
    expect(cardEntry?.output_hash).toMatch(/^[0-9a-f]{64}$/);

    // The artifact holds exactly the eligible cards, in the fixed order.
    const cards = await readCards(fixture.workDir);
    expect(cards.map((card) => [card.card_type, card.word_key, card.target_entity_key])).toEqual([
      ["WORD_MEANING", "u01-abandon", "u01-abandon-s1"],
      ["WORD_MEANING", "u01-ability", "u01-ability-s1"],
      ["CONTEXT_MEANING", "u01-abandon", "u01-abandon-ex1"],
      ["PHRASE", "u01-abandon", "u01-abandon-p1"],
      ["SENSE_DISCRIMINATION", "u01-abandon", "u01-abandon"],
    ]);
  });

  it("blocks a word with zero cards terminally: TTS/RELEASE never run", async () => {
    // ability has no sense, phrase, example, or candidate: zero cards.
    const fixture = await makeCardsFixture([{ unitKey: "u01", abilitySense: false }]);
    const ttsCalls: string[] = [];
    const releaseCalls: string[] = [];
    const report = await runToCards(fixture, [
      spyStage("TTS_SYNTHESIZE", ttsCalls),
      spyStage("RELEASE_PACKAGE", releaseCalls),
    ]);

    expect(report.status).toBe("BLOCKED");
    expect(report.stoppedAt).toBe("CARD_GENERATE");
    expect(report.results.find((outcome) => outcome.name === "CARD_GENERATE")).toMatchObject({
      status: "BLOCKED",
      error_code: "WORD_HAS_NO_CARDS",
    });
    // The gates themselves passed — the block happens at card generation.
    expect(await fixture.ledger.load("REPAIR_LOOP")).toMatchObject({ status: "PASSED" });
    expect(await fixture.ledger.load("CARD_GENERATE")).toMatchObject({
      status: "BLOCKED",
      error_code: "WORD_HAS_NO_CARDS",
    });
    expect(ttsCalls).toEqual([]);
    expect(releaseCalls).toEqual([]);
  });

  it("cannot be skipped: pending agents hold TTS/RELEASE back", async () => {
    const fixture = await makeCardsFixture();
    const ttsCalls: string[] = [];
    const releaseCalls: string[] = [];
    const allStages = [...fixture.stages, spyStage("TTS_SYNTHESIZE", ttsCalls), spyStage("RELEASE_PACKAGE", releaseCalls)];

    // Round 1: generation packets pending — nothing downstream may start.
    const report = await runPipeline(allStages, fixture.ledger, { sourceHash: SOURCE_HASH, runId: "run-pending" });
    expect(report.status).toBe("FAILED");
    expect(report.stoppedAt).toBe("AGENT_ENRICH");
    expect(report.results.find((outcome) => outcome.name === "CARD_GENERATE")).toBeUndefined();
    expect(ttsCalls).toEqual([]);
    expect(releaseCalls).toEqual([]);
  });

  it("re-runs when the card config changes and keeps every content_card_key stable", async () => {
    const fixture = await makeCardsFixture();
    const ttsCalls: string[] = [];
    await runToCards(fixture, [spyStage("TTS_SYNTHESIZE", ttsCalls)]);
    const before = await fixture.ledger.load("CARD_GENERATE");
    const cardsBefore = await readCards(fixture.workDir);
    expect(ttsCalls).toEqual(["TTS_SYNTHESIZE"]);

    // Bump only the WORD_MEANING template version in the versioned rules.
    const config = JSON.parse(await readFile(fixture.cardsConfigPath, "utf8")) as {
      template_versions: Record<string, string>;
    };
    config.template_versions.WORD_MEANING = "v2";
    await writeFile(fixture.cardsConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const report = await runPipeline([...fixture.stages, spyStage("TTS_SYNTHESIZE", ttsCalls)], fixture.ledger, {
      sourceHash: SOURCE_HASH,
      runId: "run-config-change",
    });
    expect(report.status).toBe("COMPLETED");
    const after = await fixture.ledger.load("CARD_GENERATE");
    expect(after?.input_hash).not.toBe(before?.input_hash);
    // TTS re-ran after the invalidated card stage (cascade).
    expect(ttsCalls).toEqual(["TTS_SYNTHESIZE", "TTS_SYNTHESIZE"]);

    // Template version changes must NOT create new cards (spec 5.7).
    const cardsAfter = await readCards(fixture.workDir);
    expect(cardsAfter.map((card) => card.content_card_key)).toEqual(
      cardsBefore.map((card) => card.content_card_key),
    );
    const wordMeaning = cardsAfter.filter((card) => card.card_type === "WORD_MEANING");
    expect(wordMeaning.every((card) => card.template_version === "v2")).toBe(true);
    expect(
      cardsAfter
        .filter((card) => card.card_type !== "WORD_MEANING")
        .every((card) => card.template_version === "v1"),
    ).toBe(true);
  });

  it("writes byte-identical artifacts across reruns with a self-verifying hash", async () => {
    const fixture = await makeCardsFixture();
    const options = { privateRoot: fixture.privateRoot, cardsConfigPath: fixture.cardsConfigPath };
    const stage = createCardGenerateStage(options);
    // Resolve the queue so the stage sees fully-passed units.
    const seedReport = await runToCards(fixture, []);
    expect(seedReport.status).toBe("COMPLETED");

    const entry = await fixture.ledger.load("CARD_GENERATE");
    const ctx = {
      runId: "direct-1",
      sourceHash: SOURCE_HASH,
      config: {},
      ledger: fixture.ledger,
      logger: silentLogger,
      upstream: entry ? { stage: "REPAIR_LOOP", outputHash: entry.output_hash } : null,
    };
    const first = stage.outputSchema.parse(await stage.run(undefined, ctx)) as { cards_jsonl_sha256: string };
    const bytes1 = await readFile(path.join(fixture.workDir, "cards.jsonl"), "utf8");
    const second = stage.outputSchema.parse(await stage.run(undefined, ctx)) as { cards_jsonl_sha256: string };
    const bytes2 = await readFile(path.join(fixture.workDir, "cards.jsonl"), "utf8");

    expect(bytes2).toBe(bytes1);
    expect(second.cards_jsonl_sha256).toBe(first.cards_jsonl_sha256);
    expect(second.cards_jsonl_sha256).toBe(createHash("sha256").update(bytes1, "utf8").digest("hex"));
    // The recorded ledger output hash is exactly the recomputed stage output.
    expect(entry?.output_hash).toBe(hashJson(first));
  });
});

// ---------------------------------------------------------------------------
// Unit scope (spec 5.6): a release may declare a target scope of fully-passed
// units, so CARD_GENERATE can be scoped to exactly the units that will ship.
// ---------------------------------------------------------------------------

describe("CARD_GENERATE unit scope (spec 5.6)", () => {
  /** u01 is fully card-generatable; u02's ability word has zero card evidence. */
  const twoUnitSpecs: UnitSpec[] = [
    { unitKey: "u01", abilitySense: true },
    { unitKey: "u02", abilitySense: false },
  ];

  it("generates cards only for in-scope units and never assesses out-of-scope units", async () => {
    const fixture = await makeCardsFixture(twoUnitSpecs);
    // The unscoped pipeline still blocks terminally on u02's no-card word
    // (default behavior unchanged), but all four gates are PASSED by then.
    const report = await runToCards(fixture, []);
    expect(report.status).toBe("BLOCKED");
    expect(report.results.find((outcome) => outcome.name === "CARD_GENERATE")).toMatchObject({
      status: "BLOCKED",
      error_code: "WORD_HAS_NO_CARDS",
    });
    expect(await fixture.ledger.load("REPAIR_LOOP")).toMatchObject({ status: "PASSED" });

    // Scoped generation covers exactly the declared target units: u02 is out
    // of scope, produces no cards, and is never card-checked.
    const stage = createCardGenerateStage({
      privateRoot: fixture.privateRoot,
      cardsConfigPath: fixture.cardsConfigPath,
      units: ["u01"],
    });
    const output = stage.outputSchema.parse(
      await stage.run(undefined, await fixtureLedgerContext(fixture, "scoped-1")),
    ) as { units: Array<{ unit_key: string; words: number; cards: number }> };
    expect(output.units).toEqual([{ unit_key: "u01", words: 2, cards: 5 }]);
    const cards = await readCards(fixture.workDir);
    expect(cards).toHaveLength(5);
    expect(cards.every((card) => card.unit_key === "u01")).toBe(true);
  });

  it("still blocks terminally on an in-scope word with zero cards", async () => {
    const fixture = await makeCardsFixture(twoUnitSpecs);
    await runToCards(fixture, []);
    const stage = createCardGenerateStage({
      privateRoot: fixture.privateRoot,
      cardsConfigPath: fixture.cardsConfigPath,
      units: ["u02"],
    });
    await expect(stage.run(undefined, await fixtureLedgerContext(fixture, "scoped-2"))).rejects.toMatchObject({
      code: "WORD_HAS_NO_CARDS",
      blocked: true,
    });
    // The blocked run wrote nothing: no out-of-scope cards either.
    await expect(readCards(fixture.workDir)).rejects.toThrow();
  });

  it("fails closed when the declared scope names an unknown unit", async () => {
    const fixture = await makeCardsFixture();
    await runToCards(fixture, []);
    const stage = createCardGenerateStage({
      privateRoot: fixture.privateRoot,
      cardsConfigPath: fixture.cardsConfigPath,
      units: ["u01", "u-unknown"],
    });
    await expect(stage.run(undefined, await fixtureLedgerContext(fixture, "scoped-3"))).rejects.toMatchObject({
      code: "UNIT_SCOPE_UNKNOWN",
    });
  });
});

// ---------------------------------------------------------------------------
// CLI wiring: cards generate
// ---------------------------------------------------------------------------

describe("cli: cards generate", () => {
  function makeDeps(workRoot: string, out: string[]): CliDeps & { exitCode: number | undefined } {
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

  it("generates cards for fully-passed units and records the ledger entry", async () => {
    const fixture = await makeCardsFixture();
    const workRoot = await makeTempDir("cards-cli-");
    const out: string[] = [];
    const deps = makeDeps(workRoot, out);
    const cli = buildCli(deps);

    // Prime the work dir to the fully-passed state via the production stages.
    const runPrime = (runId: string) =>
      runPipeline(fixture.stages, fixture.ledger, { sourceHash: SOURCE_HASH, runId });
    await runPrime("prime-0");
    await ingestPending(fixture.queueDir, fixture.workloads);
    await runPrime("prime-1");
    await ingestPending(fixture.queueDir, fixture.workloads);
    const report = await runPrime("prime-2");
    expect(report.status).toBe("COMPLETED");
    const seeded = await fixture.ledger.load("CARD_GENERATE");
    expect(seeded).toMatchObject({ status: "PASSED" });

    out.length = 0;
    await cli.parseAsync(
      ["cards", "generate", "--source-hash", SOURCE_HASH, "--private-root", fixture.privateRoot],
      { from: "user" },
    );
    const output = out.join("\n");
    expect(output).toContain("unit u01 words=2 cards=5");
    expect(output).toContain("cards generate OK (5 card(s) across 1 unit(s))");
    expect(deps.exitCode).toBeUndefined();
    const cliLedger = deps.createLedger(SOURCE_HASH);
    const entry = await cliLedger.load("CARD_GENERATE");
    expect(entry).toMatchObject({ status: "PASSED" });
    // Same inputs, same output hash as the pipeline's own run.
    expect(entry?.output_hash).toBe(seeded?.output_hash);
  });

  it("fails closed with the stage's machine-readable code", async () => {
    const emptyPrivateRoot = await makeTempDir("cards-cli-empty-");
    const workRoot = await makeTempDir("cards-cli-bad-");
    const out: string[] = [];
    const deps = makeDeps(workRoot, out);
    const cli = buildCli(deps);

    await cli.parseAsync(
      ["cards", "generate", "--source-hash", SOURCE_HASH, "--private-root", emptyPrivateRoot],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("cards generate failed");
    expect(out.join("\n")).toContain("AGENT_INPUT_MISSING");
    expect(deps.exitCode).toBe(1);
    const entry = await deps.createLedger(SOURCE_HASH).load("CARD_GENERATE");
    expect(entry?.status ?? "PENDING").not.toBe("PASSED");
  });

  it("--units scopes generation, still blocks in scope, and the default checks every unit", async () => {
    // u01 is fully card-generatable; u02's ability word has zero card evidence
    // — the Task 19 shape: 21 passed units, one word with no card evidence.
    const fixture = await makeCardsFixture([
      { unitKey: "u01", abilitySense: true },
      { unitKey: "u02", abilitySense: false },
    ]);
    const workRoot = await makeTempDir("cards-cli-scope-");
    const out: string[] = [];
    const deps = makeDeps(workRoot, out);
    const cli = buildCli(deps);

    // Prime all four agent gates for BOTH units; the unscoped CARD_GENERATE
    // then blocks terminally on u02 (the default still checks every unit).
    const runPrime = (runId: string) =>
      runPipeline(fixture.stages, fixture.ledger, { sourceHash: SOURCE_HASH, runId });
    await runPrime("prime-0");
    await ingestPending(fixture.queueDir, fixture.workloads);
    await runPrime("prime-1");
    await ingestPending(fixture.queueDir, fixture.workloads);
    const report = await runPrime("prime-2");
    expect(report.status).toBe("BLOCKED");
    expect(report.results.find((outcome) => outcome.name === "CARD_GENERATE")).toMatchObject({
      error_code: "WORD_HAS_NO_CARDS",
    });

    // Scoped CLI run: cards for the declared target units only.
    out.length = 0;
    await cli.parseAsync(
      ["cards", "generate", "--source-hash", SOURCE_HASH, "--private-root", fixture.privateRoot, "--units", "u01"],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("unit u01 words=2 cards=5");
    expect(out.join("\n")).toContain("cards generate OK (5 card(s) across 1 unit(s))");
    expect(deps.exitCode).toBeUndefined();
    const entry = await deps.createLedger(SOURCE_HASH).load("CARD_GENERATE");
    expect(entry).toMatchObject({ status: "PASSED" });
    const cardsAfterScoped = await readFile(path.join(fixture.workDir, "cards.jsonl"), "utf8");
    expect(cardsAfterScoped).toContain("u01-abandon");
    expect(cardsAfterScoped).not.toContain("u02-");

    // An IN-SCOPE no-card word still blocks: nothing written, ledger intact.
    out.length = 0;
    await cli.parseAsync(
      ["cards", "generate", "--source-hash", SOURCE_HASH, "--private-root", fixture.privateRoot, "--units", "u02"],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("cards generate failed [WORD_HAS_NO_CARDS]");
    expect(deps.exitCode).toBe(1);
    expect(await readFile(path.join(fixture.workDir, "cards.jsonl"), "utf8")).toBe(cardsAfterScoped);
    expect(await deps.createLedger(SOURCE_HASH).load("CARD_GENERATE")).toMatchObject({ status: "PASSED" });

    // The default (no --units) still checks EVERY unit: u02 blocks it again.
    out.length = 0;
    await cli.parseAsync(
      ["cards", "generate", "--source-hash", SOURCE_HASH, "--private-root", fixture.privateRoot],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("cards generate failed [WORD_HAS_NO_CARDS]");
    expect(deps.exitCode).toBe(1);

    // Unknown scope keys fail closed with a machine-readable code.
    out.length = 0;
    await cli.parseAsync(
      ["cards", "generate", "--source-hash", SOURCE_HASH, "--private-root", fixture.privateRoot, "--units", "u-unknown"],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("cards generate failed [UNIT_SCOPE_UNKNOWN]");
    expect(deps.exitCode).toBe(1);
  });
});
