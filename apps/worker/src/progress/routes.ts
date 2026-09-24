/**
 * Personal progress routes (spec 8.2): the ONLY place word-level personal
 * learning state is exposed. Ownership comes exclusively from the session
 * (client-supplied user ids are ignored by construction — spec 7.2) and the
 * responses are `Cache-Control: private, no-store` so no Service Worker or
 * shared cache ever keeps them (spec 10).
 */

import type { Hono } from "hono";
import { AliasRepository, ReleaseRepository, WordProgressRepository } from "@lexiloop/db";
import { requireAuth } from "../middleware/auth";
import { privateNoStoreHeaders } from "../http/cache";
import { jsonError } from "../observability/request-context";
import type { AppEnv } from "../app";

const PRIVATE_HEADERS = privateNoStoreHeaders();

function progressPayload(wordKey: string, row: Awaited<ReturnType<WordProgressRepository["get"]>>) {
  return {
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
  };
}

export function registerProgressRoutes(app: Hono<AppEnv>): void {
  app.get("/api/progress/words", requireAuth(), async (c) => {
    const requested = (c.req.query("keys") ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key !== "");
    const wordKeys = [...new Set(requested)];
    if (wordKeys.length === 0 || wordKeys.length > 200 || wordKeys.some((key) => key.length > 256)) {
      return jsonError(c, 400, "VALIDATION_FAILED", "Expected between 1 and 200 word keys");
    }

    const auth = c.var.auth;
    const context = { userId: auth.userId };
    const active = await new ReleaseRepository(c.var.deps.db).getActive();
    const aliases = new AliasRepository(c.var.deps.db);
    const resolved = await aliases.resolveMany({
      releaseId: active?.releaseId ?? "",
      keys: wordKeys,
    });
    const canonicalKeys = wordKeys.map((key) => resolved.get(key) ?? key);
    const rows = await new WordProgressRepository(c.var.deps.db).getMany(context, canonicalKeys);
    const byCanonicalKey = new Map(rows.map((row) => [row.wordKey, row]));
    return c.json(
      {
        words: wordKeys.map((wordKey, index) =>
          progressPayload(wordKey, byCanonicalKey.get(canonicalKeys[index] ?? wordKey)),
        ),
      },
      200,
      PRIVATE_HEADERS,
    );
  });

  app.get("/api/progress/words/:wordKey", requireAuth(), async (c) => {
    const auth = c.var.auth;
    const wordKey = c.req.param("wordKey");
    // Alias invariance (spec 6.4), the read-side twin of every mutation path:
    // personal state is keyed by the canonical root, so a presented (e.g.
    // renamed) key reads the SAME progress row instead of looking unseen.
    // Resolution itself is release-independent; the active release id only
    // decorates diagnostics.
    const active = await new ReleaseRepository(c.var.deps.db).getActive();
    const canonicalKey = await new AliasRepository(c.var.deps.db).resolve({
      releaseId: active?.releaseId ?? "",
      key: wordKey,
    });
    const row = await new WordProgressRepository(c.var.deps.db).get({ userId: auth.userId }, canonicalKey);
    return c.json(progressPayload(wordKey, row), 200, PRIVATE_HEADERS);
  });
}
