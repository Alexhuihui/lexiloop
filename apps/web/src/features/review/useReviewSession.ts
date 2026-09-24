/**
 * The review state machine (spec 9.4, plan Task 17).
 *
 * UI states: IDLE -> PREPARING -> QUESTION -> REVEALED -> (QUESTION | ... ->
 * COMPLETE). Nothing here touches web storage: the queue position lives
 * server-side in the study session, so the full-entry round trip (open
 * /dictionary/words/:key, come back) simply resumes the SAME unexpired
 * REVIEW session through the Session APIs at the SAME position.
 *
 * Rules encoded here:
 * - PREPARING auto-resumes the caller's unexpired REVIEW session (read-only);
 *   an explicit start creates a new one. A 409 STUDY_QUEUE_EMPTY is a normal
 *   "nothing due" outcome, never an error.
 * - Prompt derivation waits for BOTH the session's word contents and the
 *   bootstrap's unit->book map (see buildReviewCards in ReviewCard.tsx).
 * - One client-generated event-id base per reveal->rating cycle; a failed
 *   single or grouped grade replays the SAME ids. Successful responses move
 *   the local position immediately without a redundant session read.
 * - Undo is latest-only by construction: the client undoes ITS latest
 *   successful grade event group in reverse order. After undo the session is
 *   re-read (the position was rewound server-side), the undone event ids are
 *   dropped, and the word returns in the question phase (a fresh reveal
 *   creates fresh ids).
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  ApiError,
  type ApiClient,
  type GradeRating,
  type SessionView,
  type WordContentResponse,
} from "../../lib/api-client";
import { messageFor } from "../learn/useStudySession";
import type { QuickRecallCard } from "../learn/QuickRecall";
import { buildReviewCards, groupReviewCards } from "./ReviewCard";

export type ReviewPhase = "IDLE" | "PREPARING" | "QUESTION" | "REVEALED" | "COMPLETE";

export interface ReviewSessionControls {
  phase: ReviewPhase;
  session: SessionView | null;
  /** Prompts aligned index-by-index with the session's queue. */
  cards: QuickRecallCard[];
  /** Word contents of the session (null entries failed to load). */
  contents: ReadonlyMap<string, WordContentResponse | null>;
  queueIndex: number;
  gradePending: boolean;
  gradeError: string | null;
  canUndo: boolean;
  undoPending: boolean;
  undoError: string | null;
  /** The due queue came back empty (normal outcome, not an error). */
  queueEmpty: boolean;
  startError: string | null;
  loadError: string | null;
  start(): Promise<void>;
  reveal(): void;
  rate(rating: GradeRating): Promise<void>;
  undoLast(): Promise<void>;
}

/** Map of unit_key -> book_key from the content bootstrap (or null while
 *  the bootstrap is loading; derivation waits for it). */
export type UnitBookMap = ReadonlyMap<string, string> | null;

interface MachineState {
  phase: ReviewPhase;
  session: SessionView | null;
  /** Settled per session word key; null = load failed (generic prompt). */
  contents: Map<string, WordContentResponse | null>;
  cards: QuickRecallCard[];
  queueIndex: number;
  gradeEventId: string | null;
  revealedAt: number | null;
  gradePending: boolean;
  gradeError: string | null;
  lastGradeEventIds: string[];
  undoPending: boolean;
  undoError: string | null;
  queueEmpty: boolean;
  startError: string | null;
  loadError: string | null;
}

type MachineAction =
  | { type: "PREPARE" }
  | { type: "PREPARE_FAILED"; message: string }
  | { type: "BACK_TO_IDLE" }
  | { type: "SESSION_SELECTED"; session: SessionView }
  | { type: "CONTENTS_LOADED"; contents: Map<string, WordContentResponse | null> }
  | { type: "SESSION_READY"; cards: QuickRecallCard[] }
  | { type: "QUEUE_EMPTY" }
  | { type: "START_FAILED"; message: string }
  | { type: "REVEALED"; eventId: string; revealedAt: number }
  | { type: "GRADE_PENDING" }
  | { type: "GRADE_FAILED"; message: string }
  | { type: "GRADE_ADVANCED"; session: SessionView; gradedEventIds: string[] }
  | { type: "UNDO_PENDING" }
  | { type: "UNDO_FAILED"; message: string }
  | { type: "UNDO_DONE"; session: SessionView };

const INITIAL_STATE: MachineState = {
  phase: "IDLE",
  session: null,
  contents: new Map(),
  cards: [],
  queueIndex: 0,
  gradeEventId: null,
  revealedAt: null,
  gradePending: false,
  gradeError: null,
  lastGradeEventIds: [],
  undoPending: false,
  undoError: null,
  queueEmpty: false,
  startError: null,
  loadError: null,
};

function newEventId(): string {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === "function") {
    return source.randomUUID();
  }
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function reducer(state: MachineState, action: MachineAction): MachineState {
  switch (action.type) {
    case "PREPARE":
      return { ...state, phase: "PREPARING", loadError: null, queueEmpty: false };
    case "PREPARE_FAILED":
      return { ...state, phase: "IDLE", loadError: action.message };
    case "BACK_TO_IDLE":
      return { ...state, phase: "IDLE" };
    case "SESSION_SELECTED":
      return {
        ...state,
        session: action.session,
        contents: new Map(),
        cards: [],
        queueIndex: action.session.position,
        gradeEventId: null,
        revealedAt: null,
        gradeError: null,
        lastGradeEventIds: [],
        undoError: null,
      };
    case "CONTENTS_LOADED":
      return { ...state, contents: action.contents };
    case "SESSION_READY": {
      const done = (state.session?.position ?? 0) >= (state.session?.cards.length ?? 0);
      return {
        ...state,
        cards: action.cards,
        phase: done ? "COMPLETE" : "QUESTION",
      };
    }
    case "QUEUE_EMPTY":
      return { ...state, phase: "IDLE", queueEmpty: true };
    case "START_FAILED":
      return { ...state, phase: "IDLE", startError: action.message };
    case "REVEALED":
      return {
        ...state,
        phase: "REVEALED",
        gradeEventId: action.eventId,
        revealedAt: action.revealedAt,
        gradeError: null,
        undoError: null,
      };
    case "GRADE_PENDING":
      return { ...state, gradePending: true, gradeError: null };
    case "GRADE_FAILED":
      return { ...state, gradePending: false, gradeError: action.message };
    case "GRADE_ADVANCED": {
      const done = action.session.position >= action.session.cards.length;
      return {
        ...state,
        gradePending: false,
        session: action.session,
        queueIndex: action.session.position,
        gradeEventId: null,
        revealedAt: null,
        // The fresh grade group is now the latest history available for undo.
        lastGradeEventIds: action.gradedEventIds,
        phase: done ? "COMPLETE" : "QUESTION",
      };
    }
    case "UNDO_PENDING":
      return { ...state, undoPending: true, undoError: null };
    case "UNDO_FAILED":
      // The attempt consumed its latest-only chance: drop the event id.
      return {
        ...state,
        undoPending: false,
        undoError: action.message,
        lastGradeEventIds: [],
      };
    case "UNDO_DONE":
      return {
        ...state,
        undoPending: false,
        session: action.session,
        queueIndex: action.session.position,
        lastGradeEventIds: [],
        gradeEventId: null,
        revealedAt: null,
        phase: "QUESTION",
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export interface UseReviewSessionOptions {
  api: ApiClient;
  /** unit_key -> book_key from the bootstrap; null while loading. */
  bookByUnit: UnitBookMap;
}

export function useReviewSession({
  api,
  bookByUnit,
}: UseReviewSessionOptions): ReviewSessionControls {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const prepareStarted = useRef(false);

  /** Selects a session and settles its word contents (prompt derivation is
   *  a separate step that also waits for the bootstrap book map). */
  const select = useCallback(
    async (session: SessionView): Promise<void> => {
      dispatch({ type: "SESSION_SELECTED", session });
      if (session.position >= session.cards.length) {
        // A completed session has nothing to resume: offer a fresh start.
        dispatch({ type: "BACK_TO_IDLE" });
        return;
      }
      const contents = new Map<string, WordContentResponse | null>();
      await Promise.all(
        session.word_keys.map(async (wordKey) => {
          try {
            contents.set(wordKey, await api.wordContent(wordKey, session.session_id));
          } catch {
            // A failed entry degrades that card to a generic prompt only.
            contents.set(wordKey, null);
          }
        }),
      );
      dispatch({ type: "CONTENTS_LOADED", contents });
    },
    [api],
  );

  // Auto-resume once per mount: the caller's unexpired REVIEW session.
  useEffect(() => {
    if (prepareStarted.current) {
      return;
    }
    prepareStarted.current = true;
    const prepare = async (): Promise<void> => {
      dispatch({ type: "PREPARE" });
      try {
        const sessions = await api.listStudySessions();
        const target = sessions.find(
          (candidate) =>
            candidate.mode === "REVIEW" &&
            candidate.expires_at > Date.now() &&
            candidate.position < candidate.cards.length,
        );
        if (!target) {
          dispatch({ type: "BACK_TO_IDLE" });
          return;
        }
        const session = await api.getStudySession(target.session_id);
        await select(session);
      } catch (cause) {
        dispatch({ type: "PREPARE_FAILED", message: messageFor(cause) });
      }
    };
    void prepare();
  }, [api, select]);

  const start = useCallback(async (): Promise<void> => {
    dispatch({ type: "PREPARE" });
    try {
      const session = await api.createStudySession("REVIEW");
      await select(session);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "STUDY_QUEUE_EMPTY") {
        dispatch({ type: "QUEUE_EMPTY" });
        return;
      }
      dispatch({ type: "START_FAILED", message: messageFor(cause) });
    }
  }, [api, select]);

  // Prompt derivation: once the selected session's contents are settled AND
  // the bootstrap's unit->book map is available, build the queue prompts.
  useEffect(() => {
    if (state.phase !== "PREPARING" || state.session === null || bookByUnit === null) {
      return;
    }
    const session = state.session;
    const settled = session.word_keys.every((wordKey) => state.contents.has(wordKey));
    if (!settled) {
      return;
    }
    let cancelled = false;
    const derive = async (): Promise<void> => {
      const cards = await buildReviewCards(state.contents, session.cards, bookByUnit);
      if (!cancelled) {
        dispatch({ type: "SESSION_READY", cards });
      }
    };
    void derive();
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.session, state.contents, bookByUnit]);

  const reveal = useCallback((): void => {
    if (stateRef.current.phase !== "QUESTION") {
      return;
    }
    // One event id per reveal->rating cycle, generated at reveal time so a
    // failed rating retry replays the SAME id.
    dispatch({ type: "REVEALED", eventId: newEventId(), revealedAt: Date.now() });
  }, []);

  const rate = useCallback(
    async (rating: GradeRating) => {
      const current = stateRef.current;
      const session = current.session;
      const sessionId = session?.session_id;
      const cardKey = session?.cards[current.queueIndex]?.presented_card_key;
      if (
        !sessionId ||
        !cardKey ||
        !current.gradeEventId ||
        current.revealedAt === null ||
        current.gradePending
      ) {
        return;
      }
      dispatch({ type: "GRADE_PENDING" });
      const eventId = current.gradeEventId;
      try {
        const activeGroup = groupReviewCards(current.cards).find(
          (group) =>
            current.queueIndex >= group.rawStart &&
            current.queueIndex < group.rawStart + group.rawLength,
        );
        // A legacy resumed session may already be inside a group. Grade only
        // the still-current suffix so queue validation remains exact.
        const gradedCount = activeGroup
          ? activeGroup.rawStart + activeGroup.rawLength - current.queueIndex
          : 1;
        const cardsToGrade = session.cards.slice(
          current.queueIndex,
          current.queueIndex + gradedCount,
        );
        const eventIds = cardsToGrade.map((_, index) =>
          index === 0 ? eventId : `${eventId}:${index}`,
        );
        const durationMs = Math.max(Date.now() - current.revealedAt, 0);
        if (cardsToGrade.length > 1) {
          await api.gradeReviewBatch({
            session_id: sessionId,
            grades: cardsToGrade.map((card, index) => ({
              event_id: eventIds[index]!,
              card_key: card.presented_card_key,
            })),
            rating,
            duration_ms: durationMs,
          });
        } else {
          await api.gradeReview({
            event_id: eventId,
            session_id: sessionId,
            card_key: cardKey,
            rating,
            duration_ms: durationMs,
          });
        }
        const nextPosition = Math.min(
          current.queueIndex + cardsToGrade.length,
          session.cards.length,
        );
        dispatch({
          type: "GRADE_ADVANCED",
          session: {
            ...session,
            position: nextPosition,
            current_card_key: session.cards[nextPosition]?.presented_card_key ?? null,
          },
          gradedEventIds: eventIds,
        });
      } catch (cause) {
        dispatch({ type: "GRADE_FAILED", message: messageFor(cause) });
      }
    },
    [api],
  );

  const undoLast = useCallback(async () => {
    const current = stateRef.current;
    const eventIds = current.lastGradeEventIds;
    const sessionId = current.session?.session_id;
    if (eventIds.length === 0 || current.undoPending) {
      return;
    }
    dispatch({ type: "UNDO_PENDING" });
    try {
      for (const eventId of [...eventIds].reverse()) {
        await api.undoReview(eventId);
      }
      if (!sessionId) {
        return;
      }
      const refreshed = await api.getStudySession(sessionId);
      dispatch({ type: "UNDO_DONE", session: refreshed });
    } catch (cause) {
      dispatch({ type: "UNDO_FAILED", message: messageFor(cause) });
    }
  }, [api]);

  return {
    phase: state.phase,
    session: state.session,
    cards: state.cards,
    contents: state.contents,
    queueIndex: state.queueIndex,
    gradePending: state.gradePending,
    gradeError: state.gradeError,
    canUndo: state.lastGradeEventIds.length > 0,
    undoPending: state.undoPending,
    undoError: state.undoError,
    queueEmpty: state.queueEmpty,
    startError: state.startError,
    loadError: state.loadError,
    start,
    reveal,
    rate,
    undoLast,
  };
}
