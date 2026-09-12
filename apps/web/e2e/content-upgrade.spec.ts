/**
 * Release-upgrade journeys (plan Task 18 step 1): activation while a study
 * session is pinned to the old release, continued old-key grading and undo
 * through canonical aliases, new-release access to the same FSRS state, the
 * fail-closed alias-conflict activation, and rollback to old presented keys
 * with unchanged canonical state.
 *
 * Release lifecycle operations (activate/rollback/clock) go through the
 * harness control endpoints, which call the REAL publishing functions
 * (`activateRelease`/`rollbackRelease` from the compiler's publish module) —
 * the journeys assert the behavior those produce, never their internals.
 */
import { expect, test, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import {
  ANCHOR_V1,
  DRIFT_V1,
  HARBOUR_V1,
  HARBOR_V2,
  RELEASE_V1,
  RELEASE_V2,
  RELEASE_V3_COLLIDE,
  UNIT_TITLE_V1,
  UNIT_TITLE_V2,
  V2_ALIAS_EDGES,
  V3_COLLIDE_EDGES,
} from "../../worker/e2e-harness/fixture";
import {
  alice,
  harnessState,
  loginViaUi,
  SpecApi,
  type CreatedStudySession,
  type GradeShape,
  type HarnessState,
} from "./support/harness";

let state: HarnessState;

interface ControlResult {
  ok: boolean;
  code?: string;
  message?: string;
  releaseId?: string;
  previousReleaseId?: string | null;
  now?: number;
}

/** Drives a harness control endpoint (real publish/clock functions). */
async function control(action: string, body: Record<string, unknown>): Promise<{ status: number; body: ControlResult }> {
  const response = await fetch(`${state.baseUrl}/__harness/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as ControlResult };
}

let apiContext: APIRequestContext;
let api: SpecApi;
let pinned: CreatedStudySession;
let harbourOldKeyGrade: GradeShape;
let harbourReGrade: GradeShape;

test.beforeAll(async () => {
  state = await harnessState();
  apiContext = await playwrightRequest.newContext({ baseURL: state.baseUrl });
  api = new SpecApi(apiContext, state.baseUrl);
  await api.login(alice(state));

  // Setup: a NEW_WORDS session on the ACTIVE release (v1), the renamed word
  // still under its old key. Alice presents anchor and drift (the key the
  // collision activation would collapse), then grades the queue's first card.
  pinned = await api.createStudySession("NEW_WORDS");
  await api.presentWord(pinned.session_id, "present-anchor", ANCHOR_V1.wordKey);
  await api.presentWord(pinned.session_id, "present-drift", DRIFT_V1.wordKey);
  await api.grade({
    event_id: "grade-anchor-wm",
    session_id: pinned.session_id,
    card_key: pinned.cards[0]!.presented_card_key,
    rating: 3,
  });
});

test.describe.configure({ mode: "serial" });

test.afterAll(async () => {
  await apiContext.dispose();
});

test("activates the new release while the old session stays pinned to v1", async () => {
  const result = await control("activate", {
    releaseId: RELEASE_V2,
    aliases: V2_ALIAS_EDGES,
  });
  expect(result.status).toBe(200);
  expect(result.body.ok).toBe(true);
  expect(result.body.previousReleaseId).toBe(RELEASE_V1);

  // Normal browsing resolves the NEW release; the pinned session's reads
  // still resolve the OLD one (spec 6.4 seam).
  const browsing = await api.bootstrap();
  expect(browsing.release_id).toBe(RELEASE_V2);
  expect(browsing.units[0]!.title).toBe(UNIT_TITLE_V2);
  const throughSession = await api.bootstrap(pinned.session_id);
  expect(throughSession.release_id).toBe(RELEASE_V1);
  expect(throughSession.units[0]!.title).toBe(UNIT_TITLE_V1);

  // The frozen queue and position survive the activation untouched.
  const session = await api.studySession(pinned.session_id);
  expect(session.release_id).toBe(RELEASE_V1);
  expect(session.position).toBe(1);
  expect(session.cards.length).toBe(pinned.cards.length);
});

test("continues grading the pinned session through the OLD key to the canonical state", async () => {
  const session = await api.studySession(pinned.session_id);
  const current = session.cards[session.position]!;
  // The queue's second card is the renamed word's WORD_MEANING card, still
  // presented under its v1 (harbour) key.
  expect(current.presented_card_key).toBe(HARBOUR_V1.cardKeys.WORD_MEANING);

  harbourOldKeyGrade = await api.grade({
    event_id: "grade-harbour-wm-old-key",
    session_id: pinned.session_id,
    card_key: current.presented_card_key,
    rating: 1,
  });
  // The grade landed on the CANONICAL (v2) card key via the alias chain.
  expect(harbourOldKeyGrade.card_key).toBe(HARBOR_V2.cardKeys.WORD_MEANING);
  expect(harbourOldKeyGrade.presented_card_key).toBe(HARBOUR_V1.cardKeys.WORD_MEANING);
  expect(harbourOldKeyGrade.before_state).toBeNull();
});

test("undoes the old-key grade through the canonical alias and re-grades it", async () => {
  const undone = await api.undo(harbourOldKeyGrade.event_id);
  expect(undone.card_key).toBe(HARBOR_V2.cardKeys.WORD_MEANING);
  // A first grade's canonical state is deleted by the undo.
  expect(undone.restored_state).toBeNull();
  const session = await api.studySession(pinned.session_id);
  expect(session.position).toBe(1);

  // Re-grade the SAME old presented key: the canonical state returns and is
  // due again, which the next test reaches from the NEW release.
  harbourReGrade = await api.grade({
    event_id: "grade-harbour-wm-old-key-again",
    session_id: pinned.session_id,
    card_key: HARBOUR_V1.cardKeys.WORD_MEANING,
    rating: 1,
  });
  expect(harbourReGrade.card_key).toBe(HARBOR_V2.cardKeys.WORD_MEANING);
  expect(harbourReGrade.before_state).toBeNull();
});

test("reaches the same FSRS state from the new release after the clock advances", async ({ page }) => {
  // +11h: the harbour canonical card (Again, ~10h) is now due; the pinned
  // session (24h TTL) is still valid.
  const clock = await control("clock", { advanceMs: 11 * 3_600_000 });
  expect(clock.status).toBe(200);

  // A review session created NOW is pinned to the ACTIVE v2 release and
  // presents the renamed card under its NEW key.
  const review = await api.createStudySession("REVIEW");
  expect(review.release_id).toBe(RELEASE_V2);
  const renamed = review.cards.find((card) => card.canonical_card_key === HARBOR_V2.cardKeys.WORD_MEANING);
  expect(renamed).toBeDefined();
  expect(renamed!.presented_card_key).toBe(HARBOR_V2.cardKeys.WORD_MEANING);

  // Grading the new key continues the exact state the old-key grade wrote.
  const graded = await api.grade({
    event_id: "grade-harbor-wm-new-key",
    session_id: review.session_id,
    card_key: renamed!.presented_card_key,
    rating: 3,
  });
  expect(graded.card_key).toBe(HARBOR_V2.cardKeys.WORD_MEANING);
  expect(graded.before_state).toEqual(harbourReGrade.after_state);

  // Undo the latest grade: the pre-grade state comes back intact.
  const undone = await api.undo(graded.event_id);
  expect(undone.restored_state).toEqual(harbourReGrade.after_state);

  // UI proof: the review page AUTO-RESUMES the session just graded (it is
  // unexpired and belongs to this account) and renders the NEW spelling
  // fetched through the v2-pinned session.
  await loginViaUi(page, alice(state));
  await page.goto("/review");
  await expect(page.getByText(/第 1 张 \/ 共 \d+ 张/)).toBeVisible();
  await expect(page.locator("section").getByText("harbor", { exact: true })).toBeVisible();
});

test("fails closed on an alias-conflict activation and leaves the pointer unchanged", async () => {
  // drift already carries a progress row (setup): declaring it aliased into
  // the v3 probe release would collapse existing user state.
  const result = await control("activate", {
    releaseId: RELEASE_V3_COLLIDE,
    aliases: V3_COLLIDE_EDGES,
  });
  expect(result.status).toBe(409);
  expect(result.body.ok).toBe(false);
  expect(result.body.code).toBe("ALIAS_STATE_COLLISION");

  // The active pointer, content, and the drifted progress row are untouched.
  const browsing = await api.bootstrap();
  expect(browsing.release_id).toBe(RELEASE_V2);
  const drift = await api.get(`/api/progress/words/${DRIFT_V1.wordKey}`);
  expect(drift.status).toBe(200);
  expect((drift.body as { progress: { stage: string } | null }).progress?.stage).toBe("IN_PROGRESS");
});

test("rolls back so new sessions present the OLD keys against unchanged canonical state", async ({ page }) => {
  const result = await control("rollback", { releaseId: RELEASE_V1 });
  expect(result.status).toBe(200);
  expect(result.body.ok).toBe(true);
  expect(result.body.previousReleaseId).toBe(RELEASE_V2);

  // Browsing resolves v1 again; the user-visible unit title switches back.
  const browsing = await api.bootstrap();
  expect(browsing.release_id).toBe(RELEASE_V1);
  await loginViaUi(page, alice(state));
  await page.goto("/today");
  await expect(page.getByText(UNIT_TITLE_V1)).toBeVisible();
  // The learn setup word list presents the OLD spelling again.
  await page.goto("/learn");
  await expect(page.getByLabel("本单元单词顺序")).toContainText("harbour");

  // A fresh learning session now presents the old key while its canonical
  // snapshot key stays the v2 key; grading lands on the SAME state.
  const session = await api.createStudySession("NEW_WORDS");
  expect(session.release_id).toBe(RELEASE_V1);
  const queued = session.cards.find((card) => card.canonical_card_key === HARBOR_V2.cardKeys.WORD_MEANING);
  expect(queued).toBeDefined();
  expect(queued!.presented_card_key).toBe(HARBOUR_V1.cardKeys.WORD_MEANING);

  // The queue serves the anchor card first (textbook order): grade through
  // it, then grade the renamed card under its old presented key.
  await api.presentWord(session.session_id, "present-anchor-rollback", ANCHOR_V1.wordKey);
  await api.grade({
    event_id: "grade-anchor-rollback",
    session_id: session.session_id,
    card_key: session.cards[0]!.presented_card_key,
    rating: 3,
  });
  const graded = await api.grade({
    event_id: "grade-harbour-rollback-old-key",
    session_id: session.session_id,
    card_key: HARBOUR_V1.cardKeys.WORD_MEANING,
    rating: 2,
  });
  expect(graded.card_key).toBe(HARBOR_V2.cardKeys.WORD_MEANING);
});
