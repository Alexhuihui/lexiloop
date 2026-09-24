/**
 * Replaceable TTS provider seam (spec 5.8).
 *
 * V1 ships the Xiaomi MiMo provider (`mimo.ts`), but every consumer — the
 * cache, the planner, the TTS_SYNTHESIZE stage — depends only on the
 * `TtsProvider` interface here, so a later provider swap never touches the
 * compile pipeline. The API key is read ONLY from the local environment
 * (both `MIMO_API_KEY` and the legacy local name `mimo-key`), never written
 * to logs, manifests, or the repository: `TtsProviderError.details` carries a
 * header dump whose Authorization value is always `[REDACTED]`.
 */

/** Minimal fetch surface the MiMo provider needs (injectable for tests). */
export type TtsFetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** One synthesis request: the normalized text to speak. */
export interface TtsSynthesisRequest {
  readonly text: string;
}

/** One synthesis result: the provider's base64-encoded audio payload. */
export interface TtsSynthesisResult {
  readonly audioBase64: string;
}

/**
 * A TTS backend. Implementations must be stateless per call, must never log
 * or embed the API key, and must mark transport/rate-limit failures as
 * `retryable` so the pipeline's bounded retry budget applies to them only.
 */
export interface TtsProvider {
  /** Stable provider identity (part of the cache key, spec 5.8). */
  readonly name: string;
  synthesize(request: TtsSynthesisRequest): Promise<TtsSynthesisResult>;
}

/**
 * Provider failure with a stable machine-readable code. `retryable` is true
 * only for transport errors and retryable HTTP statuses (rate limits, 5xx).
 * `details` is safe to log: secrets are redacted before construction.
 */
export class TtsProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; status?: number | null; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "TtsProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.details = options.details ?? {};
  }
}

/** Current local env var name holding the MiMo API key. */
export const MIMO_API_KEY_ENV = "MIMO_API_KEY";
/** Legacy local env var name kept working for the private setup. */
export const MIMO_API_KEY_LEGACY_ENV = "mimo-key";

/**
 * Resolve the API key from the local environment only: `MIMO_API_KEY` wins
 * over the legacy `mimo-key`. Returns null when neither is set — callers
 * must fail closed instead of guessing. The value is never logged anywhere.
 */
export function resolveTtsApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const current = env[MIMO_API_KEY_ENV];
  if (typeof current === "string" && current.length > 0) return current;
  const legacy = env[MIMO_API_KEY_LEGACY_ENV];
  if (typeof legacy === "string" && legacy.length > 0) return legacy;
  return null;
}
