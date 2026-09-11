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
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createFileLedger, ledgerDirectory, type LedgerStore } from "./ledger";
import {
  createPythonRunner,
  extractSpawnArgs,
  cleanSpawnArgs,
  validateCleanArtifacts,
  validateExtractArtifacts,
  fileExists,
  readJsonl,
  sha256File,
  workDirectory,
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
import {
  VISUAL_OCR_QUEUE_DIR,
  ingestResult,
  loadQueue,
  queueStatus,
  unresolvedUnitKeys,
} from "./agents/visual-ocr";
import {
  SEMANTIC_QUEUE_DIR,
  ingestSemanticResult,
  loadSemanticQueue,
  pendingUnitKeys,
  semanticQueueStatus,
} from "./agents/work-packets";
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
      await runPython(extractSpawnArgs(mediaConfig, workDir));
      // Validate the JSONL artifact on disk before advancing the ledger.
      const records = await validateExtractArtifacts(workDir, sourceHash, mediaConfig.pages);
      for (const record of records) {
        deps.writeLine(
          `page ${record.page} ${record.method} ${record.width_px}x${record.height_px} ` +
            `${record.image_sha256.slice(0, 12)}`,
        );
      }
      await recordMediaStage(deps, {
        stage: createImageExtractStage({
          privateRoot: path.resolve(options.privateRoot ?? path.join(deps.workRoot, "..")),
          runPython,
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
      deps.writeLine(`media extract OK (${records.length} page(s)) -> ${path.join(workDir, "pages.jsonl")}`);
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
      await runPython(cleanSpawnArgs(rulePath, workDir));
      // Expected pages come from the upstream extract artifact.
      const extractRecords = await readJsonl(
        path.join(workDir, "pages.jsonl"),
        PageRecordSchema,
      );
      // Validate the JSONL artifact on disk before advancing the ledger.
      const records = await validateCleanArtifacts(
        workDir,
        sourceHash,
        extractRecords.map((record) => record.page),
      );
      for (const record of records) {
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
          runPython,
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
      deps.writeLine(`media clean OK (${records.length} page(s)) -> ${path.join(workDir, "clean.jsonl")}`);
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
    await withWorkLock(deps, workDir, async () => {
      await runPython(args);
      const packets = await readJsonl(path.join(qaDir, "packets.jsonl"), QaPacketSchema);
      for (const packet of packets) {
        deps.writeLine(`qa packet page ${packet.page} -> ${packet.packet_json}`);
      }
      deps.writeLine(`media qa-packets OK (${packets.length} packet(s)) -> ${qaDir}`);
    });
  } catch (err) {
    mediaFailure(deps, "qa-packets", err);
  }
}

// ---------------------------------------------------------------------------
// Agent packet queues (spec 5.6): agents visual-ocr packets|ingest|status
//
// The queue lives under `<work-dir>/agent-queue/visual-ocr/` and is consumed
// by externally-dispatched visual agents. Ingestion validates every response
// (packet hash, source hash, distinct agent run) and stores corrections as
// separate provenance records; it never mutates raw OCR evidence.
// ---------------------------------------------------------------------------

interface AgentQueueOptions {
  sourceHash: string;
  privateRoot?: string;
}

function visualOcrQueueDirFor(deps: CliDeps, options: AgentQueueOptions): string {
  return path.join(workDirFor(deps, options.privateRoot, options.sourceHash), VISUAL_OCR_QUEUE_DIR);
}

function agentFailure(deps: CliDeps, command: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  deps.writeLine(`agents visual-ocr ${command} failed: ${message}`);
  deps.exit?.(1);
}

async function executeVisualOcrPackets(
  deps: CliDeps,
  options: AgentQueueOptions,
): Promise<void> {
  try {
    const queueDir = visualOcrQueueDirFor(deps, options);
    const entries = await loadQueue(queueDir);
    for (const entry of entries) {
      deps.writeLine(
        `${entry.packet.packet_id} ${entry.status} round=${entry.packet.round} ` +
          `field=${entry.packet.field} page=${entry.packet.page_number} ` +
          `conf=${entry.packet.ocr_confidence.toFixed(2)}`,
      );
    }
    deps.writeLine(`agents visual-ocr packets OK (${entries.length} packet(s)) -> ${queueDir}`);
  } catch (err) {
    agentFailure(deps, "packets", err);
  }
}

async function executeVisualOcrIngest(
  deps: CliDeps,
  options: AgentQueueOptions & { result: string },
): Promise<void> {
  try {
    const queueDir = visualOcrQueueDirFor(deps, options);
    const raw = await readFile(options.result, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`--result is not valid JSON: ${options.result}`);
    }
    const entry = await ingestResult(queueDir, options.sourceHash, parsed);
    deps.writeLine(`agents visual-ocr ingest OK ${entry.packet.packet_id} ${entry.status}`);
  } catch (err) {
    agentFailure(deps, "ingest", err);
  }
}

async function executeVisualOcrStatus(
  deps: CliDeps,
  options: AgentQueueOptions,
): Promise<void> {
  try {
    const queueDir = visualOcrQueueDirFor(deps, options);
    const status = await queueStatus(queueDir);
    deps.writeLine(
      `packets total=${status.total} pending=${status.pending} ` +
        `resolved=${status.resolved} blocked=${status.blocked}`,
    );
    const units = unresolvedUnitKeys(await loadQueue(queueDir));
    deps.writeLine(units.length > 0 ? `blocking units: ${units.join(",")}` : "no blocking units");
  } catch (err) {
    agentFailure(deps, "status", err);
  }
}

// ---------------------------------------------------------------------------
// Semantic agent queue (spec 5.6): agents semantic packets|ingest|status
// plus agents resume.
//
// The queue lives under `<work-dir>/agent-queue/semantic/` and is consumed by
// externally-dispatched generation/review/repair agents. Ingestion validates
// every result before the stage ledger may continue: packet + source hashes,
// one resolution per packet, agent run ids distinct across the whole queue,
// review results answering the unit's current generation run, and repair
// mappings covering exactly the flagged issues. Agents — never humans —
// resolve every review decision; see docs/runbooks/content-agent-compile.md.
// ---------------------------------------------------------------------------

function semanticQueueDirFor(deps: CliDeps, options: AgentQueueOptions): string {
  return path.join(workDirFor(deps, options.privateRoot, options.sourceHash), SEMANTIC_QUEUE_DIR);
}

function semanticFailure(deps: CliDeps, command: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  deps.writeLine(`agents semantic ${command} failed: ${message}`);
  deps.exit?.(1);
}

async function executeSemanticPackets(
  deps: CliDeps,
  options: AgentQueueOptions,
): Promise<void> {
  try {
    const queueDir = semanticQueueDirFor(deps, options);
    const entries = await loadSemanticQueue(queueDir);
    for (const entry of entries) {
      deps.writeLine(
        `${entry.order.packet_id} ${entry.status} role=${entry.order.role} ` +
          `round=${entry.order.round} unit=${entry.order.unit_key} ` +
          `schema=${entry.order.schema_ref} prompt=${entry.order.prompt_path} ` +
          `out=${entry.order.output_path}`,
      );
    }
    deps.writeLine(`agents semantic packets OK (${entries.length} packet(s)) -> ${queueDir}`);
  } catch (err) {
    semanticFailure(deps, "packets", err);
  }
}

async function executeSemanticIngest(
  deps: CliDeps,
  options: AgentQueueOptions & { result: string },
): Promise<void> {
  try {
    const queueDir = semanticQueueDirFor(deps, options);
    const raw = await readFile(options.result, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`--result is not valid JSON: ${options.result}`);
    }
    const entry = await ingestSemanticResult(queueDir, options.sourceHash, parsed);
    deps.writeLine(`agents semantic ingest OK ${entry.order.packet_id} ${entry.status}`);
  } catch (err) {
    semanticFailure(deps, "ingest", err);
  }
}

async function executeSemanticStatus(
  deps: CliDeps,
  options: AgentQueueOptions,
): Promise<void> {
  try {
    const queueDir = semanticQueueDirFor(deps, options);
    const status = await semanticQueueStatus(queueDir);
    deps.writeLine(
      `packets total=${status.total} pending=${status.pending} resolved=${status.resolved}`,
    );
    for (const role of ["generation", "review", "repair"] as const) {
      const roleStatus = status.by_role[role];
      deps.writeLine(
        `${role} total=${roleStatus.total} pending=${roleStatus.pending} resolved=${roleStatus.resolved}`,
      );
    }
    const units = pendingUnitKeys(await loadSemanticQueue(queueDir));
    deps.writeLine(units.length > 0 ? `blocking units: ${units.join(",")}` : "no blocking units");
  } catch (err) {
    semanticFailure(deps, "status", err);
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

  const agents = program
    .command("agents")
    .description("externally-dispatched agent packet queues (spec 5.6)");
  const visualOcr = agents
    .command("visual-ocr")
    .description("visual OCR review of critical fields (headword/phonetic)");
  const queueSourceOption = (command: Command): Command =>
    command
      .requiredOption("--source-hash <hash>", "source content hash (PDF SHA-256)")
      .option("--private-root <dir>", "private root holding work/<source-hash> directories");

  queueSourceOption(
    visualOcr
      .command("packets")
      .description("list review packets and their resolution status"),
  ).action(async (options: AgentQueueOptions) => {
    await executeVisualOcrPackets(deps, options);
  });

  queueSourceOption(
    visualOcr
      .command("ingest")
      .description("validate and store one strict agent result JSON"),
  )
    .requiredOption("--result <path>", "path to the agent result JSON file")
    .action(async (options: AgentQueueOptions & { result: string }) => {
      await executeVisualOcrIngest(deps, options);
    });

  queueSourceOption(
    visualOcr
      .command("status")
      .description("queue counts and units blocked pending review"),
  ).action(async (options: AgentQueueOptions) => {
    await executeVisualOcrStatus(deps, options);
  });

  const semantic = agents
    .command("semantic")
    .description("semantic content agents: generation, independent review, repair (spec 5.6)");

  queueSourceOption(
    semantic
      .command("packets")
      .description("list semantic work packets and their resolution status"),
  ).action(async (options: AgentQueueOptions) => {
    await executeSemanticPackets(deps, options);
  });

  queueSourceOption(
    semantic
      .command("ingest")
      .description("validate and store one strict agent result JSON"),
  )
    .requiredOption("--result <path>", "path to the agent result JSON file")
    .action(async (options: AgentQueueOptions & { result: string }) => {
      await executeSemanticIngest(deps, options);
    });

  queueSourceOption(
    semantic
      .command("status")
      .description("queue counts per role and units blocked pending agents"),
  ).action(async (options: AgentQueueOptions) => {
    await executeSemanticStatus(deps, options);
  });

  agents
    .command("resume")
    .description("resume the compile pipeline after ingesting agent results (same semantics as `run`)")
    .requiredOption("--source-hash <hash>", "source content hash (PDF SHA-256)")
    .option("--through <stage>", "run only the contiguous prefix up to this stage")
    .action(async (options: RunCommandOptions) => {
      await executeRun(deps, options);
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
