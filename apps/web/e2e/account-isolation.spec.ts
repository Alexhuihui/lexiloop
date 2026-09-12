/**
 * Account-isolation journeys (plan Task 18 step 1): two synthetic accounts
 * share one release, and every personal byte stays scoped — sessions, stats,
 * progress rows, and the private audio store deny cross-account and
 * unauthenticated access.
 */
import { expect, test, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { ANCHOR_V1 } from "../../worker/e2e-harness/fixture";
import { syntheticAudioAssetKey } from "../../worker/e2e-harness/wav";
import {
  alice,
  bob,
  harnessState,
  SpecApi,
  type CreatedStudySession,
  type HarnessState,
} from "./support/harness";

let state: HarnessState;
let apiContext: APIRequestContext;
let aliceApi: SpecApi;
let bobApi: SpecApi;
let aliceSession: CreatedStudySession;
let bobSession: CreatedStudySession;

test.beforeAll(async () => {
  state = await harnessState();
  apiContext = await playwrightRequest.newContext({ baseURL: state.baseUrl });
  aliceApi = new SpecApi(apiContext, state.baseUrl);
  bobApi = new SpecApi(apiContext, state.baseUrl);
  await aliceApi.login(alice(state));
  await bobApi.login(bob(state));

  // Alice studies (presentation + familiarity only); Bob grades a card.
  aliceSession = await aliceApi.createStudySession("NEW_WORDS");
  await aliceApi.presentWord(aliceSession.session_id, "iso-present-anchor", ANCHOR_V1.wordKey);
  await aliceApi.patch(`/api/study/sessions/${aliceSession.session_id}`, {
    event_id: "iso-familiarity-anchor",
    action: "FAMILIARITY_SET",
    word_key: ANCHOR_V1.wordKey,
    familiarity: "SOMEWHAT_FAMILIAR",
  });
  bobSession = await bobApi.createStudySession("NEW_WORDS");
  await bobApi.grade({
    event_id: "iso-grade-anchor-wm",
    session_id: bobSession.session_id,
    card_key: bobSession.cards[0]!.presented_card_key,
    rating: 4,
  });
});

test.afterAll(async () => {
  await apiContext.dispose();
});

test.describe.configure({ mode: "serial" });

test("keeps study sessions, stats, and progress scoped to each account", async () => {
  // Session lists only ever contain the caller's own sessions.
  const aliceSessions = (await aliceApi.get("/api/study/sessions")).body as {
    sessions: Array<{ session_id: string }>;
  };
  const bobSessions = (await bobApi.get("/api/study/sessions")).body as {
    sessions: Array<{ session_id: string }>;
  };
  expect(aliceSessions.sessions.map((s) => s.session_id)).toEqual([aliceSession.session_id]);
  expect(bobSessions.sessions.map((s) => s.session_id)).toEqual([bobSession.session_id]);

  // Alice's presentation never created state for Bob, and Bob's grade never
  // touched Alice's stats or progress.
  const aliceStats = await aliceApi.stats();
  const bobStats = await bobApi.stats();
  expect(bobStats.learned_cards).toBe(1);
  expect(aliceStats.learned_cards).toBe(0);

  const aliceAnchor = (await aliceApi.get(`/api/progress/words/${ANCHOR_V1.wordKey}`)).body as {
    progress: { stage: string; initial_familiarity: string | null } | null;
  };
  const bobAnchor = (await bobApi.get(`/api/progress/words/${ANCHOR_V1.wordKey}`)).body as {
    progress: { stage: string } | null;
  };
  expect(aliceAnchor.progress?.stage).toBe("IN_PROGRESS");
  expect(aliceAnchor.progress?.initial_familiarity).toBe("RECOGNIZABLE");
  expect(bobAnchor.progress).toBeNull();
});

test("rejects cross-account session access with a stable error", async () => {
  // Alice addressing Bob's session id gains nothing: ownership comes from
  // the cookie, and the unknown-for-this-user session fails closed.
  const cross = await aliceApi.get(`/api/study/sessions/${bobSession.session_id}`);
  expect(cross.status).toBe(400);
  expect((cross.body as { code?: string }).code).toBe("STUDY_SESSION_INVALID");
});

test("denies unauthenticated reads of personal data and the private audio store", async ({ request }) => {
  const personalPaths = [
    "/api/study/sessions",
    "/api/stats/overview",
    `/api/progress/words/${ANCHOR_V1.wordKey}`,
    `/api/audio/${syntheticAudioAssetKey("anchor")}`,
  ];
  for (const path of personalPaths) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(401);
    const body = (await response.json()) as { code?: string };
    expect(body.code, path).toBe("AUTH_SESSION_INVALID");
  }
});

test("streams owned audio and denies audio outside the active release", async ({ request }) => {
  const cookie = aliceApi.sessionCookie();

  // Positive control: an active-release asset streams with audio metadata.
  const anchor = await request.get(`/api/audio/${syntheticAudioAssetKey("anchor")}`, {
    headers: { cookie },
  });
  expect(anchor.status()).toBe(200);
  expect(anchor.headers()["content-type"]).toBe("audio/wav");
  expect(anchor.headers()["etag"]).toBeDefined();

  // The v2 spelling's audio object does not belong to the ACTIVE v1 release:
  // the association check denies it even though the bucket holds the object.
  const harborV2 = await request.get(`/api/audio/${syntheticAudioAssetKey("harbor")}`, {
    headers: { cookie },
  });
  expect(harborV2.status()).toBe(404);
  expect(((await harborV2.json()) as { code?: string }).code).toBe("CONTENT_AUDIO_NOT_FOUND");

  // The v1 spelling's sibling asset (same bucket, active release) streams.
  const harbourV1 = await request.get(`/api/audio/${syntheticAudioAssetKey("harbour")}`, {
    headers: { cookie },
  });
  expect(harbourV1.status()).toBe(200);
});
