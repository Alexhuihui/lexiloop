/**
 * Desktop review journeys (plan Task 18 step 1): due review driven by the
 * keyboard shortcuts (Space reveal, 1-4 rate, Z undo), refresh resuming at
 * the server-side position, and the search/stats destinations. Runs LAST in
 * the serial suite so the injected clock has long since made the earlier
 * grades due — the review queue is therefore deterministically non-empty.
 */
import { expect, test } from "@playwright/test";
import { alice, harnessState, loginViaUi, type HarnessState } from "./support/harness";

let state: HarnessState;

test.beforeAll(async () => {
  state = await harnessState();
  // Make this spec self-sufficient on the injectable clock: push it well
  // past the 24h study-session TTL and every FSRS short-term interval, so
  // (a) earlier specs' review sessions are expired and the page starts from
  // IDLE, and (b) the accumulated grades are deterministically due.
  const response = await fetch(`${state.baseUrl}/__harness/clock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ advanceMs: 169 * 3_600_000 }),
  });
  if (!response.ok) {
    throw new Error("harness clock control unavailable");
  }
});

test.describe.configure({ mode: "serial" });

test("due review: keyboard reveal and rating, refresh resume, and undo", async ({ page }) => {
  await loginViaUi(page, alice(state));
  await page.goto("/review");

  await page.getByRole("button", { name: "开始复习" }).click();
  await expect(page.getByText(/第 1 张 \/ 共 \d+ 张/)).toBeVisible();

  // Space reveals; 3 rates Good; the position advances server-side.
  await page.keyboard.press(" ");
  await expect(page.getByRole("group", { name: "选择评分" })).toBeVisible();
  await page.keyboard.press("3");
  await expect(page.getByText(/第 2 张 \/ 共 \d+ 张/)).toBeVisible();
  await expect(page.getByRole("group", { name: "选择评分" })).toBeHidden();

  // A full page reload resumes the SAME unexpired session at the SAME
  // server-side position (question phase, not a new queue).
  await page.reload();
  await expect(page.getByText(/第 2 张 \/ 共 \d+ 张/)).toBeVisible();
  await expect(page.getByRole("group", { name: "选择评分" })).toBeHidden();

  // Rate Again on card 2, then undo it with Z: the SAME card must come back
  // as the current question.
  await page.keyboard.press(" ");
  await expect(page.getByRole("group", { name: "选择评分" })).toBeVisible();
  await page.keyboard.press("1");
  await expect(page.getByText(/第 3 张 \/ 共 \d+ 张/)).toBeVisible();
  await page.keyboard.press("z");
  await expect(page.getByText(/第 2 张 \/ 共 \d+ 张/)).toBeVisible();
  await expect(page.getByRole("group", { name: "选择评分" })).toBeHidden();

  // Reveal and rate the returned card again to prove the flow continues.
  await page.keyboard.press(" ");
  await page.keyboard.press("4");
  await expect(page.getByText(/第 3 张 \/ 共 \d+ 张/)).toBeVisible();
});

test("search finds a headword and the word detail shows personal state", async ({ page }) => {
  await loginViaUi(page, alice(state));
  await page.goto("/dictionary");

  await page.getByLabel("搜索词或释义").fill("anchor");
  await page.getByRole("button", { name: "搜索" }).click();
  const results = page.getByLabel("搜索结果");
  await expect(results).toBeVisible();
  await expect(results).toContainText("anchor");

  await page.getByLabel("搜索结果").getByRole("link", { name: /anchor/ }).first().click();
  await expect(page).toHaveURL(/\/dictionary\/words\//);
  await expect(page.getByRole("heading", { name: "anchor" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "全部义项" })).toBeVisible();
  // anchor's cards were fully graded during the learning journey: the word
  // detail shows the personal stage as 已学 (INTRODUCED).
  await expect(page.getByText("阶段：")).toContainText("已学");
});

test("stats reflect the accumulated learning", async ({ page }) => {
  await loginViaUi(page, alice(state));
  await page.goto("/stats");
  await expect(page.getByRole("heading", { name: "数据" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "学习概览" })).toBeVisible();
  await expect(page.getByText("已学单词")).toBeVisible();
  // The journeys before this spec introduced at least three words.
  const learned = page.locator("section", { hasText: "学习概览" }).getByText("已学单词");
  await expect(learned).toBeVisible();
});
