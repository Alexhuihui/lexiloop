/**
 * Pipeline scheduling: resume, invalidation, retries, locking, and the
 * release gate (spec 5.2, 11.1).
 *
 * Resume semantics:
 * - A stage is skipped only when its ledger entry is PASSED and both the
 *   current input hash and the stage config version hash still match.
 * - A skipped stage carries its ledger provenance forward: the next stage
 *   observes `upstream.outputHash` from the ledger, so stages that fold
 *   upstream identity into their input hash stay resume-stable.
 * - As soon as any stage re-runs, every downstream stage re-runs too
 *   (cascade invalidation), because its upstream input may have changed.
 * - A stale RUNNING entry (crashed process) anywhere in the registry — not
 *   only within the scheduled prefix — is recovered to a resumable FAILED
 *   with code STALE_RUNNING before scheduling, so `status` never reports a
 *   phantom RUNNING stage after a crash.
 * - Only `StageError.retryable` failures are retried, with capped
 *   exponential backoff plus jitter. The retry budget is per invocation;
 *   the ledger `attempts` field is cumulative across runs for observability.
 *   Everything else fails the run closed.
 *
 * Single-writer: a work directory supports at most one compile run at a
 * time. When `lockDirectory` is provided, the run holds an advisory lockfile
 * (`compile.lock`, created with the exclusive "wx" flag) for the run's
 * duration and releases it on every exit path. An existing lock always
 * refuses the run with an actionable message — a fresh lock reports an
 * active run, and a lock older than the TTL reports as stale; neither is
 * ever broken automatically.
 *
 * Note: stage outputs are passed in memory between consecutively executed
 * stages. A stage scheduled right after a skipped predecessor receives
 * `undefined` as input; artifact persistence/loading lands with the real
 * stage implementations (tasks 5-10).
 */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
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
  /**
   * Directory for the advisory single-writer lockfile. The CLI passes the
   * source work directory; when omitted the run is unguarded (tests).
   */
  lockDirectory?: string;
  /** Age at which an existing lock is reported as stale. */
  lockTtlMs?: number;
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
// Advisory single-writer work lock
// --------------------------------------------------------------------------

export const LOCK_FILE_NAME = "compile.lock";

/** Default age at which an existing work lock is reported as stale. */
export const DEFAULT_LOCK_TTL_MS = 12 * 60 * 60 * 1000;

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Raised when a run refuses to start because a work lock already exists. */
export class PipelineLockError extends Error {
  readonly lockPath: string;
  readonly stale: boolean;

  constructor(lockPath: string, stale: boolean, ageMs: number, ttlMs: number) {
    const detail = stale
      ? `Stale work lock at ${lockPath}: age ${formatDuration(ageMs)} exceeds the lock TTL ` +
        `(${formatDuration(ttlMs)}). Verify no compiler process is still writing this work ` +
        "directory, then delete the lock file manually and re-run. Locks are never broken " +
        "automatically."
      : `Another compile run appears to be active: work lock at ${lockPath} held for ` +
        `${formatDuration(ageMs)}. A work directory supports a single writer; wait for the ` +
        "active run to finish, or — only after verifying no compiler process is running — " +
        "delete the lock file manually.";
    super(detail);
    this.name = "PipelineLockError";
    this.lockPath = lockPath;
    this.stale = stale;
  }
}

export interface WorkLock {
  path: string;
  /** Idempotent; removes the lockfile when it is still the one we created. */
  release(): Promise<void>;
}

/**
 * Acquire the advisory lockfile for a work directory. Creation uses the
 * exclusive "wx" flag, so concurrent acquirers cannot both win. An existing
 * lock always refuses: below the TTL it is reported as an active run, past
 * the TTL as stale. Stale locks are never removed automatically.
 *
 * The payload carries a random ownership token: `release()` only removes the
 * lockfile when it still contains our token, so a lock that was replaced by
 * another writer is never deleted by us. If writing the payload fails after
 * exclusive creation, the just-created (empty) lock is removed before the
 * error propagates, so a failed acquisition never leaves a phantom lock.
 */
export async function acquireWorkLock(options: {
  directory: string;
  ttlMs?: number;
  /** Injectable payload writer; exists so tests can force a write failure. */
  writePayload?: (handle: FileHandle, payload: string) => Promise<void>;
}): Promise<WorkLock> {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const writePayload =
    options.writePayload ?? ((handle, payload) => handle.writeFile(payload, "utf8"));
  await mkdir(options.directory, { recursive: true });
  const lockPath = path.join(options.directory, LOCK_FILE_NAME);
  const token = randomUUID();
  const payload = `${JSON.stringify({
    pid: process.pid,
    token,
    acquired_at: new Date().toISOString(),
  })}\n`;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let ageMs = 0;
      let vanished = false;
      try {
        ageMs = Math.max(0, Date.now() - (await stat(lockPath)).mtimeMs);
      } catch {
        vanished = true; // Lock disappeared between EEXIST and stat; retry.
      }
      if (!vanished) throw new PipelineLockError(lockPath, ageMs > ttlMs, ageMs, ttlMs);
      continue;
    }
    try {
      await writePayload(handle, payload);
    } catch (err) {
      await handle.close();
      // Never leave the empty exclusive lock behind on a failed write.
      await rm(lockPath, { force: true });
      throw err;
    }
    await handle.close();
    let released = false;
    return {
      path: lockPath,
      release: async () => {
        if (released) return;
        released = true;
        let owned: boolean;
        try {
          const raw = await readFile(lockPath, "utf8");
          owned = (JSON.parse(raw) as { token?: string }).token === token;
        } catch {
          owned = false; // Vanished or unreadable: nothing of ours to remove.
        }
        if (owned) await rm(lockPath, { force: true });
      },
    };
  }
  // Only reachable if the lock kept vanishing between EEXIST and stat.
  throw new PipelineLockError(lockPath, false, 0, ttlMs);
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
  const workLock = options.lockDirectory
    ? await acquireWorkLock({ directory: options.lockDirectory, ttlMs: options.lockTtlMs })
    : null;
  try {
    return await runPipelineLocked(stages, ledger, options);
  } finally {
    // Released on every exit path, including failures and rejections.
    await workLock?.release();
  }
}

async function runPipelineLocked(
  stages: readonly AnyStage[],
  ledger: LedgerStore,
  options: RunPipelineOptions,
): Promise<RunReport> {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const logger = options.logger ?? silentLogger;
  const runId = options.runId ?? `compile-${randomUUID()}`;
  const sourceHash = options.sourceHash ?? "unknown-source";
  const config = options.config ?? {};
  const prefix = options.through ? resolveStagePrefix(stages, options.through) : [...stages];

  // 1. Crash recovery: any RUNNING entry belongs to a dead process; recover
  //    it across the full registry so status never shows phantom RUNNING
  //    stages after a crash past the scheduled prefix.
  for (const stage of stages) {
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

    const entry = await ledger.load(stage.name);
    const configHash = configVersionHash(stage);

    let inputHash: string;
    try {
      inputHash = await stage.computeInputHash(ctx);
    } catch {
      await ledger.save({
        stage: stage.name,
        status: "FAILED",
        compile_run_id: runId,
        input_hash: null,
        config_version_hash: configHash,
        output_hash: null,
        attempts: (entry?.attempts ?? 0) + 1,
        started_at: null,
        finished_at: nowIso(),
        updated_at: nowIso(),
        error_code: "INPUT_HASH_FAILED",
      });
      logger.error("stage_failed", {
        stage: stage.name,
        compile_run_id: runId,
        attempt: (entry?.attempts ?? 0) + 1,
        error_code: "INPUT_HASH_FAILED",
      });
      results.push({
        name: stage.name,
        status: "FAILED",
        attempts: (entry?.attempts ?? 0) + 1,
        error_code: "INPUT_HASH_FAILED",
      });
      runStatus = "FAILED";
      stoppedAt = stage.name;
      break;
    }

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
      // The in-memory output is unavailable, but the recorded output hash is
      // still valid provenance: stages hashing `upstream.outputHash` stay
      // resume-stable across invocations.
      upstreamRaw = undefined;
      upstream = entry.output_hash !== null ? { stage: stage.name, outputHash: entry.output_hash } : null;
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
    //    Retry decisions and backoff use the per-invocation attempt index;
    //    the persisted `attempts` value stays cumulative across runs.
    const priorAttempts = entry?.attempts ?? 0;
    const stageStart = Date.now();
    let attemptThisRun = 0;

    const saveRunning = async (totalAttempts: number): Promise<void> => {
      await ledger.save({
        stage: stage.name,
        status: "RUNNING",
        compile_run_id: runId,
        input_hash: inputHash,
        config_version_hash: configHash,
        output_hash: null,
        attempts: totalAttempts,
        started_at: startedAt,
        finished_at: null,
        updated_at: nowIso(),
        error_code: null,
      });
    };

    for (;;) {
      attemptThisRun += 1;
      const totalAttempts = priorAttempts + attemptThisRun;
      await saveRunning(totalAttempts);
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
          attempts: totalAttempts,
          started_at: startedAt,
          finished_at: nowIso(),
          updated_at: nowIso(),
          error_code: null,
        });
        logger.info("stage_completed", {
          stage: stage.name,
          compile_run_id: runId,
          attempt: totalAttempts,
          duration_ms: durationMs,
          input_hash: inputHash,
          output_hash: outputHash,
        });
        results.push({
          name: stage.name,
          status: "PASSED",
          attempts: totalAttempts,
          duration_ms: durationMs,
        });
        cascade = true;
        upstreamRaw = output;
        upstream = { stage: stage.name, outputHash };
        break;
      } catch (err) {
        const stageErr = normalizeStageError(err);
        const canRetry = stageErr.retryable && attemptThisRun < policy.maxAttempts;
        if (canRetry) {
          logger.warn("stage_retry", {
            stage: stage.name,
            compile_run_id: runId,
            attempt: totalAttempts,
            retry_count: attemptThisRun,
            error_code: stageErr.code,
          });
          await policy.sleep(backoffDelayMs(policy, attemptThisRun));
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
          attempts: totalAttempts,
          started_at: startedAt,
          finished_at: nowIso(),
          updated_at: nowIso(),
          error_code: stageErr.code,
        });
        logger.error("stage_failed", {
          stage: stage.name,
          compile_run_id: runId,
          attempt: totalAttempts,
          duration_ms: durationMs,
          error_code: stageErr.code,
          input_hash: inputHash,
        });
        results.push({
          name: stage.name,
          status: finalStatus,
          attempts: totalAttempts,
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
