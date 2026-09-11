/**
 * Personal progress routes (spec 8.2): the ONLY place word-level personal
 * learning state is exposed. Ownership comes exclusively from the session
 * (client-supplied user ids are ignored by construction — spec 7.2) and the
 * responses are `Cache-Control: private, no-store` so no Service Worker or
 * shared cache ever keeps them (spec 10).
 */

import type { Hono } from "hono";
import { WordProgressRepository } from "@lexiloop/db";
import { requireAuth } from "../middleware/auth";
import { privateNoStoreHeaders } from "../http/cache";
import type { AppEnv } from "../app";

const PRIVATE_HEADERS = privateNoStoreHeaders();

export function registerProgressRoutes(app: Hono<AppEnv>): void {
  app.get("/api/progress/words/:wordKey", requireAuth(), async (c) => {
    const auth = c.var.auth;
    const wordKey = c.req.param("wordKey");
    const row = await new WordProgressRepository(c.var.deps.db).get({ userId: auth.userId }, wordKey);
    return c.json(
      {
        word_key: wordKey,
        progress: row
          ? {
              stage: row.stage,
              initial_familiarity: row.initialFamiliarity,
              first_seen_at: row.firstSeenAt,
              introduced_release_id: row.introducedReleaseId,
              introduced_at: row.introducedAt,
              last_seen_at: row.lastSeenAt,
            }
          : null,
      },
      200,
      PRIVATE_HEADERS,
    );
  });
}
