/**
 * Task 17 acceptance tests for the Service Worker cache policy (spec 10).
 * These unit-test the POLICY FUNCTIONS only — the browser lifecycle itself is
 * Task 18's E2E territory:
 *
 * - the precache list is the static App Shell ONLY (no /api route ever);
 * - auth/progress/study/review/stats responses and every write are
 *   network-only and are never stored;
 * - an offline navigation falls back to the precached shell, but a failed
 *   content request is NEVER answered from cache (no offline 教材 rendering);
 * - content caches are release-scoped (`release_id + URL`), and an
 *   active-release switch prunes the old namespaces;
 * - audio is cached under a session-independent, content-hash key;
 * - the logout message clears the content/audio caches and keeps the shell.
 */

import { describe, expect, it } from "vitest";
import { SW_CACHE_CLEAR_MESSAGE } from "./lib/query-cache";
import {
  AUDIO_CACHE,
  CLEAR_CACHES_MESSAGE,
  CONTENT_CACHE_PREFIX,
  PRECACHE_URLS,
  SHELL_CACHE,
  SHELL_DOCUMENT,
  audioCacheKey,
  cachesToDeleteOnLogout,
  classifyRequest,
  contentCacheName,
  isContentCacheName,
  offlineFallback,
  pruneContentCacheNames,
} from "./sw";

const ORIGIN = "https://lexiloop.test";

function requestKind(path: string, init: { method?: string; mode?: RequestMode } = {}): string {
  return classifyRequest(
    new URL(`${ORIGIN}${path}`),
    init.method ?? "GET",
    init.mode ?? "cors",
    ORIGIN,
  );
}

describe("static shell precache", () => {
  it("precaches only shell documents and static app assets", () => {
    expect(PRECACHE_URLS).toContain("/");
    expect(PRECACHE_URLS).toContain("/manifest.webmanifest");
    expect(PRECACHE_URLS.some((url) => url.startsWith("/icons/"))).toBe(true);
    // No API route is ever precached, and no built asset with a hashed name
    // is hardcoded (those ride the runtime static rule).
    for (const url of PRECACHE_URLS) {
      expect(url.startsWith("/api/")).toBe(false);
    }
  });
});

describe("request classification", () => {
  it("routes every personal API prefix to network-only (spec 10 never-cache list)", () => {
    expect(requestKind("/api/auth/me")).toBe("network-only");
    expect(requestKind("/api/auth/login", { method: "POST" })).toBe("network-only");
    expect(requestKind("/api/progress/words/w-1")).toBe("network-only");
    expect(requestKind("/api/study/sessions")).toBe("network-only");
    expect(requestKind("/api/study/sessions/s-1", { method: "PATCH" })).toBe("network-only");
    expect(requestKind("/api/reviews/grade", { method: "POST" })).toBe("network-only");
    expect(requestKind("/api/reviews/e-1/undo", { method: "POST" })).toBe("network-only");
    expect(requestKind("/api/stats/overview")).toBe("network-only");
  });

  it("never caches a write or a cross-origin request", () => {
    expect(requestKind("/api/content/units/u-1", { method: "POST" })).toBe("network-only");
    expect(requestKind("/manifest.webmanifest", { method: "PUT" })).toBe("network-only");
    expect(
      classifyRequest(new URL("https://cdn.example.net/lib.js"), "GET", "cors", ORIGIN),
    ).toBe("network-only");
  });

  it("classifies content, audio, navigation, and static asset requests", () => {
    expect(requestKind("/api/content/bootstrap")).toBe("content");
    expect(requestKind("/api/content/search?q=abandon")).toBe("content");
    expect(requestKind("/api/content/words/w-1")).toBe("content");
    expect(requestKind("/api/audio/audio/ab/abc111.wav")).toBe("audio");
    expect(requestKind("/today", { mode: "navigate" })).toBe("navigate");
    expect(requestKind("/review", { mode: "navigate" })).toBe("navigate");
    expect(requestKind("/assets/index-4f2a9b.js")).toBe("static");
    expect(requestKind("/icons/icon-192.png")).toBe("static");
    expect(requestKind("/manifest.webmanifest")).toBe("static");
  });
});

describe("offline fallback policy", () => {
  it("falls back to the precached shell document for offline navigations only", () => {
    expect(offlineFallback("navigate")).toBe(SHELL_DOCUMENT);
    // A static asset must never be answered with the HTML shell, and
    // content/audio read failures NEVER answer from cache: no offline
    // textbook rendering, no bypassing session state (spec 10).
    expect(offlineFallback("static")).toBeNull();
    expect(offlineFallback("content")).toBeNull();
    expect(offlineFallback("audio")).toBeNull();
    expect(offlineFallback("network-only")).toBeNull();
  });
});

describe("release-scoped content caches", () => {
  it("names content caches after the active release", () => {
    expect(contentCacheName("rel-1")).toBe("lexiloop-content-rel-1");
    expect(isContentCacheName("lexiloop-content-rel-1")).toBe(true);
    expect(isContentCacheName(AUDIO_CACHE)).toBe(false);
    expect(isContentCacheName(SHELL_CACHE)).toBe(false);
    expect(isContentCacheName("someone-else-content-rel-1")).toBe(false);
  });

  it("prunes every old namespace when the active release changes", () => {
    const names = [
      SHELL_CACHE,
      AUDIO_CACHE,
      contentCacheName("rel-1"),
      contentCacheName("rel-2"),
      "unrelated",
    ];
    // V1 policy (documented in sw.ts): on a bootstrap release switch, old
    // content namespaces are dropped immediately; an in-progress old-release
    // session simply re-fetches its content from the network.
    expect(pruneContentCacheNames(names, "rel-2")).toEqual([contentCacheName("rel-1")]);
    expect(pruneContentCacheNames(names, "rel-1")).toEqual([contentCacheName("rel-2")]);
    expect(pruneContentCacheNames(names, null)).toEqual([
      contentCacheName("rel-1"),
      contentCacheName("rel-2"),
    ]);
  });
});

describe("audio cache keys", () => {
  it("caches audio by content hash, independent of the session query", () => {
    const withSession = new URL(`${ORIGIN}/api/audio/audio/ab/abc111.wav?session=sess-1`);
    const withoutSession = new URL(`${ORIGIN}/api/audio/audio/ab/abc111.wav`);
    expect(audioCacheKey(withSession)).toBe(audioCacheKey(withoutSession));
    expect(audioCacheKey(withSession)).toBe(`${ORIGIN}/api/audio/audio/ab/abc111.wav`);
  });
});

describe("logout cache deletion", () => {
  it("matches the clear message posted by clearPersonalState", () => {
    // sw.ts keeps the literal self-contained; this pins the contract.
    expect(CLEAR_CACHES_MESSAGE).toEqual(SW_CACHE_CLEAR_MESSAGE);
  });

  it("deletes content and audio caches and keeps the static shell", () => {
    const names = [
      SHELL_CACHE,
      AUDIO_CACHE,
      contentCacheName("rel-1"),
      contentCacheName("rel-2"),
      "unrelated-cache",
    ];
    expect(cachesToDeleteOnLogout(names)).toEqual([
      AUDIO_CACHE,
      contentCacheName("rel-1"),
      contentCacheName("rel-2"),
    ]);
  });

  it("uses stable cache names so logout clears across upgrades", () => {
    expect(SHELL_CACHE).toBe("lexiloop-shell-v1");
    expect(AUDIO_CACHE).toBe("lexiloop-audio-v1");
    expect(CONTENT_CACHE_PREFIX).toBe("lexiloop-content-");
  });
});
