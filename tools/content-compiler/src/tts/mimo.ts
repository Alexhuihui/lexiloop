/**
 * Xiaomi MiMo TTS provider — the V1 default backend (spec 5.8).
 *
 * MiMo v2.5 TTS is served through an OpenAI-compatible chat-completions
 * endpoint (`POST <base>/chat/completions`) where the synthesis TARGET TEXT
 * must be carried by an `assistant`-role message (never `user`), and the
 * voice/format travel in the `audio` object. The response carries the audio
 * as base64 in `choices[0].message.audio.data`.
 *
 * Failure handling: bounded retries ONLY for retryable statuses (rate limits
 * and 5xx) and transport errors; every other status fails immediately. The
 * Authorization header is attached per request but its value is redacted in
 * error details and never logged — the key lives only in the local env.
 */
import type { CompilerLogger } from "../logging";
import {
  TtsProviderError,
  type TtsFetchFn,
  type TtsProvider,
  type TtsSynthesisRequest,
  type TtsSynthesisResult,
} from "./provider";

export interface MiMoTtsOptions {
  /** API key from the local env (never logged, never persisted). */
  apiKey: string;
  /** OpenAI-compatible base URL, e.g. https://api.xiaomimimo.com/v1 */
  baseUrl: string;
  /** Model id, e.g. mimo-v2.5-tts */
  model: string;
  /** Preset voice id, e.g. Mia */
  voice: string;
  /** Output container format requested from the provider (default wav). */
  format?: string;
  /** Per-request timeout in milliseconds (default 120s). */
  timeoutMs?: number;
  /** Retry budget AFTER the initial attempt (default 2, bounded). */
  maxRetries?: number;
  /** Status codes worth retrying (default 429/500/502/503/504). */
  retryableStatusCodes?: readonly number[];
  /** Injectable HTTP boundary (tests); defaults to global fetch. */
  fetchFn?: TtsFetchFn;
  /** Injectable backoff sleep (tests); default capped exponential. */
  sleep?: (ms: number) => Promise<void>;
  /** Structured logger; only allowlisted fields are ever emitted. */
  logger?: CompilerLogger;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRYABLE_STATUSES = [429, 500, 502, 503, 504] as const;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 8_000;

/** Zod-free structural check of the MiMo audio response (fail closed). */
function extractAudioBase64(payload: unknown): string {
  if (payload === null || typeof payload !== "object") {
    throw new TtsProviderError("TTS_RESPONSE_INVALID", "MiMo response is not an object", {
      retryable: false,
    });
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new TtsProviderError("TTS_RESPONSE_INVALID", "MiMo response has no choices", {
      retryable: false,
    });
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (message === null || typeof message !== "object") {
    throw new TtsProviderError("TTS_RESPONSE_INVALID", "MiMo response choice has no message", {
      retryable: false,
    });
  }
  const audio = (message as { audio?: unknown }).audio;
  const data =
    audio !== null && typeof audio === "object"
      ? (audio as { data?: unknown }).data
      : undefined;
  if (typeof data !== "string" || data.length === 0) {
    throw new TtsProviderError(
      "TTS_RESPONSE_INVALID",
      "MiMo response carries no audio data (choices[0].message.audio.data)",
      { retryable: false },
    );
  }
  return data;
}

/** Header dump safe for error details/logs: the key value never appears. */
const REDACTED_REQUEST_HEADERS: Record<string, string> = {
  Authorization: "Bearer [REDACTED]",
  "Content-Type": "application/json",
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelayMs(failedAttempt: number): number {
  const uncapped = DEFAULT_BASE_DELAY_MS * 2 ** (failedAttempt - 1);
  return Math.min(uncapped, DEFAULT_MAX_DELAY_MS);
}

/**
 * Build the MiMo chat-completions request body for one normalized text.
 * Exported for contract tests: the target text MUST stay in the assistant
 * role (the MiMo v2.5 contract rejects user-role target text).
 */
export function buildMiMoTtsRequestBody(options: {
  model: string;
  text: string;
  voice: string;
  format: string;
}): Record<string, unknown> {
  return {
    model: options.model,
    messages: [{ role: "assistant", content: options.text }],
    audio: { format: options.format, voice: options.voice },
  };
}

/** Create the V1 default TTS provider bound to Xiaomi MiMo v2.5. */
export function createMiMoTtsProvider(options: MiMoTtsOptions): TtsProvider {
  const format = options.format ?? "wav";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const retryableStatuses = new Set<number>(
    (options.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUSES) as readonly number[],
  );
  const fetchFn: TtsFetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    name: "mimo",
    synthesize: async (request: TtsSynthesisRequest): Promise<TtsSynthesisResult> => {
      const body = JSON.stringify(
        buildMiMoTtsRequestBody({
          model: options.model,
          text: request.text,
          voice: options.voice,
          format,
        }),
      );
      let lastError: TtsProviderError | null = null;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchFn(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
            },
            body,
            signal: controller.signal,
          });
          if (response.ok) {
            return { audioBase64: extractAudioBase64(await response.json()) };
          }
          const retryable = retryableStatuses.has(response.status);
          lastError = new TtsProviderError(
            `TTS_HTTP_${response.status}`,
            `MiMo TTS request failed with HTTP ${response.status}` +
              `${retryable ? ` (attempt ${attempt}/${maxRetries + 1})` : ""}`,
            {
              retryable,
              status: response.status,
              details: { url, headers: REDACTED_REQUEST_HEADERS },
            },
          );
        } catch (err) {
          // Response-contract failures are already typed and NOT retryable —
          // never disguise them as transport errors.
          if (err instanceof TtsProviderError) {
            options.logger?.warn("tts_request_failed", { error_code: err.code });
            throw err;
          }
          // Transport errors and aborts are worth a bounded retry.
          const message = err instanceof Error ? err.message : String(err);
          lastError = new TtsProviderError("TTS_NETWORK", `MiMo TTS transport failure: ${message}`, {
            retryable: true,
            details: { url, headers: REDACTED_REQUEST_HEADERS },
          });
        } finally {
          clearTimeout(timer);
        }
        if (!lastError.retryable || attempt > maxRetries) {
          options.logger?.warn("tts_request_failed", { error_code: lastError.code });
          throw lastError;
        }
        await sleep(backoffDelayMs(attempt));
      }
      // Unreachable: the loop always returns or throws.
      throw lastError ?? new TtsProviderError("TTS_NETWORK", "MiMo TTS request failed");
    },
  };
}
