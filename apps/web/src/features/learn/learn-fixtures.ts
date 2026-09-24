/**
 * Shared Worker-contract fixtures for the Task 16 learn-journey component
 * tests. The fake server mirrors the REAL Worker semantics (apps/worker):
 *
 * - `POST /api/study/sessions` builds the fixed NEW_WORDS queue in the 5.7
 *   order (WORD_MEANING cards of both words first, then CONTEXT_MEANING,
 *   PHRASE, SENSE_DISCRIMINATION) and serves `SessionView` shapes, including
 *   the derived `unit_keys`/`word_keys` group fields.
 * - `PATCH /api/study/sessions/:id` accepts any word of the session's GROUP
 *   (membership validation per the spec 9.3 controller ruling; 409
 *   `STUDY_WORD_NOT_IN_GROUP` outside the group, no side effects), is
 *   idempotent by `event_id`, and upserts word_progress like
 *   `applyStudyPatch` (UNSEEN -> IN_PROGRESS only, first_seen_at once).
 * - `POST /api/reviews/grade` keeps full current-position validation,
 *   advances the position, flips a word to INTRODUCED when its last queue
 *   card is graded, and replays seen `event_id`s.
 */

export const GROUP_SIZE = 2;

/** Unit u-1 words in textbook order (tier, then source order) — server-sorted. */
export const UNIT_WORDS = [
  { word_key: "w-1", headword: "abandon", phonetic: "əˈbændən", tier: "CORE", source_order: 1 },
  { word_key: "w-2", headword: "ability", phonetic: "əˈbɪləti", tier: "CORE", source_order: 2 },
  {
    word_key: "w-3",
    headword: "abnormal",
    phonetic: "æbˈnɔːml",
    tier: "EXTENSION",
    source_order: 3,
  },
] as const;

/** The NEW_WORDS queue snapshot for the group [w-1, w-2] (spec 5.7 order). */
export const QUEUE: readonly string[] = ["k-wm-1", "k-wm-2", "k-cm-1", "k-ph-1", "k-sd-1"];

/** The session's group (release-local keys): every queued card's word. */
export const GROUP_WORD_KEYS: ReadonlySet<string> = new Set(["w-1", "w-2"]);

/** Queue cards per word — the INTRODUCED flip completes per word. */
export const WORD_CARDS: Readonly<Record<string, readonly string[]>> = {
  "w-1": ["k-wm-1", "k-cm-1", "k-ph-1", "k-sd-1"],
  "w-2": ["k-wm-2"],
};

export const ME = {
  user: { user_id: "u-1", username: "alice", status: "ACTIVE" },
  session: { expires_at: 4_102_444_800_000 },
  settings: {
    start_unit_key: "u-1",
    new_words_per_group: GROUP_SIZE,
    daily_goal: 10,
    timezone: "Asia/Shanghai",
  },
  csrf_token: "csrf-token-1",
};

export const BOOTSTRAP = {
  release_id: "rel-1",
  config_version: 1,
  release: { status: "ACTIVE", activated_at: 1_700_000_000_000 },
  books: [{ book_key: "bk-1", title: "New Horizon English 1", edition: "2nd" }],
  units: [{ unit_key: "u-1", book_key: "bk-1", level: 1, unit_order: 1, title: "Unit 1" }],
};

const EXAMPLE_W1 = {
  example_key: "e-1-1",
  sense_key: "s-1-1",
  phrase_key: null,
  origin: "exam",
  source_ref: "2022 全国卷",
  text: "She abandoned the plan.",
  target_start: 4,
  target_end: 13,
  source_order: 1,
};

/** Full word-content responses for the unit (only group words need content). */
export const WORD_CONTENTS: Readonly<Record<string, unknown>> = {
  "w-1": {
    word: {
      word_key: "w-1",
      unit_key: "u-1",
      headword: "abandon",
      phonetic: "əˈbændən",
      tier: "CORE",
      source_order: 1,
    },
    unit: { unit_key: "u-1", title: "Unit 1" },
    senses: [{ sense_key: "s-1-1", pos: "v.", gloss: "放弃；抛弃", sense_order: 1 }],
    phrases: [
      {
        phrase_key: "p-1-1",
        sense_key: "s-1-1",
        text: "abandon the plan",
        gloss: "放弃计划",
        source_order: 1,
      },
    ],
    examples: [EXAMPLE_W1],
    explanations: [
      {
        explanation_key: "x-1-1",
        syntax_notes: ["abandon 后接名词或动名词作宾语"],
        translation_hints: "表示「放弃」；注意宾语的位置",
        pitfalls: ["拼写注意：只有一个 b"],
        context_meanings: [{ example_key: "e-1-1", gloss: "放弃（计划等）" }],
        discrimination_candidates: [{ against_word_key: "w-2", note: "ability 指做某事的能力" }],
      },
    ],
    related: [],
    audio: [
      { entity_type: "word", entity_key: "w-1", asset_key: "audio/ab/abc111.wav" },
      { entity_type: "example", entity_key: "e-1-1", asset_key: "audio/ex/def222.wav" },
    ],
  },
  "w-2": {
    word: {
      word_key: "w-2",
      unit_key: "u-1",
      headword: "ability",
      phonetic: "əˈbɪləti",
      tier: "CORE",
      source_order: 2,
    },
    unit: { unit_key: "u-1", title: "Unit 1" },
    senses: [{ sense_key: "s-2-1", pos: "n.", gloss: "能力；才能", sense_order: 1 }],
    phrases: [],
    examples: [
      {
        example_key: "e-2-1",
        sense_key: "s-2-1",
        phrase_key: null,
        origin: "exam",
        source_ref: "2021 全国卷",
        text: "He has the ability to solve hard problems.",
        target_start: 11,
        target_end: 18,
        source_order: 1,
      },
    ],
    // No reviewed context meanings: w-2 therefore has no CONTEXT_MEANING card.
    explanations: [
      {
        explanation_key: "x-2-1",
        syntax_notes: ["ability to do sth"],
        translation_hints: "译作能力",
        pitfalls: [],
        context_meanings: [],
        discrimination_candidates: [],
      },
    ],
    related: [],
    audio: [{ entity_type: "word", entity_key: "w-2", asset_key: "audio/ab/abc333.wav" }],
  },
  "w-3": {
    word: {
      word_key: "w-3",
      unit_key: "u-1",
      headword: "abnormal",
      phonetic: "æbˈnɔːml",
      tier: "EXTENSION",
      source_order: 3,
    },
    unit: { unit_key: "u-1", title: "Unit 1" },
    senses: [{ sense_key: "s-3-1", pos: "adj.", gloss: "反常的；异常的", sense_order: 1 }],
    phrases: [],
    examples: [],
    explanations: [
      {
        explanation_key: "x-3-1",
        syntax_notes: [],
        translation_hints: "ab- 前缀表否定",
        pitfalls: [],
        context_meanings: [],
        discrimination_candidates: [],
      },
    ],
    related: [],
    audio: [],
  },
};

export const UNIT_CONTENT = {
  unit: { unit_key: "u-1", book_key: "bk-1", level: 1, unit_order: 1, title: "Unit 1" },
  summary: {
    status: "ACTIVE",
    words: 3,
    senses: 3,
    phrases: 1,
    examples: 2,
    explanations: 3,
    cards: 5,
  },
  words: UNIT_WORDS.map(({ word_key, headword, phonetic, tier, source_order }) => ({
    word_key,
    headword,
    phonetic,
    tier,
    source_order,
  })),
};

export interface ProgressRow {
  stage: string;
  initial_familiarity: string | null;
  first_seen_at: number;
  introduced_release_id: string | null;
  introduced_at: number | null;
  last_seen_at: number;
}

export interface SessionGroup {
  unit_keys?: string[];
  word_keys?: string[];
}

export function sessionOf(sessionId: string, position: number, group: SessionGroup = {}): unknown {
  const { unit_keys = ["u-1"], word_keys = ["w-1", "w-2"] } = group;
  return {
    session_id: sessionId,
    mode: "NEW_WORDS",
    release_id: "rel-1",
    position,
    created_at: 1_700_000_000_000,
    expires_at: 4_102_444_800_000,
    cards: QUEUE.map((key) => ({ canonical_card_key: key, presented_card_key: key })),
    current_card_key: QUEUE[position] ?? null,
    unit_keys,
    word_keys,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(code: string, status: number): Response {
  return jsonResponse({ code, message: code, request_id: "req-learn-1" }, status);
}

const AFTER_STATE = {
  version: 1,
  state: "Learning",
  stability: 0,
  difficulty: 5,
  due_at: 1_700_000_060_000,
  last_review_at: 1_700_000_060_000,
  reps: 0,
  lapses: 0,
  scheduled_days: 0,
  learning_steps: 0,
};

export interface FakeServerOptions {
  /** Session list preset (resume tests); created sessions are appended. */
  presetSessions?: string[];
  /** Group overrides per preset session id (e.g. a foreign-unit session). */
  presetGroups?: Record<string, SessionGroup>;
  /** Throw a network error once on the next PATCH. */
  failNextPatchOnce?: boolean;
  /** Throw a network error once on the next grade POST. */
  failNextGradeOnce?: boolean;
  /** Answer the next word-content read with a 404 once. */
  failNextWordContentOnce?: boolean;
  /** Hold grade commits until `resolveGrade()` (pending-state assertions). */
  holdGrades?: boolean;
}

export interface FakeServer {
  stub: (url: string, init?: RequestInit) => Response | Promise<Response>;
  requests: { url: string; init?: RequestInit; body?: unknown }[];
  state: {
    positionOf(sessionId: string): number;
    sessionIds(): string[];
    progressOf(wordKey: string): ProgressRow | null;
    patchEventIds(): string[];
    reviewEventIds(): string[];
  };
  resolveGrade(): void;
  /** Arms a one-shot network failure on the next PATCH (tests call this
   *  mid-journey to strand a presentation and exercise recovery). */
  failNextPatch(): void;
}

/**
 * A stateful fake of the study/content/progress surface with the real Worker
 * semantics. Exposes captured requests and manual grade gating for
 * pending-state assertions.
 */
export function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const requests: { url: string; init?: RequestInit; body?: unknown }[] = [];
  const sessionPositions = new Map<string, number>();
  const sessionOrder: string[] = [];
  for (const preset of options.presetSessions ?? []) {
    sessionPositions.set(preset, 0);
    sessionOrder.push(preset);
  }
  const presetGroups = options.presetGroups ?? {};
  const patchEventIds: string[] = [];
  const reviewEventIds: string[] = [];
  const reviewedRatings = new Map<string, number>();
  const gradedCards = new Set<string>();
  const progress = new Map<string, ProgressRow>();
  let createdCount = 0;
  let failPatch = options.failNextPatchOnce ?? false;
  let failGrade = options.failNextGradeOnce ?? false;
  let failContent = options.failNextWordContentOnce ?? false;
  let gradeGate: (() => void) | null = null;

  const now = () => 1_700_000_060_000;

  const sessionView = (sessionId: string, position: number): unknown =>
    sessionOf(sessionId, position, presetGroups[sessionId] ?? {});

  function flipIntroduced(): void {
    for (const [wordKey, cards] of Object.entries(WORD_CARDS)) {
      const row = progress.get(wordKey);
      if (!row || row.stage !== "IN_PROGRESS") {
        continue;
      }
      if (cards.every((card) => gradedCards.has(card))) {
        progress.set(wordKey, {
          ...row,
          stage: "INTRODUCED",
          introduced_release_id: "rel-1",
          introduced_at: now(),
        });
      }
    }
  }

  function commitGrade(body: {
    event_id: string;
    session_id: string;
    card_key: string;
    rating: number;
    duration_ms?: number;
  }): Response {
    const position = sessionPositions.get(body.session_id) ?? 0;
    if (reviewEventIds.includes(body.event_id)) {
      return jsonResponse({
        event_id: body.event_id,
        session_id: body.session_id,
        card_key: body.card_key,
        presented_card_key: body.card_key,
        release_id: "rel-1",
        rating: reviewedRatings.get(body.event_id) ?? body.rating,
        before_state: null,
        after_state: AFTER_STATE,
        reviewed_at: now(),
        duration_ms: body.duration_ms ?? null,
        undone_at: null,
        replayed: true,
      });
    }
    if (body.card_key !== QUEUE[position]) {
      return errorEnvelope("STUDY_CARD_NOT_CURRENT", 409);
    }
    reviewEventIds.push(body.event_id);
    reviewedRatings.set(body.event_id, body.rating);
    gradedCards.add(body.card_key);
    sessionPositions.set(body.session_id, position + 1);
    flipIntroduced();
    return jsonResponse({
      event_id: body.event_id,
      session_id: body.session_id,
      card_key: body.card_key,
      presented_card_key: body.card_key,
      release_id: "rel-1",
      rating: body.rating,
      before_state: null,
      after_state: AFTER_STATE,
      reviewed_at: now(),
      duration_ms: body.duration_ms ?? null,
      undone_at: null,
      replayed: false,
    });
  }

  const stub: FakeServer["stub"] = (url, init) => {
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
    if (path === "/api/content/units/u-1") {
      return jsonResponse(UNIT_CONTENT);
    }
    if (path.startsWith("/api/content/words/")) {
      const key = decodeURIComponent(path.replace("/api/content/words/", ""));
      if (failContent) {
        failContent = false;
        return errorEnvelope("CONTENT_WORD_NOT_FOUND", 404);
      }
      const content = WORD_CONTENTS[key];
      return content ? jsonResponse(content) : errorEnvelope("CONTENT_WORD_NOT_FOUND", 404);
    }
    if (path.startsWith("/api/audio/")) {
      return new Response(new Uint8Array([82, 73, 70, 70]), {
        headers: { "content-type": "audio/wav" },
      });
    }
    if (path === "/api/progress/words") {
      const keys = (new URL(url).searchParams.get("keys") ?? "").split(",").filter(Boolean);
      return jsonResponse({
        words: keys.map((key) => ({ word_key: key, progress: progress.get(key) ?? null })),
      });
    }
    if (path.startsWith("/api/progress/words/")) {
      const key = decodeURIComponent(path.replace("/api/progress/words/", ""));
      return jsonResponse({ word_key: key, progress: progress.get(key) ?? null });
    }
    if (path === "/api/study/sessions" && method === "POST") {
      createdCount += 1;
      const sessionId = `sess-created-${createdCount}`;
      sessionPositions.set(sessionId, 0);
      sessionOrder.push(sessionId);
      return jsonResponse(sessionView(sessionId, 0), 201);
    }
    if (path === "/api/study/sessions" && method === "GET") {
      return jsonResponse({
        sessions: sessionOrder.map((id) => sessionView(id, sessionPositions.get(id) ?? 0)),
      });
    }
    if (path.startsWith("/api/study/sessions/") && method === "GET") {
      const sessionId = path.replace("/api/study/sessions/", "");
      const position = sessionPositions.get(sessionId);
      return position === undefined
        ? errorEnvelope("STUDY_SESSION_INVALID", 400)
        : jsonResponse(sessionView(sessionId, position));
    }
    if (path.startsWith("/api/study/sessions/") && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as {
        event_id: string;
        action: string;
        word_key?: string;
        familiarity?: string;
      };
      const sessionId = path.replace("/api/study/sessions/", "");
      const position = sessionPositions.get(sessionId);
      if (position === undefined) {
        return errorEnvelope("STUDY_SESSION_INVALID", 400);
      }
      if (failPatch) {
        failPatch = false;
        throw new Error("simulated network failure");
      }
      const wordKey = body.word_key ?? "";
      if (patchEventIds.includes(body.event_id)) {
        const row = progress.get(wordKey);
        return jsonResponse({
          event_id: body.event_id,
          word_key: body.word_key,
          replayed: true,
          progress: row
            ? {
                stage: row.stage,
                initial_familiarity: null,
                first_seen_at: row.first_seen_at,
                last_seen_at: row.last_seen_at,
              }
            : { stage: "IN_PROGRESS", initial_familiarity: null, first_seen_at: 0, last_seen_at: 0 },
        });
      }
      // The real Worker accepts patches for any word of the session's group
      // and writes nothing on rejection (apps/worker familiarity.ts).
      if (!GROUP_WORD_KEYS.has(wordKey)) {
        return errorEnvelope("STUDY_WORD_NOT_IN_GROUP", 409);
      }
      patchEventIds.push(body.event_id);
      const existing = progress.get(wordKey);
      // The Worker converts the API choice to the STORED enum before writing
      // (UNKNOWN / RECOGNIZABLE / KNOWN) and returns the stored value on the
      // progress route (apps/worker/src/study/familiarity.ts).
      const familiarity =
        body.action === "FAMILIARITY_SET" ? (body.familiarity ?? null) : null;
      const storedFamiliarity =
        familiarity === "VERY_UNFAMILIAR"
          ? "UNKNOWN"
          : familiarity === "SOMEWHAT_FAMILIAR"
            ? "RECOGNIZABLE"
            : familiarity === "FAMILIAR"
              ? "KNOWN"
              : null;
      const row: ProgressRow = {
        stage: existing ? existing.stage : "IN_PROGRESS",
        initial_familiarity: storedFamiliarity ?? existing?.initial_familiarity ?? null,
        first_seen_at: existing?.first_seen_at ?? now(),
        introduced_release_id: existing?.introduced_release_id ?? null,
        introduced_at: existing?.introduced_at ?? null,
        last_seen_at: now(),
      };
      progress.set(wordKey, row);
      // The patch response converts back to the API choice (apps/worker).
      const apiFamiliarity =
        row.initial_familiarity === "UNKNOWN"
          ? "VERY_UNFAMILIAR"
          : row.initial_familiarity === "RECOGNIZABLE"
            ? "SOMEWHAT_FAMILIAR"
            : row.initial_familiarity === "KNOWN"
              ? "FAMILIAR"
              : null;
      return jsonResponse({
        event_id: body.event_id,
        word_key: body.word_key,
        replayed: false,
        progress: {
          stage: row.stage,
          initial_familiarity: apiFamiliarity,
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
        },
      });
    }
    if (path === "/api/reviews/grade" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        event_id: string;
        session_id: string;
        card_key: string;
        rating: number;
        duration_ms?: number;
      };
      if (sessionPositions.get(body.session_id) === undefined) {
        return errorEnvelope("STUDY_SESSION_INVALID", 400);
      }
      if (failGrade) {
        failGrade = false;
        throw new Error("simulated network failure");
      }
      if (options.holdGrades && reviewEventIds.includes(body.event_id) === false) {
        return new Promise<Response>((resolve) => {
          gradeGate = () => {
            resolve(commitGrade(body));
          };
        });
      }
      return commitGrade(body);
    }
    throw new Error(`Unexpected request in test stub: ${method} ${url}`);
  };

  return {
    stub,
    requests,
    state: {
      positionOf: (sessionId) => sessionPositions.get(sessionId) ?? -1,
      sessionIds: () => [...sessionOrder],
      progressOf: (wordKey) => progress.get(wordKey) ?? null,
      patchEventIds: () => [...patchEventIds],
      reviewEventIds: () => [...reviewEventIds],
    },
    resolveGrade: () => {
      gradeGate?.();
      gradeGate = null;
    },
    failNextPatch: () => {
      failPatch = true;
    },
  };
}
