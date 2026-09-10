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
import { collectEnvSecrets, createCompilerLogger, type CompilerLogger } from "./logging";
import {
  configVersionHash,
  resolveStagePrefix,
  runPipeline,
  type ReleaseGate,
} from "./pipeline";
import {
  PRODUCTION_STAGE_DEPENDENCIES,
  RELEASE_STAGE,
  getProductionStages,
} from "./stage-registry";
import type { AnyStage } from "./stage";

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
  const deps: CliDeps = {
    workRoot: DEFAULT_WORK_ROOT,
    stages: getProductionStages(),
    createLedger: (sourceHash) =>
      createFileLedger({ directory: ledgerDirectory(DEFAULT_WORK_ROOT, sourceHash) }),
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
