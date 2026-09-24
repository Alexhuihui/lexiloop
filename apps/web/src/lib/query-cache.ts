/**
 * Memory-only React Query policy and personal-state clearing (spec 10).
 *
 * - The query client is deliberately created WITHOUT any persistence plugin:
 *   personal state lives in memory and the in-memory query cache only.
 * - `clearPersonalState` is the single logout/expiry exit path: it clears the
 *   query cache, removes every `lexiloop`-prefixed web storage key and the
 *   personal IndexedDB databases, and posts the cache-clear message to the
 *   Service Worker (feature-detected — the worker itself lands in Task 17,
 *   which owns the matching message handler). The static App Shell precache
 *   is allowed to survive; content/audio caches are the worker's to drop.
 */

import { QueryClient } from "@tanstack/react-query";

/** Cache key for the authenticated session probe (`GET /api/auth/me`). */
export const AUTH_ME_QUERY_KEY = ["auth", "me"] as const;

/** Cache key for the learning overview (`GET /api/stats/overview`). */
export const STATS_OVERVIEW_QUERY_KEY = ["stats", "overview"] as const;

/** Cache key for the shared release bootstrap (`GET /api/content/bootstrap`). */
export const CONTENT_BOOTSTRAP_QUERY_KEY = ["content", "bootstrap"] as const;

/** Cache key for one unit's shared teaching content. */
export function unitContentQueryKey(unitKey: string): readonly ["content", "unit", string] {
  return ["content", "unit", unitKey] as const;
}

/** Cache key for the caller's unexpired study sessions (resume). */
export const STUDY_SESSIONS_QUERY_KEY = ["study", "sessions"] as const;

/** Posted to the Service Worker on logout/expiry (matched by Task 17's sw). */
export const SW_CACHE_CLEAR_MESSAGE = { type: "lexiloop:clear-caches" } as const;

/** Every personal storage key/database this app may ever create is prefixed. */
const PERSONAL_STORAGE_PREFIX = "lexiloop";
const PERSONAL_DB_NAMES = ["lexiloop"] as const;

export type AppQueryClient = QueryClient;

export function createAppQueryClient(): AppQueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retry policy is owned by the API client: bounded retries for
        // idempotent reads only. React Query must not add a second layer.
        retry: false,
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        gcTime: 15 * 60_000,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/** Minimal structural types so tests can inject fakes for every sink. */
export interface ClearPersonalStateOptions {
  localStorage?: StorageLike | null;
  sessionStorage?: StorageLike | null;
  indexedDB?: IDBFactoryLike | null;
  serviceWorkerContainer?: ServiceWorkerContainerLike | null;
}

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  removeItem(key: string): void;
}

interface IDBFactoryLike {
  deleteDatabase(name: string): unknown;
}

interface ServiceWorkerContainerLike {
  controller?: { postMessage(message: unknown): void } | null;
}

function removePrefixedKeys(storage: StorageLike | null | undefined): void {
  if (!storage) {
    return;
  }
  const doomed: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(PERSONAL_STORAGE_PREFIX)) {
      doomed.push(key);
    }
  }
  for (const key of doomed) {
    storage.removeItem(key);
  }
}

export function clearPersonalState(
  queryClient: AppQueryClient,
  options: ClearPersonalStateOptions = {},
): void {
  // Stop in-flight personal reads first: a fetch that settles after the
  // cache is dropped must not leave a late entry behind.
  queryClient.cancelQueries();
  queryClient.clear();

  const localStorageSink =
    options.localStorage !== undefined
      ? options.localStorage
      : (globalThis.localStorage ?? null);
  const sessionStorageSink =
    options.sessionStorage !== undefined
      ? options.sessionStorage
      : (globalThis.sessionStorage ?? null);
  removePrefixedKeys(localStorageSink);
  removePrefixedKeys(sessionStorageSink);

  const idb = options.indexedDB !== undefined ? options.indexedDB : (globalThis.indexedDB ?? null);
  if (idb) {
    for (const name of PERSONAL_DB_NAMES) {
      idb.deleteDatabase(name);
    }
  }

  // Feature-detected: no Service Worker exists until Task 17 wires it up.
  const container =
    options.serviceWorkerContainer !== undefined
      ? options.serviceWorkerContainer
      : (globalThis.navigator?.serviceWorker ?? null);
  container?.controller?.postMessage(SW_CACHE_CLEAR_MESSAGE);
}
