/**
 * Content routes (spec 8.2): `/api/content/bootstrap`, `/api/content/units/
 * :unitKey`, `/api/content/words/:wordKey`, and `/api/content/search?q=`.
 * All are GET-only reads behind the session cookie; responses carry ONLY
 * shared textbook data (never familiarity/due/user fields — spec 8.2) and
 * the shared-content cache policy. `?session=<id>` performs the read through
 * a valid study session, pinning content to its release (spec 6.4).
 */

import type { Context, Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { UserContext } from "@lexiloop/db";
import { requireAuth } from "../middleware/auth";
import { contentCacheHeaders } from "../http/cache";
import { jsonError } from "../observability/request-context";
import { ContentService } from "./service";
import { assetKeyFromPath, serveAudio } from "./audio";
import type { AppEnv } from "../app";

const CONTENT_CACHE_HEADERS = contentCacheHeaders();

const sessionQuerySchema = z.strictObject({
  /** Study session whose pinned release serves this read (spec 6.4). */
  session: z.string().min(1).max(128).optional(),
});

const searchQuerySchema = sessionQuerySchema.extend({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Shared validator behavior: a stable 400 for malformed query parameters. */
function queryValidationFailed(c: Context<AppEnv>): Response {
  return jsonError(c, 400, "VALIDATION_FAILED", "Query parameters failed validation");
}

const validateSessionQuery = zValidator("query", sessionQuerySchema, (result, c) => {
  if (!result.success) {
    return queryValidationFailed(c as Context<AppEnv>);
  }
  return undefined;
});

const validateSearchQuery = zValidator("query", searchQuerySchema, (result, c) => {
  if (!result.success) {
    return queryValidationFailed(c as Context<AppEnv>);
  }
  return undefined;
});

/** Resolves the content release or maps the failure to a stable error. */
async function resolveReleaseOrError(
  c: Context<AppEnv>,
  sessionId: string | undefined,
): Promise<{ ok: true; releaseId: string } | { ok: false; response: Response }> {
  const auth = c.var.auth;
  const resolution = await new ContentService(c.var.deps.db).resolveRelease(
    { userId: auth.userId } satisfies UserContext,
    c.var.deps.now?.() ?? Date.now(),
    sessionId,
  );
  if (resolution.ok) {
    return { ok: true, releaseId: resolution.releaseId };
  }
  if (resolution.reason === "NO_ACTIVE_RELEASE") {
    return { ok: false, response: jsonError(c, 404, "CONTENT_NO_ACTIVE_RELEASE", "No active content release is configured") };
  }
  return {
    ok: false,
    response: jsonError(c, 400, "CONTENT_SESSION_INVALID", "Study session is unknown, expired, or not yours"),
  };
}

export function registerContentRoutes(app: Hono<AppEnv>): void {
  app.get("/api/content/bootstrap", requireAuth(), validateSessionQuery, async (c) => {
    const pinned = await resolveReleaseOrError(c, c.req.valid("query").session);
    if (!pinned.ok) {
      return pinned.response;
    }
    return c.json(await new ContentService(c.var.deps.db).bootstrap(pinned.releaseId), 200, CONTENT_CACHE_HEADERS);
  });

  app.get("/api/content/units/:unitKey", requireAuth(), validateSessionQuery, async (c) => {
    const pinned = await resolveReleaseOrError(c, c.req.valid("query").session);
    if (!pinned.ok) {
      return pinned.response;
    }
    const payload = await new ContentService(c.var.deps.db).unitContent(pinned.releaseId, c.req.param("unitKey"));
    if (!payload) {
      return jsonError(c, 404, "CONTENT_UNIT_NOT_FOUND", "Unit does not exist in this release");
    }
    return c.json(payload, 200, CONTENT_CACHE_HEADERS);
  });

  app.get("/api/content/words/:wordKey", requireAuth(), validateSessionQuery, async (c) => {
    const pinned = await resolveReleaseOrError(c, c.req.valid("query").session);
    if (!pinned.ok) {
      return pinned.response;
    }
    const payload = await new ContentService(c.var.deps.db).wordContent(pinned.releaseId, c.req.param("wordKey"));
    if (!payload) {
      return jsonError(c, 404, "CONTENT_WORD_NOT_FOUND", "Word does not exist in this release");
    }
    return c.json(payload, 200, CONTENT_CACHE_HEADERS);
  });

  app.get("/api/content/search", requireAuth(), validateSearchQuery, async (c) => {
    const { q, limit, session } = c.req.valid("query");
    const pinned = await resolveReleaseOrError(c, session);
    if (!pinned.ok) {
      return pinned.response;
    }
    const hits = await new ContentService(c.var.deps.db).search(pinned.releaseId, q, { limit });
    return c.json({ query: q, release_id: pinned.releaseId, hits }, 200, CONTENT_CACHE_HEADERS);
  });

  // Asset keys contain slashes (audio/<prefix>/<hash>.wav), so the audio
  // route is a wildcard and the remainder is the decoded key.
  app.get("/api/audio/*", requireAuth(), async (c) => {
    const assetKey = assetKeyFromPath(c.req.path, "/api/audio/");
    if (assetKey === undefined) {
      return jsonError(c, 404, "CONTENT_AUDIO_NOT_FOUND", "Audio asset does not belong to this release");
    }
    const pinned = await resolveReleaseOrError(c, c.req.query("session"));
    if (!pinned.ok) {
      return pinned.response;
    }
    return await serveAudio(c, pinned.releaseId, assetKey);
  });
}
