/**
 * Mobile learning journey (plan Task 18 step 1): on a phone viewport the
 * bottom navigation is the shell; a learner previews the textbook group,
 * studies each word, records first-contact familiarity, then grades the
 * session queue in the SERVER's fixed order through quick recall — the
 * first rating included — and lands on the completion summary with every
 * studied word introduced.
 *
 * Deliberate app behavior under test: the setup page previews a tier-
 * filtered group, but the FIXED queue is always the server's decision
 * (spec 9.3: the client never reshuffles) — with the schema-default group
 * size that is the whole unit (14 cards), so the recall prompts degrade to
 * generic ones for cards beyond the studied preview's derivable model. The
 * journey follows the app, not the preview.
 */
import { expect, test } from "@playwright/test";
import { alice, harnessState, loginViaUi, SpecApi, type HarnessState } from "./support/harness";

test.use({ viewport: { width: 390, height: 844 } });

let state: HarnessState;

test.beforeAll(async () => {
  state = await harnessState();
});

test.describe.configure({ mode: "serial" });

test("mobile shell shows the bottom navigation and hides the sidebar", async ({ page }) => {
  await loginViaUi(page, alice(state));
  const bottomNav = page.getByRole("navigation", { name: "主导航" });
  const sideNav = page.getByRole("navigation", { name: "侧边导航" });
  await expect(bottomNav).toBeVisible();
  await expect(sideNav).toBeHidden();
});

test("quick recall and the first rating introduce the studied group", async ({ page }) => {
  const api = new SpecApi(page.request, state.baseUrl);
  await api.login(alice(state));
  const statsBefore = await api.stats();

  await loginViaUi(page, alice(state));
  await page.goto("/learn");

  // Setup: the textbook order comes from the active synthetic release. The
  // tier filter shapes the client PREVIEW (3 CORE words).
  await expect(page.getByRole("heading", { name: "学习", exact: true })).toBeVisible();
  await page.getByLabel("选择分层").selectOption("CORE");
  await expect(page.getByText("预计本组 3 个新词")).toBeVisible();
  const wordOrder = page.getByLabel("本单元单词顺序");
  await expect(wordOrder).toContainText("anchor");
  await expect(wordOrder).toContainText("harbour");
  await expect(wordOrder).toContainText("voyage");

  await page.getByRole("button", { name: "开始学习" }).click();

  // Study each preview word: content loads, one WORD_PRESENTED lands, then
  // the first-contact familiarity is recorded (never a grade).
  const familiarities = ["很陌生", "有印象", "熟悉"];
  for (let index = 0; index < 3; index += 1) {
    await expect(page.getByText(`第 ${index + 1} 词 / 共 3 词`)).toBeVisible();
    await expect(page.getByRole("heading", { name: /anchor|harbour|voyage/ })).toBeVisible();
    const choice = familiarities[index]!;
    await page.getByRole("button", { name: choice }).click();
    await expect(page.getByRole("button", { name: choice })).toHaveAttribute("aria-pressed", "true");
    if (index < 2) {
      await page.getByRole("button", { name: "下一词" }).click();
    } else {
      await page.getByRole("button", { name: "开始快速回忆" }).click();
    }
  }

  // Quick recall: the SERVER's queue is the whole unit — 14 cards (7 words,
  // one WORD_MEANING + one PHRASE each) — in the fixed order. Reveal and
  // rate every card; the FIRST rating (再次 on card 1) is this group's
  // first grade.
  for (let card = 1; card <= 14; card += 1) {
    await expect(page.getByText(`第 ${card} 张 / 共 14 张`)).toBeVisible();
    await page.getByRole("button", { name: "揭示答案" }).click();
    await expect(page.getByRole("group", { name: "选择评分" })).toBeVisible();
    await page.getByRole("button", { name: "再次" }).click();
  }

  // Completion: every STUDIED word is INTRODUCED server-side. The summary
  // reads progress through the alias-resolving endpoint, so harbour's row is
  // found under its canonical v2 word key (the rename alias): 3/3. Stats are
  // canonical-keyed, so learned_words counts all three as well.
  await expect(page.getByRole("heading", { name: "本组学习完成" })).toBeVisible();
  await expect(page.getByText("已引入 3 / 3 个单词")).toBeVisible();

  const statsAfter = await api.stats();
  expect(statsAfter.reviews_total).toBe(statsBefore.reviews_total + 14);
  expect(statsAfter.learned_words).toBeGreaterThanOrEqual(3);

  // Back to today from the completion view.
  await page.getByRole("link", { name: "回到今日" }).click();
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { name: "今日" })).toBeVisible();
});
