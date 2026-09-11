/**
 * Production stage registry (spec 5.2).
 *
 * Declares the 13 production stage names in exact compile order plus their
 * dependency edges. Stages land task by task: IMAGE_EXTRACT and
 * WATERMARK_CLEAN call the versioned Python media workers (spec 5.3) through
 * `src/media.ts`; LAYOUT_OCR runs the PP-StructureV3 worker and
 * STRUCTURE_NORMALIZE recovers records deterministically, gating on
 * visual-OCR review packets (spec 5.4); AGENT_ENRICH through REPAIR_LOOP run
 * the four isolated agent roles (generation, independent review,
 * deterministic validator, repair) behind the fail-closed three-round state
 * machine (spec 5.6). Every other stage is still an unimplemented, fail-closed
 * handler. The names, order, and dependencies declared here are final.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { UnitValidationReport as UnitValidationReportSchema } from "@lexiloop/content-schema";
import { hashJson, hashString, StageError, type AnyStage, type StageRunContext } from "./stage";
import {
  DEFAULT_RULE_PATH,
  MediaOutputInvalidError,
  MediaSpawnError,
  MediaStageConfigSchema,
  cleanSpawnArgs,
  createPythonRunner,
  extractSpawnArgs,
  sha256File,
  validateCleanArtifacts,
  validateExtractArtifacts,
  type SpawnPythonFn,
} from "./media";
import {
  DEFAULT_OCR_CONFIG_PATH,
  ocrJsonlHash,
  ocrSpawnArgs,
  toNormalizeInputBlocks,
  validateOcrArtifacts,
} from "./ocr-adapter";
import { assignReadingOrder } from "./normalize/reading-order";
import { LLCY_2024_NORMALIZE_CONFIG } from "./normalize/config";
import { segmentStructure, type NormalizeOutput } from "./normalize/segmentation";
import {
  VISUAL_OCR_PROMPT_VERSION,
  enqueuePackets,
  loadQueue,
  unresolvedUnitKeys,
  VISUAL_OCR_QUEUE_DIR,
} from "./agents/visual-ocr";
import {
  SEMANTIC_QUEUE_DIR,
  WorkPacketError,
  loadSemanticQueue,
  loadUnitWorkloads,
  semanticQueueDigest,
  type UnitWorkload,
  type WorkOrder,
} from "./agents/work-packets";
import { AgentDispatchPendingError } from "./agents/provider";
import { createFilesystemProvider } from "./agents/filesystem-provider";
import {
  assessUnit,
  collectUnitStates,
  ReviewLoopError,
  type UnitAssessment,
} from "./agents/review-loop";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Value type of the validation report (the schema export is value-only). */
type UnitValidationReportT = z.output<typeof UnitValidationReportSchema>;

/** Assessments whose phase hands the caller a work order to enqueue. */
type OrderBearingAssessment = Extract<UnitAssessment, { order: WorkOrder }>;

/** Assessments whose phase carries a deterministic validation report. */
type ReportedAssessment = Extract<UnitAssessment, { report: UnitValidationReportT }>;

export const PRODUCTION_STAGE_NAMES = [
  "SOURCE_FINGERPRINT",
  "IMAGE_EXTRACT",
  "WATERMARK_CLEAN",
  "LAYOUT_OCR",
  "STRUCTURE_NORMALIZE",
  "AGENT_ENRICH",
  "AGENT_REVIEW",
  "DETERMINISTIC_VALIDATE",
  "REPAIR_LOOP",
  "CARD_GENERATE",
  "TTS_SYNTHESIZE",
  "AUDIO_VALIDATE",
  "RELEASE_PACKAGE",
] as const;

export type ProductionStageName = (typeof PRODUCTION_STAGE_NAMES)[number];

/** Dependency edges: each stage depends on its immediate predecessor. */
export const PRODUCTION_STAGE_DEPENDENCIES: Readonly<
  Record<ProductionStageName, readonly ProductionStageName[]>
> = {
  SOURCE_FINGERPRINT: [],
  IMAGE_EXTRACT: ["SOURCE_FINGERPRINT"],
  WATERMARK_CLEAN: ["IMAGE_EXTRACT"],
  LAYOUT_OCR: ["WATERMARK_CLEAN"],
  STRUCTURE_NORMALIZE: ["LAYOUT_OCR"],
  AGENT_ENRICH: ["STRUCTURE_NORMALIZE"],
  AGENT_REVIEW: ["AGENT_ENRICH"],
  DETERMINISTIC_VALIDATE: ["AGENT_REVIEW"],
  REPAIR_LOOP: ["DETERMINISTIC_VALIDATE"],
  CARD_GENERATE: ["REPAIR_LOOP"],
  TTS_SYNTHESIZE: ["CARD_GENERATE"],
  AUDIO_VALIDATE: ["TTS_SYNTHESIZE"],
  RELEASE_PACKAGE: ["AUDIO_VALIDATE"],
};

/** The final stage, guarded so it only runs when all predecessors PASSED. */
export const RELEASE_STAGE: ProductionStageName = "RELEASE_PACKAGE";

/** Default private root (git-ignored); artifacts live under `<root>/work/`. */
export const DEFAULT_PRIVATE_ROOT = ".lexiloop-private";

/**
 * Placeholder handler used until the real stage lands. Fails closed with a
 * non-retryable error so an accidental run can never produce content.
 */
function unimplementedStage(name: ProductionStageName): AnyStage {
  const configVersion = "0-unimplemented";
  return {
    name,
    configVersion,
    inputSchema: z.unknown(),
    outputSchema: z.never(),
    computeInputHash: () => hashString(`${name}:${configVersion}`),
    run: async () => {
      throw new StageError(
        "STAGE_NOT_IMPLEMENTED",
        `Stage ${name} has no handler yet (planned for Phase 2 tasks 5-10)`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Media stage outputs (spec 5.3)
// ---------------------------------------------------------------------------

export const ImageExtractOutputSchema = z.object({
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Relative to the per-source work directory. */
  pages_jsonl: z.literal("pages.jsonl"),
  pages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        method: z.enum(["embedded", "rendered"]),
        width_px: z.number().int().positive(),
        height_px: z.number().int().positive(),
        image_sha256: z.string().regex(/^[0-9a-f]{64}$/),
      }),
    )
    .min(1),
});
export type ImageExtractOutput = z.output<typeof ImageExtractOutputSchema>;

export const WatermarkCleanOutputSchema = z.object({
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  rule_version: z.number().int().positive(),
  /** Relative to the per-source work directory. */
  clean_jsonl: z.literal("clean.jsonl"),
  pages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        cleaned_image_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        mask_bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
        region_names: z.array(z.string()),
        changed_pixels: z.number().int().nonnegative(),
        body_overlap_detected: z.boolean(),
      }),
    )
    .min(1),
  /** Pages whose watermark region overlaps body ink; they route to repair. */
  body_overlap_pages: z.array(z.number().int().positive()),
});
export type WatermarkCleanOutput = z.output<typeof WatermarkCleanOutputSchema>;

export interface MediaStageOptions {
  /**
   * Private root holding per-source work directories. Artifacts live under
   * `<private-root>/work/<source-hash>/` and stay out of git.
   */
  privateRoot: string;
  /**
   * Python runner (argument-array spawn). REQUIRED so a media stage can
   * never silently "pass" by validating stale artifacts without actually
   * running the worker; production wiring resolves a real runner via
   * `resolveMediaStageOptions`, tests inject stubs.
   */
  runPython: SpawnPythonFn;
  /** Watermark rule for WATERMARK_CLEAN. */
  rulePath?: string;
  /** Versioned PP-StructureV3 config for LAYOUT_OCR. */
  ocrConfigPath?: string;
}

/** Fill defaults for optional media wiring; the runner is never optional. */
export function resolveMediaStageOptions(
  options: { privateRoot?: string; runPython?: SpawnPythonFn; rulePath?: string; ocrConfigPath?: string } = {},
): MediaStageOptions {
  return {
    privateRoot: options.privateRoot ?? DEFAULT_PRIVATE_ROOT,
    runPython: options.runPython ?? createPythonRunner(),
    ...(options.rulePath !== undefined ? { rulePath: options.rulePath } : {}),
    ...(options.ocrConfigPath !== undefined ? { ocrConfigPath: options.ocrConfigPath } : {}),
  };
}

function mediaConfig(ctx: StageRunContext): { sourcePath: string; pages: number[]; dpi: number } {
  const parsed = MediaStageConfigSchema.safeParse(ctx.config.media);
  if (!parsed.success) {
    throw new StageError(
      "MEDIA_CONFIG_INVALID",
      `stage requires run config media {sourcePath, pages, dpi}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function workDirectoryFor(privateRoot: string, sourceHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(sourceHash)) {
    throw new StageError("MEDIA_CONFIG_INVALID", `sourceHash must be a sha-256 hex string`);
  }
  return path.join(path.resolve(privateRoot), "work", sourceHash);
}

function toSpawnError(err: unknown): StageError {
  if (err instanceof StageError) return err;
  if (err instanceof MediaOutputInvalidError) {
    return new StageError("MEDIA_OUTPUT_INVALID", err.message);
  }
  // MediaSpawnError carries the worker's stable error code (parsed from the
  // worker's JSON stderr line, e.g. RULE_NOT_FOUND, MEDIA_TIMEOUT).
  if (err instanceof MediaSpawnError) {
    return new StageError(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new StageError("STAGE_UNEXPECTED_ERROR", message);
}

/**
 * IMAGE_EXTRACT: pulls each requested page's dominant embedded image
 * (verbatim stream bytes, no re-encoding) or renders it once at the
 * configured DPI, then validates `pages.jsonl` and the image hashes before
 * the pipeline may advance.
 */
export function createImageExtractStage(options: MediaStageOptions): AnyStage {
  const { runPython } = options;
  const configVersion = "1";
  return {
    name: "IMAGE_EXTRACT",
    configVersion,
    inputSchema: z.unknown(),
    outputSchema: ImageExtractOutputSchema,
    computeInputHash: (ctx) =>
      hashJson({
        stage: "IMAGE_EXTRACT",
        configVersion,
        sourceHash: ctx.sourceHash,
        media: ctx.config.media ?? null,
        upstream: ctx.upstream?.outputHash ?? null,
      }),
    run: async (_input, ctx) => {
      try {
        const media = mediaConfig(ctx);
        const workDir = workDirectoryFor(options.privateRoot, ctx.sourceHash);
        await runPython(extractSpawnArgs(media, workDir));
        const records = await validateExtractArtifacts(workDir, ctx.sourceHash, media.pages);
        return {
          source_sha256: ctx.sourceHash,
          pages_jsonl: "pages.jsonl",
          pages: records.map((record) => ({
            page: record.page,
            method: record.method,
            width_px: record.width_px,
            height_px: record.height_px,
            image_sha256: record.image_sha256,
          })),
        } satisfies ImageExtractOutput;
      } catch (err) {
        throw toSpawnError(err);
      }
    },
  };
}

/**
 * WATERMARK_CLEAN: applies the versioned watermark rule strictly inside the
 * declared masks (background/selective fill), asserts changed pixels stay
 * confined to the masks, and validates `clean.jsonl` before advancing.
 * Pages flagged `body_overlap_detected` do not pass silently: they are
 * reported in `body_overlap_pages` for the agent repair loop (spec 5.3).
 */
export function createWatermarkCleanStage(options: MediaStageOptions): AnyStage {
  const { runPython } = options;
  const rulePath = options.rulePath ?? DEFAULT_RULE_PATH;
  const configVersion = "1";
  return {
    name: "WATERMARK_CLEAN",
    configVersion,
    inputSchema: z.unknown(),
    outputSchema: WatermarkCleanOutputSchema,
    computeInputHash: async (ctx) =>
      hashJson({
        stage: "WATERMARK_CLEAN",
        configVersion,
        sourceHash: ctx.sourceHash,
        media: ctx.config.media ?? null,
        rule_sha256: await sha256File(rulePath),
        upstream: ctx.upstream?.outputHash ?? null,
      }),
    run: async (_input, ctx) => {
      try {
        const media = mediaConfig(ctx);
        const workDir = workDirectoryFor(options.privateRoot, ctx.sourceHash);
        await runPython(cleanSpawnArgs(rulePath, workDir));
        const records = await validateCleanArtifacts(workDir, ctx.sourceHash, media.pages);
        const bodyOverlapPages: number[] = [];
        for (const record of records) {
          if (record.body_overlap_detected) bodyOverlapPages.push(record.page);
        }
        return {
          source_sha256: ctx.sourceHash,
          rule_version: records[0]!.rule_version,
          clean_jsonl: "clean.jsonl",
          pages: records.map((record) => ({
            page: record.page,
            cleaned_image_sha256: record.cleaned_image_sha256,
            mask_bounds: record.mask_bounds,
            region_names: record.region_names,
            changed_pixels: record.changed_pixels,
            body_overlap_detected: record.body_overlap_detected,
          })),
          body_overlap_pages: bodyOverlapPages,
        } satisfies WatermarkCleanOutput;
      } catch (err) {
        throw toSpawnError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Layout OCR + structure normalization stages (spec 5.4)
// ---------------------------------------------------------------------------

export const LayoutOcrOutputSchema = z.object({
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Relative to the per-source work directory. */
  ocr_jsonl: z.literal("ocr.jsonl"),
  /** SHA-256 of the validated OCR JSONL artifact. */
  ocr_jsonl_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pipeline: z.string().min(1),
  pipeline_version: z.string().min(1),
  model_version: z.string().min(1),
  config_version: z.number().int().positive(),
  block_count: z.number().int().nonnegative(),
  pages: z
    .array(
      z.object({
        page: z.number().int().positive(),
        block_count: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});
export type LayoutOcrOutput = z.output<typeof LayoutOcrOutputSchema>;

export const NormalizedEntityRowSchema = z.looseObject({
  entity_type: z.enum(["book", "unit", "word", "sense", "phrase", "example"]),
});
export type NormalizedEntityRow = z.output<typeof NormalizedEntityRowSchema>;

export const StructureNormalizeOutputSchema = z.object({
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Relative to the per-source work directory. */
  normalized_jsonl: z.literal("normalized.jsonl"),
  /** SHA-256 of the written entity rows (provenance-bearing records). */
  normalized_jsonl_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  counts: z.object({
    units: z.number().int().nonnegative(),
    words: z.number().int().nonnegative(),
    senses: z.number().int().nonnegative(),
    phrases: z.number().int().nonnegative(),
    examples: z.number().int().nonnegative(),
  }),
  unit_boundaries: z.array(
    z.object({
      unit_key: z.string().min(1),
      unit_order: z.number().int().positive(),
      title: z.string().min(1),
      first_page: z.number().int().positive(),
      last_page: z.number().int().positive(),
    }),
  ),
  /** Packets resolved by visual-agent decisions folded into this run. */
  resolved_packets: z.number().int().nonnegative(),
});
export type StructureNormalizeOutput = z.output<typeof StructureNormalizeOutputSchema>;

/**
 * LAYOUT_OCR: runs the versioned PP-StructureV3 worker over every cleaned
 * page image, then validates `ocr.jsonl` — schema, source/page-image hash
 * chain, and the private raw-text evidence — before the ledger may advance.
 */
export function createLayoutOcrStage(options: MediaStageOptions): AnyStage {
  const { runPython } = options;
  const ocrConfigPath = options.ocrConfigPath ?? DEFAULT_OCR_CONFIG_PATH;
  const configVersion = "1";
  return {
    name: "LAYOUT_OCR",
    configVersion,
    inputSchema: z.unknown(),
    outputSchema: LayoutOcrOutputSchema,
    computeInputHash: async (ctx) =>
      hashJson({
        stage: "LAYOUT_OCR",
        configVersion,
        sourceHash: ctx.sourceHash,
        media: ctx.config.media ?? null,
        ocr_config_sha256: await sha256File(ocrConfigPath),
        upstream: ctx.upstream?.outputHash ?? null,
      }),
    run: async (_input, ctx) => {
      try {
        const media = mediaConfig(ctx);
        const workDir = workDirectoryFor(options.privateRoot, ctx.sourceHash);
        await runPython(ocrSpawnArgs(ocrConfigPath, workDir));
        // The OCR chain is anchored in the cleaned pages: validate both.
        const cleanRecords = await validateCleanArtifacts(workDir, ctx.sourceHash, media.pages);
        const records = await validateOcrArtifacts(workDir, ctx.sourceHash, cleanRecords);
        const blockCounts = new Map<number, number>();
        for (const record of records) {
          blockCounts.set(record.page, (blockCounts.get(record.page) ?? 0) + 1);
        }
        const first = records[0]!;
        return {
          source_sha256: ctx.sourceHash,
          ocr_jsonl: "ocr.jsonl",
          ocr_jsonl_sha256: await ocrJsonlHash(workDir),
          pipeline: first.pipeline,
          pipeline_version: first.pipeline_version,
          model_version: first.model_version,
          config_version: first.config_version,
          block_count: records.length,
          pages: [...blockCounts.entries()]
            .sort(([a], [b]) => a - b)
            .map(([page, blockCount]) => ({ page, block_count: blockCount })),
        } satisfies LayoutOcrOutput;
      } catch (err) {
        throw toSpawnError(err);
      }
    },
  };
}

/** Build the strict packet for one field review (spec 5.4/5.6). */
function packetForReview(review: NormalizeOutput["fieldReviews"][number]) {
  return {
    role: "visual_ocr" as const,
    packet_id: review.packet_id,
    unit_key: review.unit_key,
    prompt_version: VISUAL_OCR_PROMPT_VERSION,
    round: review.round,
    field: review.field,
    page_number: review.page_number,
    page_image_sha256: review.page_image_sha256,
    bbox: review.bbox,
    current_text: review.current_text,
    ocr_confidence: review.ocr_confidence,
    evidence_codes: review.evidence_codes,
  };
}

/**
 * STRUCTURE_NORMALIZE: recovers book/Unit/word/sense/phrase/example records
 * from the validated OCR blocks. Three fail-closed gates guard the artifact:
 * word entries referencing a unit with no matched banner fail the stage
 * BLOCKED (DANGLING_UNIT_REFERENCE); critical fields that fail deterministic
 * acceptance become visual-OCR packets and fail the stage with
 * VISUAL_PACKETS_PENDING until every packet is resolved; a field that
 * exhausts its repair budget (or is BLOCKed) fails the stage BLOCKED —
 * no path can be bypassed by any flag.
 */
export function createStructureNormalizeStage(options: MediaStageOptions): AnyStage {
  const configVersion = "1";
  return {
    name: "STRUCTURE_NORMALIZE",
    configVersion,
    inputSchema: z.unknown(),
    outputSchema: StructureNormalizeOutputSchema,
    computeInputHash: (ctx) =>
      hashJson({
        stage: "STRUCTURE_NORMALIZE",
        configVersion,
        sourceHash: ctx.sourceHash,
        media: ctx.config.media ?? null,
        normalize_config: LLCY_2024_NORMALIZE_CONFIG,
        upstream: ctx.upstream?.outputHash ?? null,
      }),
    run: async (_input, ctx) => {
      try {
        const media = mediaConfig(ctx);
        const workDir = workDirectoryFor(options.privateRoot, ctx.sourceHash);
        const cleanRecords = await validateCleanArtifacts(workDir, ctx.sourceHash, media.pages);
        const records = await validateOcrArtifacts(workDir, ctx.sourceHash, cleanRecords);
        const blocks = assignReadingOrder(toNormalizeInputBlocks(records));

        // Fold resolved visual decisions (separate provenance records) in.
        const queueDir = path.join(workDir, VISUAL_OCR_QUEUE_DIR);
        const entries = await loadQueue(queueDir);
        const corrections = entries
          .filter((entry) => entry.status === "resolved" && entry.result !== undefined)
          .map((entry) => ({
            packet_id: entry.result!.packet_id,
            verdict: entry.result!.verdict,
            ...(entry.result!.corrected_text !== undefined
              ? { corrected_text: entry.result!.corrected_text }
              : {}),
            agent_run_id: entry.result!.agent_run_id,
            round: entry.packet.round,
          }));

        const normalized = segmentStructure(blocks, LLCY_2024_NORMALIZE_CONFIG, corrections);

        // Fail closed on a structurally invalid book: word entries recovered
        // before any unit banner matched would reference a synthetic unit that
        // has no Unit record. Never emit dangling word/unit references — unit
        // detection must be calibrated, not bypassed.
        const knownUnits = new Set(normalized.units.map((unit) => unit.unit_key));
        const danglingUnits = [
          ...new Set(normalized.words.map((word) => word.unit_key)),
        ].filter((unitKey) => !knownUnits.has(unitKey));
        if (danglingUnits.length > 0) {
          const danglingWords = normalized.words.filter((word) =>
            danglingUnits.includes(word.unit_key),
          );
          const first = danglingWords[0]!;
          throw new StageError(
            "DANGLING_UNIT_REFERENCE",
            `${danglingWords.length} word(s) reference unit(s) with no matched banner ` +
              `[${danglingUnits.join(",")}] (first: "${first.headword}" on page ` +
              `${first.page_number}); calibrate unit_title_patterns instead of emitting a ` +
              `book with dangling references`,
            { blocked: true },
          );
        }

        if (normalized.blockedFields.length > 0) {
          // Terminal: a BLOCKED unit must never reach the release stage.
          throw new StageError(
            "VISUAL_FIELD_BLOCKED",
            `${normalized.blockedFields.length} critical field(s) exhausted visual review ` +
              `(units: ${[...new Set(normalized.blockedFields.map((f) => f.unit_key))].join(",")})`,
            { blocked: true },
          );
        }
        if (normalized.fieldReviews.length > 0) {
          await enqueuePackets(queueDir, normalized.fieldReviews.map(packetForReview));
          const pending = await loadQueue(queueDir);
          const units = unresolvedUnitKeys(pending);
          throw new StageError(
            "VISUAL_PACKETS_PENDING",
            `${normalized.fieldReviews.length} critical field(s) await visual review; ` +
              `${pending.filter((entry) => entry.status === "pending").length} packet(s) pending` +
              (units.length > 0 ? ` (blocking units: ${units.join(",")})` : ""),
          );
        }

        const rows: NormalizedEntityRow[] = [
          { entity_type: "book", ...normalized.book },
          ...normalized.units.map((unit) => ({ entity_type: "unit" as const, ...unit })),
          ...normalized.words.map((word) => ({ entity_type: "word" as const, ...word })),
          ...normalized.senses.map((sense) => ({ entity_type: "sense" as const, ...sense })),
          ...normalized.phrases.map((phrase) => ({ entity_type: "phrase" as const, ...phrase })),
          ...normalized.examples.map((example) => ({
            entity_type: "example" as const,
            ...example,
          })),
        ];
        const normalizedJsonlPath = path.join(workDir, "normalized.jsonl");
        await mkdir(path.dirname(normalizedJsonlPath), { recursive: true });
        await writeFile(
          normalizedJsonlPath,
          rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
          "utf8",
        );
        return {
          source_sha256: ctx.sourceHash,
          normalized_jsonl: "normalized.jsonl",
          normalized_jsonl_sha256: await sha256File(normalizedJsonlPath),
          counts: {
            units: normalized.units.length,
            words: normalized.words.length,
            senses: normalized.senses.length,
            phrases: normalized.phrases.length,
            examples: normalized.examples.length,
          },
          unit_boundaries: normalized.unitBoundaries,
          resolved_packets: corrections.length,
        } satisfies StructureNormalizeOutput;
      } catch (err) {
        throw toSpawnError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Semantic agent gates (spec 5.6): AGENT_ENRICH -> AGENT_REVIEW ->
// DETERMINISTIC_VALIDATE -> REPAIR_LOOP
//
// Four isolated roles run behind one fail-closed state machine per Unit:
// generation, independent review (which reads only source evidence, the
// generated result, and the schema), deterministic validation, and repair
// (only reviewer-flagged issues, mapped per issue code). Each stage owns one
// packet boundary: it enqueues the packets its phase needs, then fails with
// SEMANTIC_PACKETS_PENDING until externally-dispatched agents have answered
// (filesystem provider; no LLM key lives in this application). After at most
// three repair rounds a fourth repair is impossible and the whole Unit
// becomes BLOCKED — there is no flag, CLI command, or DB update that clears
// it, so CARD_GENERATE can only run when every target Unit exited all four
// gates as PASSED.
// ---------------------------------------------------------------------------

/** Options for the semantic agent gate stages. */
export interface AgentGateOptions {
  /** Private root holding per-source work directories. */
  privateRoot: string;
  /** Versioned forbidden-term list for the deterministic validator. */
  forbiddenTerms?: readonly string[];
}

export const AgentGateOutputSchema = z.object({
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Exit phase of every target Unit for this gate (assessUnit phases). */
  units: z
    .array(
      z.object({
        unit_key: z.string().min(1),
        phase: z.string().min(1),
      }),
    )
    .min(1),
});
export type AgentGateOutput = z.output<typeof AgentGateOutputSchema>;

const AGENT_GATE_CONFIG_VERSION = "1";

interface AgentGatePaths {
  workDir: string;
  queueDir: string;
}

function agentGatePaths(options: AgentGateOptions, sourceHash: string): AgentGatePaths {
  const workDir = workDirectoryFor(options.privateRoot, sourceHash);
  return { workDir, queueDir: path.join(workDir, SEMANTIC_QUEUE_DIR) };
}

/** Reassess every target Unit from the current queue state (pure, per run). */
async function assessTargetUnits(
  gate: AgentGatePaths,
  options: AgentGateOptions,
  ctx: StageRunContext,
): Promise<Array<{ workload: UnitWorkload; assessment: UnitAssessment }>> {
  const workloads = await loadUnitWorkloads(gate.workDir);
  const entries = await loadSemanticQueue(gate.queueDir);
  const states = collectUnitStates(
    entries,
    workloads.map((workload) => workload.unitKey),
  );
  return workloads.map((workload) => ({
    workload,
    assessment: assessUnit(workload, states.get(workload.unitKey)!, {
      compileRunId: ctx.runId,
      ...(options.forbiddenTerms !== undefined ? { forbiddenTerms: options.forbiddenTerms } : {}),
    }),
  }));
}

function unitKeysOf(
  assessed: ReadonlyArray<{ workload: UnitWorkload }>,
): string {
  return assessed.map(({ workload }) => workload.unitKey).join(",");
}

/** Map agent-module errors onto StageError so codes survive the ledger. */
function toAgentStageError(err: unknown): StageError {
  if (err instanceof StageError) return err;
  if (err instanceof WorkPacketError || err instanceof ReviewLoopError) {
    return new StageError(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new StageError("STAGE_UNEXPECTED_ERROR", message);
}

/** Atomic JSON write (temp file in the same directory, renamed over). */
async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${randomBytes(6).toString("hex")}`,
  );
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath);
}

/**
 * Hand every awaiting Unit's work order to the filesystem provider — the one
 * dispatch seam, shared with the runbook's supervisor flow: dispatch means
 * "enqueue the packet, then fail with AgentDispatchPendingError until the
 * externally-dispatched agent's result has been ingested". All pending
 * packets are enqueued before the stage fails closed with their resume
 * instructions.
 */
async function dispatchWorkOrders(
  provider: ReturnType<typeof createFilesystemProvider>,
  awaiting: ReadonlyArray<{ workload: UnitWorkload; assessment: OrderBearingAssessment }>,
): Promise<never> {
  const pending: string[] = [];
  for (const { assessment } of awaiting) {
    try {
      await provider.dispatch(assessment.order);
    } catch (err) {
      if (err instanceof AgentDispatchPendingError) {
        pending.push(err.message);
        continue;
      }
      throw err;
    }
  }
  // An awaiting assessment never has a stored result, so a resolved dispatch
  // here would mean the queue changed mid-run; fail closed regardless.
  throw new StageError(
    "SEMANTIC_PACKETS_PENDING",
    pending.length > 0
      ? pending.join("; ")
      : `packet ${awaiting[0]?.assessment.order.order.packet_id ?? "?"} awaits an external agent`,
  );
}

/**
 * AGENT_ENRICH / AGENT_REVIEW: drive one packet boundary per Unit — the
 * generation packets, then the review packet answering the unit's current
 * generation run. Both enqueue what their phase needs and then fail closed
 * with SEMANTIC_PACKETS_PENDING until the dispatched agents' results have
 * been ingested; both pass once no target Unit awaits their phase.
 */
function createAgentPacketStage(
  name: "AGENT_ENRICH" | "AGENT_REVIEW",
  options: AgentGateOptions,
): AnyStage {
  const phase = name === "AGENT_ENRICH" ? "awaiting_generation" : "awaiting_review";
  return {
    name,
    configVersion: AGENT_GATE_CONFIG_VERSION,
    inputSchema: z.unknown(),
    outputSchema: AgentGateOutputSchema,
    // The queue digest folds every packet and result into the input hash, so
    // an ingested agent result invalidates the gate and the pipeline
    // naturally re-runs it on the next invocation.
    computeInputHash: async (ctx) => {
      const gate = agentGatePaths(options, ctx.sourceHash);
      return hashJson({
        stage: name,
        configVersion: AGENT_GATE_CONFIG_VERSION,
        sourceHash: ctx.sourceHash,
        queue: await semanticQueueDigest(gate.queueDir),
        forbidden_terms: options.forbiddenTerms ? hashJson(options.forbiddenTerms) : null,
        upstream: ctx.upstream?.outputHash ?? null,
      });
    },
    run: async (_input, ctx) => {
      try {
        const gate = agentGatePaths(options, ctx.sourceHash);
        const assessed = await assessTargetUnits(gate, options, ctx);
        const awaiting = assessed.filter(
          (entry): entry is { workload: UnitWorkload; assessment: OrderBearingAssessment } =>
            entry.assessment.phase === phase,
        );
        if (awaiting.length > 0) {
          const provider = createFilesystemProvider({ queueDir: gate.queueDir, sourceHash: ctx.sourceHash });
          await dispatchWorkOrders(provider, awaiting);
        }
        return {
          source_sha256: ctx.sourceHash,
          units: assessed.map(({ workload, assessment }) => ({
            unit_key: workload.unitKey,
            phase: assessment.phase,
          })),
        } satisfies AgentGateOutput;
      } catch (err) {
        throw toAgentStageError(err);
      }
    },
  };
}

export function createAgentEnrichStage(options: AgentGateOptions): AnyStage {
  return createAgentPacketStage("AGENT_ENRICH", options);
}

export function createAgentReviewStage(options: AgentGateOptions): AnyStage {
  return createAgentPacketStage("AGENT_REVIEW", options);
}

/**
 * DETERMINISTIC_VALIDATE: mechanically checks schema, enums, lengths,
 * coverage, foreign keys, stable keys, cited provenance, source-field
 * immutability, forbidden terms, and cross-field consistency for every
 * target Unit, persisting the per-unit reports under
 * `<work-dir>/validation/`. A Unit whose ERROR findings attach to fields no
 * reviewer flagged is blocked here and now: the repair protocol can never
 * address them (agents repair only reviewer-flagged issues).
 */
export function createDeterministicValidateStage(options: AgentGateOptions): AnyStage {
  return {
    name: "DETERMINISTIC_VALIDATE",
    configVersion: AGENT_GATE_CONFIG_VERSION,
    inputSchema: z.unknown(),
    outputSchema: AgentGateOutputSchema,
    computeInputHash: async (ctx) => {
      const gate = agentGatePaths(options, ctx.sourceHash);
      return hashJson({
        stage: "DETERMINISTIC_VALIDATE",
        configVersion: AGENT_GATE_CONFIG_VERSION,
        sourceHash: ctx.sourceHash,
        queue: await semanticQueueDigest(gate.queueDir),
        forbidden_terms: options.forbiddenTerms ? hashJson(options.forbiddenTerms) : null,
        upstream: ctx.upstream?.outputHash ?? null,
      });
    },
    run: async (_input, ctx) => {
      try {
        const gate = agentGatePaths(options, ctx.sourceHash);
        const assessed = await assessTargetUnits(gate, options, ctx);
        const validated: Array<{ workload: UnitWorkload; assessment: ReportedAssessment }> = [];
        for (const entry of assessed) {
          if (!("report" in entry.assessment)) {
            throw new StageError(
              "SEMANTIC_STATE_INVALID",
              `unit ${entry.workload.unitKey} has no deterministic validation report ` +
                `(phase ${entry.assessment.phase}); generation and review results must resolve first`,
            );
          }
          validated.push({ workload: entry.workload, assessment: entry.assessment });
        }
        for (const { workload, assessment } of validated) {
          await writeJsonAtomic(
            path.join(gate.workDir, "validation", `${workload.unitKey}.json`),
            assessment.report,
          );
        }
        const unrepairable = validated.filter(
          ({ assessment }) =>
            assessment.phase === "blocked" && assessment.reason === "UNREPAIRABLE_VALIDATION",
        );
        if (unrepairable.length > 0) {
          throw new StageError(
            "UNIT_BLOCKED",
            `deterministic validation failed on field(s) no reviewer flagged for unit(s) ` +
              `${unitKeysOf(unrepairable)}; the repair protocol only addresses reviewer-flagged issues`,
            { blocked: true },
          );
        }
        return {
          source_sha256: ctx.sourceHash,
          units: validated.map(({ workload, assessment }) => ({
            unit_key: workload.unitKey,
            phase: assessment.phase,
          })),
        } satisfies AgentGateOutput;
      } catch (err) {
        throw toAgentStageError(err);
      }
    },
  };
}

/**
 * REPAIR_LOOP: drives the repair protocol — enqueue one repair packet per
 * flagged Unit (whose mapping must cover exactly the flagged issues), fail
 * closed while agents work, and terminate any Unit that exhausts the budget:
 * one initial generation/review plus at most three repair-agent + fresh-review
 * cycles, then a fourth repair is impossible and the whole Unit becomes
 * BLOCKED. The stage (and therefore CARD_GENERATE and everything after it)
 * only passes when every target Unit exited the gates as PASSED.
 */
export function createRepairLoopStage(options: AgentGateOptions): AnyStage {
  return {
    name: "REPAIR_LOOP",
    configVersion: AGENT_GATE_CONFIG_VERSION,
    inputSchema: z.unknown(),
    outputSchema: AgentGateOutputSchema,
    computeInputHash: async (ctx) => {
      const gate = agentGatePaths(options, ctx.sourceHash);
      return hashJson({
        stage: "REPAIR_LOOP",
        configVersion: AGENT_GATE_CONFIG_VERSION,
        sourceHash: ctx.sourceHash,
        queue: await semanticQueueDigest(gate.queueDir),
        forbidden_terms: options.forbiddenTerms ? hashJson(options.forbiddenTerms) : null,
        upstream: ctx.upstream?.outputHash ?? null,
      });
    },
    run: async (_input, ctx) => {
      try {
        const gate = agentGatePaths(options, ctx.sourceHash);
        const assessed = await assessTargetUnits(gate, options, ctx);
        const awaiting = assessed.filter(
          (entry): entry is { workload: UnitWorkload; assessment: OrderBearingAssessment } =>
            entry.assessment.phase === "awaiting_repair",
        );
        if (awaiting.length > 0) {
          const provider = createFilesystemProvider({ queueDir: gate.queueDir, sourceHash: ctx.sourceHash });
          await dispatchWorkOrders(provider, awaiting);
        }
        const blocked = assessed.filter(({ assessment }) => assessment.phase === "blocked");
        if (blocked.length > 0) {
          const reasons = blocked
            .map(({ assessment }) => (assessment.phase === "blocked" ? assessment.reason : ""))
            .join(",");
          throw new StageError(
            "UNIT_BLOCKED",
            `unit(s) ${unitKeysOf(blocked)} exhausted the agent review gates (${reasons}); ` +
              "a BLOCKED unit can never reach card, audio, or package stages and no flag clears it",
            { blocked: true },
          );
        }
        const notPassed = assessed.filter(({ assessment }) => assessment.phase !== "passed");
        if (notPassed.length > 0) {
          throw new StageError(
            "SEMANTIC_STATE_INVALID",
            `unit(s) ${unitKeysOf(notPassed)} did not exit the review loop as PASSED ` +
              `(${notPassed.map(({ assessment }) => assessment.phase).join(",")})`,
          );
        }
        return {
          source_sha256: ctx.sourceHash,
          units: assessed.map(({ workload }) => ({ unit_key: workload.unitKey, phase: "passed" })),
        } satisfies AgentGateOutput;
      } catch (err) {
        throw toAgentStageError(err);
      }
    },
  };
}

/**
 * The 13 production stages in compile order. SOURCE_FINGERPRINT,
 * CARD_GENERATE, TTS_SYNTHESIZE, AUDIO_VALIDATE, and RELEASE_PACKAGE are
 * still fail-closed placeholders; the four semantic agent gates are wired to
 * the filesystem provider queue, so they fail closed with
 * SEMANTIC_PACKETS_PENDING until externally-dispatched agents answer.
 */
export function getProductionStages(
  options: { privateRoot?: string; runPython?: SpawnPythonFn; rulePath?: string; ocrConfigPath?: string } = {},
): AnyStage[] {
  // resolveMediaStageOptions always provides a real argument-array runner,
  // so production wiring can never construct media stages that would
  // "validate" stale artifacts without spawning the worker.
  const mediaOptions: MediaStageOptions = resolveMediaStageOptions(options);
  const agentGateOptions: AgentGateOptions = { privateRoot: mediaOptions.privateRoot };
  const stages: Partial<Record<ProductionStageName, AnyStage>> = {
    IMAGE_EXTRACT: createImageExtractStage(mediaOptions),
    WATERMARK_CLEAN: createWatermarkCleanStage(mediaOptions),
    LAYOUT_OCR: createLayoutOcrStage(mediaOptions),
    STRUCTURE_NORMALIZE: createStructureNormalizeStage(mediaOptions),
    AGENT_ENRICH: createAgentEnrichStage(agentGateOptions),
    AGENT_REVIEW: createAgentReviewStage(agentGateOptions),
    DETERMINISTIC_VALIDATE: createDeterministicValidateStage(agentGateOptions),
    REPAIR_LOOP: createRepairLoopStage(agentGateOptions),
  };
  return PRODUCTION_STAGE_NAMES.map((name) => stages[name] ?? unimplementedStage(name));
}
