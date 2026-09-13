/**
 * Bridge to the versioned Python media workers (design doc section 5.3).
 *
 * The Python module (`tools/content-compiler/python/lexiloop_media`) performs
 * page-image extraction and watermark cleanup. This module spawns it with an
 * argument ARRAY via `execFile` (never a shell string: the real source PDF
 * path contains spaces and CJK punctuation), then validates the JSONL
 * artifacts on disk with Zod before anything may advance the ledger.
 *
 * Invariants mirrored from the Python side:
 * - originals are extracted without re-encoding when possible (or rendered
 *   once at a configured DPI);
 * - cleanup changes pixels strictly inside the versioned watermark mask
 *   (`changed_pixels_outside` must be 0);
 * - nothing in this chain ever writes a PDF.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

/** `tools/content-compiler` package root. */
export const COMPILER_ROOT = resolve(THIS_DIR, "..");
/** Repository root (holds pyproject.toml for `uv run`). */
export const REPO_ROOT = resolve(COMPILER_ROOT, "..", "..");
/** Directory holding the `lexiloop_media` Python package. */
export const PYTHON_DIR = join(COMPILER_ROOT, "python");
/** Default versioned watermark rule. */
export const DEFAULT_RULE_PATH = join(COMPILER_ROOT, "config", "watermarks", "llcy-2024.json");

const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Spawning (argument arrays only — never shell strings)
// ---------------------------------------------------------------------------

/** Per-call overrides for a single Python spawn. */
export interface SpawnCallOptions {
  /**
   * Timeout for THIS spawn in milliseconds; wins over the runner-level
   * `timeoutMs`. Long-running workers (e.g. a full-book OCR chunk) raise this
   * per call instead of growing the global default for every spawn.
   */
  timeoutMs?: number;
}

export type SpawnPythonFn = (
  args: readonly string[],
  callOptions?: SpawnCallOptions,
) => Promise<{ stdout: string }>;

export class MediaSpawnError extends Error {
  readonly code: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(code: string, message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "MediaSpawnError";
    this.code = code;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface PythonRunnerOptions {
  /** Python launcher binary; defaults to $LEXILOOP_PYTHON or "uv". */
  pythonBin?: string;
  /** Working directory for the child; defaults to the repo root (uv project). */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Default runner: `uv run python -m lexiloop_media <args...>` executed with
 * `spawn` in array mode (`shell` never enabled). PYTHONPATH is extended so
 * the package imports without installation.
 */
export function createPythonRunner(options: PythonRunnerOptions = {}): SpawnPythonFn {
  const pythonBin = options.pythonBin ?? process.env.LEXILOOP_PYTHON ?? "uv";
  const cwd = options.cwd ?? REPO_ROOT;
  const defaultTimeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  return async (args, callOptions) => {
    // The per-call override wins: one long worker (an OCR chunk over a
    // full-book slice) must not force raising the default for every spawn.
    const timeoutMs = callOptions?.timeoutMs ?? defaultTimeoutMs;
    const moduleArgs = ["-m", "lexiloop_media", ...args];
    const argv =
      pythonBin === "uv" ? ["uv", "run", "python", ...moduleArgs] : [pythonBin, ...moduleArgs];
    const child = spawn(argv[0]!, [...argv.slice(1)], {
      cwd,
      shell: false, // argument-array spawn only; paths may contain CJK/space
      env: {
        ...process.env,
        PYTHONPATH: process.env.PYTHONPATH
          ? `${PYTHON_DIR}${delimiter}${process.env.PYTHONPATH}`
          : PYTHON_DIR,
      },
    });
    return await new Promise<{ stdout: string }>((resolvePromise, rejectPromise) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        rejectPromise(
          new MediaSpawnError(
            "MEDIA_SPAWN_FAILED",
            `failed to spawn ${pythonBin}: ${err.message}`,
            null,
            stderr,
          ),
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          rejectPromise(
            new MediaSpawnError(
              "MEDIA_TIMEOUT",
              `lexiloop_media ${args[0] ?? "?"} timed out after ${timeoutMs}ms`,
              code,
              stderr,
            ),
          );
          return;
        }
        if (code === 0) {
          resolvePromise({ stdout });
          return;
        }
        // The worker reports machine-readable errors as single-line JSON on
        // stderr: surface its stable error code instead of burying it in a
        // message tail.
        let errorCode = "MEDIA_WORKER_FAILED";
        let errorMessage = "";
        const stderrLines = stderr.trim().split("\n").filter((line) => line.length > 0);
        for (let index = stderrLines.length - 1; index >= 0; index -= 1) {
          try {
            const parsed = JSON.parse(stderrLines[index]!) as { error?: unknown; message?: unknown };
            if (typeof parsed.error === "string" && parsed.error.length > 0) {
              errorCode = parsed.error;
              errorMessage = typeof parsed.message === "string" ? parsed.message : "";
              break;
            }
          } catch {
            // not a JSON line; keep scanning backwards
          }
        }
        if (!errorMessage) {
          errorMessage = `lexiloop_media ${args[0] ?? "?"} exited with code ${code}\n` +
            stderrLines.slice(-4).join("\n");
        }
        rejectPromise(new MediaSpawnError(errorCode, errorMessage, code, stderr));
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Zod schemas (mirror the pydantic models exactly)
// ---------------------------------------------------------------------------

const hex64 = z.string().regex(HEX64);
const unit = z.number().min(0).max(1);
const boxTuple = z.tuple([unit, unit, unit, unit]);
const fillMode = z.enum(["selective", "background", "inpaint", "band"]);

/** Page scoping for a region (1-based PDF pages). */
export const PageSelectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("pages"), pages: z.array(z.number().int().positive()).min(1) }),
  z.object({ kind: z.literal("except"), pages: z.array(z.number().int().positive()).min(1) }),
]);
export type PageSelector = z.infer<typeof PageSelectorSchema>;

const regionBase = {
  name: z.string().min(1),
  fill_mode: fillMode.nullish(),
  page_selector: PageSelectorSchema.default({ kind: "all" }),
  /** Normalized rect holes never touched by cleanup. */
  exclude: z.array(boxTuple).default([]),
  /** Inclusive luminance band removed by `band` fill (required for it). */
  remove_lo_luminance: z.number().int().min(0).max(255).nullish(),
  remove_hi_luminance: z.number().int().min(0).max(255).nullish(),
};

const bandIssue = (ctx: { addIssue(message: string): void }) => (value: {
  fill_mode?: string | null;
  remove_lo_luminance?: number | null;
  remove_hi_luminance?: number | null;
}) => {
  if (
    value.fill_mode === "band" &&
    (value.remove_lo_luminance == null || value.remove_hi_luminance == null)
  ) {
    ctx.addIssue("fill_mode 'band' requires remove_lo_luminance and remove_hi_luminance");
  }
};

const RectRegionObject = z.object({
  kind: z.literal("rect"),
  box: boxTuple,
  ...regionBase,
});
export const RectRegionSchema = RectRegionObject.superRefine((value, ctx) =>
  bandIssue(ctx)(value),
);
const PolygonRegionObject = z.object({
  kind: z.literal("polygon"),
  points: z.array(z.tuple([unit, unit])).min(3),
  ...regionBase,
});
export const PolygonRegionSchema = PolygonRegionObject.superRefine((value, ctx) =>
  bandIssue(ctx)(value),
);
export const FillConfigSchema = z.object({
  default_mode: fillMode.default("selective"),
  inpaint_radius: z.number().int().min(1).default(3),
  chroma_preserve_spread: z.number().int().min(0).max(255).default(25),
  chroma_preserve_max_luminance: z.number().int().min(0).max(255).default(220),
});
export const EvidenceConfigSchema = z.object({
  min_page_fraction: z.number().min(0).max(1).default(0.6),
  min_ink_ratio: z.number().min(0).max(1).default(0.002),
  ink_threshold: z.number().int().min(0).max(255).default(24),
  luminance_split: z.number().int().min(0).max(255).default(140),
  max_chroma_spread: z.number().int().min(0).max(255).default(32),
  dark_text_max_ratio: z.number().gt(0).max(1).default(0.02),
  min_chromatic_pixels: z.number().int().min(1).default(400),
  dark_fill_preserve_luminance: z.number().int().min(0).max(255).default(180),
});
export const WatermarkRuleSchema = z.object({
  rule_version: z.number().int().positive(),
  book_key: z.string().min(1),
  notes: z.string().nullish(),
  fill: FillConfigSchema.default({
    default_mode: "selective",
    inpaint_radius: 3,
    chroma_preserve_spread: 25,
    chroma_preserve_max_luminance: 220,
  }),
  evidence: EvidenceConfigSchema.default({
    min_page_fraction: 0.6,
    min_ink_ratio: 0.002,
    ink_threshold: 24,
    luminance_split: 140,
    max_chroma_spread: 32,
    dark_text_max_ratio: 0.02,
    min_chromatic_pixels: 400,
    dark_fill_preserve_luminance: 100,
  }),
  regions: z.array(z.union([RectRegionSchema, PolygonRegionSchema])).min(1),
});
export type WatermarkRuleConfig = z.infer<typeof WatermarkRuleSchema>;

export const PageRecordSchema = z.object({
  source_sha256: hex64,
  page: z.number().int().positive(),
  width_px: z.number().int().positive(),
  height_px: z.number().int().positive(),
  method: z.enum(["embedded", "rendered"]),
  image_sha256: hex64,
  image_path: z.string().min(1),
  dpi: z.number().int().positive().nullable(),
  ext: z.string().min(1),
});
export type PageRecord = z.infer<typeof PageRecordSchema>;

export const CleanRecordSchema = z.object({
  source_sha256: hex64,
  page: z.number().int().positive(),
  rule_version: z.number().int().positive(),
  original_image_path: z.string().min(1),
  original_image_sha256: hex64,
  cleaned_image_path: z.string().min(1),
  cleaned_image_sha256: hex64,
  mask_bounds: z.tuple([unit, unit, unit, unit]).nullable(),
  region_names: z.array(z.string().min(1)),
  changed_pixels: z.number().int().nonnegative(),
  changed_pixels_outside: z.literal(0),
  body_overlap_detected: z.boolean(),
});
export type CleanRecord = z.infer<typeof CleanRecordSchema>;

/** One row of `qa/packets.jsonl` (written by `media qa-packets`). */
export const QaPacketSchema = z.object({
  page: z.number().int().positive(),
  source_sha256: hex64.nullable(),
  rule_version: z.number().int().positive().nullable(),
  mask_bounds: z.tuple([unit, unit, unit, unit]).nullable(),
  region_names: z.array(z.string()),
  changed_pixels: z.number().int().nonnegative().nullable(),
  body_overlap_detected: z.boolean().nullable(),
  cleaned_image: z.string().min(1),
  cleaned_preview: z.string().min(1),
  original_image: z.string().min(1).optional(),
  original_preview: z.string().min(1).optional(),
  packet_json: z.string().min(1),
});
export type QaPacket = z.infer<typeof QaPacketSchema>;

/** Per-run media configuration carried in pipeline stage config (`media`). */
export const MediaStageConfigSchema = z.object({
  sourcePath: z.string().min(1),
  pages: z.array(z.number().int().positive()).min(1),
  dpi: z.number().int().positive().default(300),
});
export type MediaStageConfig = z.infer<typeof MediaStageConfigSchema>;

// ---------------------------------------------------------------------------
// JSONL loading + validation
// ---------------------------------------------------------------------------

export class MediaOutputInvalidError extends Error {
  readonly code = "MEDIA_OUTPUT_INVALID";
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "MediaOutputInvalidError";
    this.path = path;
  }
}

/** Parse JSONL text into schema-validated rows (fail closed on any line). */
export function parseJsonl<Schema extends z.ZodType>(
  path: string,
  text: string,
  schema: Schema,
): z.output<Schema>[] {
  const rows: z.output<Schema>[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new MediaOutputInvalidError(path, `line ${index + 1} is not valid JSON: ${String(err)}`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new MediaOutputInvalidError(
        path,
        `line ${index + 1} failed schema validation: ${parsed.error.message}`,
      );
    }
    rows.push(parsed.data);
  }
  return rows;
}

export async function readJsonl<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
): Promise<z.output<Schema>[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MediaOutputInvalidError(path, "file not found");
    }
    throw err;
  }
  return parseJsonl(path, text, schema);
}

/** Streaming SHA-256 of a file (hex). */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectPromise);
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** True when the file exists and is readable. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Per-source work directory: `<private-root>/work/<source-hash>`. */
export function workDirectory(privateRoot: string, sourceHash: string): string {
  if (!HEX64.test(sourceHash)) {
    throw new Error(`Invalid source hash ${JSON.stringify(sourceHash)}`);
  }
  return join(resolve(privateRoot), "work", sourceHash);
}

// ---------------------------------------------------------------------------
// Shared spawn arguments + artifact validation (used by CLI and stages)
// ---------------------------------------------------------------------------

/** Argument array for `lexiloop_media fingerprint` (source inventory probe). */
export function fingerprintSpawnArgs(sourcePath: string): string[] {
  return ["fingerprint", "--source", resolve(sourcePath)];
}

/** Argument array for `lexiloop_media extract` on a per-source work dir. */
export function extractSpawnArgs(media: MediaStageConfig, workDir: string): string[] {
  return [
    "extract",
    "--source", resolve(media.sourcePath),
    "--pages", media.pages.join(","),
    "--out-dir", workDir,
    "--dpi", String(media.dpi),
  ];
}

/** Argument array for `lexiloop_media clean` on a per-source work dir. */
export function cleanSpawnArgs(rulePath: string, workDir: string): string[] {
  return [
    "clean",
    "--pages-jsonl", join(workDir, "pages.jsonl"),
    "--rule", resolve(rulePath),
    "--out-dir", workDir,
  ];
}

function assertSortedPagesMatch(
  artifactPath: string,
  actual: number[],
  expected: readonly number[],
): void {
  const sortedActual = [...actual].sort((a, b) => a - b);
  const sortedExpected = [...expected].sort((a, b) => a - b);
  if (
    sortedActual.length !== sortedExpected.length ||
    sortedActual.some((page, index) => page !== sortedExpected[index])
  ) {
    throw new MediaOutputInvalidError(
      artifactPath,
      `expected page(s) [${sortedExpected.join(",")}], got [${sortedActual.join(",")}]`,
    );
  }
}

/**
 * Validate `pages.jsonl` and every referenced image against the request:
 * schema, page set/order-free membership, source hash, file existence, and
 * image hashes. Throws `MediaOutputInvalidError` on any mismatch.
 */
export async function validateExtractArtifacts(
  workDir: string,
  sourceHash: string,
  expectedPages: readonly number[],
): Promise<PageRecord[]> {
  const pagesJsonlPath = join(workDir, "pages.jsonl");
  const records = await readJsonl(pagesJsonlPath, PageRecordSchema);
  assertSortedPagesMatch(
    pagesJsonlPath,
    records.map((record) => record.page),
    expectedPages,
  );
  for (const record of records) {
    if (record.source_sha256 !== sourceHash) {
      throw new MediaOutputInvalidError(
        pagesJsonlPath,
        `page ${record.page}: source hash mismatch`,
      );
    }
    const imagePath = join(workDir, record.image_path);
    if (!(await fileExists(imagePath))) {
      throw new MediaOutputInvalidError(
        pagesJsonlPath,
        `page ${record.page}: image file missing: ${record.image_path}`,
      );
    }
    if ((await sha256File(imagePath)) !== record.image_sha256) {
      throw new MediaOutputInvalidError(
        pagesJsonlPath,
        `page ${record.page}: image hash mismatch`,
      );
    }
  }
  return records;
}

/**
 * Validate `clean.jsonl` and every cleaned image: schema (including
 * `changed_pixels_outside == 0`), page set, source hash, file existence,
 * and cleaned image hashes. Throws `MediaOutputInvalidError`.
 */
export async function validateCleanArtifacts(
  workDir: string,
  sourceHash: string,
  expectedPages: readonly number[],
): Promise<CleanRecord[]> {
  const cleanJsonlPath = join(workDir, "clean.jsonl");
  const records = await readJsonl(cleanJsonlPath, CleanRecordSchema);
  assertSortedPagesMatch(
    cleanJsonlPath,
    records.map((record) => record.page),
    expectedPages,
  );
  for (const record of records) {
    if (record.source_sha256 !== sourceHash) {
      throw new MediaOutputInvalidError(
        cleanJsonlPath,
        `page ${record.page}: source hash mismatch`,
      );
    }
    const cleanedPath = join(workDir, record.cleaned_image_path);
    if (!(await fileExists(cleanedPath))) {
      throw new MediaOutputInvalidError(
        cleanJsonlPath,
        `page ${record.page}: cleaned image missing: ${record.cleaned_image_path}`,
      );
    }
    if ((await sha256File(cleanedPath)) !== record.cleaned_image_sha256) {
      throw new MediaOutputInvalidError(
        cleanJsonlPath,
        `page ${record.page}: cleaned image hash mismatch`,
      );
    }
  }
  return records;
}
