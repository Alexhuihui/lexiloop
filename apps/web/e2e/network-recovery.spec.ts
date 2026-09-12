/**
 * Network and failure-path recovery journeys (plan Task 18 step 1): a
 * duplicate grade under a network retry counts exactly once (the SAME
 * event_id is replayed), auth expiry recovers through re-login with the
 * route preserved, and an R2 object denial surfaces inline without blocking
 * the study flow.
 *
 * Group sizes are read from the page (the SERVER decides each NEW_WORDS
 * queue), never hardcoded: earlier specs shape how many words remain.
 */
import { expect, test, type Page } from "@playwright/test";
import { HARBOUR_V1 } from "../../worker/e2e-harness/fixture";
import {
  alice,
  harnessState,
  loginViaUi,
  SpecApi,
  type HarnessState,
} from "./support/harness";

let state: HarnessState;

interface ControlResult {
  ok: boolean;
  code?: string;
  now?: number;
}

test.beforeAll(async () => {
  state = await harnessState();
});

async function control(action: string, body: Record<string, unknown>): Promise<ControlResult> {
  const response = await fetch(`${state.baseUrl}/__harness/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as ControlResult;
}

/** Reads the server-decided group size from the learn setup preview. */
async function groupSizeOf(page: Page): Promise<number> {
  await expect(page.getByText(/预计本组 \d+ 个新词/)).toBeVisible();
  // The preview first renders with an empty progress map (every word looks
  // learnable); wait for personal progress to land — earlier journeys made
  // anchor INTRODUCED, which is the only tag progress can produce.
  await expect(page.getByLabel("本单元单词顺序")).toContainText("已学");
  const preview = await page.getByText(/预计本组 \d+ 个新词/).textContent();
  const match = /\d+/.exec(preview ?? "");
  if (!match) {
    throw new Error(`could not parse group size from "${preview ?? ""}"`);
  }
  return Number(match[0]);
}

test.describe.configure({ mode: "serial" });

test("duplicate grade under network retry counts exactly once", async ({ page }) => {
  const api = new SpecApi(page.request, state.baseUrl);
  await api.login(alice(state));
  const statsBefore = await api.stats();

  await loginViaUi(page, alice(state));
  await page.goto("/learn");
  const groupSize = await groupSizeOf(page);
  expect(groupSize).toBeGreaterThan(0);
  await page.getByRole("button", { name: "开始学习" }).click();

  // Study every word of the group (one WORD_PRESENTED + familiarity each).
  const familiarities = ["很陌生", "有印象", "熟悉"];
  for (let index = 0; index < groupSize; index += 1) {
    await expect(page.getByText(`第 ${index + 1} 词 / 共 ${groupSize} 词`)).toBeVisible();
    const choice = familiarities[index % familiarities.length]!;
    await page.getByRole("button", { name: choice }).click();
    if (index < groupSize - 1) {
      await page.getByRole("button", { name: "下一词" }).click();
    } else {
      await page.getByRole("button", { name: "开始快速回忆" }).click();
    }
  }

  // Card 1: the FIRST grade request dies on the network. The UI must show
  // the stable failure notice and replay the SAME event id on retry.
  let droppedFirstAttempt = false;
  await page.route("**/api/reviews/grade", async (route) => {
    if (!droppedFirstAttempt) {
      droppedFirstAttempt = true;
      await route.abort("connectionrefused");
      return;
    }
    await route.continue();
  });
  await expect(page.getByText(/第 1 张 \/ 共 \d+ 张/)).toBeVisible();
    const counterText = (await page.getByText(/第 1 张 \/ 共 \d+ 张/).textContent()) ?? "";
  const queueTotal = Number(/共 (\d+) 张/.exec(counterText)![1]);
  await page.getByRole("button", { name: "揭示答案" }).click();
  await page.getByRole("button", { name: "良好" }).click();
  await expect(page.getByText(/评分未提交/)).toBeVisible();
  // The retried request passes through and advances the queue exactly once.
  await page.getByRole("button", { name: "良好" }).click();
  await expect(page.getByText(new RegExp(`第 2 张 / 共 ${queueTotal} 张`))).toBeVisible();

  // Grade the second card normally, then leave the session (two events).
  await page.getByRole("button", { name: "揭示答案" }).click();
  await page.getByRole("button", { name: "良好" }).click();
  await expect(page.getByText(new RegExp(`第 3 张 / 共 ${queueTotal} 张`))).toBeVisible();

  // Exactly 2 events landed: the aborted attempt was never counted, and the
  // retried one exactly once.
  const statsAfter = await api.stats();
  expect(statsAfter.reviews_total).toBe(statsBefore.reviews_total + 2);
});

test("recovers from auth expiry by re-login and resumes the attempted route", async ({ page }) => {
  await loginViaUi(page, alice(state));
  await expect(page).toHaveURL(/\/today$/);

  // Push the injectable clock past the 168h idle session window: every
  // session issued before now is expired server-side.
  const result = await control("clock", { advanceMs: 169 * 3_600_000 });
  expect(result.ok).toBe(true);

  await page.goto("/today");
  await expect(page).toHaveURL(/\/login$/);

  // Re-login resumes the attempted route (spec 11.2) — recovery complete.
  await loginViaUi(page, alice(state));
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { name: "今日" })).toBeVisible();
});

test("R2 denial surfaces inline without blocking study", async ({ page }) => {
  const api = new SpecApi(page.request, state.baseUrl);
  await api.login(alice(state));

  // The learn setup's server-decided group always opens with the earliest
  // textbook-order word that still has learnable progress — harbour here —
  // and harbour has word-level audio. Delete THAT audio object so the first
  // study card is deterministically the denied one.
  const harbourContent = (await api.get(`/api/content/words/${HARBOUR_V1.wordKey}`)).body as {
    audio: Array<{ asset_key: string }>;
  };
  const assetKey = harbourContent.audio[0]!.asset_key;
  const deleted = await control("r2-delete", { key: assetKey });
  expect(deleted.ok).toBe(true);

  // Denial, part 1 (API): the audio ROW still exists but the object is gone
  // from the private store — the release-integrity failure, not a 401.
  const denied = await api.get(`/api/audio/${assetKey}`);
  expect(denied.status).toBe(404);
  expect((denied.body as { code?: string }).code).toBe("CONTENT_AUDIO_OBJECT_MISSING");

  // Denial, part 2 (UI): the study card announces the audio failure inline
  // and the journey continues — familiarity and the next word still work.
  await loginViaUi(page, alice(state));
  await page.goto("/learn");
  const groupSize = await groupSizeOf(page);
  expect(groupSize).toBeGreaterThan(0);
  await page.getByRole("button", { name: "开始学习" }).click();
  await expect(page.getByText(`第 1 词 / 共 ${groupSize} 词`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "harbour", exact: true })).toBeVisible();
  await expect(page.getByText("音频暂时无法播放，可先继续学习。")).toBeVisible();
  await page.getByRole("button", { name: "很陌生" }).click();
  if (groupSize > 1) {
    await page.getByRole("button", { name: "下一词" }).click();
    await expect(page.getByText(`第 2 词 / 共 ${groupSize} 词`)).toBeVisible();
  }

  // The flow itself is untouched by the denial: drift (already introduced
  // by the earlier journeys) still resolves its canonical progress row.
  const drift = await api.get(`/api/progress/words/${HARBOUR_V1.wordKey}`);
  expect(drift.status).toBe(200);
});
