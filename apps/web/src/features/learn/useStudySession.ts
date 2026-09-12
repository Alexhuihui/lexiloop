/**
 * The new-word learning state machine (spec 9.3, plan Task 16).
 *
 * UI states: SETUP -> STUDY_WORDS -> QUICK_RECALL_QUESTION ->
 * QUICK_RECALL_REVEALED -> COMPLETE. Nothing here touches web storage: every
 * bit of progress is persisted through the Worker Session APIs (session
 * create/get, the StudyPatch endpoints, and /api/reviews/grade), so an
 * interrupted journey resumes from the server alone.
 *
 * Binding interaction rules encoded here:
 * - When a word becomes visible, exactly ONE stable WORD_PRESENTED patch
 *   event (one `event_id` per word, generated once) is sent; familiarity
 *   controls stay disabled until the Worker acknowledges it.
 * - The Worker validates patches against the session's GROUP (spec 9.3
 *   ruling: familiarity is first-sorting for every studied word), so every
 *   group word's presentation acks during study. A 409
 *   `STUDY_WORD_NOT_IN_GROUP` marks a word "deferred" as a pure fallback;
 *   deferred AND network-failed words are retried after each successful
 *   grade advances the position, with the SAME event id. A 409 writes
 *   nothing server-side, so retrying it is safe.
 * - A failed (network) patch is retried through `retryPresentation` — or the
 *   recall/complete-phase retry control — with the SAME event id; no second
 *   event is ever generated for one presentation.
 * - A familiarity choice sends FAMILIARITY_SET (fresh event id per choice;
 *   it may be changed while the word is current) and NEVER calls the
 *   grade endpoint.
 * - Grading happens only in QUICK_RECALL_REVEALED: one client-generated
 *   `event_id` per reveal->rating cycle; the SAME id is replayed when the
 *   grade request fails; the next card is enabled only after the grade and
 *   the session re-read both succeeded.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  ApiError,
  type ApiClient,
  type FamiliarityChoice,
  type GradeRating,
  type SessionView,
  type WordContentResponse,
} from "../../lib/api-client";
import { buildQuickRecallCards, type QuickRecallCard } from "./QuickRecall";

export type LearnPhase =
  | "SETUP"
  | "STUDY_WORDS"
  | "QUICK_RECALL_QUESTION"
  | "QUICK_RECALL_REVEALED"
  | "COMPLETE";

/** One word of the planned group in textbook order. */
export interface GroupWord {
  wordKey: string;
  headword: string;
  phonetic: string | null;
  tier: string;
  sourceOrder: number;
}

export type PresentationState = "untried" | "pending" | "acked" | "deferred" | "failed";

/** A group word plus its machine-managed study state. */
export interface StudyWordState extends GroupWord {
  /** The ONE stable WORD_PRESENTED event id for this word. */
  presentedEventId: string;
  content: WordContentResponse | null;
  contentFailed: boolean;
  presentation: PresentationState;
  presentationError: string | null;
  familiarity: FamiliarityChoice | null;
}

export interface StudySessionControls {
  phase: LearnPhase;
  session: SessionView | null;
  words: StudyWordState[];
  studyIndex: number;
  starting: boolean;
  setupError: string | null;
  familiarityPending: boolean;
  gradePending: boolean;
  gradeError: string | null;
  recallCards: QuickRecallCard[] | null;
  queueIndex: number;
  summary: { introduced: number; total: number } | null;
  startGroup(group: readonly GroupWord[]): Promise<void>;
  resumeSession(expected: readonly GroupWord[]): Promise<void>;
  retryPresentation(wordKey: string): Promise<void>;
  /** Retries every deferred/failed presentation with its SAME event id;
   *  refreshes the completion summary when already complete. */
  retryPendingPresentations(): Promise<void>;
  retryContent(wordKey: string): void;
  chooseFamiliarity(wordKey: string, choice: FamiliarityChoice): Promise<void>;
  advanceStudy(): Promise<void>;
  reveal(): void;
  rate(rating: GradeRating): Promise<void>;
}

interface MachineState {
  phase: LearnPhase;
  session: SessionView | null;
  words: StudyWordState[];
  studyIndex: number;
  starting: boolean;
  setupError: string | null;
  contentLoadingKey: string | null;
  presentationKey: string | null;
  familiarityPending: boolean;
  recallCards: QuickRecallCard[] | null;
  queueIndex: number;
  gradeEventId: string | null;
  gradePending: boolean;
  gradeError: string | null;
  revealedAt: number | null;
  summary: { introduced: number; total: number } | null;
}

type MachineAction =
  | { type: "START" }
  | { type: "START_FAILED"; message: string }
  | {
      type: "SESSION_STARTED";
      session: SessionView;
      words: StudyWordState[];
      studyIndex: number;
      phase: LearnPhase;
      recallCards: QuickRecallCard[] | null;
    }
  | { type: "CONTENT_LOADING"; wordKey: string }
  | { type: "CONTENT_LOADED"; wordKey: string; content: WordContentResponse }
  | { type: "CONTENT_RETRY"; wordKey: string }
  | { type: "CONTENT_FAILED"; wordKey: string }
  | { type: "PRESENT_PENDING"; wordKey: string }
  | { type: "PRESENT_ACKED"; wordKey: string }
  | { type: "PRESENT_DEFERRED"; wordKey: string }
  | { type: "PRESENT_FAILED"; wordKey: string; message: string }
  | { type: "STUDY_NEXT" }
  | { type: "RECALL_STARTED"; session: SessionView; cards: QuickRecallCard[] }
  | { type: "REVEALED"; eventId: string; revealedAt: number }
  | { type: "GRADE_PENDING" }
  | { type: "GRADE_FAILED"; message: string }
  | { type: "GRADE_ADVANCED"; session: SessionView }
  | { type: "SUMMARY"; introduced: number; total: number }
  | { type: "FAMILIARITY_PENDING" }
  | { type: "FAMILIARITY_ACKED"; wordKey: string; choice: FamiliarityChoice }
  | { type: "FAMILIARITY_FAILED" };

const INITIAL_STATE: MachineState = {
  phase: "SETUP",
  session: null,
  words: [],
  studyIndex: 0,
  starting: false,
  setupError: null,
  contentLoadingKey: null,
  presentationKey: null,
  familiarityPending: false,
  recallCards: null,
  queueIndex: 0,
  gradeEventId: null,
  gradePending: false,
  gradeError: null,
  revealedAt: null,
  summary: null,
};

function updateWord(
  words: readonly StudyWordState[],
  wordKey: string,
  update: (word: StudyWordState) => StudyWordState,
): StudyWordState[] {
  return words.map((word) => (word.wordKey === wordKey ? update(word) : word));
}

function reducer(state: MachineState, action: MachineAction): MachineState {
  switch (action.type) {
    case "START":
      return { ...state, starting: true, setupError: null };
    case "START_FAILED":
      return { ...state, starting: false, setupError: action.message };
    case "SESSION_STARTED":
      return {
        ...state,
        starting: false,
        setupError: null,
        session: action.session,
        words: action.words,
        studyIndex: action.studyIndex,
        phase: action.phase,
        recallCards: action.recallCards,
        queueIndex: action.session.position,
        summary: null,
      };
    case "CONTENT_LOADING":
      return { ...state, contentLoadingKey: action.wordKey };
    case "CONTENT_LOADED":
      return {
        ...state,
        contentLoadingKey:
          state.contentLoadingKey === action.wordKey ? null : state.contentLoadingKey,
        words: updateWord(state.words, action.wordKey, (word) => ({
          ...word,
          content: action.content,
          contentFailed: false,
        })),
      };
    case "CONTENT_RETRY":
      return {
        ...state,
        words: updateWord(state.words, action.wordKey, (word) => ({
          ...word,
          contentFailed: false,
        })),
      };
    case "CONTENT_FAILED":
      return {
        ...state,
        contentLoadingKey:
          state.contentLoadingKey === action.wordKey ? null : state.contentLoadingKey,
        words: updateWord(state.words, action.wordKey, (word) => ({
          ...word,
          contentFailed: true,
        })),
      };
    case "PRESENT_PENDING":
      return {
        ...state,
        presentationKey: action.wordKey,
        words: updateWord(state.words, action.wordKey, (word) => ({
          ...word,
          presentation: "pending",
          presentationError: null,
        })),
      };
    case "PRESENT_ACKED":
      return {
        ...state,
        presentationKey:
          state.presentationKey === action.wordKey ? null : state.presentationKey,
        words: updateWord(state.words, action.wordKey, (word) => ({
          ...word,
          presentation: "acked",
          presentationError: null,
        })),
      };
    case "PRESENT_DEFERRED":
      return {
        ...state,
        presentationKey:
          state.presentationKey === action.wordKey ? null : state.presentationKey,
        words: updateWord(state.words, action.wordKey, (word) => ({
          ...word,
          presentation: "deferred",
          presentationError: null,
        })),
      };
    case "PRESENT_FAILED":
      return {
        ...state,
        presentationKey:
          state.presentationKey === action.wordKey ? null : state.presentationKey,
        words: updateWord(state.words, action.wordKey, (word) => ({
          ...word,
          presentation: "failed",
          presentationError: action.message,
        })),
      };
    case "STUDY_NEXT":
      return {
        ...state,
        studyIndex: Math.min(state.studyIndex + 1, Math.max(state.words.length - 1, 0)),
      };
    case "RECALL_STARTED":
      return {
        ...state,
        session: action.session,
        recallCards: action.cards,
        queueIndex: action.session.position,
        phase: "QUICK_RECALL_QUESTION",
        gradeError: null,
        gradeEventId: null,
        revealedAt: null,
      };
    case "REVEALED":
      return {
        ...state,
        phase: "QUICK_RECALL_REVEALED",
        gradeEventId: action.eventId,
        revealedAt: action.revealedAt,
        gradeError: null,
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
        phase: done ? "COMPLETE" : "QUICK_RECALL_QUESTION",
      };
    }
    case "SUMMARY":
      return { ...state, summary: { introduced: action.introduced, total: action.total } };
    case "FAMILIARITY_PENDING":
      return { ...state, familiarityPending: true };
    case "FAMILIARITY_ACKED":
      return {
        ...state,
        familiarityPending: false,
        words: updateWord(state.words, action.wordKey, (word) => ({
          ...word,
          familiarity: action.choice,
        })),
      };
    case "FAMILIARITY_FAILED":
      return { ...state, familiarityPending: false };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

/** Worker error -> stable user-facing message (never raw server text).
 *  Shared with the review flow so both surfaces report identically. */
export function messageFor(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 0) {
      return "网络连接失败，请检查网络后重试";
    }
    return "服务暂时不可用，请稍后重试";
  }
  return cause instanceof Error && cause.message ? cause.message : "操作失败，请重试";
}

/** Stored familiarity value -> API choice (spec 9.3 vocabulary). */
function familiarityFromStored(stored: string | null): FamiliarityChoice | null {
  switch (stored) {
    case "UNKNOWN":
      return "VERY_UNFAMILIAR";
    case "RECOGNIZABLE":
      return "SOMEWHAT_FAMILIAR";
    case "KNOWN":
      return "FAMILIAR";
    default:
      return null;
  }
}

function newEventId(): string {
  const source = globalThis.crypto;
  if (source && typeof source.randomUUID === "function") {
    return source.randomUUID();
  }
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function toStudyWord(word: GroupWord): StudyWordState {
  return {
    ...word,
    presentedEventId: newEventId(),
    content: null,
    contentFailed: false,
    presentation: "untried",
    presentationError: null,
    familiarity: null,
  };
}

export interface UseStudySessionOptions {
  api: ApiClient;
}

export function useStudySession({ api }: UseStudySessionOptions): StudySessionControls {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const loadContent = useCallback(
    async (wordKey: string) => {
      const current = stateRef.current;
      const word = current.words.find((candidate) => candidate.wordKey === wordKey);
      if (!word || word.content || word.contentFailed || current.contentLoadingKey !== null) {
        return;
      }
      dispatch({ type: "CONTENT_LOADING", wordKey });
      try {
        const content = await api.wordContent(wordKey, current.session?.session_id);
        dispatch({ type: "CONTENT_LOADED", wordKey, content });
      } catch {
        // Shown inline; a content failure never discards the position.
        dispatch({ type: "CONTENT_FAILED", wordKey });
      }
    },
    [api],
  );

  const attemptPresentation = useCallback(
    async (wordKey: string) => {
      const current = stateRef.current;
      const word = current.words.find((candidate) => candidate.wordKey === wordKey);
      if (!word || !current.session || current.presentationKey !== null) {
        return;
      }
      dispatch({ type: "PRESENT_PENDING", wordKey });
      try {
        await api.patchStudySession(current.session.session_id, {
          event_id: word.presentedEventId,
          action: "WORD_PRESENTED",
          word_key: wordKey,
        });
        dispatch({ type: "PRESENT_ACKED", wordKey });
      } catch (cause) {
        if (cause instanceof ApiError && cause.code === "STUDY_WORD_NOT_IN_GROUP") {
          // Membership rejection writes nothing server-side; kept as a
          // defensive fallback (the spec 9.3 path accepts every group word).
          dispatch({ type: "PRESENT_DEFERRED", wordKey });
        } else {
          dispatch({ type: "PRESENT_FAILED", wordKey, message: messageFor(cause) });
        }
      }
    },
    [api],
  );

  const syncPendingPresentations = useCallback(async () => {
    for (const word of stateRef.current.words) {
      if (word.presentation === "deferred" || word.presentation === "failed") {
        // Both states carry the word's SAME, never-recorded event id.
        await attemptPresentation(word.wordKey);
      }
    }
  }, [attemptPresentation]);

  // Study view: load the visible word's content (failures stay inline).
  useEffect(() => {
    if (state.phase !== "STUDY_WORDS") {
      return;
    }
    const word = state.words[state.studyIndex];
    if (word && word.content === null && !word.contentFailed) {
      void loadContent(word.wordKey);
    }
  }, [state.phase, state.words, state.studyIndex, loadContent]);

  // Study view: present the visible word once its content is available.
  useEffect(() => {
    if (state.phase !== "STUDY_WORDS") {
      return;
    }
    const word = state.words[state.studyIndex];
    if (word && word.content !== null && word.presentation === "untried") {
      void attemptPresentation(word.wordKey);
    }
  }, [state.phase, state.words, state.studyIndex, attemptPresentation]);

  const startGroup = useCallback(
    async (group: readonly GroupWord[]) => {
      dispatch({ type: "START" });
      try {
        const session = await api.createStudySession("NEW_WORDS");
        dispatch({
          type: "SESSION_STARTED",
          session,
          words: group.map(toStudyWord),
          studyIndex: 0,
          phase: "STUDY_WORDS",
          recallCards: null,
        });
      } catch (cause) {
        dispatch({ type: "START_FAILED", message: messageFor(cause) });
      }
    },
    [api],
  );

  const resumeSession = useCallback(
    async (expected: readonly GroupWord[]) => {
      dispatch({ type: "START" });
      try {
        const sessions = await api.listStudySessions();
        const target = sessions.find(
          (candidate) => candidate.mode === "NEW_WORDS" && candidate.expires_at > Date.now(),
        );
        if (!target) {
          throw new Error("没有可继续的学习会话");
        }
        const session = await api.getStudySession(target.session_id);
        // The resume must continue EXACTLY the group the user is set to
        // study: the Worker derives the session's word keys from its pinned
        // snapshot, and a mismatch (e.g. a session started in another unit
        // or tier selection) must not be resumed against a wrong word list.
        const sessionWords = new Set(session.word_keys);
        const expectedWords = new Set(expected.map((word) => word.wordKey));
        const sameGroup =
          sessionWords.size === expectedWords.size &&
          [...expectedWords].every((key) => sessionWords.has(key));
        if (!sameGroup) {
          throw new Error("当前学习会话与所选单元或分层不一致，无法继续");
        }
        const progressRows = await Promise.all(
          expected.map(async (word) => {
            try {
              return (await api.wordProgress(word.wordKey)).progress;
            } catch {
              return null;
            }
          }),
        );
        const words: StudyWordState[] = expected.map((word, index) => {
          const row = progressRows[index] ?? null;
          const prepared = toStudyWord(word);
          // A word_progress row exists only after an acknowledged presentation.
          return {
            ...prepared,
            presentation: row ? "acked" : "untried",
            familiarity: familiarityFromStored(row?.initial_familiarity ?? null),
          };
        });
        if (words.length === 0) {
          throw new Error("没有可继续的学习内容");
        }
        const firstUnpresented = words.findIndex((word) => word.presentation !== "acked");
        if (firstUnpresented === -1) {
          // Every group word was presented: continue directly in quick recall.
          const loaded: StudyWordState[] = [];
          for (const word of words) {
            try {
              loaded.push({
                ...word,
                content: await api.wordContent(word.wordKey, session.session_id),
              });
            } catch {
              loaded.push(word);
            }
          }
          dispatch({
            type: "SESSION_STARTED",
            session,
            words: loaded,
            studyIndex: 0,
            phase: "QUICK_RECALL_QUESTION",
            recallCards: buildQuickRecallCards(loaded, session.cards),
          });
          return;
        }
        dispatch({
          type: "SESSION_STARTED",
          session,
          words,
          studyIndex: firstUnpresented,
          phase: "STUDY_WORDS",
          recallCards: null,
        });
      } catch (cause) {
        dispatch({ type: "START_FAILED", message: messageFor(cause) });
      }
    },
    [api],
  );

  const chooseFamiliarity = useCallback(
    async (wordKey: string, choice: FamiliarityChoice) => {
      const current = stateRef.current;
      const word = current.words.find((candidate) => candidate.wordKey === wordKey);
      if (!word || !current.session || current.familiarityPending) {
        return;
      }
      if (word.presentation !== "acked") {
        return; // the controls are disabled until the ack anyway
      }
      dispatch({ type: "FAMILIARITY_PENDING" });
      try {
        // A fresh event per choice; changing the choice while the word is
        // current simply sends another FAMILIARITY_SET. Never a grade call.
        await api.patchStudySession(current.session.session_id, {
          event_id: newEventId(),
          action: "FAMILIARITY_SET",
          word_key: wordKey,
          familiarity: choice,
        });
        dispatch({ type: "FAMILIARITY_ACKED", wordKey, choice });
      } catch {
        dispatch({ type: "FAMILIARITY_FAILED" });
      }
    },
    [api],
  );

  const advanceStudy = useCallback(async () => {
    const current = stateRef.current;
    if (current.phase !== "STUDY_WORDS") {
      return;
    }
    if (current.studyIndex < current.words.length - 1) {
      dispatch({ type: "STUDY_NEXT" });
      return;
    }
    // Last word studied: enter quick recall with every group card, in the
    // server's snapshot order (the client never reshuffles).
    const session = current.session;
    if (!session) {
      return;
    }
    const words = [...current.words];
    for (const [index, word] of words.entries()) {
      if (word.content === null) {
        try {
          words[index] = {
            ...word,
            content: await api.wordContent(word.wordKey, session.session_id),
          };
        } catch {
          // Missing content degrades that card to a generic prompt only.
        }
      }
    }
    dispatch({
      type: "RECALL_STARTED",
      session,
      cards: buildQuickRecallCards(words, session.cards),
    });
  }, [api]);

  const reveal = useCallback((): void => {
    if (stateRef.current.phase !== "QUICK_RECALL_QUESTION") {
      return;
    }
    // One event id per reveal->rating cycle, generated at reveal time so a
    // failed rating retry replays the SAME id.
    dispatch({ type: "REVEALED", eventId: newEventId(), revealedAt: Date.now() });
  }, []);

  const retryContent = useCallback((wordKey: string): void => {
    // Clears the failure flag; the content effect re-issues the read.
    dispatch({ type: "CONTENT_RETRY", wordKey });
  }, []);

  const refreshSummary = useCallback(async () => {
    const progressRows = await Promise.all(
      stateRef.current.words.map(async (word) => {
        try {
          return (await api.wordProgress(word.wordKey)).progress;
        } catch {
          return null;
        }
      }),
    );
    dispatch({
      type: "SUMMARY",
      introduced: progressRows.filter((row) => row?.stage === "INTRODUCED").length,
      total: progressRows.length,
    });
  }, [api]);

  const retryPendingPresentations = useCallback(async () => {
    await syncPendingPresentations();
    // A late presentation can complete a word's introduction (its cards were
    // already graded), so the completion summary must be re-read.
    if (stateRef.current.phase === "COMPLETE") {
      await refreshSummary();
    }
  }, [syncPendingPresentations, refreshSummary]);

  const rate = useCallback(
    async (rating: GradeRating) => {
      const current = stateRef.current;
      const sessionId = current.session?.session_id;
      const cardKey = current.session?.cards[current.queueIndex]?.presented_card_key;
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
      try {
        await api.gradeReview({
          event_id: current.gradeEventId,
          session_id: sessionId,
          card_key: cardKey,
          rating,
          duration_ms: Math.max(Date.now() - current.revealedAt, 0),
        });
        // The client advances only on success, after re-reading the session
        // (the advanced position lives server-side).
        const refreshed = await api.getStudySession(sessionId);
        await syncPendingPresentations();
        dispatch({ type: "GRADE_ADVANCED", session: refreshed });
        if (refreshed.position >= refreshed.cards.length) {
          await refreshSummary();
        }
      } catch (cause) {
        dispatch({ type: "GRADE_FAILED", message: messageFor(cause) });
      }
    },
    [api, syncPendingPresentations, refreshSummary],
  );

  return {
    phase: state.phase,
    session: state.session,
    words: state.words,
    studyIndex: state.studyIndex,
    starting: state.starting,
    setupError: state.setupError,
    familiarityPending: state.familiarityPending,
    gradePending: state.gradePending,
    gradeError: state.gradeError,
    recallCards: state.recallCards,
    queueIndex: state.queueIndex,
    summary: state.summary,
    startGroup,
    resumeSession,
    retryPresentation: attemptPresentation,
    retryPendingPresentations,
    retryContent,
    chooseFamiliarity,
    advanceStudy,
    reveal,
    rate,
  };
}
