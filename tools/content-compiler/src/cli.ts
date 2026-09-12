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
  CardGenerateOutputSchema,
  createCardGenerateStage,
  createAudioValidateStage,
  createTtsSynthesizeStage,
  AudioValidateOutputSchema,
  DEFAULT_CARDS_CONFIG_PATH,
  DEFAULT_TTS_CONFIG_PATH,
  LLCY_2024_EXPECTED_PAGE_COUNT,
  SourceFingerprintOutputSchema,
  TtsSynthesizeOutputSchema,
  PRODUCTION_STAGE_DEPENDENCIES,
  RELEASE_STAGE,
  getProductionStages,
} from "./stage-registry";
import { buildTtsPlan, collectTtsItems, readTtsConfig } from "./tts/plan";
import { loadAudioManifest } from "./tts/cache";
import type { TtsFetchFn } from "./tts/provider";
import {
  VISUAL_OCR_QUEUE_DIR,
  ingestResult,
  loadQueue,
  queueStatus,
  unresolvedUnitKeys,
} from "./agents/visual-ocr";
import {
  SEMANTIC_QUEUE_DIR,
  WorkPacketError,
  ingestSemanticResult,
  loadSemanticQueue,
  loadUnitWorkloads,
  pendingUnitKeys,
  semanticQueueStatus,
} from "./agents/work-packets";
import { hashJson, StageError, type AnyStage, type StageRunContext } from "./stage";
import { AliasGraphError } from "@lexiloop/domain";
import type { LexiloopDatabase } from "@lexiloop/db";
import {
  ReleaseMetadataConfigSchema,
  ReleasePackageOutputSchema,
  createReleasePackageStage,
} from "./release/package";
import { verifyBundle } from "./release/validate";
import { AliasFileSchema } from "./release/aliases";
import {
  PublishError,
  activateRelease,
  rollbackRelease,
  smokeRelease,
  stageBundle,
  type R2AudioStore,
} from "./release/publish";

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
  /**
   * Injectable HTTP boundary for the TTS provider (tests); defaults to global
   * fetch. Never used by `tts plan`, and by `tts synthesize` only with
   * explicit `--execute`.
   */
  ttsFetchFn?: TtsFetchFn;
  /**
   * Injectable TTS API key (tests); undefined resolves MIMO_API_KEY / the
   * legacy local mimo-key from the environment at run time. The value is
   * never logged and never lands in any artifact.
   */
  ttsApiKey?: string | null;
  /**
   * Injectable D1 + R2 dependencies for the `release` publishing commands
   * (tests inject fakes; production wiring comes from the publish script).
   * Without them, `release stage|smoke|activate|rollback` fail closed.
   */
  release?: { db: LexiloopDatabase; r2: R2AudioStore };
}

interface RunCommandOptions {
  /** Source content hash; required unless --source is given. */
  sourceHash?: string;
  /** Source PDF path: hashed for the run and wired into SOURCE_FINGERPRINT. */
  source?: string;
  /** Page scope for the media stages; defaults to every page of the source. */
  pages?: string;
  privateRoot?: string;
  through?: string;
}

/**
 * Resolved scope of a plan/run invocation: the content identity, the stages
 * (rebuilt when --source/--private-root override the default wiring), and the
 * work root the ledger and lock live under.
 */
interface RunScope {
  sourceHash: string;
  sourcePath: string | null;
  stages: readonly AnyStage[];
  workRoot: string;
  /** Parsed --pages; null means "every page of the source". */
  pages: number[] | null;
}

/** Stage-name option values accept lowercase/hyphenated forms. */
function normalizeStageName(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_");
}

/**
 * Resolve the run scope shared by plan/run/resume/agents resume. The stages
 * are rebuilt whenever --source or --private-root overrides the default
 * wiring so SOURCE_FINGERPRINT receives the PDF path and every private
 * artifact lands under the requested root.
 */
async function resolveRunScope(deps: CliDeps, options: RunCommandOptions): Promise<RunScope> {
  if (options.source === undefined && options.sourceHash === undefined) {
    throw new Error("either --source or --source-hash is required");
  }
  let sourceHash: string;
  let sourcePath: string | null = null;
  if (options.source !== undefined) {
    // --source: hash the file (its identity) and wire it into the stages.
    const resolved = await resolveMediaSource(options.source, options.sourceHash);
    sourceHash = resolved.sourceHash;
    sourcePath = resolved.sourcePath;
  } else {
    // --source-hash only: resume/status flows keyed on the given identity.
    sourceHash = options.sourceHash!;
  }
  const privateRoot = resolveRootPath(options.privateRoot, path.join(".lexiloop-private"));
  const overridesScope = options.source !== undefined || options.privateRoot !== undefined;
  const stages = overridesScope
    ? getProductionStages({
        privateRoot,
        ...(deps.runPython !== undefined ? { runPython: deps.runPython } : {}),
        ...(sourcePath !== null ? { sourcePath } : {}),
      })
    : deps.stages;
  const workRoot = options.privateRoot !== undefined ? path.join(privateRoot, "work") : deps.workRoot;
  return {
    sourceHash,
    sourcePath,
    stages,
    workRoot,
    pages: options.pages !== undefined ? parsePageList(options.pages) : null,
  };
}

/**
 * Media run config for plan/run invoked with --source: the requested page
 * scope, defaulting to every page (the fingerprint already reported the
 * count, so plan surfaces it without guessing).
 */
function mediaConfigFor(scope: RunScope, pageCount: number | null): MediaStageConfig | null {
  if (!scope.sourcePath) return null;
  const pages = scope.pages ?? (pageCount !== null ? rangePages(pageCount) : null);
  if (!pages) return null;
  return MediaStageConfigSchema.parse({ sourcePath: scope.sourcePath, pages, dpi: 300 });
}

function rangePages(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}

const hashSummary = (hash: string | null): string => (hash ? hash.slice(0, 12) : "-");

function releaseGateFor(): ReleaseGate {
  return {
    stage: RELEASE_STAGE,
    requires: PRODUCTION_STAGE_DEPENDENCIES[RELEASE_STAGE],
  };
}

function resolveThrough(stages: readonly AnyStage[], through: string | undefined): string | undefined {
  if (!through) return undefined;
  // Accept the exact registered name first, then ergonomic forms like
  // "structure-normalize" for "STRUCTURE_NORMALIZE"; unknown names throw.
  const exact = stages.some((stage) => stage.name === through);
  const candidate = exact ? through : normalizeStageName(through);
  resolveStagePrefix(stages, candidate); // validates registration + contiguity
  return candidate;
}

async function executeRun(deps: CliDeps, options: RunCommandOptions): Promise<void> {
  const scope = await resolveRunScope(deps, options);
  const through = resolveThrough(scope.stages, options.through);
  const ledger = deps.createLedger(scope.sourceHash);
  // Media stages key their inputs on the run config, so a --source run pins
  // the page scope here; without --source the run proceeds on ledger
  // provenance alone (resume of media work already recorded).
  let config: Record<string, unknown> = {};
  if (scope.sourcePath) {
    const pageCount = await fingerprintPageCountFor(deps, scope);
    const media = mediaConfigFor(scope, pageCount);
    if (media) config = { media };
  }
  const report = await runPipeline(scope.stages, ledger, {
    sourceHash: scope.sourceHash,
    through,
    config,
    releaseGate: releaseGateFor(),
    logger: deps.logger,
    // Single-writer guard: one advisory lockfile per source work directory.
    lockDirectory: path.join(scope.workRoot, scope.sourceHash),
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

/**
 * Page count for a --source run: from the parsed --pages when given,
 * otherwise from the SOURCE_FINGERPRINT worker (read-only probe) so a full
 * compile can request every page without knowing the count up front.
 */
async function fingerprintPageCountFor(deps: CliDeps, scope: RunScope): Promise<number | null> {
  if (scope.pages !== null) return null;
  if (!scope.sourcePath) return null;
  const stage = scope.stages.find((entry) => entry.name === "SOURCE_FINGERPRINT");
  if (!stage) return null;
  const output = SourceFingerprintOutputSchema.parse(
    await stage.run(undefined, {
      runId: "scope",
      sourceHash: scope.sourceHash,
      config: {},
      ledger: deps.createLedger(scope.sourceHash),
      logger: deps.logger,
      upstream: null,
    }),
  );
  return output.page_count;
}

async function executePlan(deps: CliDeps, options: RunCommandOptions): Promise<void> {
  const scope = await resolveRunScope(deps, options);
  const through = resolveThrough(scope.stages, options.through);
  const ledger = deps.createLedger(scope.sourceHash);
  const prefix = through ? resolveStagePrefix(scope.stages, through) : scope.stages;

  // Source inventory (read-only, no external call): hash, page count, and
  // the 440-page expectation check from the approved source inventory.
  let media: MediaStageConfig | null = null;
  if (scope.sourcePath) {
    deps.writeLine(`source ${scope.sourceHash}`);
    const pageCount = await fingerprintPageCountFor(deps, scope);
    deps.writeLine(
      pageCount === null
        ? "pages unknown (--pages not given and no fingerprint output)"
        : `pages ${pageCount} (expected ${LLCY_2024_EXPECTED_PAGE_COUNT}) ` +
            (pageCount === LLCY_2024_EXPECTED_PAGE_COUNT ? "PASS" : "FAIL"),
    );
    if (pageCount !== null && pageCount !== LLCY_2024_EXPECTED_PAGE_COUNT) {
      deps.writeLine(
        `plan FAIL: source page count ${pageCount} differs from the approved inventory ` +
          `(${LLCY_2024_EXPECTED_PAGE_COUNT}); stop and re-verify the source`,
      );
      deps.exit?.(1);
    }
    if (pageCount !== null) {
      deps.writeLine(`estimate ocr_pages=${pageCount} (PP-StructureV3, CPU)`);
      media = mediaConfigFor(scope, pageCount);
      await printTtsEstimate(deps, scope);
    }
  }

  // Dry-run caveat: stage input hashes are computed without upstream output
  // context (no artifacts are loaded), matching the pipeline's own hashing
  // for stages that key their inputs on run config.
  const config: Record<string, unknown> = media ? { media } : {};
  for (const stage of prefix) {
    const entry = await ledger.load(stage.name);
    let inputHash: string | null = null;
    try {
      inputHash = await stage.computeInputHash({
        runId: "plan",
        sourceHash: scope.sourceHash,
        config,
        ledger,
        logger: deps.logger,
        upstream: null,
      });
    } catch {
      // A stage whose inputs are not materialized yet simply cannot be
      // up-to-date; inputHash stays null and the stage reports would-run.
    }
    const skipped =
      inputHash !== null &&
      entry?.status === "PASSED" &&
      entry.input_hash === inputHash &&
      entry.config_version_hash === configVersionHash(stage);
    // plan is a dry-run: it never writes.
    deps.writeLine(
      skipped
        ? `${stage.name} would-skip (PASSED, input unchanged, config ${stage.configVersion})`
        : `${stage.name} would-run (${entry?.status ?? "no entry"}, config ${stage.configVersion})`,
    );
  }
}

/** Estimated TTS work from the validated content, when it already exists. */
async function printTtsEstimate(deps: CliDeps, scope: RunScope): Promise<void> {
  const workDir = path.join(scope.workRoot, scope.sourceHash);
  try {
    const workloads = await loadUnitWorkloads(workDir);
    deps.writeLine(`estimate tts_items=${collectTtsItems(workloads).length}`);
  } catch {
    deps.writeLine("estimate tts_items=unavailable (no validated content yet)");
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
  label = "media",
): Promise<T | null> {
  let lock;
  try {
    lock = await acquireWorkLock({ directory: workDir });
  } catch (err) {
    if (err instanceof PipelineLockError) {
      deps.writeLine(`${label}: ${err.message}`);
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

// ---------------------------------------------------------------------------
// Card generation (spec 5.7): cards generate
//
// The command runs the SAME CARD_GENERATE stage handler the pipeline uses —
// including its fail-closed preconditions: cards are only produced once every
// target Unit exited the four agent review gates as PASSED, and a Unit with a
// learnable word that has zero cards is blocked terminally. The recorded
// ledger entry mirrors the pipeline's own input-hash semantics (upstream
// REPAIR_LOOP provenance included), so a subsequent `run`/`resume` stays
// resume-consistent with what `cards generate` recorded.
// ---------------------------------------------------------------------------

function stageErrorCode(err: unknown): string | null {
  if (err instanceof StageError || err instanceof WorkPacketError) return err.code;
  return null;
}

interface CardsGenerateOptions {
  sourceHash: string;
  privateRoot?: string;
  config?: string;
}

async function executeCardsGenerate(deps: CliDeps, options: CardsGenerateOptions): Promise<void> {
  try {
    if (!/^[0-9a-f]{64}$/.test(options.sourceHash)) {
      throw new Error("--source-hash must be a 64-character sha-256 hex string");
    }
    const sourceHash = options.sourceHash;
    const workDir = workDirFor(deps, options.privateRoot, sourceHash);
    const configOption = options.config ?? DEFAULT_CARDS_CONFIG_PATH;
    const cardsConfigPath = path.isAbsolute(configOption) ? configOption : path.join(REPO_ROOT, configOption);
    const stage = createCardGenerateStage({
      privateRoot: path.resolve(options.privateRoot ?? path.join(deps.workRoot, "..")),
      cardsConfigPath,
    });
    const ledger = deps.createLedger(sourceHash);
    await withWorkLock(deps, workDir, async () => {
      // Mirror the pipeline's upstream context so the recorded input hash is
      // exactly what a `run`/`resume` would compute for CARD_GENERATE.
      const upstreamEntry = await ledger.load("REPAIR_LOOP");
      const ctx: StageRunContext = {
        runId: `cards-${new Date().toISOString()}`,
        sourceHash,
        config: {},
        ledger,
        logger: deps.logger,
        upstream:
          upstreamEntry?.status === "PASSED" && upstreamEntry.output_hash !== null
            ? { stage: "REPAIR_LOOP", outputHash: upstreamEntry.output_hash }
            : null,
      };
      const inputHash = await stage.computeInputHash(ctx);
      const existing = await ledger.load(stage.name);
      if (
        existing?.status === "PASSED" &&
        existing.input_hash === inputHash &&
        existing.config_version_hash === configVersionHash(stage)
      ) {
        deps.writeLine("cards generate up-to-date (PASSED, input unchanged)");
        return;
      }
      const output = CardGenerateOutputSchema.parse(await stage.run(undefined, ctx));
      const now = new Date().toISOString();
      await ledger.save({
        stage: stage.name,
        status: "PASSED",
        compile_run_id: ctx.runId,
        input_hash: inputHash,
        config_version_hash: configVersionHash(stage),
        output_hash: hashJson(output),
        attempts: (existing?.attempts ?? 0) + 1,
        started_at: now,
        finished_at: now,
        updated_at: now,
        error_code: null,
      });
      for (const unit of output.units) {
        deps.writeLine(`unit ${unit.unit_key} words=${unit.words} cards=${unit.cards}`);
      }
      deps.writeLine(
        `cards generate OK (${output.counts.cards} card(s) across ${output.counts.units} unit(s)) -> ` +
          path.join(workDir, "cards.jsonl"),
      );
    }, "cards");
  } catch (err) {
    const code = stageErrorCode(err);
    const message = err instanceof Error ? err.message : String(err);
    deps.writeLine(`cards generate failed${code ? ` [${code}]` : ""}: ${message}`);
    deps.exit?.(1);
  }
}

// ---------------------------------------------------------------------------
// Cached MiMo TTS (spec 5.8): tts plan | tts synthesize | tts validate
//
// `tts plan` is a pure dry-run: characters, request count, cache hits/misses,
// and estimated output bytes BEFORE any paid/network call — it never writes.
// `tts synthesize` is INERT without the explicit --execute flag; with it, the
// command runs the SAME TTS_SYNTHESIZE stage handler the pipeline uses (its
// CARD_GENERATE hash precondition included) and records a resume-consistent
// PASSED entry in the shared stage ledger. `tts validate` runs the same
// AUDIO_VALIDATE stage (the deterministic Python audio gate) and records the
// output RELEASE_PACKAGE accepts. The API key is read only from the local
// environment and is never logged or written to any artifact.
// ---------------------------------------------------------------------------

interface TtsCommandOptions {
  sourceHash: string;
  privateRoot?: string;
  config?: string;
}

interface TtsSynthesizeCommandOptions extends TtsCommandOptions {
  limit?: string;
  execute?: boolean;
}

function ttsErrorCode(err: unknown): string | null {
  if (err instanceof StageError || err instanceof WorkPacketError) return err.code;
  return null;
}

function ttsFailure(deps: CliDeps, command: string, err: unknown): void {
  const code = ttsErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  deps.writeLine(`tts ${command} failed${code ? ` [${code}]` : ""}: ${message}`);
  deps.exit?.(1);
}

function resolveTtsConfigPath(options: TtsCommandOptions): string {
  const configOption = options.config ?? DEFAULT_TTS_CONFIG_PATH;
  return path.isAbsolute(configOption) ? configOption : path.join(REPO_ROOT, configOption);
}

/** Print the synthesis plan; shared verbatim by `tts plan` and the dry-run. */
async function printTtsPlan(deps: CliDeps, options: TtsCommandOptions): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(options.sourceHash)) {
    throw new Error("--source-hash must be a 64-character sha-256 hex string");
  }
  const workDir = workDirFor(deps, options.privateRoot, options.sourceHash);
  const config = await readTtsConfig(resolveTtsConfigPath(options));
  const workloads = await loadUnitWorkloads(workDir);
  const items = collectTtsItems(workloads);
  const plan = buildTtsPlan({ items, config, existing: await loadAudioManifest(workDir) });
  deps.writeLine(
    `tts plan: ${items.length} item(s) -> ${plan.requestCount} unique text(s) ` +
      `(provider=${config.provider} model=${config.model} voice=${config.voice})`,
  );
  deps.writeLine(
    `characters=${plan.characters} request_count=${plan.requestCount} ` +
      `cache_hits=${plan.cacheHits} cache_misses=${plan.cacheMisses}`,
  );
  deps.writeLine(`estimated_output_bytes=${plan.estimatedOutputBytes}`);
  for (const entry of plan.entries) {
    deps.writeLine(
      `audio ${entry.objectKey} ${entry.cached ? "cached" : "miss"} chars=${entry.textChars}`,
    );
  }
}

async function executeTtsPlan(deps: CliDeps, options: TtsCommandOptions): Promise<void> {
  try {
    await printTtsPlan(deps, options);
    deps.writeLine("tts plan OK (dry-run: no network call, no writes)");
  } catch (err) {
    ttsFailure(deps, "plan", err);
  }
}

async function executeTtsSynthesize(
  deps: CliDeps,
  options: TtsSynthesizeCommandOptions,
): Promise<void> {
  try {
    await printTtsPlan(deps, options);
    if (!options.execute) {
      deps.writeLine(
        "tts synthesize INERT without --execute (dry-run plan above; no synthesis, no writes)",
      );
      return;
    }
    if (!/^[0-9a-f]{64}$/.test(options.sourceHash)) {
      throw new Error("--source-hash must be a 64-character sha-256 hex string");
    }
    const sourceHash = options.sourceHash;
    const workDir = workDirFor(deps, options.privateRoot, sourceHash);
    const limit = options.limit !== undefined ? Number.parseInt(options.limit, 10) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error("--limit must be a positive integer");
    }
    const stage = createTtsSynthesizeStage({
      privateRoot: path.resolve(options.privateRoot ?? path.join(deps.workRoot, "..")),
      ttsConfigPath: resolveTtsConfigPath(options),
      ...(deps.ttsFetchFn !== undefined ? { fetchFn: deps.ttsFetchFn } : {}),
      ...(deps.ttsApiKey !== undefined ? { apiKey: deps.ttsApiKey } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const ledger = deps.createLedger(sourceHash);
    await withWorkLock(deps, workDir, async () => {
      // Mirror the pipeline's upstream context so the recorded input hash is
      // exactly what a `run`/`resume` would compute for TTS_SYNTHESIZE.
      const upstreamEntry = await ledger.load("CARD_GENERATE");
      const ctx: StageRunContext = {
        runId: `tts-${new Date().toISOString()}`,
        sourceHash,
        config: {},
        ledger,
        logger: deps.logger,
        upstream:
          upstreamEntry?.status === "PASSED" && upstreamEntry.output_hash !== null
            ? { stage: "CARD_GENERATE", outputHash: upstreamEntry.output_hash }
            : null,
      };
      const inputHash = await stage.computeInputHash(ctx);
      const existing = await ledger.load(stage.name);
      if (
        existing?.status === "PASSED" &&
        existing.input_hash === inputHash &&
        existing.config_version_hash === configVersionHash(stage)
      ) {
        deps.writeLine("tts synthesize up-to-date (PASSED, input unchanged)");
        return;
      }
      const output = TtsSynthesizeOutputSchema.parse(await stage.run(undefined, ctx));
      const now = new Date().toISOString();
      await ledger.save({
        stage: stage.name,
        status: "PASSED",
        compile_run_id: ctx.runId,
        input_hash: inputHash,
        config_version_hash: configVersionHash(stage),
        output_hash: hashJson(output),
        attempts: (existing?.attempts ?? 0) + 1,
        started_at: now,
        finished_at: now,
        updated_at: now,
        error_code: null,
      });
      for (const asset of output.assets) {
        deps.writeLine(`asset ${asset.object_key} ${asset.bytes}B`);
      }
      deps.writeLine(
        `tts synthesize OK (${output.counts.unique_texts} unique text(s), ` +
          `${output.counts.synthesized} synthesized, ${output.counts.cache_hits} cache hit(s)) -> ` +
          path.join(workDir, "audio", "manifest.jsonl"),
      );
    }, "tts");
  } catch (err) {
    ttsFailure(deps, "synthesize", err);
  }
}

async function executeTtsValidate(deps: CliDeps, options: TtsCommandOptions): Promise<void> {
  try {
    if (!/^[0-9a-f]{64}$/.test(options.sourceHash)) {
      throw new Error("--source-hash must be a 64-character sha-256 hex string");
    }
    const sourceHash = options.sourceHash;
    const workDir = workDirFor(deps, options.privateRoot, sourceHash);
    const stage = createAudioValidateStage({
      privateRoot: path.resolve(options.privateRoot ?? path.join(deps.workRoot, "..")),
      ttsConfigPath: resolveTtsConfigPath(options),
      runPython: deps.runPython ?? createPythonRunner(),
    });
    const ledger = deps.createLedger(sourceHash);
    await withWorkLock(deps, workDir, async () => {
      const upstreamEntry = await ledger.load("TTS_SYNTHESIZE");
      const ctx: StageRunContext = {
        runId: `tts-validate-${new Date().toISOString()}`,
        sourceHash,
        config: {},
        ledger,
        logger: deps.logger,
        upstream:
          upstreamEntry?.status === "PASSED" && upstreamEntry.output_hash !== null
            ? { stage: "TTS_SYNTHESIZE", outputHash: upstreamEntry.output_hash }
            : null,
      };
      const inputHash = await stage.computeInputHash(ctx);
      const existing = await ledger.load(stage.name);
      if (
        existing?.status === "PASSED" &&
        existing.input_hash === inputHash &&
        existing.config_version_hash === configVersionHash(stage)
      ) {
        deps.writeLine("tts validate up-to-date (PASSED, input unchanged)");
        return;
      }
      const output = AudioValidateOutputSchema.parse(await stage.run(undefined, ctx));
      const now = new Date().toISOString();
      await ledger.save({
        stage: stage.name,
        status: "PASSED",
        compile_run_id: ctx.runId,
        input_hash: inputHash,
        config_version_hash: configVersionHash(stage),
        output_hash: hashJson(output),
        attempts: (existing?.attempts ?? 0) + 1,
        started_at: now,
        finished_at: now,
        updated_at: now,
        error_code: null,
      });
      deps.writeLine(
        `tts validate OK (${output.counts.checked} asset(s) passed deterministic inspection) -> ` +
          path.join(workDir, "audio", "inspection.jsonl"),
      );
    }, "tts");
  } catch (err) {
    ttsFailure(deps, "validate", err);
  }
}

// ---------------------------------------------------------------------------
// Release packaging and publishing (spec 5.9/6.4/11.3): release
// package | verify | stage | smoke | activate | rollback
//
// `release package` runs the SAME RELEASE_PACKAGE stage the pipeline uses
// (13/13 PASSED ledger entries required, stale provenance refused) and writes
// the immutable bundle under `<private-root>/releases/<release-id>/`.
// `release verify` re-hashes every manifest-declared file. `release stage`
// imports the bundle as an INACTIVE D1 release (IMPORTING — app_meta is never
// touched) and uploads content-addressed audio idempotently. `release smoke`
// runs the pre-activation checks (IMPORTING -> VALIDATING -> READY, failures
// -> FAILED). ONLY `activate` moves the active pointer, and only for READY;
// `rollback` re-activates a RETIRED release. There is no --force and no
// manual status override anywhere.
// ---------------------------------------------------------------------------

interface ReleasePackageOptions {
  sourceHash: string;
  privateRoot?: string;
  previousRelease?: string;
  metadata?: string;
}

interface ReleaseVerifyOptions {
  bundle: string;
}

interface ReleaseStageOptions {
  bundle: string;
  privateRoot?: string;
}

interface ReleaseActivateOptions {
  release: string;
  aliases?: string;
}

interface ReleaseIdOptions {
  release: string;
}

function releaseErrorCode(err: unknown): string | null {
  if (err instanceof StageError || err instanceof PublishError || err instanceof AliasGraphError) {
    return err.code;
  }
  return null;
}

function releaseFailure(deps: CliDeps, command: string, err: unknown): void {
  const code = releaseErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  deps.writeLine(`release ${command} failed${code ? ` [${code}]` : ""}: ${message}`);
  deps.exit?.(1);
}

/** Absolute path resolution for bundle/private roots (repo-root relative). */
function resolveRootPath(value: string | undefined, fallback: string): string {
  const option = value ?? fallback;
  return path.isAbsolute(option) ? option : path.join(REPO_ROOT, option);
}

function requireReleaseDeps(deps: CliDeps): { db: LexiloopDatabase; r2: R2AudioStore } {
  if (!deps.release) {
    throw new PublishError(
      "RELEASE_DEPS_MISSING",
      "D1/R2 dependencies are not configured; run publishing through scripts/publish-release.ts " +
        "(a D1 database and a private R2 store are required)",
    );
  }
  return deps.release;
}

async function executeReleasePackage(deps: CliDeps, options: ReleasePackageOptions): Promise<void> {
  try {
    if (!/^[0-9a-f]{64}$/.test(options.sourceHash)) {
      throw new Error("--source-hash must be a 64-character sha-256 hex string");
    }
    const sourceHash = options.sourceHash;
    const privateRoot = resolveRootPath(options.privateRoot, path.join(".lexiloop-private"));
    let metadata;
    if (options.metadata !== undefined) {
      metadata = ReleaseMetadataConfigSchema.parse(JSON.parse(await readFile(options.metadata, "utf8")));
    }
    const stage = createReleasePackageStage({
      privateRoot,
      ...(metadata !== undefined ? { metadata } : {}),
      ...(options.previousRelease !== undefined ? { previousReleaseId: options.previousRelease } : {}),
    });
    const ledger = deps.createLedger(sourceHash);
    const upstreamEntry = await ledger.load("AUDIO_VALIDATE");
    const ctx: StageRunContext = {
      runId: `release-${new Date().toISOString()}`,
      sourceHash,
      config: {},
      ledger,
      logger: deps.logger,
      upstream:
        upstreamEntry?.status === "PASSED" && upstreamEntry.output_hash !== null
          ? { stage: "AUDIO_VALIDATE", outputHash: upstreamEntry.output_hash }
          : null,
    };
    const inputHash = await stage.computeInputHash(ctx);
    const existing = await ledger.load(stage.name);
    if (
      existing?.status === "PASSED" &&
      existing.input_hash === inputHash &&
      existing.config_version_hash === configVersionHash(stage)
    ) {
      deps.writeLine("release package up-to-date (PASSED, input unchanged)");
      return;
    }
    const output = ReleasePackageOutputSchema.parse(await stage.run(undefined, ctx));
    const now = new Date().toISOString();
    await ledger.save({
      stage: stage.name,
      status: "PASSED",
      compile_run_id: ctx.runId,
      input_hash: inputHash,
      config_version_hash: configVersionHash(stage),
      output_hash: hashJson(output),
      attempts: (existing?.attempts ?? 0) + 1,
      started_at: now,
      finished_at: now,
      updated_at: now,
      error_code: null,
    });
    deps.writeLine(
      `release package OK (${output.units} unit(s), ${output.audio_assets} audio asset(s)) -> ` +
        `${path.join(privateRoot, output.release_dir)}`,
    );
    deps.writeLine(`release ${output.release_id} manifest ${output.manifest_sha256.slice(0, 12)}`);
  } catch (err) {
    releaseFailure(deps, "package", err);
  }
}

async function executeReleaseVerify(deps: CliDeps, options: ReleaseVerifyOptions): Promise<void> {
  try {
    const bundleDir = resolveRootPath(options.bundle, options.bundle);
    const result = await verifyBundle(bundleDir);
    if (!result.ok || !result.manifest) {
      const details = result.errors.map((error) => `${error.path}: ${error.reason}`).join("; ");
      throw new PublishError("BUNDLE_VERIFY_FAILED", `bundle at ${bundleDir} failed verification: ${details}`);
    }
    deps.writeLine(
      `release verify OK (${result.manifest.files.length} file(s), release ${result.manifest.release_id}, ` +
        `manifest ${result.manifestSha256?.slice(0, 12)})`,
    );
  } catch (err) {
    releaseFailure(deps, "verify", err);
  }
}

async function executeReleaseStage(deps: CliDeps, options: ReleaseStageOptions): Promise<void> {
  try {
    const { db, r2 } = requireReleaseDeps(deps);
    const bundleDir = resolveRootPath(options.bundle, options.bundle);
    const verified = await verifyBundle(bundleDir);
    if (!verified.ok || !verified.manifest) {
      const details = verified.errors.map((error) => `${error.path}: ${error.reason}`).join("; ");
      throw new PublishError("BUNDLE_VERIFY_FAILED", `bundle at ${bundleDir} failed verification: ${details}`);
    }
    const privateRoot = resolveRootPath(options.privateRoot, path.join(".lexiloop-private"));
    const audioRoot = path.join(privateRoot, "work", verified.manifest.source_pdf_sha256);
    const result = await stageBundle({ db, r2, bundleDir, audioRoot, now: Date.now() });
    deps.writeLine(
      `release stage OK (release ${result.releaseId} status=IMPORTING, ` +
        `audio uploaded=${result.uploaded} reused=${result.reused}; app_meta untouched)`,
    );
  } catch (err) {
    releaseFailure(deps, "stage", err);
  }
}

async function executeReleaseSmoke(deps: CliDeps, options: ReleaseIdOptions): Promise<void> {
  try {
    const { db, r2 } = requireReleaseDeps(deps);
    const result = await smokeRelease({ db, r2, releaseId: options.release });
    for (const check of result.checks) {
      const detail = check.detail ? ` (${check.detail})` : "";
      deps.writeLine(`check ${check.passed ? "PASS" : "FAIL"} ${check.name}${detail}`);
    }
    deps.writeLine(`release smoke OK (release ${result.releaseId} status=READY)`);
  } catch (err) {
    releaseFailure(deps, "smoke", err);
  }
}

async function executeReleaseActivate(deps: CliDeps, options: ReleaseActivateOptions): Promise<void> {
  try {
    const { db } = requireReleaseDeps(deps);
    let aliases: readonly unknown[] | undefined;
    if (options.aliases !== undefined) {
      aliases = AliasFileSchema.parse(JSON.parse(await readFile(options.aliases, "utf8"))).edges;
    }
    const result = await activateRelease({
      db,
      releaseId: options.release,
      ...(aliases !== undefined ? { aliases } : {}),
      now: Date.now(),
    });
    deps.writeLine(
      `release activate OK (release ${result.releaseId} status=ACTIVE, ` +
        `previous=${result.previousReleaseId ?? "none"}, aliases=${result.aliasesImported})`,
    );
  } catch (err) {
    releaseFailure(deps, "activate", err);
  }
}

async function executeReleaseRollback(deps: CliDeps, options: ReleaseIdOptions): Promise<void> {
  try {
    const { db } = requireReleaseDeps(deps);
    const result = await rollbackRelease({ db, releaseId: options.release, now: Date.now() });
    deps.writeLine(
      `release rollback OK (release ${result.releaseId} status=ACTIVE again, ` +
        `undone=${result.previousReleaseId ?? "none"})`,
    );
  } catch (err) {
    releaseFailure(deps, "rollback", err);
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
      .option(
        "--source-hash <hash>",
        "source content hash (PDF SHA-256); required unless --source is given",
      )
      .option("--source <path>", "path to the source PDF (hashed; wired into SOURCE_FINGERPRINT)")
      .option("--pages <list>", "comma-separated page scope for the media stages (default: all)")
      .option("--private-root <dir>", "private root holding work/<source-hash> directories")
      .option("--through <stage>", "run only the contiguous prefix up to this stage");

  const requireSourceIdentity = (options: RunCommandOptions): string => {
    if (options.sourceHash !== undefined) return options.sourceHash;
    if (options.source !== undefined) return "(resolved from --source)";
    throw new Error("either --source or --source-hash is required");
  };

  sourceHashOption(
    program.command("plan").description("dry-run: print the stage order and what would run"),
  ).action(async (options: RunCommandOptions) => {
    requireSourceIdentity(options);
    await executePlan(deps, options);
  });

  sourceHashOption(
    program
      .command("run")
      .description("run the pipeline, resuming from PASSED stages with unchanged inputs"),
  ).action(async (options: RunCommandOptions) => {
    requireSourceIdentity(options);
    await executeRun(deps, options);
  });

  sourceHashOption(
    program
      .command("resume")
      .description("resume an interrupted compile (same semantics as run)"),
  ).action(async (options: RunCommandOptions) => {
    requireSourceIdentity(options);
    await executeRun(deps, options);
  });

  program
    .command("status")
    .description("print the current ledger state of every registered stage")
    .requiredOption("--source-hash <hash>", "source content hash (PDF SHA-256)")
    .action(async (options: RunCommandOptions) => {
      await executeStatus(deps, options.sourceHash!);
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

  sourceHashOption(
    agents
      .command("resume")
      .description("resume the compile pipeline after ingesting agent results (same semantics as `run`)"),
  ).action(async (options: RunCommandOptions) => {
    requireSourceIdentity(options);
    await executeRun(deps, options);
  });

  const cards = program
    .command("cards")
    .description("deterministic card generation from review-passed units (spec 5.7)");

  cards
    .command("generate")
    .description("derive card definitions from fully-passed units and write cards.jsonl")
    .requiredOption("--source-hash <hash>", "source content hash (PDF SHA-256)")
    .option("--config <path>", "versioned card rules JSON", DEFAULT_CARDS_CONFIG_PATH)
    .option("--private-root <dir>", "private root holding work/<source-hash> directories")
    .action(async (options: CardsGenerateOptions) => {
      await executeCardsGenerate(deps, options);
    });

  const tts = program
    .command("tts")
    .description("cached MiMo TTS synthesis and deterministic audio validation (spec 5.8)");
  const ttsSourceOption = (command: Command): Command =>
    command
      .requiredOption("--source-hash <hash>", "source content hash (PDF SHA-256)")
      .option("--config <path>", "versioned TTS synthesis config JSON", DEFAULT_TTS_CONFIG_PATH)
      .option("--private-root <dir>", "private root holding work/<source-hash> directories");

  ttsSourceOption(
    tts
      .command("plan")
      .description("dry-run: characters, request count, cache hits/misses before any paid call"),
  ).action(async (options: TtsCommandOptions) => {
    await executeTtsPlan(deps, options);
  });

  ttsSourceOption(
    tts
      .command("synthesize")
      .description("synthesize missing assets through the TTS provider (INERT without --execute)"),
  )
    .option("--limit <n>", "synthesize only the first N unique texts (smoke runs)")
    .option("--execute", "REQUIRED to perform paid synthesis and write private audio", false)
    .action(async (options: TtsSynthesizeCommandOptions) => {
      await executeTtsSynthesize(deps, options);
    });

  ttsSourceOption(
    tts
      .command("validate")
      .description("run the deterministic audio gate over every cached asset"),
  ).action(async (options: TtsCommandOptions) => {
    await executeTtsValidate(deps, options);
  });

  const release = program
    .command("release")
    .description("immutable release packaging and publishing (spec 5.9/6.4/11.3)");

  release
    .command("package")
    .description("package a fully-compiled work directory into the immutable release bundle")
    .requiredOption("--source-hash <hash>", "source content hash (PDF SHA-256)")
    .option("--private-root <dir>", "private root holding work/ and releases/ directories")
    .option("--previous-release <id>", "previous compatible release recorded in rollback.json")
    .option("--metadata <path>", "release metadata JSON (schema/prompt/model ids)", )
    .action(async (options: ReleasePackageOptions) => {
      await executeReleasePackage(deps, options);
    });

  release
    .command("verify")
    .description("verify a bundle: manifest schema + SHA-256/size of every declared file")
    .requiredOption("--bundle <dir>", "release bundle directory")
    .action(async (options: ReleaseVerifyOptions) => {
      await executeReleaseVerify(deps, options);
    });

  release
    .command("stage")
    .description("verify + upload audio to private R2 + import an INACTIVE D1 release (IMPORTING)")
    .requiredOption("--bundle <dir>", "release bundle directory")
    .option("--private-root <dir>", "private root holding work/<source-hash> audio")
    .action(async (options: ReleaseStageOptions) => {
      await executeReleaseStage(deps, options);
    });

  release
    .command("smoke")
    .description("run pre-activation checks (IMPORTING -> VALIDATING -> READY, failures -> FAILED)")
    .requiredOption("--release <id>", "staged release id")
    .action(async (options: ReleaseIdOptions) => {
      await executeReleaseSmoke(deps, options);
    });

  release
    .command("activate")
    .description("atomically switch the active pointer to a READY release (the ONLY pointer writer)")
    .requiredOption("--release <id>", "READY release id")
    .option("--aliases <path>", "typed alias edges JSON to validate and import with the activation batch")
    .action(async (options: ReleaseActivateOptions) => {
      await executeReleaseActivate(deps, options);
    });

  release
    .command("rollback")
    .description("re-activate a RETIRED release (presents the older keys again; user state untouched)")
    .requiredOption("--release <id>", "RETIRED release id")
    .action(async (options: ReleaseIdOptions) => {
      await executeReleaseRollback(deps, options);
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
