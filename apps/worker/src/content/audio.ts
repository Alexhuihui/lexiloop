/**
 * Private audio streaming (spec 8.2/10): the R2 bucket is never public. An
 * authenticated request may stream an asset only when the asset belongs to
 * the resolved release (active, or the release pinned by a valid study
 * session) and that release is ACTIVE or retained (RETIRED) — the association
 * check is the `audio_asset` row lookup in `ContentService.audioAsset`.
 *
 * Responses are content-addressed (the asset key derives from the content
 * hash), so they carry the stored `content_sha256` as a strong ETag, support
 * byte ranges via the R2 range option, and cache immutably for a year.
 */

import type { Context } from "hono";
import {
  AUDIO_CONTENT_TYPE,
  audioCacheHeaders,
  ifNoneMatchSatisfied,
  parseRangeSpec,
  resolveRange,
  strongETag,
} from "../http/cache";
import { jsonError } from "../observability/request-context";
import type { AppEnv } from "../app";
import { ContentService } from "./service";

/** 304 with the validator + cache policy; no body, no storage touched. */
function notModified(etag: string): Response {
  return new Response(null, {
    status: 304,
    headers: { etag, ...audioCacheHeaders() },
  });
}

/**
 * Streams `assetKey` from the injectable R2 bucket for `releaseId`. The
 * caller has already resolved the release (active or session-pinned) and
 * authenticated the user.
 */
export async function serveAudio(c: Context<AppEnv>, releaseId: string, assetKey: string): Promise<Response> {
  const deps = c.var.deps;
  if (!deps.audioBucket) {
    return jsonError(c, 503, "AUDIO_STORAGE_UNAVAILABLE", "Audio storage is not configured");
  }
  const asset = await new ContentService(deps.db).audioAsset(releaseId, assetKey);
  if (!asset) {
    return jsonError(c, 404, "CONTENT_AUDIO_NOT_FOUND", "Audio asset does not belong to this release");
  }

  const etag = strongETag(asset.contentSha256);
  if (ifNoneMatchSatisfied(c.req.header("if-none-match"), etag)) {
    return notModified(etag);
  }

  const parsedRange = parseRangeSpec(c.req.header("range"));
  const rangeSpec = parsedRange === "malformed" ? null : parsedRange;
  const object =
    rangeSpec === null
      ? await deps.audioBucket.get(assetKey)
      : await deps.audioBucket.get(assetKey, { range: rangeSpec });
  if (!object) {
    // The D1 row says the asset exists; the object is gone from private
    // storage — a release integrity failure, not a client error class.
    return jsonError(c, 404, "CONTENT_AUDIO_OBJECT_MISSING", "Audio object is missing from storage");
  }

  const range = resolveRange(rangeSpec, object.size);
  if (range === "unsatisfiable") {
    const error = jsonError(c, 416, "CONTENT_RANGE_NOT_SATISFIABLE", "Requested range is outside the audio object");
    error.headers.set("content-range", `bytes */${object.size}`);
    return error;
  }

  const headers: Record<string, string> = {
    ...audioCacheHeaders(),
    etag,
    "accept-ranges": "bytes",
    "content-type": AUDIO_CONTENT_TYPE,
  };
  if (rangeSpec === null) {
    // No manual content-length: Workers rejects it on streamed bodies; the
    // runtime derives framing from the R2 object stream itself.
    return c.body(object.body, 200, headers);
  }
  return c.body(object.body, 206, {
    ...headers,
    "content-range": `bytes ${range.start}-${range.end}/${object.size}`,
  });
}

/**
 * Extracts the asset key after `/api/audio/` — asset keys contain slashes
 * (`audio/<prefix>/<hash>.wav`), so the route is registered with a wildcard
 * and the full remainder (decoded) is the key.
 */
export function assetKeyFromPath(path: string, routePrefix: string): string | undefined {
  if (!path.startsWith(routePrefix)) {
    return undefined;
  }
  const raw = path.slice(routePrefix.length);
  if (raw === "" || raw.includes("..")) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}
