/**
 * Study and review routes (spec 8.3):
 *
 * - `POST /api/study/sessions` — create a fixed-release session (queue built
 *   server-side in the binding 5.7 order, release pinned for 24h).
 * - `GET  /api/study/sessions` — the caller's unexpired sessions (resume).
 * - `GET  /api/study/sessions/:sessionId` — one session with frozen queue and
 *   current position; the client advances only on success responses.
 * - `PATCH /api/study/sessions/:sessionId` — the StudyPatch body
 *   (WORD_PRESENTED / FAMILIARITY_SET), idempotent by event_id.
 * - `POST /api/reviews/grade` — server-side FSRS grading as one atomic batch.
 * - `POST /api/reviews/grade-batch` — one visible word rating atomically
 *   grades its consecutive per-sense WORD_MEANING cards.
 * - `POST /api/reviews/:eventId/undo` — latest-only revocation.
 *
 * Every route serves personal data: auth comes exclusively from the session
 * cookie (spec 7.2), writes validate Origin AND CSRF, and responses are
 * `Cache-Control: private, no-store` (spec 10).
 */

import type { Context, Hono } from "hono";
import { z, flattenError } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { UserContext } from "@lexiloop/db";
import { requireAuth } from "../middleware/auth";
import { requireCsrf, requireValidOrigin } from "../auth/csrf";
import { privateNoStoreHeaders } from "../http/cache";
import { jsonError } from "../observability/request-context";
import { StudyHttpError, StudyService } from "./service";
import { applyStudyPatch, StudyPatchSchema } from "./familiarity";
import { gradeReview, gradeReviewBatch } from "./grade";
import { undoReview } from "./undo";
import type { AppEnv } from "../app";

const PRIVATE_HEADERS = privateNoStoreHeaders();

const createSessionSchema = z.strictObject({
  /** Session mode (spec 8.3): 新词 / 快测 / 复习. */
  mode: z.enum(["NEW_WORDS", "QUICK_TEST", "REVIEW"]),
});

const gradeSchema = z.strictObject({
  event_id: z.string().min(1).max(128),
  session_id: z.string().min(1).max(128),
  /** Exact presented key of the queue's current item. */
  card_key: z.string().min(1).max(256),
  /** Again=1, Hard=2, Good=3, Easy=4 (spec 5.7). */
  rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  /** Answer duration (spec 8.3); bounded to reject nonsense, stored as-is. */
  duration_ms: z.number().int().min(0).max(86_400_000).optional(),
});

const gradeBatchSchema = z
  .strictObject({
    session_id: z.string().min(1).max(128),
    grades: z
      .array(
        z.strictObject({
          event_id: z.string().min(1).max(128),
          card_key: z.string().min(1).max(256),
        }),
      )
      .min(2)
      .max(50),
    rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    duration_ms: z.number().int().min(0).max(86_400_000).optional(),
  })
  .refine(
    (value) => new Set(value.grades.map((grade) => grade.event_id)).size === value.grades.length,
    { message: "event_id values must be unique within a batch", path: ["grades"] },
  );

/** Shared validator behavior: a stable 400 with field details for bad bodies. */
function validateBody<S extends z.ZodType>(schema: S) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return jsonError(
        c as Context<AppEnv>,
        400,
        "VALIDATION_FAILED",
        "Request body failed schema validation",
        flattenError(result.error),
      );
    }
    return undefined;
  });
}

/** Maps StudyHttpError failures onto the app's error envelope; rethrows rest. */
function errorResponse(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof StudyHttpError) {
    return jsonError(c, error.status, error.code, error.message);
  }
  throw error;
}

export function registerStudyRoutes(app: Hono<AppEnv>): void {
  app.post(
    "/api/study/sessions",
    requireAuth(),
    requireValidOrigin(),
    requireCsrf(),
    validateBody(createSessionSchema),
    async (c) => {
      try {
        const service = new StudyService(c.var.deps.db, c.var.deps.now ?? (() => Date.now()));
        const ctx: UserContext = { userId: c.var.auth.userId };
        const view = await service.createSession(ctx, c.req.valid("json").mode);
        return c.json(view, 201, PRIVATE_HEADERS);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  app.get("/api/study/sessions", requireAuth(), async (c) => {
    const service = new StudyService(c.var.deps.db, c.var.deps.now ?? (() => Date.now()));
    const ctx: UserContext = { userId: c.var.auth.userId };
    return c.json({ sessions: await service.listSessions(ctx) }, 200, PRIVATE_HEADERS);
  });

  app.get("/api/study/sessions/:sessionId", requireAuth(), async (c) => {
    try {
      const service = new StudyService(c.var.deps.db, c.var.deps.now ?? (() => Date.now()));
      const ctx: UserContext = { userId: c.var.auth.userId };
      const view = await service.getSession(ctx, c.req.param("sessionId"));
      return c.json(view, 200, PRIVATE_HEADERS);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.patch(
    "/api/study/sessions/:sessionId",
    requireAuth(),
    requireValidOrigin(),
    requireCsrf(),
    validateBody(StudyPatchSchema),
    async (c) => {
      try {
        const service = new StudyService(c.var.deps.db, c.var.deps.now ?? (() => Date.now()));
        const ctx: UserContext = { userId: c.var.auth.userId };
        const result = await applyStudyPatch(service, ctx, c.req.param("sessionId"), c.req.valid("json"));
        return c.json(result, 200, PRIVATE_HEADERS);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  app.post(
    "/api/reviews/grade",
    requireAuth(),
    requireValidOrigin(),
    requireCsrf(),
    validateBody(gradeSchema),
    async (c) => {
      try {
        const service = new StudyService(c.var.deps.db, c.var.deps.now ?? (() => Date.now()));
        const ctx: UserContext = { userId: c.var.auth.userId };
        const result = await gradeReview(service, ctx, c.req.valid("json"));
        return c.json(result, 200, PRIVATE_HEADERS);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  app.post(
    "/api/reviews/grade-batch",
    requireAuth(),
    requireValidOrigin(),
    requireCsrf(),
    validateBody(gradeBatchSchema),
    async (c) => {
      try {
        const service = new StudyService(c.var.deps.db, c.var.deps.now ?? (() => Date.now()));
        const ctx: UserContext = { userId: c.var.auth.userId };
        const result = await gradeReviewBatch(service, ctx, c.req.valid("json"));
        return c.json(result, 200, PRIVATE_HEADERS);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  );

  app.post("/api/reviews/:eventId/undo", requireAuth(), requireValidOrigin(), requireCsrf(), async (c) => {
    try {
      const service = new StudyService(c.var.deps.db, c.var.deps.now ?? (() => Date.now()));
      const ctx: UserContext = { userId: c.var.auth.userId };
      const result = await undoReview(service, ctx, c.req.param("eventId"));
      return c.json(result, 200, PRIVATE_HEADERS);
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
