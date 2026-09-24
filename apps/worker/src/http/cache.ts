/**
 * HTTP cache policy (spec 8.2/10): one source of truth for the three response
 * classes the API serves.
 *
 * - Personal data (`/api/progress/*`, `/api/study/*`, `/api/stats/*`):
 *   `private, no-store` — a Service Worker must never keep it (spec 10).
 * - Shared content (`/api/content/*`): account-independent textbook data that
 *   a Service Worker may store per `release_id + URL` namespace (spec 10), so
 *   the HTTP response must stay revalidatable (`private, no-cache`); the
 *   release namespace comes from the bootstrap body, never from long HTTP
 *   freshness, because the active release can switch underneath a stable URL.
 * - Audio (`/api/audio/:assetKey`): asset keys are content-addressed, so the
 *   content-hash ETag allows `private, max-age=31536000, immutable` (spec 10:
 *   audio is cached by content hash).
 */

/** Cache-Control for personal endpoints (spec 10: private, no-store). */
export const PRIVATE_NO_STORE = "private, no-store";

/** Cache-Control for shared, release-scoped content endpoints. */
export const CONTENT_CACHE_CONTROL = "private, no-cache";

/** Cache-Control for content-addressed audio objects. */
export const AUDIO_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** The only container V1 synthesizes (audio_asset.format_container = 'wav'). */
export const AUDIO_CONTENT_TYPE = "audio/wav";

export function privateNoStoreHeaders(): Record<string, string> {
  return { "cache-control": PRIVATE_NO_STORE };
}

export function contentCacheHeaders(): Record<string, string> {
  return { "cache-control": CONTENT_CACHE_CONTROL };
}

export function audioCacheHeaders(): Record<string, string> {
  return { "cache-control": AUDIO_CACHE_CONTROL };
}

/** Strong ETag derived from the stored content hash (spec 8.2). */
export function strongETag(contentSha256: string): string {
  return `"${contentSha256}"`;
}

/** RFC 9110 If-None-Match evaluation: any listed entity-tag (or `*`) matches. */
export function ifNoneMatchSatisfied(headerValue: string | undefined, etag: string): boolean {
  if (headerValue === undefined) {
    return false;
  }
  return headerValue
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag || candidate === `W/${etag}`);
}

/**
 * A syntactically valid single-range request, in R2 `R2Range` shape. Multi-
 * range headers use the first range; anything malformed is reported so the
 * caller can ignore it and serve the full object (RFC 9110: invalid Range
 * header fields are ignored, only valid-but-unsatisfiable ones get 416).
 */
export type RangeSpec = { offset: number } | { offset: number; length: number } | { suffix: number };

const SINGLE_RANGE_PATTERN = /^bytes=(\d+)-(\d*)$/;
const SUFFIX_RANGE_PATTERN = /^bytes=-(\d+)$/;

export function parseRangeSpec(headerValue: string | undefined): RangeSpec | "malformed" | null {
  if (headerValue === undefined) {
    return null;
  }
  const trimmed = headerValue.trim();
  const suffix = SUFFIX_RANGE_PATTERN.exec(trimmed);
  if (suffix) {
    const value = Number(suffix[1]);
    return value > 0 ? { suffix: value } : "malformed";
  }
  const single = SINGLE_RANGE_PATTERN.exec(trimmed);
  if (!single) {
    return "malformed";
  }
  const offset = Number(single[1]);
  const end = single[2];
  if (end === "") {
    return { offset };
  }
  const last = Number(end);
  if (last < offset) {
    return "malformed";
  }
  return { offset, length: last - offset + 1 };
}

export interface ResolvedByteRange {
  start: number;
  end: number;
}

/**
 * Turns a parsed spec into concrete byte offsets once the object size is
 * known. A suffix longer than the object yields the whole object (RFC 9110);
 * an offset at or beyond the end is unsatisfiable (416).
 */
export function resolveRange(spec: RangeSpec | null, size: number): ResolvedByteRange | "unsatisfiable" {
  const last = size - 1;
  if (spec === null) {
    return { start: 0, end: last };
  }
  if ("suffix" in spec) {
    return { start: Math.max(0, size - spec.suffix), end: last };
  }
  if (spec.offset >= size) {
    return "unsatisfiable";
  }
  const end = "length" in spec ? Math.min(last, spec.offset + spec.length - 1) : last;
  return { start: spec.offset, end };
}
