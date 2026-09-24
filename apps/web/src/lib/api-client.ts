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

// ---------------------------------------------------------------------------
// Content (spec 8.2): shared textbook data, never personal fields.
// ---------------------------------------------------------------------------

const bootstrapResponseSchema = z.object({
  release_id: z.string(),
  config_version: z.number(),
  release: z.object({ status: z.string(), activated_at: z.number().nullable() }),
  books: z.array(
    z.object({ book_key: z.string(), title: z.string(), edition: z.string() }),
  ),
  units: z.array(
    z.object({
      unit_key: z.string(),
      book_key: z.string(),
      level: z.number(),
      unit_order: z.number(),
      title: z.string(),
    }),
  ),
});

export type BootstrapResponse = z.infer<typeof bootstrapResponseSchema>;

const unitContentResponseSchema = z.object({
  unit: z.object({
    unit_key: z.string(),
    book_key: z.string(),
    level: z.number(),
    unit_order: z.number(),
    title: z.string(),
  }),
  summary: z
    .object({
      status: z.string(),
      words: z.number(),
      senses: z.number(),
      phrases: z.number(),
      examples: z.number(),
      explanations: z.number(),
      cards: z.number(),
    })
    .nullable(),
  words: z.array(
    z.object({
      word_key: z.string(),
      headword: z.string(),
      phonetic: z.string().nullable(),
      tier: z.string(),
      source_order: z.number(),
    }),
  ),
});

export type UnitContentResponse = z.infer<typeof unitContentResponseSchema>;

const wordContentResponseSchema = z.object({
  word: z.object({
    word_key: z.string(),
    unit_key: z.string(),
    headword: z.string(),
    phonetic: z.string().nullable(),
    tier: z.string(),
    source_order: z.number(),
  }),
  unit: z.object({ unit_key: z.string(), title: z.string() }).nullable(),
  senses: z.array(
    z.object({
      sense_key: z.string(),
      pos: z.string(),
      gloss: z.string(),
      sense_order: z.number(),
    }),
  ),
  phrases: z.array(
    z.object({
      phrase_key: z.string(),
      sense_key: z.string().nullable(),
      text: z.string(),
      gloss: z.string(),
      source_order: z.number(),
    }),
  ),
  examples: z.array(
    z.object({
      example_key: z.string(),
      sense_key: z.string().nullable(),
      phrase_key: z.string().nullable(),
      origin: z.string(),
      source_ref: z.string().nullable(),
      text: z.string(),
      target_start: z.number(),
      target_end: z.number(),
      source_order: z.number(),
    }),
  ),
  explanations: z.array(
    z.object({
      explanation_key: z.string(),
      syntax_notes: z.array(z.string()),
      translation_hints: z.string(),
      pitfalls: z.array(z.string()),
      context_meanings: z.array(z.object({ example_key: z.string(), gloss: z.string() })),
      discrimination_candidates: z.array(
        z.object({ against_word_key: z.string(), note: z.string() }),
      ),
    }),
  ),
  related: z.array(z.object({ to_word_key: z.string(), relation_type: z.string() })),
  audio: z.array(
    z.object({ entity_type: z.string(), entity_key: z.string(), asset_key: z.string() }),
  ),
});

export type WordContentResponse = z.infer<typeof wordContentResponseSchema>;

// ---------------------------------------------------------------------------
// Dictionary search (spec 9.5): exact headword > prefix > Chinese gloss >
// phrase > example, with the matched-field metadata for highlighting.
// ---------------------------------------------------------------------------

export const searchMatchedFieldSchema = z.enum([
  "headword_exact",
  "headword_prefix",
  "sense_gloss",
  "phrase",
  "example",
]);
export type SearchMatchedField = z.infer<typeof searchMatchedFieldSchema>;

const searchHitSchema = z.object({
  word_key: z.string(),
  headword: z.string(),
  phonetic: z.string().nullable(),
  tier: z.string(),
  unit_key: z.string(),
  matched_field: searchMatchedFieldSchema,
  matched_text: z.string(),
});

export type SearchHit = z.infer<typeof searchHitSchema>;

const searchResponseSchema = z.object({
  query: z.string(),
  release_id: z.string(),
  hits: z.array(searchHitSchema),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

// ---------------------------------------------------------------------------
// Study and review (spec 8.3): sessions, the StudyPatch body, and grading.
// ---------------------------------------------------------------------------

/** Session mode (spec 8.3): 新词 / 快测 / 复习. */
export const studyModeSchema = z.enum(["NEW_WORDS", "QUICK_TEST", "REVIEW"]);
export type StudyMode = z.infer<typeof studyModeSchema>;

/** First-contact familiarity (spec 9.3): 很陌生 / 有印象 / 熟悉. */
export const familiarityChoiceSchema = z.enum([
  "VERY_UNFAMILIAR",
  "SOMEWHAT_FAMILIAR",
  "FAMILIAR",
]);
export type FamiliarityChoice = z.infer<typeof familiarityChoiceSchema>;

export type GradeRating = 1 | 2 | 3 | 4;

const studyQueueCardSchema = z.object({
  canonical_card_key: z.string(),
  presented_card_key: z.string(),
});

const sessionViewSchema = z.object({
  session_id: z.string(),
  mode: studyModeSchema,
  release_id: z.string(),
  position: z.number(),
  created_at: z.number(),
  expires_at: z.number(),
  cards: z.array(studyQueueCardSchema),
  /** Presented key at the current position; null when the queue is done. */
  current_card_key: z.string().nullable(),
  /** Distinct release-local unit keys of the snapshot's cards (sorted). */
  unit_keys: z.array(z.string()),
  /** Distinct release-local word keys of the snapshot's cards (sorted);
   *  lets a resuming client verify the session matches its selection. */
  word_keys: z.array(z.string()),
});

export type SessionView = z.infer<typeof sessionViewSchema>;

const studyPatchBodySchema = z.discriminatedUnion("action", [
  z.object({
    event_id: z.string(),
    action: z.literal("WORD_PRESENTED"),
    word_key: z.string(),
  }),
  z.object({
    event_id: z.string(),
    action: z.literal("FAMILIARITY_SET"),
    word_key: z.string(),
    familiarity: familiarityChoiceSchema,
  }),
]);

export type StudyPatchBody = z.infer<typeof studyPatchBodySchema>;

const patchProgressSchema = z.object({
  stage: z.string(),
  initial_familiarity: familiarityChoiceSchema.nullable(),
  first_seen_at: z.number(),
  last_seen_at: z.number(),
});

const patchResultSchema = z.object({
  event_id: z.string(),
  word_key: z.string(),
  progress: patchProgressSchema,
  replayed: z.boolean(),
});

export type PatchResult = z.infer<typeof patchResultSchema>;

export interface GradeRequestBody {
  event_id: string;
  session_id: string;
  /** Exact presented key of the queue's current item. */
  card_key: string;
  rating: GradeRating;
  duration_ms?: number;
}

const gradeResultSchema = z.object({
  event_id: z.string(),
  session_id: z.string(),
  card_key: z.string(),
  presented_card_key: z.string(),
  release_id: z.string(),
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  before_state: z.unknown(),
  after_state: z.unknown(),
  reviewed_at: z.number(),
  duration_ms: z.number().nullable(),
  undone_at: z.number().nullable(),
  replayed: z.boolean(),
});

export type GradeResult = z.infer<typeof gradeResultSchema>;

/** Result of the latest-only undo (apps/worker/src/study/undo.ts). */
const undoResultSchema = z.object({
  event_id: z.string(),
  undone_at: z.number(),
  card_key: z.string(),
  restored_state: z.unknown().nullable(),
  word_stage: z.string().nullable(),
});

export type UndoResult = z.infer<typeof undoResultSchema>;

// ---------------------------------------------------------------------------
// Personal progress and stats (spec 8.2/8.3).
// ---------------------------------------------------------------------------

/**
 * The word-progress route returns the RAW stored familiarity value
 * (UNKNOWN / RECOGNIZABLE / KNOWN — see apps/worker progress routes), unlike
 * the patch/grade responses which convert to the API choice enum.
 */
export const storedFamiliaritySchema = z.enum(["UNKNOWN", "RECOGNIZABLE", "KNOWN"]);

const wordProgressResponseSchema = z.object({
  word_key: z.string(),
  progress: z
    .object({
      stage: z.string(),
      initial_familiarity: storedFamiliaritySchema.nullable(),
      first_seen_at: z.number(),
      introduced_release_id: z.string().nullable(),
      introduced_at: z.number().nullable(),
      last_seen_at: z.number(),
    })
    .nullable(),
});

export type WordProgressResponse = z.infer<typeof wordProgressResponseSchema>;

const wordProgressBatchResponseSchema = z.object({
  words: z.array(wordProgressResponseSchema),
});

const statsOverviewSchema = z.object({
  learned_words: z.number(),
  learned_cards: z.number(),
  estimated_retention: z.number().nullable(),
  reviews_today: z.number(),
  reviews_total: z.number(),
  streak_days: z.number(),
  due_forecast: z.array(z.object({ date: z.string(), cards: z.number() })),
  difficult_words: z.array(
    z.object({
      word_key: z.string(),
      headword: z.string().nullable(),
      lapses: z.number(),
      max_difficulty: z.number(),
      cards: z.number(),
    }),
  ),
  units: z.array(
    z.object({
      unit_key: z.string(),
      title: z.string(),
      total_cards: z.number(),
      studied_cards: z.number(),
      coverage: z.number(),
      estimated_retention: z.number().nullable(),
    }),
  ),
});

export type StatsOverview = z.infer<typeof statsOverviewSchema>;

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
  /** Invoked once per auth-expiry episode (401/403 CSRF_INVALID) before the
   *  error is thrown; re-armed by the next successful login()/me(). */
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
  /** Shared release content: books and units (spec 8.2). */
  bootstrap(sessionId?: string): Promise<BootstrapResponse>;
  /** One unit's teaching structure and word list (spec 8.2). */
  unitContent(unitKey: string, sessionId?: string): Promise<UnitContentResponse>;
  /** Full dictionary entry for one word (spec 8.2). */
  wordContent(wordKey: string, sessionId?: string): Promise<WordContentResponse>;
  /** Dictionary search across the release (spec 9.5). */
  searchContent(query: string, limit?: number): Promise<SearchResponse>;
  /** URL for a private audio asset, optionally session-release-pinned. */
  audioUrl(assetKey: string, sessionId?: string): string;
  /** Silently downloads an audio asset so the SW/browser can cache it. */
  prefetchAudio(url: string): Promise<void>;
  /** Word-level personal progress (spec 8.2): the ONLY personal word state. */
  wordProgress(wordKey: string): Promise<WordProgressResponse>;
  /** Batch progress for setup previews (one request for the whole unit). */
  wordProgressBatch(wordKeys: readonly string[]): Promise<WordProgressResponse[]>;
  /** Learning overview (spec 9.6). */
  statsOverview(): Promise<StatsOverview>;
  /** The caller's unexpired study sessions (resume, spec 8.3). */
  listStudySessions(): Promise<SessionView[]>;
  /** Creates a fixed-release study session (spec 8.3). */
  createStudySession(mode: StudyMode): Promise<SessionView>;
  /** One session with its frozen queue and current position (spec 8.3). */
  getStudySession(sessionId: string): Promise<SessionView>;
  /** WORD_PRESENTED / FAMILIARITY_SET progress patch, idempotent by event_id. */
  patchStudySession(sessionId: string, patch: StudyPatchBody): Promise<PatchResult>;
  /** Server-side FSRS grade of the queue's current card (spec 8.3). */
  gradeReview(requestBody: GradeRequestBody): Promise<GradeResult>;
  /** Revokes the caller's LATEST valid, un-undone review event (spec 8.3). */
  undoReview(eventId: string): Promise<UndoResult>;
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
  // Auth-expiry episodes: once the handler has been told the session is gone,
  // further 401s from in-flight or re-mounted reads are the SAME expiry and
  // must not re-trigger state clearing (the shell clears personal state and
  // redirects exactly once). The signal re-arms when a session is
  // re-established through a successful login() or me().
  let unauthorizedSignaled = false;

  function signalUnauthorized(): void {
    if (unauthorizedSignaled) {
      return;
    }
    unauthorizedSignaled = true;
    onUnauthorized?.();
  }

  function sessionReestablished(): void {
    unauthorizedSignaled = false;
  }

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
        // The session is gone; retrying cannot help. Signal once per expiry
        // episode, then throw.
        signalUnauthorized();
        throw await toApiError(response);
      }

      if (!response.ok) {
        const error = await toApiError(response);
        if (error.status === 403 && error.code === "CSRF_INVALID") {
          // The session can no longer authorize writes (e.g. a stale token
          // after a server-side rotation). Retrying or re-issuing writes
          // cannot help; the only way forward is re-authentication, so take
          // the same path as a 401.
          signalUnauthorized();
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
      sessionReestablished();
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
      sessionReestablished();
      return parsed;
    },

    async bootstrap(sessionId?: string): Promise<BootstrapResponse> {
      const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
      return bootstrapResponseSchema.parse(await request(`/api/content/bootstrap${query}`));
    },

    async unitContent(unitKey: string, sessionId?: string): Promise<UnitContentResponse> {
      const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
      return unitContentResponseSchema.parse(
        await request(`/api/content/units/${encodeURIComponent(unitKey)}${query}`),
      );
    },

    async wordContent(wordKey: string, sessionId?: string): Promise<WordContentResponse> {
      const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
      return wordContentResponseSchema.parse(
        await request(`/api/content/words/${encodeURIComponent(wordKey)}${query}`),
      );
    },

    async searchContent(query: string, limit?: number): Promise<SearchResponse> {
      const params = new URLSearchParams({ q: query });
      if (limit !== undefined) {
        params.set("limit", String(limit));
      }
      return searchResponseSchema.parse(await request(`/api/content/search?${params.toString()}`));
    },

    audioUrl(assetKey: string, sessionId?: string): string {
      const url = new URL(
        `/api/audio/${assetKey.split("/").map(encodeURIComponent).join("/")}`,
        baseUrl,
      );
      if (sessionId) {
        url.searchParams.set("session", sessionId);
      }
      return url.toString();
    },

    async prefetchAudio(url: string): Promise<void> {
      const response = await fetchFn(url, {
        method: "GET",
        credentials: "same-origin",
        headers: { accept: "audio/*" },
      });
      if (response.status === 401) {
        signalUnauthorized();
      }
      if (!response.ok) {
        throw new ApiError(response.status, {
          code: "AUDIO_PREFETCH_FAILED",
          message: "Audio prefetch failed",
          request_id: "",
        });
      }
      // Consume the body: this guarantees the full object is available to
      // the Service Worker's cache.put() (or the browser HTTP cache).
      await response.arrayBuffer();
    },

    async wordProgress(wordKey: string): Promise<WordProgressResponse> {
      return wordProgressResponseSchema.parse(
        await request(`/api/progress/words/${encodeURIComponent(wordKey)}`),
      );
    },

    async wordProgressBatch(wordKeys: readonly string[]): Promise<WordProgressResponse[]> {
      const unique = [...new Set(wordKeys)];
      if (unique.length === 0) {
        return [];
      }
      const chunks = Array.from(
        { length: Math.ceil(unique.length / 200) },
        (_, index) => unique.slice(index * 200, (index + 1) * 200),
      );
      const responses = await Promise.all(
        chunks.map(async (chunk) => {
          const params = new URLSearchParams({ keys: chunk.join(",") });
          return wordProgressBatchResponseSchema.parse(
            await request(`/api/progress/words?${params.toString()}`),
          ).words;
        }),
      );
      return responses.flat();
    },

    async statsOverview(): Promise<StatsOverview> {
      return statsOverviewSchema.parse(await request("/api/stats/overview"));
    },

    async listStudySessions(): Promise<SessionView[]> {
      const parsed = z.object({ sessions: z.array(sessionViewSchema) }).parse(
        await request("/api/study/sessions"),
      );
      return parsed.sessions;
    },

    async createStudySession(mode: StudyMode): Promise<SessionView> {
      return sessionViewSchema.parse(
        await request("/api/study/sessions", { method: "POST", body: { mode } }),
      );
    },

    async getStudySession(sessionId: string): Promise<SessionView> {
      return sessionViewSchema.parse(
        await request(`/api/study/sessions/${encodeURIComponent(sessionId)}`),
      );
    },

    async patchStudySession(sessionId: string, patch: StudyPatchBody): Promise<PatchResult> {
      // Validate through the same shape the Worker enforces so a client bug
      // fails locally instead of spending a write request.
      const body = studyPatchBodySchema.parse(patch);
      return patchResultSchema.parse(
        await request(`/api/study/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          body,
        }),
      );
    },

    async gradeReview(requestBody: GradeRequestBody): Promise<GradeResult> {
      return gradeResultSchema.parse(
        await request("/api/reviews/grade", { method: "POST", body: requestBody }),
      );
    },

    async undoReview(eventId: string): Promise<UndoResult> {
      return undoResultSchema.parse(
        await request(`/api/reviews/${encodeURIComponent(eventId)}/undo`, {
          method: "POST",
        }),
      );
    },

    setCsrfToken(token: string | undefined): void {
      csrfToken = token;
    },

    setOnUnauthorized(handler: (() => void) | undefined): void {
      onUnauthorized = handler;
    },
  };
}
