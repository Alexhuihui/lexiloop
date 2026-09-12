/**
 * LexiLoop Service Worker (spec 10, plan Task 17): a hand-rolled worker with
 * NO workbox. Cache policy in one place:
 *
 * - The ONLY precache is the static App Shell (`/` document, manifest, icons).
 *   V1 promises NO offline textbook reading: an offline navigation gets the
 *   cached shell, and the app inside it renders its own offline notices
 *   because every personal API read fails.
 * - `/api/auth/*`, `/api/progress/*`, `/api/study/*`, `/api/reviews/*`, and
 *   `/api/stats/*` are NEVER cached (they are `private, no-store` on the
 *   wire) and no write request is ever cached.
 * - `/api/content/*` may live in a release-scoped Cache Storage
 *   (`lexiloop-content-<release_id>`) during an authenticated session. In V1
 *   the cache is WRITE-THROUGH ONLY: responses are stored per release (so
 *   shared textbook bytes are stored once and the namespace machinery is in
 *   place), but a content request is NEVER ANSWERED from cache — offline or
 *   otherwise — so cached教材 detail can never bypass Session state (spec
 *   10's offline rule). The bootstrap response's `release_id` switches the
 *   active namespace and prunes the old ones (V1 simplification: the prune is
 *   immediate; an in-progress old-release session simply re-fetches its
 *   content from the network).
 * - Audio (`/api/audio/*`) is content-hash addressed and release-independent
 *   (spec 5.8), so it is cached first under the URL with the `session` query
 *   stripped — instant replays, no session ids in cache keys. Media range
 *   requests are answered with the whole object (the assets are tiny and a
 *   200 is valid HTTP for a ranged request): Chromium forbids the Range
 *   header on a SW-initiated fetch(), so it must be stripped before the
 *   network passthrough (audioPassthroughRequest).
 * - The logout message (`lexiloop:clear-caches`, posted by
 *   `clearPersonalState` in lib/query-cache.ts) deletes every content and
 *   audio cache; the static shell precache survives.
 *
 * The policy functions below are pure and unit-tested by sw.test.ts; the
 * browser lifecycle itself is Task 18's E2E territory.
 */

// ---------------------------------------------------------------------------
// Pure policy surface
// ---------------------------------------------------------------------------

export const SHELL_CACHE = "lexiloop-shell-v1";
export const AUDIO_CACHE = "lexiloop-audio-v1";
export const CONTENT_CACHE_PREFIX = "lexiloop-content-";

/** The cached shell document that offline navigations fall back to. */
export const SHELL_DOCUMENT = "/";

/** The static App Shell precache — deliberately minimal and deterministic. */
export const PRECACHE_URLS: readonly string[] = [
  "/",
  "/manifest.webmanifest",
  "/icons/lexiloop.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/maskable-512.png",
];

/** Matched by the logout/expiry message in lib/query-cache.ts. */
export const CLEAR_CACHES_MESSAGE = { type: "lexiloop:clear-caches" } as const;

export type RequestKind = "navigate" | "static" | "content" | "audio" | "network-only";

/** Personal data prefixes that are never touched by any cache (spec 10). */
export const PERSONAL_API_PREFIXES: readonly string[] = [
  "/api/auth/",
  "/api/progress/",
  "/api/study/",
  "/api/reviews/",
  "/api/stats/",
];

/**
 * Classifies one request against the worker's scope origin. Everything that
 * is not a same-origin, idempotent shell/content/audio read is network-only.
 */
export function classifyRequest(
  url: URL,
  method: string,
  mode: string,
  scopeOrigin: string,
): RequestKind {
  if (method !== "GET" && method !== "HEAD") {
    return "network-only";
  }
  if (url.origin !== scopeOrigin) {
    return "network-only";
  }
  if (PERSONAL_API_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
    return "network-only";
  }
  if (url.pathname === "/api/audio" || url.pathname.startsWith("/api/audio/")) {
    return "audio";
  }
  if (url.pathname === "/api/content" || url.pathname.startsWith("/api/content/")) {
    return "content";
  }
  if (mode === "navigate") {
    return "navigate";
  }
  return "static";
}

/**
 * What a failed request of each kind may fall back to. Only a NAVIGATION may
 * be answered with the precached shell; a failed content/audio read must
 * surface as a failure so the app shows its notice instead of cached教材
 * detail (spec 10).
 */
export function offlineFallback(kind: RequestKind): string | null {
  return kind === "navigate" ? SHELL_DOCUMENT : null;
}

/** Release-scoped content cache name (`release_id + URL`, spec 10). */
export function contentCacheName(releaseId: string): string {
  return `${CONTENT_CACHE_PREFIX}${releaseId}`;
}

export function isContentCacheName(name: string): boolean {
  return name.startsWith(CONTENT_CACHE_PREFIX);
}

/**
 * Old content namespaces to delete when `activeReleaseId` changes. V1
 * policy: prune immediately on the switch (or when no release is known
 * anymore) — an in-progress old-release session simply re-fetches.
 */
export function pruneContentCacheNames(
  names: readonly string[],
  activeReleaseId: string | null,
): string[] {
  return names.filter((name) => {
    if (!isContentCacheName(name)) {
      return false;
    }
    return activeReleaseId === null || name !== contentCacheName(activeReleaseId);
  });
}

/** Cache names the logout message must delete; the shell precache survives. */
export function cachesToDeleteOnLogout(names: readonly string[]): string[] {
  return names.filter((name) => isContentCacheName(name) || name === AUDIO_CACHE);
}

/**
 * Audio cache key: the URL with the `session` query stripped, because the
 * asset key itself is the content hash (spec 5.8) and audio objects are
 * release-independent — no session id should fragment or leak into keys.
 */
export function audioCacheKey(url: URL): string {
  const key = new URL(url.toString());
  key.searchParams.delete("session");
  return key.toString();
}

/**
 * A fetch()-able Request without the media `Range` header. Chromium forbids
 * the Range header on a Service-Worker-initiated fetch() (forbidden header
 * name), so an `<audio>` range request handed back to `fetch(request)` fails
 * with "Failed to fetch" before the network is reached. Audio assets are
 * tiny content-addressed WAVs, so answering a ranged media request with the
 * whole 200 object is valid HTTP (RFC 9110 allows servers to ignore Range).
 */
export function audioPassthroughRequest(request: Request): Request {
  if (!request.headers.has("range")) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.delete("range");
  return new Request(request.url, { method: request.method, headers });
}

// ---------------------------------------------------------------------------
// Runtime (registered only inside a real ServiceWorkerGlobalScope)
// ---------------------------------------------------------------------------

interface FetchEventLike extends Event {
  request: Request;
  respondWith(response: Promise<Response>): void;
}

interface MessageEventLike extends Event {
  data: unknown;
}

interface ServiceWorkerScopeLike {
  location: { origin: string };
  addEventListener(type: string, listener: (event: Event) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
}

/** Offline fallback response when even the shell precache is missing. */
function offlineResponse(): Response {
  return new Response("离线状态下暂不可用", {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function registerHandlers(): void {
  const scope = self as unknown as ServiceWorkerScopeLike;
  // The content namespace observed from the bootstrap response.
  let activeReleaseId: string | null = null;

  async function activateRelease(nextReleaseId: string): Promise<void> {
    if (activeReleaseId === nextReleaseId) {
      return;
    }
    activeReleaseId = nextReleaseId;
    const names = await caches.keys();
    await Promise.all(
      pruneContentCacheNames(names, activeReleaseId).map((name) => caches.delete(name)),
    );
  }

  async function forgetRelease(): Promise<void> {
    activeReleaseId = null;
  }

  scope.addEventListener("install", () => {
    const install = async (): Promise<void> => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll([...PRECACHE_URLS]);
      await scope.skipWaiting();
    };
    void install();
  });

  scope.addEventListener("activate", () => {
    void scope.clients.claim();
  });

  scope.addEventListener("message", (event: Event) => {
    if ((event as MessageEventLike).data === undefined) {
      return;
    }
    const data = (event as MessageEventLike).data as { type?: unknown } | null;
    if (data === null || typeof data !== "object" || data.type !== CLEAR_CACHES_MESSAGE.type) {
      return;
    }
    const clear = async (): Promise<void> => {
      await forgetRelease();
      const names = await caches.keys();
      await Promise.all(
        cachesToDeleteOnLogout(names).map((name) => caches.delete(name)),
      );
    };
    void clear();
  });

  scope.addEventListener("fetch", (event: Event) => {
    const fetchEvent = event as FetchEventLike;
    const request = fetchEvent.request;
    const kind = classifyRequest(
      new URL(request.url),
      request.method,
      request.mode,
      scope.location.origin,
    );

    if (kind === "network-only") {
      // Default browser handling: the network, and nothing else.
      return;
    }

    if (kind === "navigate") {
      fetchEvent.respondWith(
        fetch(request).catch(async () => {
          const cached = await caches.match(SHELL_DOCUMENT, { cacheName: SHELL_CACHE });
          return cached ?? offlineResponse();
        }),
      );
      return;
    }

    if (kind === "static") {
      fetchEvent.respondWith(
        (async () => {
          const cached = await caches.match(request, { cacheName: SHELL_CACHE });
          if (cached) {
            return cached;
          }
          const response = await fetch(request);
          if (response.ok) {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(request, response.clone());
          }
          return response;
        })(),
      );
      return;
    }

    if (kind === "audio") {
      fetchEvent.respondWith(
        (async () => {
          const key = audioCacheKey(new URL(request.url));
          const cached = await caches.match(key, { cacheName: AUDIO_CACHE });
          if (cached) {
            return cached;
          }
          // Range must be stripped (see audioPassthroughRequest): Chromium
          // rejects a SW fetch() that carries it, which would fail every
          // first `<audio>` play before the network is reached.
          const response = await fetch(audioPassthroughRequest(request));
          if (response.ok) {
            const cache = await caches.open(AUDIO_CACHE);
            await cache.put(key, response.clone());
          }
          return response;
        })(),
      );
      return;
    }

    // Content: network-first, write-through into the release namespace,
    // NEVER answered from cache (see module doc). The bootstrap response
    // carries the active release id and switches the namespace.
    fetchEvent.respondWith(
      (async () => {
        let response: Response;
        try {
          response = await fetch(request);
        } catch {
          // No cache fallback for content, offline included (module doc).
          return new Response("离线状态下暂不可用", {
            status: 503,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
        if (!response.ok) {
          return response;
        }
        const url = new URL(request.url);
        if (url.pathname === "/api/content/bootstrap") {
          // The response IS the bootstrap: observe it and switch namespaces.
          const observe = async (): Promise<void> => {
            try {
              const body = (await response.clone().json()) as { release_id?: unknown };
              if (typeof body.release_id === "string" && body.release_id !== "") {
                await activateRelease(body.release_id);
              }
            } catch {
              // Namespace bookkeeping must never break the read.
            }
          };
          void observe();
        }
        const writeThrough = async (): Promise<void> => {
          if (activeReleaseId === null) {
            // Before the first bootstrap observation there is no namespace.
            return;
          }
          try {
            const cache = await caches.open(contentCacheName(activeReleaseId));
            await cache.put(request, response.clone());
          } catch {
            // Storage failures must never break the read.
          }
        };
        void writeThrough();
        return response;
      })(),
    );
  });
}

// happy-dom/vitest define `window`; a real ServiceWorkerGlobalScope does not.
if (typeof window === "undefined" && typeof self !== "undefined") {
  registerHandlers();
}
