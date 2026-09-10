/**
 * Pipeline scheduling: resume, invalidation, retries, and the release gate
 * (spec 5.2, 11.1).
 *
 * Resume semantics:
 * - A stage is skipped only when its ledger entry is PASSED and both the
 *   current input hash and the stage config version hash still match.
 * - As soon as any stage re-runs, every downstream stage re-runs too
 *   (cascade invalidation), because its upstream input may have changed.
 * - A stale RUNNING entry (crashed process) is recovered to a resumable
 *   FAILED with code STALE_RUNNING before scheduling.
 * - Only `StageError.retryable` failures are retried, with capped
 *   exponential backoff plus jitter. Everything else fails the run closed.
 *
 * Note: stage outputs are passed in memory between consecutively executed
 * stages. A stage scheduled right after a skipped predecessor receives
 * `undefined` as input; artifact persistence/loading lands with the real
 * stage implementations (tasks 5-10).
 */
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import type { LedgerStore } from "./ledger";
import { silentLogger, type CompilerLogger } from "./logging";
import {
  StageError,
  hashJson,
  hashString,
  type AnyStage,
  type StageRunContext,
  type StageStatus,
  type StageUpstream,
} from "./stage";

// --------------------------------------------------------------------------
// Retry policy
// --------------------------------------------------------------------------

export interface RetryPolicy {
  /** Total attempts per invocation of a stage (including the first). */
  maxAttempts: number;
  baseDelayMs: number;
  factor: number;
  /** Upper bound for a single delay (bounded/backoff cap, spec 11.1). */
  maxDelayMs: number;
  /** Proportion of random jitter added to each delay. */
  jitterRatio: number;
  sleep: (ms: number) => Promise<void>;
  /** Random source in [0, 1) for jitter; injectable for deterministic tests. */
  random: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  factor: 2,
  maxDelayMs: 8000,
  jitterRatio: 0.25,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Capped exponential delay after `failedAttempt` (1-based) plus jitter. */
export function backoffDelayMs(policy: RetryPolicy, failedAttempt: number): number {
  const uncapped = policy.baseDelayMs * policy.factor ** (failedAttempt - 1);
  const capped = Math.min(uncapped, policy.maxDelayMs);
  return Math.round(capped + policy.random() * capped * policy.jitterRatio);
}

// --------------------------------------------------------------------------
// Run options and report
// --------------------------------------------------------------------------

/** The release stage refuses to run unless each required stage is PASSED. */
export interface ReleaseGate {
  stage: string;
  requires: readonly string[];
}

export interface RunPipelineOptions {
  /** Restrict the run to the contiguous prefix ending at this stage. */
  through?: string;
  /** Versioned per-stage configuration fed into stage input hashes. */
  config?: Record<string, unknown>;
  sourceHash?: string;
  runId?: string;
  logger?: CompilerLogger;
  retry?: Partial<RetryPolicy>;
  releaseGate?: ReleaseGate;
}

export type StageOutcomeStatus = StageStatus | "SKIPPED";

export interface StageOutcome {
  name: string;
  status: StageOutcomeStatus;
  attempts?: number;
  duration_ms?: number;
  error_code?: string | null;
}

export type RunStatus = "COMPLETED" | "FAILED" | "BLOCKED";

export interface RunReport {
  runId: string;
  status: RunStatus;
  stoppedAt: string | null;
  results: StageOutcome[];
}

/** Contiguous prefix of `stages` ending at `through`; throws when unknown. */
export function resolveStagePrefix(stages: readonly AnyStage[], through: string): AnyStage[] {
  const index = stages.findIndex((stage) => stage.name === through);
  if (index < 0) {
    const registered = stages.map((stage) => stage.name).join(", ");
    throw new Error(`Unknown stage "${through}"; registered stages: ${registered}`);
  }
  return stages.slice(0, index + 1);
}

// --------------------------------------------------------------------------
// Pipeline
// --------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeStageError(err: unknown): StageError {
  if (err instanceof StageError) return err;
  if (err instanceof ZodError) {
    return new StageError("OUTPUT_SCHEMA_INVALID", "Stage output failed schema validation");
  }
  const message = err instanceof Error ? err.message : String(err);
  return new StageError("STAGE_UNEXPECTED_ERROR", message);
}

/** Stable hash over the stage identity + its declared config version. */
export function configVersionHash(stage: AnyStage): string {
  return hashString(`${stage.name}:configVersion:${stage.configVersion}`);
}

export async function runPipeline(
  stages: readonly AnyStage[],
  ledger: LedgerStore,
  options: RunPipelineOptions = {},
): Promise<RunReport> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const logger = options.logger ?? silentLogger;
  const runId = options.runId ?? `compile-${randomUUID()}`;
  const sourceHash = options.sourceHash ?? "unknown-source";
  const config = options.config ?? {};
  const prefix = options.through ? resolveStagePrefix(stages, options.through) : [...stages];

  // 1. Crash recovery: any RUNNING entry is from a dead process; turn it into
  //    a resumable FAILED before scheduling anything.
  for (const stage of prefix) {
    const entry = await ledger.load(stage.name);
    if (entry?.status === "RUNNING") {
      await ledger.save({
        ...entry,
        status: "FAILED",
        error_code: "STALE_RUNNING",
        updated_at: nowIso(),
      });
      logger.warn("stage_recovered", {
        stage: stage.name,
        compile_run_id: runId,
        error_code: "STALE_RUNNING",
      });
    }
  }

  // 2. Materialize PENDING for stages without history so `status` reflects
  //    the full declared order.
  for (const stage of prefix) {
    if (!(await ledger.load(stage.name))) {
      await ledger.save({
        stage: stage.name,
        status: "PENDING",
        compile_run_id: runId,
        input_hash: null,
        config_version_hash: null,
        output_hash: null,
        attempts: 0,
        started_at: null,
        finished_at: null,
        updated_at: nowIso(),
        error_code: null,
      });
    }
  }

  const results: StageOutcome[] = [];
  let runStatus: RunStatus = "COMPLETED";
  let stoppedAt: string | null = null;
  let cascade = false;
  let upstreamRaw: unknown;
  let upstream: StageUpstream | null = null;

  stageLoop: for (const stage of prefix) {
    const ctx: StageRunContext = {
      runId,
      sourceHash,
      config,
      ledger,
      logger,
      upstream,
    };

    let inputHash: string;
    try {
      inputHash = await stage.computeInputHash(ctx);
    } catch {
      await ledger.save({
        stage: stage.name,
        status: "FAILED",
        compile_run_id: runId,
        input_hash: null,
        config_version_hash: configVersionHash(stage),
        output_hash: null,
        attempts: 1,
        started_at: null,
        finished_at: nowIso(),
        updated_at: nowIso(),
        error_code: "INPUT_HASH_FAILED",
      });
      logger.error("stage_failed", {
        stage: stage.name,
        compile_run_id: runId,
        error_code: "INPUT_HASH_FAILED",
      });
      results.push({ name: stage.name, status: "FAILED", attempts: 1, error_code: "INPUT_HASH_FAILED" });
      runStatus = "FAILED";
      stoppedAt = stage.name;
      break;
    }

    const entry = await ledger.load(stage.name);
    const configHash = configVersionHash(stage);

    // 3. Resume: skip only when PASSED with matching input and config hashes.
    if (
      !cascade &&
      entry?.status === "PASSED" &&
      entry.input_hash === inputHash &&
      entry.config_version_hash === configHash
    ) {
      results.push({ name: stage.name, status: "SKIPPED" });
      logger.info("stage_skipped", {
        stage: stage.name,
        compile_run_id: runId,
        input_hash: inputHash,
      });
      // Upstream output is not available for skipped stages; see module doc.
      upstreamRaw = undefined;
      upstream = null;
      continue;
    }

    // 4. BLOCKED is terminal: the unit must not proceed (spec 5.6/17) until
    //    the entry is explicitly cleared.
    if (entry?.status === "BLOCKED") {
      results.push({ name: stage.name, status: "BLOCKED", error_code: entry.error_code });
      logger.error("stage_blocked", {
        stage: stage.name,
        compile_run_id: runId,
        error_code: entry.error_code ?? "STAGE_BLOCKED",
      });
      runStatus = "BLOCKED";
      stoppedAt = stage.name;
      break stageLoop;
    }

    const startedAt = nowIso();

    // 5. Release gate: refuse (BLOCKED, fail-closed) unless every required
    //    predecessor has a PASSED ledger entry.
    if (options.releaseGate && options.releaseGate.stage === stage.name) {
      const unmet: string[] = [];
      for (const required of options.releaseGate.requires) {
        const requiredEntry = await ledger.load(required);
        if (requiredEntry?.status !== "PASSED") unmet.push(required);
      }
      if (unmet.length > 0) {
        await ledger.save({
          stage: stage.name,
          status: "BLOCKED",
          compile_run_id: runId,
          input_hash: inputHash,
          config_version_hash: configHash,
          output_hash: null,
          attempts: 0,
          started_at: null,
          finished_at: nowIso(),
          updated_at: nowIso(),
          error_code: "RELEASE_GATE_UNMET",
        });
        results.push({
          name: stage.name,
          status: "BLOCKED",
          error_code: "RELEASE_GATE_UNMET",
        });
        logger.error("stage_blocked", {
          stage: stage.name,
          compile_run_id: runId,
          error_code: "RELEASE_GATE_UNMET",
        });
        runStatus = "BLOCKED";
        stoppedAt = stage.name;
        break stageLoop;
      }
    }

    // 6. Validate upstream output against this stage's input contract.
    let input: unknown;
    try {
      input = stage.inputSchema.parse(upstreamRaw);
    } catch {
      await ledger.save({
        stage: stage.name,
        status: "FAILED",
        compile_run_id: runId,
        input_hash: inputHash,
        config_version_hash: configHash,
        output_hash: null,
        attempts: (entry?.attempts ?? 0) + 1,
        started_at: null,
        finished_at: nowIso(),
        updated_at: nowIso(),
        error_code: "INPUT_SCHEMA_INVALID",
      });
      logger.error("stage_failed", {
        stage: stage.name,
        compile_run_id: runId,
        error_code: "INPUT_SCHEMA_INVALID",
      });
      results.push({
        name: stage.name,
        status: "FAILED",
        attempts: (entry?.attempts ?? 0) + 1,
        error_code: "INPUT_SCHEMA_INVALID",
      });
      runStatus = "FAILED";
      stoppedAt = stage.name;
      break stageLoop;
    }

    // 7. Execute with capped exponential backoff for retryable failures.
    const priorAttempts = entry && entry.status !== "PASSED" ? entry.attempts : 0;
    const stageStart = Date.now();
    let attempt = priorAttempts;

    const saveRunning = async (nextAttempt: number, errorCode: string | null): Promise<void> => {
      await ledger.save({
        stage: stage.name,
        status: "RUNNING",
        compile_run_id: runId,
        input_hash: inputHash,
        config_version_hash: configHash,
        output_hash: null,
        attempts: nextAttempt,
        started_at: startedAt,
        finished_at: null,
        updated_at: nowIso(),
        error_code: errorCode,
      });
    };

    for (;;) {
      attempt += 1;
      await saveRunning(attempt, null);
      try {
        const rawOutput = await stage.run(input, ctx);
        const output = stage.outputSchema.parse(rawOutput);
        const outputHash = hashJson(output);
        const durationMs = Date.now() - stageStart;
        await ledger.save({
          stage: stage.name,
          status: "PASSED",
          compile_run_id: runId,
          input_hash: inputHash,
          config_version_hash: configHash,
          output_hash: outputHash,
          attempts: attempt,
          started_at: startedAt,
          finished_at: nowIso(),
          updated_at: nowIso(),
          error_code: null,
        });
        logger.info("stage_completed", {
          stage: stage.name,
          compile_run_id: runId,
          attempt,
          duration_ms: durationMs,
          input_hash: inputHash,
          output_hash: outputHash,
        });
        results.push({
          name: stage.name,
          status: "PASSED",
          attempts: attempt,
          duration_ms: durationMs,
        });
        cascade = true;
        upstreamRaw = output;
        upstream = { stage: stage.name, outputHash };
        break;
      } catch (err) {
        const stageErr = normalizeStageError(err);
        const canRetry = stageErr.retryable && attempt < policy.maxAttempts;
        if (canRetry) {
          logger.warn("stage_retry", {
            stage: stage.name,
            compile_run_id: runId,
            attempt,
            retry_count: attempt,
            error_code: stageErr.code,
          });
          await policy.sleep(backoffDelayMs(policy, attempt));
          continue;
        }
        const finalStatus: StageStatus = stageErr.blocked ? "BLOCKED" : "FAILED";
        const durationMs = Date.now() - stageStart;
        await ledger.save({
          stage: stage.name,
          status: finalStatus,
          compile_run_id: runId,
          input_hash: inputHash,
          config_version_hash: configHash,
          output_hash: null,
          attempts: attempt,
          started_at: startedAt,
          finished_at: nowIso(),
          updated_at: nowIso(),
          error_code: stageErr.code,
        });
        logger.error("stage_failed", {
          stage: stage.name,
          compile_run_id: runId,
          attempt,
          duration_ms: durationMs,
          error_code: stageErr.code,
          input_hash: inputHash,
        });
        results.push({
          name: stage.name,
          status: finalStatus,
          attempts: attempt,
          duration_ms: durationMs,
          error_code: stageErr.code,
        });
        runStatus = finalStatus === "BLOCKED" ? "BLOCKED" : "FAILED";
        stoppedAt = stage.name;
        break stageLoop;
      }
    }
  }

  return { runId, status: runStatus, stoppedAt, results };
}
