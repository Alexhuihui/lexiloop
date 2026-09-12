/**
 * Statistics routes (spec 8.2/8.3/9.6): `GET /api/stats/overview` returns the
 * caller's learning overview — learned word/card counts, estimated memory
 * retention, today + historical review counts, the consecutive-study-day
 * streak in the user's timezone, the 30-day due forecast, high-lapse/difficult
 * words, and Unit mastery (coverage + predicted retention of graded cards).
 *
 * Personal data route: identity comes exclusively from the session cookie and
 * the response is `Cache-Control: private, no-store` (spec 10).
 */

import type { Hono } from "hono";
import { requireAuth } from "../middleware/auth";
import { privateNoStoreHeaders } from "../http/cache";
import { statsOverview } from "./queries";
import type { AppEnv } from "../app";

const PRIVATE_HEADERS = privateNoStoreHeaders();

export function registerStatsRoutes(app: Hono<AppEnv>): void {
  app.get("/api/stats/overview", requireAuth(), async (c) => {
    const deps = c.var.deps;
    const now = deps.now?.() ?? Date.now();
    const overview = await statsOverview(deps.db, { userId: c.var.auth.userId }, now);
    return c.json(overview, 200, PRIVATE_HEADERS);
  });
}
