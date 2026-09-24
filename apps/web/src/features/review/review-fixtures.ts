/**
 * Shared Worker-contract fixtures for the Task 17 review-journey component
 * tests. Reuses the learn fixtures' bootstrap/word content and mirrors the
 * REAL Worker semantics (apps/worker):
 *
 * - `POST /api/study/sessions` with mode REVIEW builds the due queue ordered
 *   by due time then canonical key (spec 6.3) — deliberately NOT the 5.7
 *   teaching order and a SUBSET of the two words' cards, so prompt alignment
 *   by position would be visibly wrong.
 * - Queue keys are the compiler's stable `content_card_key` (SHA-256 over
 *   book/unit/ordinal/slug, packages/domain stable-key.ts), computed here
 *   with node:crypto — the server side of the contract the client derives.
 * - `POST /api/reviews/grade` validates the current position, replays seen
 *   event ids, and advances.
 * - `POST /api/reviews/:eventId/undo` is latest-only (409 REVIEW_UNDO_NOT_LATEST
 *   / REVIEW_EVENT_UNDONE), rewinds the owning session position, and returns
 *   the UndoResult shape of apps/worker/src/study/undo.ts.
 */

import { createHash } from "node:crypto";
import { BOOTSTRAP, ME, WORD_CONTENTS } from "../learn/learn-fixtures";

export { BOOTSTRAP, ME, WORD_CONTENTS };

const UNIT_KEY = "u-1";
const BOOK_KEY = "bk-1";

/** The compiler's stable card key (spec 5.5/5.7) — server-side derivation. */
function cardKey(input: { ordinal: number; slug: string }): string {
  // Canonical form of packages/domain stable-key.ts: keys sorted
  // (book < ordinal < slug < type < unit), NFC strings, hex digest.
  const canonical = JSON.stringify({
    book: BOOK_KEY,
    ordinal: input.ordinal,
    slug: input.slug,
    type: "card",
    unit: UNIT_KEY,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** abandon (source order 1): word-meaning card of sense s-1-1. */
export const K_W1_WORD = cardKey({ ordinal: 1, slug: "word_meaning:s-1-1" });
/** abandon: context card of exam example e-1-1. */
export const K_W1_CONTEXT = cardKey({ ordinal: 1, slug: "context_meaning:e-1-1" });
/** abandon: phrase card of p-1-1 (NOT due in the default fixture queue). */
export const K_W1_PHRASE = cardKey({ ordinal: 1, slug: "phrase:p-1-1" });
/** abandon: discrimination card against w-2 (NOT due in the default queue). */
export const K_W1_DISCRIMINATION = cardKey({
  ordinal: 1,
  slug: "sense_discrimination:w-1:w-2",
});
/** ability (source order 2): word-meaning card of sense s-2-1. */
export const K_W2_WORD = cardKey({ ordinal: 2, slug: "word_meaning:s-2-1" });

/** Default due order (spec 6.3): context card first, then ability, abandon. */
export const REVIEW_QUEUE: readonly string[] = [K_W1_CONTEXT, K_W2_WORD, K_W1_WORD];

const AFTER_STATE = {
  version: 1,
  state: "Review",
  stability: 3,
  difficulty: 5,
  due_at: 1_700_086_400_000,
  last_review_at: 1_700_000_000_000,
  reps: 1,
  lapses: 0,
  scheduled_days: 1,
  learning_steps: 0,
};

const NOW = 1_700_000_000_000;

interface ReviewEvent {
  eventId: string;
  rating: number;
  cardKey: string;
  sessionId: string;
  undoneAt: number | null;
}

export interface ReviewServerState {
  positionOf(sessionId: string): number;
  events(): ReviewEvent[];
}

export interface ReviewServer {
  stub: (url: string, init?: RequestInit) => Response | Promise<Response>;
  requests: { url: string; init?: RequestInit; body?: unknown }[];
  state: ReviewServerState;
  /** Arms a one-shot undo rejection with the given worker error code. */
  rejectNextUndoOnce(code: "REVIEW_UNDO_NOT_LATEST" | "REVIEW_EVENT_UNDONE"): void;
}

export interface ReviewServerOptions {
  /** Preset unexpired REVIEW sessions (auto-resume tests); [] starts clean. */
  presetSessions?: string[];
  /** Queue override (defaults to the three-card due order). */
  queueKeys?: readonly string[];
  /** Throw a network error on the next grade POST once. */
  failNextGradeOnce?: boolean;
  /** POST /api/study/sessions answers 409 STUDY_QUEUE_EMPTY (nothing due). */
  emptyQueue?: boolean;
}

/** A stateful fake of the review surface with the real Worker semantics. */
export function createReviewServer(options: ReviewServerOptions = {}): ReviewServer {
  const requests: { url: string; init?: RequestInit; body?: unknown }[] = [];
  const queue: readonly string[] = options.queueKeys ?? REVIEW_QUEUE;
  const positions = new Map<string, number>();
  const sessionOrder: string[] = [];
  for (const preset of options.presetSessions ?? []) {
    positions.set(preset, 0);
    sessionOrder.push(preset);
  }
  const events: ReviewEvent[] = [];
  let createdCount = 0;
  let failGrade = options.failNextGradeOnce ?? false;
  let rejectUndo: "REVIEW_UNDO_NOT_LATEST" | "REVIEW_EVENT_UNDONE" | null = null;

  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const errorEnvelope = (code: string, status: number): Response =>
    jsonResponse({ code, message: code, request_id: "req-review-1" }, status);

  const latestUnUndone = (): ReviewEvent | null =>
    [...events].reverse().find((event) => event.undoneAt === null) ?? null;

  const sessionView = (sessionId: string, position: number): unknown => ({
    session_id: sessionId,
    mode: "REVIEW",
    release_id: "rel-1",
    position,
    created_at: NOW,
    // Far-future expiry so resume filters (expires_at > Date.now()) hold.
    expires_at: 4_102_444_800_000,
    cards: queue.map((key) => ({
      canonical_card_key: key,
      presented_card_key: key,
    })),
    current_card_key: queue[position] ?? null,
    unit_keys: ["u-1"],
    word_keys: ["w-1", "w-2"],
  });

  const stub: ReviewServer["stub"] = (url, init) => {
    const method = init?.method ?? "GET";
    const path = new URL(url).pathname;
    requests.push({
      url: String(url),
      init,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });

    if (path === "/api/auth/me") {
      return jsonResponse(ME);
    }
    if (path === "/api/content/bootstrap") {
      return jsonResponse(BOOTSTRAP);
    }
    if (path.startsWith("/api/content/words/")) {
      const key = decodeURIComponent(path.replace("/api/content/words/", ""));
      const content = WORD_CONTENTS[key];
      return content ? jsonResponse(content) : errorEnvelope("CONTENT_WORD_NOT_FOUND", 404);
    }
    if (path.startsWith("/api/progress/words/")) {
      const key = decodeURIComponent(path.replace("/api/progress/words/", ""));
      return jsonResponse({
        word_key: key,
        progress:
          key === "w-1"
            ? {
                stage: "INTRODUCED",
                // Stored value (apps/worker progress routes return the raw
                // row: UNKNOWN / RECOGNIZABLE / KNOWN, not the API choice).
                initial_familiarity: "RECOGNIZABLE",
                first_seen_at: NOW,
                introduced_release_id: "rel-1",
                introduced_at: NOW,
                last_seen_at: NOW,
              }
            : null,
      });
    }
    if (path === "/api/study/sessions" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { mode?: string };
      if (body.mode !== "REVIEW") {
        return errorEnvelope("VALIDATION_FAILED", 400);
      }
      if (options.emptyQueue) {
        return errorEnvelope("STUDY_QUEUE_EMPTY", 409);
      }
      createdCount += 1;
      const sessionId = `sess-review-created-${createdCount}`;
      positions.set(sessionId, 0);
      sessionOrder.push(sessionId);
      return jsonResponse(sessionView(sessionId, 0), 201);
    }
    if (path === "/api/study/sessions" && method === "GET") {
      return jsonResponse({
        sessions: sessionOrder.map((id) => sessionView(id, positions.get(id) ?? 0)),
      });
    }
    if (path.startsWith("/api/study/sessions/") && method === "GET") {
      const sessionId = path.replace("/api/study/sessions/", "");
      const position = positions.get(sessionId);
      return position === undefined
        ? errorEnvelope("STUDY_SESSION_INVALID", 400)
        : jsonResponse(sessionView(sessionId, position));
    }
    if (path === "/api/reviews/grade" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        event_id: string;
        session_id: string;
        card_key: string;
        rating: number;
        duration_ms?: number;
      };
      const position = positions.get(body.session_id);
      if (position === undefined) {
        return errorEnvelope("STUDY_SESSION_INVALID", 400);
      }
      if (failGrade) {
        failGrade = false;
        return Promise.reject(new Error("simulated network failure"));
      }
      const seen = events.find((event) => event.eventId === body.event_id);
      if (seen) {
        return jsonResponse({
          event_id: seen.eventId,
          session_id: body.session_id,
          card_key: seen.cardKey,
          presented_card_key: seen.cardKey,
          release_id: "rel-1",
          rating: seen.rating,
          before_state: null,
          after_state: AFTER_STATE,
          reviewed_at: NOW,
          duration_ms: body.duration_ms ?? null,
          undone_at: seen.undoneAt,
          replayed: true,
        });
      }
      if (body.card_key !== queue[position]) {
        return errorEnvelope("STUDY_CARD_NOT_CURRENT", 409);
      }
      events.push({
        eventId: body.event_id,
        rating: body.rating,
        cardKey: body.card_key,
        sessionId: body.session_id,
        undoneAt: null,
      });
      positions.set(body.session_id, position + 1);
      return jsonResponse({
        event_id: body.event_id,
        session_id: body.session_id,
        card_key: body.card_key,
        presented_card_key: body.card_key,
        release_id: "rel-1",
        rating: body.rating,
        before_state: null,
        after_state: AFTER_STATE,
        reviewed_at: NOW,
        duration_ms: body.duration_ms ?? null,
        undone_at: null,
        replayed: false,
      });
    }
    if (path.startsWith("/api/reviews/") && path.endsWith("/undo") && method === "POST") {
      const eventId = path.replace("/api/reviews/", "").replace(/\/undo$/, "");
      const record = events.find((event) => event.eventId === eventId);
      if (!record) {
        return errorEnvelope("REVIEW_EVENT_NOT_FOUND", 404);
      }
      if (rejectUndo !== null) {
        const code = rejectUndo;
        rejectUndo = null;
        return errorEnvelope(code, 409);
      }
      if (record.undoneAt !== null) {
        return errorEnvelope("REVIEW_EVENT_UNDONE", 409);
      }
      const latest = latestUnUndone();
      if (!latest || latest.eventId !== record.eventId) {
        return errorEnvelope("REVIEW_UNDO_NOT_LATEST", 409);
      }
      const position = positions.get(record.sessionId) ?? 0;
      positions.set(record.sessionId, Math.max(position - 1, 0));
      record.undoneAt = NOW;
      return jsonResponse({
        event_id: record.eventId,
        undone_at: NOW,
        card_key: record.cardKey,
        restored_state: null,
        word_stage: "INTRODUCED",
      });
    }
    return Promise.reject(new Error(`Unexpected request in test stub: ${method} ${url}`));
  };

  return {
    stub,
    requests,
    state: {
      positionOf: (sessionId) => positions.get(sessionId) ?? -1,
      events: () => events.map((event) => ({ ...event })),
    },
    rejectNextUndoOnce: (code) => {
      rejectUndo = code;
    },
  };
}
