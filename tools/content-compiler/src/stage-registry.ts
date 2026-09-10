/**
 * Production stage registry (spec 5.2).
 *
 * Declares the 13 production stage names in exact compile order plus their
 * dependency edges. Stages land task by task: IMAGE_EXTRACT and
 * WATERMARK_CLEAN call the versioned Python media workers (spec 5.3) through
 * `src/media.ts`; every other stage is still an unimplemented, fail-closed
 * handler. The names, order, and dependencies declared here are final.
 */
import { z } from "zod";
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
import path from "node:path";

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
}

/** Fill defaults for optional media wiring; the runner is never optional. */
export function resolveMediaStageOptions(
  options: { privateRoot?: string; runPython?: SpawnPythonFn; rulePath?: string } = {},
): MediaStageOptions {
  return {
    privateRoot: options.privateRoot ?? DEFAULT_PRIVATE_ROOT,
    runPython: options.runPython ?? createPythonRunner(),
    ...(options.rulePath !== undefined ? { rulePath: options.rulePath } : {}),
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

/**
 * The 13 production stages in compile order. SOURCE_FINGERPRINT and the
 * stages from LAYOUT_OCR onward are still fail-closed placeholders.
 */
export function getProductionStages(
  options: { privateRoot?: string; runPython?: SpawnPythonFn; rulePath?: string } = {},
): AnyStage[] {
  // resolveMediaStageOptions always provides a real argument-array runner,
  // so production wiring can never construct media stages that would
  // "validate" stale artifacts without spawning the worker.
  const mediaOptions: MediaStageOptions = resolveMediaStageOptions(options);
  const mediaStages: Partial<Record<ProductionStageName, AnyStage>> = {
    IMAGE_EXTRACT: createImageExtractStage(mediaOptions),
    WATERMARK_CLEAN: createWatermarkCleanStage(mediaOptions),
  };
  return PRODUCTION_STAGE_NAMES.map((name) => mediaStages[name] ?? unimplementedStage(name));
}
