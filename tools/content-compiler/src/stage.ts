/**
 * Stage protocol for the Content Compiler pipeline (spec 5.2).
 *
 * A stage is a named, versioned unit of compile work. The pipeline (see
 * `pipeline.ts`) schedules stages in order, hashes their inputs to decide
 * resume/invalidation, persists state transitions in the ledger, and retries
 * only errors explicitly marked retryable.
 */
import { createHash } from "node:crypto";
import type { ZodType } from "zod";
import type { LedgerStore } from "./ledger";
import type { CompilerLogger } from "./logging";

/** Ledger status values for a stage (spec 5.2). */
export const STAGE_STATUSES = ["PENDING", "RUNNING", "PASSED", "FAILED", "BLOCKED"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

/**
 * Error type stages throw. `retryable` gates pipeline retries (spec 11.1:
 * only network timeouts / rate limits are retried; config and schema errors
 * fail closed). `blocked` marks an unrecoverable unit that must never reach
 * the release stage.
 */
export class StageError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly blocked: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; blocked?: boolean } = {},
  ) {
    super(message);
    this.name = "StageError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.blocked = options.blocked ?? false;
  }
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Deterministic stringify (object keys sorted recursively) so hashes of the
 * same logical value are stable across processes.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function hashJson(value: unknown): string {
  return hashString(stableStringify(value));
}

/** Provenance of the previous stage's output, passed to the next stage. */
export interface StageUpstream {
  stage: string;
  outputHash: string | null;
}

/**
 * Per-run context handed to every stage. `config` carries versioned stage
 * configuration (e.g. watermark mask rules) whose values feed input hashes;
 * it must never contain secrets or raw source text.
 */
export interface StageRunContext {
  readonly runId: string;
  readonly sourceHash: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly ledger: LedgerStore;
  readonly logger: CompilerLogger;
  readonly upstream: StageUpstream | null;
}

/**
 * A pipeline stage, generic over its input/output. `computeInputHash` must
 * return a hash over everything the stage consumes besides upstream output
 * (inputs, versioned config); the pipeline combines it with `configVersion`
 * to decide resume vs. re-run.
 */
export interface Stage<I, O> {
  name: string;
  configVersion: string;
  inputSchema: ZodType<I>;
  outputSchema: ZodType<O>;
  computeInputHash(ctx: StageRunContext): Promise<string> | string;
  run(input: I, ctx: StageRunContext): Promise<O>;
}

/** Heterogeneous stage arrays use erasing to unknown on both sides. */
export type AnyStage = Stage<unknown, unknown>;
