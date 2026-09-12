/**
 * Safe API client for the LexiLoop web app (spec 7/8/10/11.2).
 *
 * Safety rules encoded here:
 * - Writes (POST/PUT/PATCH/DELETE) always carry the `Origin` header and, once
 *   a session exists, the session-derived CSRF token (`x-csrf-token`, matching
 *   the worker's `CSRF_HEADER`). They are sent exactly once — spec 11.2
 *   forbids client-side write retries; only `event_id` replay may repeat them.
 * - Reads (GET/HEAD) may retry idempotently, but the attempts are bounded
 *   (default 3 total) with exponential backoff on 5xx/429 and network errors.
 * - 401 never retries: it means the session is gone, so the client signals
 *   `onUnauthorized` exactly once and the app clears personal state and
 *   redirects to /login preserving the attempted route. A 403 `CSRF_INVALID`
 *   write response takes the same path: the session can no longer authorize
 *   writes, so re-authentication is the only way forward.
 * - Nothing is persisted. The CSRF token (delivered by `login()` and by the
 *   `/api/auth/me` bootstrap) lives in memory only; responses are handed to
 *   the caller (React Query cache is memory-only). No
 *   localStorage/IndexedDB/cookie writes anywhere in this module.
 */

import { z } from "zod";

/** Worker error envelope (spec 8): { code, message, request_id, details? }. */
export const errorEnvelopeSchema = z.object({
  code: z.string(),
  message: z.string(),
  request_id: z.string(),
  details: z.unknown().optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

const loginResponseSchema = z.object({
  user: z.object({
    user_id: z.string(),
    username: z.string(),
    status: z.string(),
  }),
  session: z.object({ expires_at: z.number() }),
  csrf_token: z.string(),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

const meResponseSchema = z.object({
  user: z.object({
    user_id: z.string(),
    username: z.string(),
    status: z.string(),
    session_version: z.number().optional(),
  }),
  session: z.object({ expires_at: z.number() }),
  settings: z
    .object({
      start_unit_key: z.string(),
      new_words_per_group: z.number(),
      daily_goal: z.number(),
      timezone: z.string(),
    })
    .nullable(),
  // Returned alongside the session data so a returning client (valid cookie,
  // cold page load) is write-ready without re-logging in.
  csrf_token: z.string(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

/** Error raised for any non-2xx or network failure. `status` is 0 offline. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details?: unknown;

  constructor(status: number, envelope: Pick<ErrorEnvelope, "code" | "message" | "request_id" | "details">) {
    super(envelope.message);
    this.name = "ApiError";
    this.status = status;
    this.code = envelope.code;
    this.requestId = envelope.request_id;
    if (envelope.details !== undefined) {
      this.details = envelope.details;
    }
  }
}

export interface ApiClientOptions {
  /** Injectable fetch (tests use stubs); defaults to globalThis.fetch. */
  fetchFn?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** API base URL; defaults to the current page origin. */
  baseUrl?: string;
  /** Value for the Origin header on writes; defaults to the base URL origin. */
  origin?: string;
  /** Injectable delay for read backoff (tests pass an instant no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts per read (writes are always exactly 1). Default 3. */
  readAttempts?: number;
  /** Invoked once per 401 before the error is thrown. */
  onUnauthorized?: () => void;
}

export interface ApiRequestInit {
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** JSON body; serialized and sent with application/json when present. */
  body?: unknown;
  headers?: HeadersInit;
}

export interface ApiClient {
  request(path: string, init?: ApiRequestInit): Promise<unknown>;
  login(username: string, password: string): Promise<LoginResponse>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  /** Stores the session CSRF token in memory only (never persisted). */
  setCsrfToken(token: string | undefined): void;
  /** Wiring point for the app-wide 401 handler (see clearPersonalState). */
  setOnUnauthorized(handler: (() => void) | undefined): void;
}

const DEFAULT_READ_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 300;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function backoffDelay(attempt: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** attempt;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchFn = options.fetchFn ?? ((input: string | URL, init?: RequestInit) => fetch(input, init));
  const baseUrl = options.baseUrl ?? globalThis.location?.origin ?? "http://localhost";
  const origin = options.origin ?? new URL(baseUrl).origin;
  const sleep = options.sleep ?? defaultSleep;
  const readAttempts = Math.max(1, options.readAttempts ?? DEFAULT_READ_ATTEMPTS);

  let csrfToken: string | undefined;
  let onUnauthorized = options.onUnauthorized;

  function parseEnvelopeOrFallback(status: number, raw: string): ApiError {
    try {
      const parsed: unknown = JSON.parse(raw);
      const envelope = errorEnvelopeSchema.parse(parsed);
      return new ApiError(status, envelope);
    } catch {
      return new ApiError(status, {
        code: "INTERNAL",
        message: "服务暂时不可用，请稍后重试",
        request_id: "",
      });
    }
  }

  async function toApiError(response: Response): Promise<ApiError> {
    const raw = await response.text().catch(() => "");
    return parseEnvelopeOrFallback(response.status, raw);
  }

  function buildHeaders(method: string, hasBody: boolean, extra?: HeadersInit): Headers {
    const headers = new Headers(extra);
    const isWrite = method !== "GET" && method !== "HEAD";
    if (hasBody) {
      headers.set("content-type", "application/json");
    }
    if (isWrite) {
      headers.set("origin", origin);
      if (csrfToken !== undefined) {
        headers.set("x-csrf-token", csrfToken);
      }
    }
    return headers;
  }

  async function request(path: string, init: ApiRequestInit = {}): Promise<unknown> {
    const method = init.method ?? "GET";
    const isWrite = method !== "GET" && method !== "HEAD";
    const attempts = isWrite ? 1 : readAttempts;
    const url = new URL(path, baseUrl);
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetchFn(url, {
          method,
          headers: buildHeaders(method, body !== undefined, init.headers),
          ...(body !== undefined ? { body } : {}),
        });
      } catch (cause) {
        // Network failure: retry reads only, then surface a stable error.
        if (attempt + 1 < attempts) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw new ApiError(0, {
          code: "NETWORK_ERROR",
          message: "网络连接失败，请检查网络后重试",
          request_id: "",
          ...(cause instanceof Error ? { details: { error_type: cause.name } } : {}),
        });
      }

      if (response.status === 401) {
        // The session is gone; retrying cannot help. Signal once, then throw.
        onUnauthorized?.();
        throw await toApiError(response);
      }

      if (!response.ok) {
        const error = await toApiError(response);
        if (error.status === 403 && error.code === "CSRF_INVALID") {
          // The session can no longer authorize writes (e.g. a stale token
          // after a server-side rotation). Retrying or re-issuing writes
          // cannot help; the only way forward is re-authentication, so take
          // the same path as a 401.
          onUnauthorized?.();
        }
        const retryable = !isWrite && (response.status >= 500 || response.status === 429);
        if (retryable && attempt + 1 < attempts) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        throw error;
      }

      if (response.status === 204) {
        return undefined;
      }
      return (await response.json()) as unknown;
    }
  }

  return {
    request,

    async login(username: string, password: string): Promise<LoginResponse> {
      const data = await request("/api/auth/login", {
        method: "POST",
        body: { username, password },
      });
      const parsed = loginResponseSchema.parse(data);
      csrfToken = parsed.csrf_token;
      return parsed;
    },

    async logout(): Promise<void> {
      try {
        await request("/api/auth/logout", { method: "POST" });
      } finally {
        // The session is revoked server-side either way; drop the in-memory
        // token so no later write can present it.
        csrfToken = undefined;
      }
    },

    async me(): Promise<MeResponse> {
      const parsed = meResponseSchema.parse(await request("/api/auth/me"));
      csrfToken = parsed.csrf_token;
      return parsed;
    },

    setCsrfToken(token: string | undefined): void {
      csrfToken = token;
    },

    setOnUnauthorized(handler: (() => void) | undefined): void {
      onUnauthorized = handler;
    },
  };
}
