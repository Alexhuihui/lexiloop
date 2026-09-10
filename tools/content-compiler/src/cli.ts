/**
 * Content Compiler CLI (spec 5, Phase 2).
 *
 * A single Commander root exported as `buildCli(deps)` so later tasks extend
 * this same function with `media`, `agents`, `tts`, and `release` command
 * groups. All command handlers receive the filesystem root, stage registry,
 * ledger factory, logger, and output sink through `CliDeps` — no hardcoded
 * paths inside handlers, which keeps the CLI fully testable.
 *
 * Executed directly via the pinned `tsx` dependency: the package `cli` script
 * and the root `pnpm compiler` script both run `tsx src/cli.ts`.
 */
import { Command, CommanderError } from "commander";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFileLedger, ledgerDirectory, type LedgerStore } from "./ledger";
import {
  createPythonRunner,
  fileExists,
  readJsonl,
  sha256File,
  workDirectory,
  CleanRecordSchema,
  DEFAULT_RULE_PATH,
  MediaOutputInvalidError,
  MediaSpawnError,
  MediaStageConfigSchema,
  PageRecordSchema,
  QaPacketSchema,
  REPO_ROOT,
  type MediaStageConfig,
  type SpawnPythonFn,
} from "./media";
import { collectEnvSecrets, createCompilerLogger, type CompilerLogger } from "./logging";
import {
  configVersionHash,
  resolveStagePrefix,
  runPipeline,
  acquireWorkLock,
  PipelineLockError,
  type ReleaseGate,
} from "./pipeline";
import {
  createImageExtractStage,
  createWatermarkCleanStage,
  PRODUCTION_STAGE_DEPENDENCIES,
  RELEASE_STAGE,
  getProductionStages,
} from "./stage-registry";
import { hashJson, type AnyStage, type StageRunContext } from "./stage";

export const DEFAULT_WORK_ROOT = path.join(".lexiloop-private", "work");

export interface CliDeps {
  /** Root directory holding per-source work directories (ledger et al). */
  workRoot: string;
  /** Registered stages in compile order; traversal is a contiguous prefix. */
  stages: readonly AnyStage[];
  createLedger(sourceHash: string): LedgerStore;
  logger: CompilerLogger;
  /** Human-readable output sink (one line per call). */
  writeLine(line: string): void;
  /** Called with a nonzero code when a command fails; default is a no-op. */
  exit?(code: number): void;
  /**
   * Runner for the Python media workers (argument-array spawn). Defaults to
   * `createPythonRunner()`; tests inject a stub.
   */
  runPython?: SpawnPythonFn;
}

interface RunCommandOptions {
  sourceHash: string;
  through?: string;
}

const hashSummary = (hash: string | null): string => (hash ? hash.slice(0, 12) : "-");

function releaseGateFor(): ReleaseGate {
  return {
    stage: RELEASE_STAGE,
    requires: PRODUCTION_STAGE_DEPENDENCIES[RELEASE_STAGE],
  };
}

function resolveThrough(deps: CliDeps, through: string | undefined): string | undefined {
  if (!through) return undefined;
  resolveStagePrefix(deps.stages, through); // validates registration + contiguity
  return through;
}

async function executeRun(deps: CliDeps, options: RunCommandOptions): Promise<void> {
  const through = resolveThrough(deps, options.through);
  const ledger = deps.createLedger(options.sourceHash);
  const report = await runPipeline(deps.stages, ledger, {
    sourceHash: options.sourceHash,
    through,
    releaseGate: releaseGateFor(),
    logger: deps.logger,
    // Single-writer guard: one advisory lockfile per source work directory.
    lockDirectory: path.join(deps.workRoot, options.sourceHash),
  });
  for (const outcome of report.results) {
    const suffix = outcome.error_code ? ` error=${outcome.error_code}` : "";
    deps.writeLine(`${outcome.name} ${outcome.status}${suffix}`);
  }
  if (report.status === "COMPLETED") {
    deps.writeLine(`run ${report.runId} COMPLETED`);
  } else {
    deps.writeLine(`run ${report.runId} ${report.status} at ${report.stoppedAt ?? "?"}`);
    deps.exit?.(1);
  }
}

async function executePlan(deps: CliDeps, options: RunCommandOptions): Promise<void> {
  const through = resolveThrough(deps, options.through);
  const ledger = deps.createLedger(options.sourceHash);
  const prefix = through ? resolveStagePrefix(deps.stages, through) : deps.stages;
  // Dry-run caveat: stage input hashes are computed without upstream output
  // context (no artifacts are loaded), matching the pipeline's own hashing
  // for stages that key their inputs on run config.
  const config: Record<string, unknown> = {};
  for (const stage of prefix) {
    const entry = await ledger.load(stage.name);
    const inputHash = await stage.computeInputHash({
      runId: "plan",
      sourceHash: options.sourceHash,
      config,
      ledger,
      logger: deps.logger,
      upstream: null,
    });
    const skipped =
      entry?.status === "PASSED" &&
      entry.input_hash === inputHash &&
      entry.config_version_hash === configVersionHash(stage);
    // plan is a dry-run: it never writes.
    deps.writeLine(
      skipped
        ? `${stage.name} would-skip (PASSED, input unchanged)`
        : `${stage.name} would-run (${entry?.status ?? "no entry"})`,
    );
  }
}

async function executeStatus(deps: CliDeps, sourceHash: string): Promise<void> {
  const ledger = deps.createLedger(sourceHash);
  for (const stage of deps.stages) {
    const entry = await ledger.load(stage.name);
    if (!entry) {
      deps.writeLine(`${stage.name} PENDING attempts=0`);
      continue;
    }
    const errorCode = entry.error_code ?? "-";
    deps.writeLine(
      `${stage.name} ${entry.status} attempts=${entry.attempts} ` +
        `input=${hashSummary(entry.input_hash)} output=${hashSummary(entry.output_hash)} ` +
        `error=${errorCode} updated=${entry.updated_at}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Media commands (spec 5.3): extract / clean / qa-packets
//
// Each command spawns the versioned Python module with an ARGUMENT ARRAY
// (never a shell string: the real source path contains spaces and CJK
// punctuation), validates the JSONL artifacts on disk with Zod, and only
// then records a PASSED ledger entry for the corresponding stage. Originals
// and cleaned images stay inside the git-ignored private root; nothing in
// this chain ever writes a PDF.
// ---------------------------------------------------------------------------

interface MediaSource {
  sourceHash: string;
  sourcePath: string | null;
}

function parsePageList(value: string): number[] {
  const pages = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => Number.parseInt(item, 10));
  if (pages.length === 0 || pages.some((page) => !Number.isInteger(page) || page < 1)) {
    throw new Error(`--pages must be a comma-separated list of 1-based page numbers`);
  }
  if (new Set(pages).size !== pages.length) {
    throw new Error(`--pages contains duplicate page numbers`);
  }
  return pages;
}

async function resolveMediaSource(
  source: string | undefined,
  sourceHashOption: string | undefined,
): Promise<MediaSource> {
  if (sourceHashOption) {
    if (!/^[0-9a-f]{64}$/.test(sourceHashOption)) {
      throw new Error("--source-hash must be a 64-character sha-256 hex string");
    }
    return { sourceHash: sourceHashOption, sourcePath: null };
  }
  if (!source) {
    throw new Error("either --source or --source-hash is required");
  }
  const resolved = path.resolve(source);
  if (!(await fileExists(resolved))) {
    throw new Error(`source PDF not found: ${resolved}`);
  }
  return { sourceHash: await sha256File(resolved), sourcePath: resolved };
}

function workDirFor(deps: CliDeps, privateRoot: string | undefined, sourceHash: string): string {
  // --private-root (as used by the smoke run) or the configured work root.
  // Relative private roots resolve against the repo root because `pnpm
  // compiler` executes inside the package directory.
  if (privateRoot) {
    const resolved =
      path.isAbsolute(privateRoot) ? privateRoot : path.join(REPO_ROOT, privateRoot);
    return workDirectory(resolved, sourceHash);
  }
  return path.join(deps.workRoot, sourceHash);
}

async function withWorkLock<T>(
  deps: CliDeps,
  workDir: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  let lock;
  try {
    lock = await acquireWorkLock({ directory: workDir });
  } catch (err) {
    if (err instanceof PipelineLockError) {
      deps.writeLine(`media: ${err.message}`);
      deps.exit?.(1);
      return null;
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/** Record a PASSED ledger entry whose hashes match a pipeline run of the stage. */
async function recordMediaStage(
  deps: CliDeps,
  params: {
    stage: AnyStage;
    sourceHash: string;
    mediaConfig: Record<string, unknown>;
    output: unknown;
  },
): Promise<void> {
  const ledger = deps.createLedger(params.sourceHash);
  const runId = `media-${new Date().toISOString()}`;
  const ctx: StageRunContext = {
    runId,
    sourceHash: params.sourceHash,
    config: { media: params.mediaConfig },
    ledger,
    logger: deps.logger,
    upstream: null,
  };
  const now = new Date().toISOString();
  await ledger.save({
    stage: params.stage.name,
    status: "PASSED",
    compile_run_id: runId,
    input_hash: await params.stage.computeInputHash(ctx),
    config_version_hash: configVersionHash(params.stage),
    output_hash: hashJson(params.output),
    attempts: 1,
    started_at: now,
    finished_at: now,
    updated_at: now,
    error_code: null,
  });
}

function mediaFailure(deps: CliDeps, command: string, err: unknown): void {
  if (err instanceof MediaSpawnError || err instanceof MediaOutputInvalidError) {
    deps.writeLine(`media ${command} failed: ${err.message}`);
  } else if (err instanceof Error) {
    deps.writeLine(`media ${command} failed: ${err.message}`);
  } else {
    deps.writeLine(`media ${command} failed: ${String(err)}`);
  }
  deps.exit?.(1);
}

async function executeMediaExtract(
  deps: CliDeps,
  options: { source?: string; pages: string; privateRoot?: string; dpi?: string },
): Promise<void> {
  const runPython = deps.runPython ?? createPythonRunner();
  try {
    const pages = parsePageList(options.pages);
    const { sourceHash, sourcePath } = await resolveMediaSource(options.source, undefined);
    if (!sourcePath) throw new Error("media extract requires --source");
    const workDir = workDirFor(deps, options.privateRoot, sourceHash);
    const mediaConfig: MediaStageConfig = MediaStageConfigSchema.parse({
      sourcePath,
      pages,
      dpi: options.dpi ? Number.parseInt(options.dpi, 10) : 300,
    });
    await withWorkLock(deps, workDir, async () => {
      await runPython([
        "extract",
        "--source", mediaConfig.sourcePath,
        "--pages", mediaConfig.pages.join(","),
        "--out-dir", workDir,
        "--dpi", String(mediaConfig.dpi),
      ]);
      // Validate the JSONL artifact on disk before advancing the ledger.
      const pagesJsonlPath = path.join(workDir, "pages.jsonl");
      const records = await readJsonl(pagesJsonlPath, PageRecordSchema);
      if (records.length !== mediaConfig.pages.length) {
        throw new MediaOutputInvalidError(
          pagesJsonlPath,
          `expected ${mediaConfig.pages.length} record(s), got ${records.length}`,
        );
      }
      for (const record of records) {
        if (record.source_sha256 !== sourceHash) {
          throw new MediaOutputInvalidError(
            pagesJsonlPath,
            `page ${record.page}: source hash mismatch`,
          );
        }
        const imagePath = path.join(workDir, record.image_path);
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
        deps.writeLine(
          `page ${record.page} ${record.method} ${record.width_px}x${record.height_px} ` +
            `${record.image_sha256.slice(0, 12)}`,
        );
      }
      await recordMediaStage(deps, {
        stage: createImageExtractStage({
          privateRoot: path.resolve(options.privateRoot ?? path.join(deps.workRoot, "..")),
        }),
        sourceHash,
        mediaConfig,
        output: {
          source_sha256: sourceHash,
          pages_jsonl: "pages.jsonl",
          pages: records.map((record) => ({
            page: record.page,
            method: record.method,
            width_px: record.width_px,
            height_px: record.height_px,
            image_sha256: record.image_sha256,
          })),
        },
      });
      deps.writeLine(`media extract OK (${records.length} page(s)) -> ${pagesJsonlPath}`);
    });
  } catch (err) {
    mediaFailure(deps, "extract", err);
  }
}

async function executeMediaClean(
  deps: CliDeps,
  options: { source?: string; sourceHash?: string; rule?: string; privateRoot?: string },
): Promise<void> {
  const runPython = deps.runPython ?? createPythonRunner();
  try {
    const { sourceHash, sourcePath } = await resolveMediaSource(options.source, options.sourceHash);
    const workDir = workDirFor(deps, options.privateRoot, sourceHash);
    // Relative rule paths resolve against the repo root (see workDirFor).
    const rule = options.rule ?? DEFAULT_RULE_PATH;
    const rulePath = path.isAbsolute(rule) ? rule : path.join(REPO_ROOT, rule);
    await withWorkLock(deps, workDir, async () => {
      await runPython([
        "clean",
        "--pages-jsonl", path.join(workDir, "pages.jsonl"),
        "--rule", rulePath,
        "--out-dir", workDir,
      ]);
      // Validate the JSONL artifact on disk before advancing the ledger.
      const cleanJsonlPath = path.join(workDir, "clean.jsonl");
      const records = await readJsonl(cleanJsonlPath, CleanRecordSchema);
      for (const record of records) {
        if (record.source_sha256 !== sourceHash) {
          throw new MediaOutputInvalidError(
            cleanJsonlPath,
            `page ${record.page}: source hash mismatch`,
          );
        }
        const cleanedPath = path.join(workDir, record.cleaned_image_path);
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
        deps.writeLine(
          `page ${record.page} cleaned regions=[${record.region_names.join(",")}] ` +
            `changed=${record.changed_pixels} mask_bounds=[${(record.mask_bounds ?? []).map((v) => v.toFixed(3)).join(",")}]` +
            `${record.body_overlap_detected ? " BODY-OVERLAP" : ""}`,
        );
      }
      const overlapPages = records.filter((r) => r.body_overlap_detected).map((r) => r.page);
      if (overlapPages.length > 0) {
        deps.writeLine(
          `media clean WARNING: watermark/body overlap on page(s) ${overlapPages.join(",")}; ` +
            `route to the agent repair loop before OCR acceptance`,
        );
      }
      await recordMediaStage(deps, {
        stage: createWatermarkCleanStage({
          privateRoot: path.resolve(options.privateRoot ?? path.join(deps.workRoot, "..")),
          rulePath,
        }),
        sourceHash,
        // Matches pipeline config when --source is provided; with only a
        // --source-hash the placeholder keeps the entry deterministic.
        mediaConfig: {
          sourcePath: sourcePath ?? `(source-hash:${sourceHash})`,
          pages: records.map((record) => record.page),
          dpi: 300,
        },
        output: {
          source_sha256: sourceHash,
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
          body_overlap_pages: overlapPages,
        },
      });
      deps.writeLine(`media clean OK (${records.length} page(s)) -> ${cleanJsonlPath}`);
    });
  } catch (err) {
    mediaFailure(deps, "clean", err);
  }
}

async function executeMediaQaPackets(
  deps: CliDeps,
  options: { source?: string; sourceHash?: string; pages?: string; privateRoot?: string },
): Promise<void> {
  const runPython = deps.runPython ?? createPythonRunner();
  try {
    const { sourceHash } = await resolveMediaSource(options.source, options.sourceHash);
    const workDir = workDirFor(deps, options.privateRoot, sourceHash);
    const qaDir = path.join(workDir, "qa");
    const args = ["qa-packets", "--clean-jsonl", path.join(workDir, "clean.jsonl"), "--out-dir", qaDir];
    if (options.pages) {
      args.push("--pages", parsePageList(options.pages).join(","));
    }
    await runPython(args);
    const packets = await readJsonl(path.join(qaDir, "packets.jsonl"), QaPacketSchema);
    for (const packet of packets) {
      deps.writeLine(`qa packet page ${packet.page} -> ${packet.packet_json}`);
    }
    deps.writeLine(`media qa-packets OK (${packets.length} packet(s)) -> ${qaDir}`);
  } catch (err) {
    mediaFailure(deps, "qa-packets", err);
  }
}

export function buildCli(deps: CliDeps): Command {
  const program = new Command();
  program
    .name("content-compiler")
    .description("LexiLoop Content Compiler: resumable stage pipeline")
    .exitOverride()
    .showHelpAfterError("(run 'content-compiler --help' for the full usage)");

  const sourceHashOption = (command: Command): Command =>
    command
      .requiredOption("--source-hash <hash>", "source content hash (PDF SHA-256)")
      .option("--through <stage>", "run only the contiguous prefix up to this stage");

  sourceHashOption(
    program.command("plan").description("dry-run: print the stage order and what would run"),
  ).action(async (options: RunCommandOptions) => {
    await executePlan(deps, options);
  });

  sourceHashOption(
    program
      .command("run")
      .description("run the pipeline, resuming from PASSED stages with unchanged inputs"),
  ).action(async (options: RunCommandOptions) => {
    await executeRun(deps, options);
  });

  sourceHashOption(
    program
      .command("resume")
      .description("resume an interrupted compile (same semantics as run)"),
  ).action(async (options: RunCommandOptions) => {
    await executeRun(deps, options);
  });

  program
    .command("status")
    .description("print the current ledger state of every registered stage")
    .requiredOption("--source-hash <hash>", "source content hash (PDF SHA-256)")
    .action(async (options: RunCommandOptions) => {
      await executeStatus(deps, options.sourceHash);
    });

  const media = program
    .command("media")
    .description("page-image extraction and watermark cleanup workers (versioned Python module)");

  media
    .command("extract")
    .description("extract original page images (no re-encoding when possible; no PDF output)")
    .requiredOption("--source <path>", "path to the source PDF")
    .requiredOption("--pages <list>", "comma-separated 1-based page numbers")
    .option("--private-root <dir>", "private root holding work/<source-hash> directories")
    .option("--dpi <n>", "DPI for the single render fallback", "300")
    .action(async (options) => {
      await executeMediaExtract(deps, options);
    });

  media
    .command("clean")
    .description("apply the versioned watermark rule strictly inside declared masks")
    .option("--source <path>", "path to the source PDF (hashes the file)")
    .option("--source-hash <hash>", "source content hash when the PDF path is unavailable")
    .option("--rule <path>", "versioned watermark rule JSON", DEFAULT_RULE_PATH)
    .option("--private-root <dir>", "private root holding work/<source-hash> directories")
    .action(async (options) => {
      await executeMediaClean(deps, options);
    });

  media
    .command("qa-packets")
    .description("emit visual-QA packets (JSON + previews) for cleaned pages")
    .option("--source <path>", "path to the source PDF (hashes the file)")
    .option("--source-hash <hash>", "source content hash when the PDF path is unavailable")
    .option("--pages <list>", "optional comma-separated page filter")
    .option("--private-root <dir>", "private root holding work/<source-hash> directories")
    .action(async (options) => {
      await executeMediaQaPackets(deps, options);
    });

  return program;
}

/** Wire the production dependencies; only this function knows real paths. */
export async function main(argv: readonly string[]): Promise<void> {
  const dotenv = await import("dotenv");
  dotenv.config();
  const logger = createCompilerLogger({
    sink: (line) => process.stdout.write(`${line}\n`),
    secrets: collectEnvSecrets(),
  });
  // Resolved against the repo root: `pnpm compiler` executes inside the
  // package directory, but private state always lives at the repo root.
  const workRoot = path.join(REPO_ROOT, ".lexiloop-private", "work");
  const deps: CliDeps = {
    workRoot,
    stages: getProductionStages({ privateRoot: path.join(REPO_ROOT, ".lexiloop-private") }),
    createLedger: (sourceHash) =>
      createFileLedger({ directory: ledgerDirectory(workRoot, sourceHash) }),
    logger,
    writeLine: (line) => process.stdout.write(`${line}\n`),
    exit: (code) => {
      process.exitCode = code;
    },
  };
  const program = buildCli(deps);
  if (argv.length === 0) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync([...argv], { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) {
      process.exitCode = err.exitCode;
      if (err.code !== "commander.help" && err.code !== "commander.helpDisplayed") {
        process.stderr.write(`${err.message}\n`);
      }
      return;
    }
    if (err instanceof Error) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
