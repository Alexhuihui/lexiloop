import { useEffect } from "react";

const MAX_PARALLEL_PREFETCHES = 2;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

/**
 * Defers non-critical work until after React has committed the visible page.
 * requestIdleCallback keeps it away from first paint; the timeout fallback
 * also works in Safari and in the test DOM.
 */
export function scheduleIdleTask(task: () => void): () => void {
  if (typeof window === "undefined") {
    const handle = setTimeout(task, 0);
    return () => clearTimeout(handle);
  }

  const idleWindow = window as IdleWindow;
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(task, { timeout: 1_200 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(task, 0);
  return () => window.clearTimeout(handle);
}

/**
 * Warms a small set of audio assets with bounded concurrency. Fetching the
 * entire response lets the Service Worker put it into Cache Storage; without
 * an active worker the immutable HTTP response still lands in browser cache.
 */
export async function prefetchAudioFiles(
  urls: readonly string[],
  prefetch: (url: string) => Promise<void>,
): Promise<void> {
  const queue = [...new Set(urls.filter((url) => url !== ""))];
  let cursor = 0;
  const next = async (): Promise<void> => {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const url = queue[index];
      if (!url) {
        continue;
      }
      try {
        await prefetch(url);
      } catch {
        // Prefetch is an optimization only. Playback retains its inline error
        // and retry behavior if the background request fails.
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_PREFETCHES, queue.length) }, () => next()),
  );
}

/** Starts silent audio warming only after the current page is visible. */
export function useAudioPrefetch(
  urls: readonly string[],
  prefetch: (url: string) => Promise<void>,
): void {
  const key = [...new Set(urls)].sort().join("\n");
  useEffect(() => {
    if (key === "") {
      return;
    }
    const stableUrls = key.split("\n");
    return scheduleIdleTask(() => {
      void prefetchAudioFiles(stableUrls, prefetch);
    });
  }, [key, prefetch]);
}
