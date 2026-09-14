/**
 * Production stage registry (spec 5.2).
 *
 * Declares the 13 production stage names in exact compile order plus their
 * dependency edges. SOURCE_FINGERPRINT inventories the source PDF (SHA-256 +
 * page count through the versioned Python media workers, spec 5.3);
 * IMAGE_EXTRACT and WATERMARK_CLEAN call the versioned Python media workers
 * (spec 5.3) through `src/media.ts`; LAYOUT_OCR runs the
 * PP-StructureV3 worker and STRUCTURE_NORMALIZE recovers records
 * deterministically, gating on visual-OCR review packets (spec 5.4);
 * AGENT_ENRICH through REPAIR_LOOP run the four isolated agent roles
 * (generation, independent review, deterministic validator, repair) behind the
 * fail-closed three-round state machine (spec 5.6); CARD_GENERATE derives the
 * four deterministic card types and the introduction queues' fixed order from
 * the review-passed content (spec 5.7); TTS_SYNTHESIZE caches provider audio
 * and AUDIO_VALIDATE runs the deterministic Python audio gate (spec 5.8);
 * RELEASE_PACKAGE produces the immutable release bundle (spec 5.9, implemented
 * in `src/release/package.ts`). The names, order, and dependencies declared
 * here are final.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { AgentGenerationOutput, UnitValidationReport as UnitValidationReportSchema } from "@lexiloop/content-schema";
import { hashJson, StageError, type AnyStage, type StageRunContext } from "./stage";
import {
  COMPILER_ROOT,
  DEFAULT_RULE_PATH,
  MediaOutputInvalidError,
  MediaSpawnError,
  MediaStageConfigSchema,
  cleanSpawnArgs,
  createPythonRunner,
  extractSpawnArgs,
  fingerprintSpawnArgs,
  fileExists,
  readJsonl,
  sha256File,
  validateCleanArtifacts,
  validateExtractArtifacts,
  type CleanRecord,
  type SpawnPythonFn,
} from "./media";
import {
  DEFAULT_OCR_CONFIG_PATH,
  OCR_JSONL,
  OcrBlockRecordSchema,
  ocrJsonlHash,
  ocrSpawnArgs,
  toNormalizeInputBlocks,
  validateOcrArtifacts,
  type OcrBlockRecord,
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
import {
  CardRuleError,
  CardRulesConfigSchema,
  generateUnitCards,
  type CardRulesConfig,
} from "@lexiloop/domain";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AUDIO_DIR,
  AUDIO_INSPECTION,
  AUDIO_MANIFEST,
  AudioInspectionRowSchema,
  loadAudioManifest,
  withWavInfoComment,
  writeAudioManifest,
  type AudioManifestRow,
} from "./tts/cache";
import {
  DEFAULT_TTS_CONFIG_PATH,
  buildTtsPlan,
  collectTtsItems,
  readTtsConfig,
} from "./tts/plan";
import { createMiMoTtsProvider } from "./tts/mimo";
import {
  resolveTtsApiKey,
  TtsProviderError,
  type TtsFetchFn,
  type TtsProvider,
} from "./tts/provider";
import {
  createReleasePackageStage,
  RELEASE_PACKAGE_PREDECESSORS,
  RELEASE_PACKAGE_STAGE,
} from "./release/package";

// Re-exported so the CLI and tests can resolve the packaging stage alongside
// the other production stage factories.
export { createReleasePackageStage, RELEASE_PACKAGE_STAGE, RELEASE_PACKAGE_PREDECESSORS };

/** Value type of the validation report (the schema export is value-only). */
type UnitValidationReportT = z.output<typeof UnitValidationReportSchema>;

/** Value type of the review-passed generation output. */
type AgentGenerationOutputT = z.output<typeof AgentGenerationOutput>;

/** Assessments whose phase hands the caller a work order to enqueue. */
type OrderBearingAssessment = Extract<UnitAssessment, { order: WorkOrder }>;

/** Assessments whose phase carries a deterministic validation report. */
type ReportedAssessment = Extract<UnitAssessment, { report: UnitValidationReportT }>;

export const PRODUCTION_STAGE_NAMES = [...RELEASE_PACKAGE_PREDECESSORS, RELEASE_PACKAGE_STAGE] as const;

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
export const RELEASE_STAGE: ProductionStageName = RELEASE_PACKAGE_STAGE;

/** Default private root (git-ignored); artifacts live under `<root>/work/`. */
export const DEFAULT_PRIVATE_ROOT = ".lexiloop-private";

// ---------------------------------------------------------------------------
// SOURCE_FINGERPRINT (spec 5.2/5.3): source inventory probe
//
// The first stage of every compile run. It hashes the source PDF, reads the
// page count through the versioned Python media bridge (`lexiloop_media
// fingerprint`, argument-array spawn), and emits a ledger output that later
// stages chain via the pipeline's upstream provenance. The stage REPORTS the
// page count; `plan`/`run` surface the expectation check against the approved
// source inventory (440 pages for llcy-2024).
// ---------------------------------------------------------------------------

/** Approved source inventory: the llcy-2024 source PDF has 440 pages. */
export const LLCY_2024_EXPECTED_PAGE_COUNT = 440;

export const SourceFingerprintOutputSchema = z.object({
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  algorithm: z.literal("sha256"),
  /** Reported by the PyMuPDF worker; checked against the inventory by plan/run. */
  page_count: z.number().int().positive(),
  /** Version of the fingerprint worker contract baked into the output. */
  fingerprint_config_version: z.string().min(1),
});
export type SourceFingerprintOutput = z.output<typeof SourceFingerprintOutputSchema>;

/** Strict shape of the `lexiloop_media fingerprint` stdout summary. */
const FingerprintWorkerSummarySchema = z.object({
  algorithm: z.literal("sha256"),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  page_count: z.number().int().positive(),
});

/** Options for the SOURCE_FINGERPRINT stage. */
export interface SourceFingerprintStageOptions {
  /**
   * Path of the source PDF. REQUIRED at run time (the stage fails closed
   * without it); `computeInputHash` binds to content identity (the run's
   * source hash) only, so resume never depends on the path staying stable.
   */
  sourcePath?: string;
  /**
   * Python runner (argument-array spawn). Defaults to the real runner;
   * tests inject stubs.
   */
  runPython?: SpawnPythonFn;
}

/**
 * SOURCE_FINGERPRINT: compute the source PDF's SHA-256, read its page count
 * through the Python media bridge, and emit the source-inventory ledger
 * output. Every misuse fails closed with a machine-readable code:
 * FINGERPRINT_CONFIG_INVALID (no path wired), SOURCE_NOT_FOUND (missing
 * file), SOURCE_HASH_MISMATCH (run context or worker hashed other content),
 * MEDIA_OUTPUT_INVALID (malformed worker summary).
 */
export function createSourceFingerprintStage(options: SourceFingerprintStageOptions = {}): AnyStage {
  const runPython = options.runPython ?? createPythonRunner();
  const configVersion = "1";
  return {
    name: "SOURCE_FINGERPRINT",
    configVersion,
    inputSchema: z.unknown(),
    outputSchema: SourceFingerprintOutputSchema,
    computeInputHash: (ctx) =>
      hashJson({
        stage: "SOURCE_FINGERPRINT",
        configVersion,
        sourceHash: ctx.sourceHash,
        upstream: null,
      }),
    run: async (_input, ctx) => {
      try {
        if (options.sourcePath === undefined) {
          throw new StageError(
            "FINGERPRINT_CONFIG_INVALID",
            "SOURCE_FINGERPRINT requires the source PDF path (pass --source, or wire " +
              "sourcePath into the stage registry); the stage never guesses inputs",
          );
        }
        const sourcePath = path.resolve(options.sourcePath);
        if (!(await fileExists(sourcePath))) {
          throw new StageError("SOURCE_NOT_FOUND", `source PDF not found: ${sourcePath}`);
        }
        // (a) The stage computes the file hash itself: the ledger output must
        // never inherit a hash it did not verify.
        const sourceSha256 = await sha256File(sourcePath);
        if (/^[0-9a-f]{64}$/.test(ctx.sourceHash) && ctx.sourceHash !== sourceSha256) {
          throw new StageError(
            "SOURCE_HASH_MISMATCH",
            `run context names source ${ctx.sourceHash.slice(0, 12)} but ${sourcePath} hashes to ` +
              `${sourceSha256.slice(0, 12)}; the source changed under this run`,
          );
        }
        // (b) Page count via PyMuPDF through the media bridge; the worker
        // re-hashes the file so a swapped source can never slip through.
        const { stdout } = await runPython(fingerprintSpawnArgs(sourcePath));
        let rawSummary: unknown;
        try {
          rawSummary = JSON.parse(stdout.trim());
        } catch {
          throw new MediaOutputInvalidError(
            sourcePath,
            `fingerprint summary is not valid JSON: ${stdout.trim().slice(0, 120)}`,
          );
        }
        const summary = FingerprintWorkerSummarySchema.safeParse(rawSummary);
        if (!summary.success) {
          throw new MediaOutputInvalidError(
            sourcePath,
            `fingerprint summary failed schema validation: ${summary.error.message}`,
          );
        }
        if (summary.data.source_sha256 !== sourceSha256) {
          throw new StageError(
            "SOURCE_HASH_MISMATCH",
            `fingerprint worker hashed ${summary.data.source_sha256.slice(0, 12)} but the stage ` +
              `computed ${sourceSha256.slice(0, 12)} for ${sourcePath}`,
          );
        }
        // (c) Ledger output: source hash + page count + config version.
        return {
          source_sha256: sourceSha256,
          algorithm: "sha256",
          page_count: summary.data.page_count,
          fingerprint_config_version: configVersion,
        } satisfies SourceFingerprintOutput;
      } catch (err) {
        throw toSpawnError(err);
      }
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
  /**
   * LAYOUT_OCR chunk size: pages per worker spawn. The full book is never
   * OCR'd in one spawn (a 440-page PaddleOCR run takes hours); missing pages
   * are filled chunk-by-chunk with per-chunk timeouts. Default 12.
   */
  ocrChunkPages?: number;
  /** Per-chunk spawn timeout (ms) for LAYOUT_OCR. Default 15 minutes. */
  ocrChunkTimeoutMs?: number;
}

/** Default LAYOUT_OCR pages per worker spawn. */
export const DEFAULT_OCR_CHUNK_PAGES = 12;
/** Default per-chunk LAYOUT_OCR spawn timeout (15 minutes). */
export const DEFAULT_OCR_CHUNK_TIMEOUT_MS = 15 * 60 * 1000;

/** Fill defaults for optional media wiring; the runner is never optional. */
export function resolveMediaStageOptions(
  options: {
    privateRoot?: string;
    runPython?: SpawnPythonFn;
    rulePath?: string;
    ocrConfigPath?: string;
    ocrChunkPages?: number;
    ocrChunkTimeoutMs?: number;
  } = {},
): MediaStageOptions {
  return {
    privateRoot: options.privateRoot ?? DEFAULT_PRIVATE_ROOT,
    runPython: options.runPython ?? createPythonRunner(),
    ...(options.rulePath !== undefined ? { rulePath: options.rulePath } : {}),
    ...(options.ocrConfigPath !== undefined ? { ocrConfigPath: options.ocrConfigPath } : {}),
    ...(options.ocrChunkPages !== undefined ? { ocrChunkPages: options.ocrChunkPages } : {}),
    ...(options.ocrChunkTimeoutMs !== undefined
      ? { ocrChunkTimeoutMs: options.ocrChunkTimeoutMs }
      : {}),
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
 * Pages of `ocr.jsonl` considered COMPLETE for a resume: the page is in scope,
 * rows exist for it, and every row's `page_image_sha256` matches the clean
 * record's cleaned image hash. Anything else (missing rows, stale hashes, an
 * unreadable artifact) counts as missing, so the reconcile-then-fill loop
 * re-spawns exactly the pages a previous run never finished.
 */
async function completedOcrPages(
  workDir: string,
  expectedPages: readonly number[],
  cleanByPage: ReadonlyMap<number, CleanRecord>,
): Promise<Set<number>> {
  let rows: OcrBlockRecord[];
  try {
    rows = await readJsonl(path.join(workDir, OCR_JSONL), OcrBlockRecordSchema);
  } catch {
    return new Set(); // no artifact yet (or unreadable): nothing counts as complete
  }
  const rowsByPage = new Map<number, OcrBlockRecord[]>();
  for (const row of rows) {
    const pageRows = rowsByPage.get(row.page) ?? [];
    pageRows.push(row);
    rowsByPage.set(row.page, pageRows);
  }
  const complete = new Set<number>();
  for (const page of expectedPages) {
    const clean = cleanByPage.get(page);
    const pageRows = rowsByPage.get(page);
    if (!clean || !pageRows || pageRows.length === 0) continue;
    if (pageRows.every((row) => row.page_image_sha256 === clean.cleaned_image_sha256)) {
      complete.add(page);
    }
  }
  return complete;
}

/**
 * LAYOUT_OCR: runs the versioned PP-StructureV3 worker over every cleaned
 * page image, then validates `ocr.jsonl` — schema, source/page-image hash
 * chain, and the private raw-text evidence — before the ledger may advance.
 *
 * Execution is chunked and resumable: the stage first reconciles the existing
 * `ocr.jsonl` against the cleaned pages, then spawns the worker once per
 * chunk of MISSING pages (`--pages`, per-chunk timeout) — the worker merges
 * each chunk into the artifact, so a 440-page book survives spawn timeouts
 * and retries only process what is actually missing. The final
 * `validateOcrArtifacts` run covers every page exactly as a single-spawn run
 * would: chunking changes nothing about the output schema or hashes.
 */
export function createLayoutOcrStage(options: MediaStageOptions): AnyStage {
  const { runPython } = options;
  const ocrConfigPath = options.ocrConfigPath ?? DEFAULT_OCR_CONFIG_PATH;
  const chunkPages =
    options.ocrChunkPages ?? DEFAULT_OCR_CHUNK_PAGES;
  if (!Number.isInteger(chunkPages) || chunkPages < 1) {
    throw new Error(`ocrChunkPages must be a positive integer, got ${chunkPages}`);
  }
  const chunkTimeoutMs = options.ocrChunkTimeoutMs ?? DEFAULT_OCR_CHUNK_TIMEOUT_MS;
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
        // The OCR chain is anchored in the cleaned pages: validate them first
        // (reconciliation needs each page's cleaned image hash), then fill
        // only the pages the existing artifact does not already cover.
        const cleanRecords = await validateCleanArtifacts(workDir, ctx.sourceHash, media.pages);
        const cleanByPage = new Map(cleanRecords.map((record) => [record.page, record]));
        const complete = await completedOcrPages(workDir, media.pages, cleanByPage);
        const missingPages = media.pages.filter((page) => !complete.has(page)).sort((a, b) => a - b);
        for (let index = 0; index < missingPages.length; index += chunkPages) {
          const chunk = missingPages.slice(index, index + chunkPages);
          await runPython(ocrSpawnArgs(ocrConfigPath, workDir, chunk), {
            timeoutMs: chunkTimeoutMs,
          });
        }
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
  // v3: chapter-aware calibration for the full 440-page raster. Chapter
  // openers establish authoritative chapter context; front matter (before the
  // first opener) and back matter (from the index opener) are signal-inert;
  // unit keys are chapter-qualified (c<chapter>.u<number>) with unit_order as
  // the global encounter ordinal; the monotonic guard is chapter-scoped.
  // v4: CJK-leading gloss blocks attach to the open entry (multi-line gloss
  // continuations, and glosses of headword lines ending at their POS marker)
  // instead of being silently dropped.
  // Bumped so cached ledgers invalidate and re-segment.
  const configVersion = "4";
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

// ---------------------------------------------------------------------------
// Card generation (spec 5.7): CARD_GENERATE
//
// Cards are never freely written by agents: they are derived by fixed,
// versioned rules from content that already exited all four agent gates as
// PASSED. The stage re-assesses every target Unit through the same state
// machine as the gates (so a queue that somehow regressed fails closed),
// derives the four card types via @lexiloop/domain's rule engine, rejects any
// Unit where a learnable word would end with zero cards (terminal block), and
// writes `cards.jsonl` into the work directory — the bytes every downstream
// stage (audio, package) anchor on.
// ---------------------------------------------------------------------------

/** Default versioned card-rules config (spec 5.7). */
export const DEFAULT_CARDS_CONFIG_PATH = path.join(COMPILER_ROOT, "config", "cards", "v1.json");

export const CardGenerateOutputSchema = z.object({
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Relative to the per-source work directory. */
  cards_jsonl: z.literal("cards.jsonl"),
  /** SHA-256 of the written card rows (one strict CardDefinition per line). */
  cards_jsonl_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Version of the card rules the cards were generated with. */
  card_rules_version: z.string().min(1),
  counts: z.object({
    units: z.number().int().nonnegative(),
    words: z.number().int().nonnegative(),
    cards: z.number().int().nonnegative(),
    by_type: z.object({
      WORD_MEANING: z.number().int().nonnegative(),
      CONTEXT_MEANING: z.number().int().nonnegative(),
      PHRASE: z.number().int().nonnegative(),
      SENSE_DISCRIMINATION: z.number().int().nonnegative(),
    }),
  }),
  units: z
    .array(
      z.object({
        unit_key: z.string().min(1),
        words: z.number().int().nonnegative(),
        cards: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});
export type CardGenerateOutput = z.output<typeof CardGenerateOutputSchema>;

const CARD_GENERATE_CONFIG_VERSION = "1";

/** Options for the CARD_GENERATE stage. */
export interface CardGenerateStageOptions {
  /** Private root holding per-source work directories. */
  privateRoot: string;
  /** Versioned card-rules config; defaults to `config/cards/v1.json`. */
  cardsConfigPath?: string;
}

/** Read + strictly validate the versioned card rules (fail closed). */
async function readCardsConfig(filePath: string): Promise<CardRulesConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StageError("CARD_CONFIG_INVALID", `card rules config unreadable at ${filePath}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StageError("CARD_CONFIG_INVALID", `card rules config at ${filePath} is not valid JSON`);
  }
  const config = CardRulesConfigSchema.safeParse(parsed);
  if (!config.success) {
    throw new StageError(
      "CARD_CONFIG_INVALID",
      `card rules config at ${filePath} violates the contract: ${config.error.issues[0]?.message ?? config.error.message}`,
    );
  }
  return config.data;
}

/** Map card-rule/agent errors onto StageError so codes survive the ledger. */
function toCardStageError(err: unknown): StageError {
  if (err instanceof StageError) return err;
  if (err instanceof CardRuleError) {
    // A learnable word with zero active cards blocks the Unit terminally
    // (spec 5.7 rule 7); every other rule breach is a deterministic failure.
    return new StageError(err.code, err.message, { blocked: err.code === "WORD_HAS_NO_CARDS" });
  }
  if (err instanceof WorkPacketError || err instanceof ReviewLoopError) {
    return new StageError(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new StageError("STAGE_UNEXPECTED_ERROR", message);
}

/**
 * CARD_GENERATE: derive the deterministic learning cards (spec 5.7). The
 * input hash covers the versioned card config plus every validated Unit
 * input — the semantic queue digest folds each packet (unit source evidence)
 * and each ingested agent result — so any config or content change re-runs
 * card generation and nothing downstream can run on stale cards. The stage
 * only passes when every target Unit exited the four agent gates as PASSED.
 */
export function createCardGenerateStage(options: CardGenerateStageOptions): AnyStage {
  const cardsConfigPath = options.cardsConfigPath ?? DEFAULT_CARDS_CONFIG_PATH;
  return {
    name: "CARD_GENERATE",
    configVersion: CARD_GENERATE_CONFIG_VERSION,
    inputSchema: z.unknown(),
    outputSchema: CardGenerateOutputSchema,
    computeInputHash: async (ctx) =>
      hashJson({
        stage: "CARD_GENERATE",
        configVersion: CARD_GENERATE_CONFIG_VERSION,
        sourceHash: ctx.sourceHash,
        cards_config_sha256: await sha256File(cardsConfigPath),
        queue: await semanticQueueDigest(agentGatePaths(options, ctx.sourceHash).queueDir),
        upstream: ctx.upstream?.outputHash ?? null,
      }),
    run: async (_input, ctx) => {
      try {
        const gate = agentGatePaths(options, ctx.sourceHash);
        const config = await readCardsConfig(cardsConfigPath);
        // Re-assess through the gates' own state machine: a Unit that is not
        // passed fails the stage closed — cards never precede review.
        const assessed = await assessTargetUnits(gate, options, ctx);
        const generated: Array<{ workload: UnitWorkload; generation: AgentGenerationOutputT }> = [];
        for (const entry of assessed) {
          const { assessment } = entry;
          if (assessment.phase !== "passed") {
            throw new StageError(
              "SEMANTIC_STATE_INVALID",
              `unit ${entry.workload.unitKey} did not exit the review loop as PASSED ` +
                `(phase ${assessment.phase}); CARD_GENERATE can only run once every ` +
                "target Unit passed all four gates",
            );
          }
          if (assessment.report.status !== "PASSED") {
            throw new StageError(
              "SEMANTIC_STATE_INVALID",
              `unit ${entry.workload.unitKey} carries a ${assessment.report.status} validation report`,
            );
          }
          generated.push({ workload: entry.workload, generation: assessment.generation });
        }

        const units: CardGenerateOutput["units"] = [];
        const byType: CardGenerateOutput["counts"]["by_type"] = {
          WORD_MEANING: 0,
          CONTEXT_MEANING: 0,
          PHRASE: 0,
          SENSE_DISCRIMINATION: 0,
        };
        const rows: string[] = [];
        for (const { workload, generation } of generated) {
          const cards = generateUnitCards({ config, source: workload.source, generation });
          for (const card of cards) {
            byType[card.card_type] += 1;
            rows.push(JSON.stringify(card));
          }
          units.push({
            unit_key: workload.unitKey,
            words: workload.source.words.length,
            cards: cards.length,
          });
        }
        const cardsPath = path.join(gate.workDir, "cards.jsonl");
        await mkdir(path.dirname(cardsPath), { recursive: true });
        await writeFile(
          cardsPath,
          rows.length > 0 ? `${rows.join("\n")}\n` : "",
          "utf8",
        );
        return {
          source_sha256: ctx.sourceHash,
          cards_jsonl: "cards.jsonl",
          cards_jsonl_sha256: await sha256File(cardsPath),
          card_rules_version: config.card_rules_version,
          counts: {
            units: units.length,
            words: units.reduce((acc, unit) => acc + unit.words, 0),
            cards: units.reduce((acc, unit) => acc + unit.cards, 0),
            by_type: byType,
          },
          units,
        } satisfies CardGenerateOutput;
      } catch (err) {
        throw toCardStageError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// TTS synthesis + deterministic audio validation (spec 5.8): TTS_SYNTHESIZE,
// AUDIO_VALIDATE
//
// V1 pre-generates audio for every headword and every example sentence of
// every target unit through the replaceable TtsProvider seam (default Xiaomi
// MiMo `mimo-v2.5-tts`, preset English voice). Assets are content-addressed
// under the private work directory with the same key layout as R2
// (`audio/<hash-prefix>/<hash>.wav`); the cache key is the hash of provider +
// model + voice + normalized text + synthesis config version, so ANY
// synthesis-parameter change produces new keys and re-runs the audio gate.
//
// Both stages REQUIRE a matching CARD_GENERATE output hash (ledger entry
// PASSED, upstream provenance equal to it, and cards.jsonl bytes folded into
// the input hash) — audio never precedes deterministic card generation.
// AUDIO_VALIDATE runs the deterministic Python gate (ffprobe/soundfile only:
// no ASR, no audio read-back) and produces the only input RELEASE_PACKAGE
// accepts. Neither stage ever sees the API key's value in logs or artifacts.
// ---------------------------------------------------------------------------

/** Default versioned TTS synthesis config (spec 5.8). */
export { DEFAULT_TTS_CONFIG_PATH };

export const TtsSynthesizeOutputSchema = z.object({
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Relative to the per-source work directory. */
  audio_manifest: z.literal(AUDIO_MANIFEST),
  /** SHA-256 of the manifest artifact (sorted rows; deterministic). */
  audio_manifest_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  synthesis_config_version: z.string().min(1),
  counts: z.object({
    /** Content records covered (headwords + examples). */
    items: z.number().int().nonnegative(),
    /** Unique normalized texts = provider calls on a cold cache. */
    unique_texts: z.number().int().nonnegative(),
    cache_hits: z.number().int().nonnegative(),
    synthesized: z.number().int().nonnegative(),
  }),
  /** Characters across unique normalized texts. */
  characters: z.number().int().nonnegative(),
  assets: z
    .array(
      z.object({
        cache_key: z.string().regex(/^[0-9a-f]{64}$/),
        object_key: z.string().min(1),
        text_sha256: z.string().regex(/^[0-9a-f]{64}$/),
        text_chars: z.number().int().positive(),
        min_seconds: z.number().nonnegative(),
        max_seconds: z.number().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().positive(),
      }),
    )
    .min(1),
});
export type TtsSynthesizeOutput = z.output<typeof TtsSynthesizeOutputSchema>;

export const AudioValidateOutputSchema = z.object({
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** Relative to the per-source work directory. */
  audio_inspection: z.literal(AUDIO_INSPECTION),
  /** SHA-256 of the inspection artifact consumed by RELEASE_PACKAGE. */
  audio_inspection_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  synthesis_config_version: z.string().min(1),
  counts: z.object({
    checked: z.number().int().positive(),
    /** The stage only passes when every asset passed every check. */
    failed: z.literal(0),
  }),
});
export type AudioValidateOutput = z.output<typeof AudioValidateOutputSchema>;

const TTS_CONFIG_VERSION = "1";

/** Options shared by both TTS stages. */
export interface TtsStageOptions {
  /** Private root holding per-source work directories. */
  privateRoot: string;
  /** Versioned synthesis config; defaults to `config/tts/mimo-v2.5.json`. */
  ttsConfigPath?: string;
}

/** Options for the TTS_SYNTHESIZE stage. */
export interface TtsSynthesizeStageOptions extends TtsStageOptions {
  /** Injectable HTTP boundary (tests); defaults to global fetch. */
  fetchFn?: TtsFetchFn;
  /**
   * API key. Undefined resolves `MIMO_API_KEY`/legacy `mimo-key` from the
   * local env at run time; null forces the fail-closed no-key behavior in
   * tests. The value is never logged and never lands in any artifact.
   */
  apiKey?: string | null;
  /** Injectable backoff sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Provider retry budget override (tests); defaults to the config value. */
  maxRetries?: number;
  /** Cap on unique texts synthesized (smoke runs); folds into the input hash. */
  limit?: number;
}

/** Options for the AUDIO_VALIDATE stage. */
export interface AudioValidateStageOptions extends TtsStageOptions {
  /**
   * Runner for the Python audio gate (argument-array spawn). REQUIRED so the
   * gate can never "pass" by validating stale artifacts without actually
   * running the worker; production wiring resolves a real runner, tests
   * inject stubs.
   */
  runPython: SpawnPythonFn;
}

/**
 * CARD_GENERATE provenance every audio stage requires: the ledger entry must
 * be PASSED with its recorded output hash. Returns that hash.
 */
async function requireCardsLedgerProvenance(ctx: StageRunContext): Promise<string> {
  const entry = await ctx.ledger.load("CARD_GENERATE");
  if (!entry || entry.status !== "PASSED" || entry.output_hash === null) {
    throw new StageError(
      "CARD_GENERATE_NOT_PASSED",
      "TTS stages require a PASSED CARD_GENERATE ledger entry with its output hash; " +
        "audio never precedes deterministic card generation",
    );
  }
  return entry.output_hash;
}

/**
 * Provenance for TTS_SYNTHESIZE: CARD_GENERATE must be PASSED and the run's
 * immediate upstream must name CARD_GENERATE with the matching output hash —
 * audio never precedes deterministic cards.
 */
async function requireCardsProvenance(ctx: StageRunContext): Promise<void> {
  const cardsOutputHash = await requireCardsLedgerProvenance(ctx);
  if (!ctx.upstream || ctx.upstream.stage !== "CARD_GENERATE") {
    throw new StageError(
      "CARD_GENERATE_NOT_PASSED",
      "no CARD_GENERATE upstream provenance in this run context; " +
        "invoke audio stages through the pipeline or prime the ledger first",
    );
  }
  if (ctx.upstream.outputHash !== cardsOutputHash) {
    throw new StageError(
      "CARD_GENERATE_HASH_MISMATCH",
      `upstream hash ${(ctx.upstream.outputHash ?? "(null)").slice(0, 12)} does not match the ` +
        `CARD_GENERATE ledger output ${cardsOutputHash.slice(0, 12)}`,
    );
  }
}

/** TTS_SYNTHESIZE provenance AUDIO_VALIDATE requires (same binding shape). */
async function requireTtsProvenance(ctx: StageRunContext): Promise<void> {
  const entry = await ctx.ledger.load("TTS_SYNTHESIZE");
  if (!entry || entry.status !== "PASSED" || entry.output_hash === null) {
    throw new StageError(
      "TTS_SYNTHESIZE_NOT_PASSED",
      "AUDIO_VALIDATE requires a PASSED TTS_SYNTHESIZE ledger entry with its output hash",
    );
  }
  if (!ctx.upstream || ctx.upstream.stage !== "TTS_SYNTHESIZE") {
    throw new StageError(
      "TTS_SYNTHESIZE_NOT_PASSED",
      "no TTS_SYNTHESIZE upstream provenance in this run context; " +
        "invoke audio validation through the pipeline or prime the ledger first",
    );
  }
  if (ctx.upstream.outputHash !== entry.output_hash) {
    throw new StageError(
      "TTS_SYNTHESIZE_HASH_MISMATCH",
      `upstream hash ${(ctx.upstream.outputHash ?? "(null)").slice(0, 12)} does not match the ` +
        `TTS_SYNTHESIZE ledger output ${entry.output_hash.slice(0, 12)}`,
    );
  }
}

/** SHA-256 of cards.jsonl (fail closed when the artifact is missing). */
async function cardsJsonlSha256(workDir: string): Promise<string> {
  return sha256File(path.join(workDir, "cards.jsonl"));
}

/** Map TTS/agent errors onto StageError so codes survive the ledger. */
function toTtsStageError(err: unknown): StageError {
  if (err instanceof StageError) return err;
  if (err instanceof TtsProviderError) {
    // Only transport/rate-limit failures are retryable (spec 11.1).
    return new StageError(err.code, err.message, { retryable: err.retryable });
  }
  if (err instanceof WorkPacketError || err instanceof ReviewLoopError) {
    return new StageError(err.code, err.message);
  }
  if (err instanceof MediaSpawnError) {
    return new StageError(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new StageError("STAGE_UNEXPECTED_ERROR", message);
}

/**
 * TTS_SYNTHESIZE: plan the audio coverage from the validated content records,
 * reuse every still-intact cached asset, and synthesize the rest through the
 * replaceable provider into private content-addressed WAVs that carry their
 * text hash as RIFF metadata. The manifest rewritten here is exactly the
 * current required asset set, so a partial `--limit` run can never validate.
 */
export function createTtsSynthesizeStage(options: TtsSynthesizeStageOptions): AnyStage {
  const ttsConfigPath = options.ttsConfigPath ?? DEFAULT_TTS_CONFIG_PATH;
  const limit = options.limit;
  return {
    name: "TTS_SYNTHESIZE",
    configVersion: TTS_CONFIG_VERSION,
    inputSchema: z.unknown(),
    outputSchema: TtsSynthesizeOutputSchema,
    computeInputHash: async (ctx) => {
      const workDir = workDirectoryFor(options.privateRoot, ctx.sourceHash);
      return hashJson({
        stage: "TTS_SYNTHESIZE",
        configVersion: TTS_CONFIG_VERSION,
        sourceHash: ctx.sourceHash,
        tts_config_sha256: await sha256File(ttsConfigPath),
        cards_jsonl_sha256: await cardsJsonlSha256(workDir),
        limit: limit ?? null,
        upstream: ctx.upstream?.outputHash ?? null,
      });
    },
    run: async (_input, ctx) => {
      try {
        const workDir = workDirectoryFor(options.privateRoot, ctx.sourceHash);
        const config = await readTtsConfig(ttsConfigPath);
        await requireCardsProvenance(ctx);
        const workloads = await loadUnitWorkloads(workDir);
        const items = collectTtsItems(workloads);
        if (items.length === 0) {
          throw new StageError(
            "TTS_INPUT_EMPTY",
            "no headwords or example sentences recovered from the validated content; " +
              "refusing to pass TTS_SYNTHESIZE with zero audio coverage",
          );
        }
        const existing = await loadAudioManifest(workDir);
        const plan = buildTtsPlan({ items, config, existing });
        const entries = limit !== undefined ? plan.entries.slice(0, limit) : plan.entries;

        // Verify cached assets against the disk BEFORE any paid call: a hit
        // requires an intact file whose bytes still match the manifest.
        const decided: Array<{ entry: (typeof entries)[number]; cached: AudioManifestRow | null }> = [];
        for (const entry of entries) {
          const prior = existing.find((row) => row.cache_key === entry.cacheKey) ?? null;
          let valid: AudioManifestRow | null = null;
          if (entry.cached && prior) {
            const absPath = path.join(workDir, entry.objectKey);
            if (await fileExists(absPath)) {
              if ((await sha256File(absPath)) === prior.sha256) valid = prior;
            }
          }
          decided.push({ entry, cached: valid });
        }

        let provider: TtsProvider | null = null;
        const owed = decided.filter((decision) => decision.cached === null);
        if (owed.length > 0) {
          const apiKey = options.apiKey === undefined ? resolveTtsApiKey() : options.apiKey;
          if (!apiKey) {
            throw new StageError(
              "TTS_API_KEY_MISSING",
              `${owed.length} audio asset(s) need synthesis but no API key is configured; ` +
                `set ${"MIMO_API_KEY"} (or the legacy local name) in the local environment`,
            );
          }
          provider = createMiMoTtsProvider({
            apiKey,
            baseUrl: config.base_url,
            model: config.model,
            voice: config.voice,
            format: config.audio_format,
            timeoutMs: config.timeout_ms,
            maxRetries: options.maxRetries ?? config.max_retries,
            retryableStatusCodes: config.retryable_status_codes,
            ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
            ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
            logger: ctx.logger,
          });
        }

        const rows: AudioManifestRow[] = [];
        let cacheHits = 0;
        let synthesized = 0;
        for (const { entry, cached } of decided) {
          let fileSha256: string;
          let bytes: number;
          if (cached) {
            fileSha256 = cached.sha256;
            bytes = cached.bytes;
            cacheHits += 1;
          } else {
            const result = await provider!.synthesize({ text: entry.text });
            // The WAV carries its text hash as metadata: the audio gate's
            // binding to the content records (spec 5.8).
            const wav = withWavInfoComment(Buffer.from(result.audioBase64, "base64"), entry.textSha256);
            const absPath = path.join(workDir, entry.objectKey);
            await mkdir(path.dirname(absPath), { recursive: true });
            await writeFile(absPath, wav);
            fileSha256 = await sha256File(absPath);
            bytes = wav.length;
            synthesized += 1;
          }
          rows.push({
            cache_key: entry.cacheKey,
            object_key: entry.objectKey,
            // Relative to the manifest's directory (`audio/`), mirroring the
            // other private JSONL artifacts.
            wav_path: path.posix.relative(AUDIO_DIR, entry.objectKey),
            text_sha256: entry.textSha256,
            text_chars: entry.textChars,
            min_seconds: entry.minSeconds,
            max_seconds: entry.maxSeconds,
            sha256: fileSha256,
            bytes,
            provider: config.provider,
            model: config.model,
            voice: config.voice,
            synthesis_config_version: config.synthesis_config_version,
          });
        }
        rows.sort((a, b) => (a.cache_key < b.cache_key ? -1 : a.cache_key > b.cache_key ? 1 : 0));
        const manifestSha256 = await writeAudioManifest(workDir, rows);
        ctx.logger.info("tts_synthesize_completed", {
          stage: "TTS_SYNTHESIZE",
          compile_run_id: ctx.runId,
          output_hash: manifestSha256,
        });
        return {
          source_sha256: ctx.sourceHash,
          audio_manifest: AUDIO_MANIFEST,
          audio_manifest_sha256: manifestSha256,
          synthesis_config_version: config.synthesis_config_version,
          counts: {
            items: items.length,
            unique_texts: entries.length,
            cache_hits: cacheHits,
            synthesized,
          },
          characters: entries.reduce((acc, entry) => acc + entry.textChars, 0),
          assets: rows.map((row) => ({
            cache_key: row.cache_key,
            object_key: row.object_key,
            text_sha256: row.text_sha256,
            text_chars: row.text_chars,
            min_seconds: row.min_seconds,
            max_seconds: row.max_seconds,
            sha256: row.sha256,
            bytes: row.bytes,
          })),
        } satisfies TtsSynthesizeOutput;
      } catch (err) {
        throw toTtsStageError(err);
      }
    },
  };
}

/** Argument array for `lexiloop_media inspect` on a per-source work dir. */
export function ttsInspectSpawnArgs(ttsConfigPath: string, workDir: string): string[] {
  return [
    "inspect",
    "--manifest",
    path.join(workDir, AUDIO_MANIFEST),
    "--out",
    path.join(workDir, AUDIO_INSPECTION),
    "--policy",
    path.resolve(ttsConfigPath),
  ];
}

/**
 * AUDIO_VALIDATE: the deterministic audio gate (spec 5.8). 100% of the
 * manifest-required assets must exist and cover every required text; the
 * Python worker (ffprobe/soundfile only — no ASR, no audio read-back)
 * verifies container/codec/rate/channels, the text-length duration band,
 * non-empty/non-silent audio with bounded head/tail silence, peak, clipping
 * ratio, file size, and the WAV `text_hash` metadata against the content
 * records. Its inspection artifact is the only input RELEASE_PACKAGE accepts.
 */
export function createAudioValidateStage(options: AudioValidateStageOptions): AnyStage {
  const ttsConfigPath = options.ttsConfigPath ?? DEFAULT_TTS_CONFIG_PATH;
  const { runPython } = options;
  return {
    name: "AUDIO_VALIDATE",
    configVersion: TTS_CONFIG_VERSION,
    inputSchema: z.unknown(),
    outputSchema: AudioValidateOutputSchema,
    computeInputHash: async (ctx) => {
      const workDir = workDirectoryFor(options.privateRoot, ctx.sourceHash);
      return hashJson({
        stage: "AUDIO_VALIDATE",
        configVersion: TTS_CONFIG_VERSION,
        sourceHash: ctx.sourceHash,
        tts_config_sha256: await sha256File(ttsConfigPath),
        cards_jsonl_sha256: await cardsJsonlSha256(workDir),
        audio_manifest_sha256: await sha256File(path.join(workDir, AUDIO_MANIFEST)),
        upstream: ctx.upstream?.outputHash ?? null,
      });
    },
    run: async (_input, ctx) => {
      try {
        const workDir = workDirectoryFor(options.privateRoot, ctx.sourceHash);
        const config = await readTtsConfig(ttsConfigPath);
        // CARD_GENERATE provenance (ledger + artifact binding) and the
        // immediate TTS_SYNTHESIZE upstream must both match before the gate.
        await requireCardsLedgerProvenance(ctx);
        await requireTtsProvenance(ctx);

        const rows = await loadAudioManifest(workDir);
        if (rows.length === 0) {
          throw new StageError("AUDIO_GATE_FAILED", "no audio manifest; run TTS_SYNTHESIZE first");
        }
        for (const row of rows) {
          if (!(await fileExists(path.join(workDir, row.object_key)))) {
            throw new StageError(
              "AUDIO_ASSET_MISSING",
              `manifest asset ${row.cache_key.slice(0, 12)} missing: ${row.object_key}`,
            );
          }
        }

        // Coverage: the manifest must contain every required text's cache key
        // (a limited synthesis run can never pass the audio gate).
        const workloads = await loadUnitWorkloads(workDir);
        const expected = buildTtsPlan({ items: collectTtsItems(workloads), config, existing: rows });
        const manifestKeys = new Set(rows.map((row) => row.cache_key));
        const missing = expected.entries.filter((entry) => !manifestKeys.has(entry.cacheKey));
        if (missing.length > 0) {
          throw new StageError(
            "AUDIO_COVERAGE_INCOMPLETE",
            `${missing.length} required text(s) absent from the audio manifest ` +
              `(first: ${missing[0]!.cacheKey.slice(0, 12)} "${missing[0]!.text}")`,
          );
        }

        await runPython(ttsInspectSpawnArgs(ttsConfigPath, workDir));

        const inspectionPath = path.join(workDir, AUDIO_INSPECTION);
        const inspection = await readJsonl(inspectionPath, AudioInspectionRowSchema);
        const byKey = new Map(inspection.map((row) => [row.cache_key, row]));
        for (const row of rows) {
          const result = byKey.get(row.cache_key);
          if (!result) {
            throw new StageError(
              "AUDIO_GATE_FAILED",
              `no inspection result for asset ${row.cache_key.slice(0, 12)}`,
            );
          }
          if (!result.ok) {
            throw new StageError(
              "AUDIO_GATE_FAILED",
              `asset ${row.cache_key.slice(0, 12)} failed deterministic inspection: ` +
                `${result.error ?? "UNKNOWN"}${result.message ? ` (${result.message})` : ""}`,
            );
          }
          if (result.text_sha256 !== undefined && result.text_sha256 !== row.text_sha256) {
            throw new StageError(
              "AUDIO_GATE_FAILED",
              `asset ${row.cache_key.slice(0, 12)} text hash does not match the content record`,
            );
          }
        }

        return {
          source_sha256: ctx.sourceHash,
          audio_inspection: AUDIO_INSPECTION,
          audio_inspection_sha256: await sha256File(inspectionPath),
          synthesis_config_version: config.synthesis_config_version,
          counts: { checked: rows.length, failed: 0 },
        } satisfies AudioValidateOutput;
      } catch (err) {
        throw toTtsStageError(err);
      }
    },
  };
}

/**
 * The 13 production stages in compile order, all implemented. The four
 * semantic agent gates are wired to the filesystem provider queue, so they
 * fail closed with SEMANTIC_PACKETS_PENDING until externally-dispatched
 * agents answer; CARD_GENERATE derives the rule-based cards once every target
 * Unit exited the gates as PASSED; TTS_SYNTHESIZE caches provider audio and
 * AUDIO_VALIDATE runs the deterministic Python audio gate; RELEASE_PACKAGE
 * writes the immutable release bundle under `<private-root>/releases/`.
 * SOURCE_FINGERPRINT fails closed unless the source PDF path was wired (see
 * `SourceFingerprintStageOptions`).
 */
export function getProductionStages(
  options: {
    privateRoot?: string;
    sourcePath?: string;
    runPython?: SpawnPythonFn;
    rulePath?: string;
    ocrConfigPath?: string;
    ocrChunkPages?: number;
    ocrChunkTimeoutMs?: number;
    cardsConfigPath?: string;
    ttsConfigPath?: string;
  } = {},
): AnyStage[] {
  // resolveMediaStageOptions always provides a real argument-array runner,
  // so production wiring can never construct media stages that would
  // "validate" stale artifacts without spawning the worker.
  const mediaOptions: MediaStageOptions = resolveMediaStageOptions(options);
  const agentGateOptions: AgentGateOptions = { privateRoot: mediaOptions.privateRoot };
  const ttsOptions: TtsStageOptions = {
    privateRoot: mediaOptions.privateRoot,
    ...(options.ttsConfigPath !== undefined ? { ttsConfigPath: options.ttsConfigPath } : {}),
  };
  const stages: Record<ProductionStageName, AnyStage> = {
    SOURCE_FINGERPRINT: createSourceFingerprintStage({
      runPython: mediaOptions.runPython,
      ...(options.sourcePath !== undefined ? { sourcePath: options.sourcePath } : {}),
    }),
    IMAGE_EXTRACT: createImageExtractStage(mediaOptions),
    WATERMARK_CLEAN: createWatermarkCleanStage(mediaOptions),
    LAYOUT_OCR: createLayoutOcrStage(mediaOptions),
    STRUCTURE_NORMALIZE: createStructureNormalizeStage(mediaOptions),
    AGENT_ENRICH: createAgentEnrichStage(agentGateOptions),
    AGENT_REVIEW: createAgentReviewStage(agentGateOptions),
    DETERMINISTIC_VALIDATE: createDeterministicValidateStage(agentGateOptions),
    REPAIR_LOOP: createRepairLoopStage(agentGateOptions),
    CARD_GENERATE: createCardGenerateStage({
      privateRoot: mediaOptions.privateRoot,
      ...(options.cardsConfigPath !== undefined ? { cardsConfigPath: options.cardsConfigPath } : {}),
    }),
    TTS_SYNTHESIZE: createTtsSynthesizeStage(ttsOptions),
    AUDIO_VALIDATE: createAudioValidateStage({ ...ttsOptions, runPython: mediaOptions.runPython }),
    RELEASE_PACKAGE: createReleasePackageStage({ privateRoot: mediaOptions.privateRoot }),
  };
  return PRODUCTION_STAGE_NAMES.map((name) => stages[name]);
}
