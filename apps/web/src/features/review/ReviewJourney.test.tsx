/**
 * Task 17 journey-level tests for the review flow (spec 9.4): context cloze
 * by default with word-meaning fallback, reveal (answer, contextual meaning,
 * collapsible explanations), the four FSRS ratings with same-event replay,
 * latest-only undo, the full-entry round trip that keeps the review position,
 * the Space/1-4/Z/S desktop shortcuts, and audio failure that never blocks
 * the flow (spec 10).
 *
 * The fake server mirrors the real Worker: the REVIEW queue is due-ordered
 * and a SUBSET of the words' cards, so prompt alignment by position would be
 * visibly wrong — the client must derive prompts per card key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";
import { createApiClient } from "../../lib/api-client";
import { createAppQueryClient } from "../../lib/query-cache";
import { createAppRoutes } from "../../app/router";
import {
  K_W1_CONTEXT,
  K_W1_WORD,
  K_W2_WORD,
  createReviewServer,
} from "./review-fixtures";

function renderReview(
  stub: (url: string, init?: RequestInit) => Response | Promise<Response>,
  initialPath = "/review",
) {
  const api = createApiClient({
    fetchFn: async (url, init) => stub(String(url), init),
    baseUrl: "https://lexiloop.test",
    origin: "https://lexiloop.test",
    sleep: () => Promise.resolve(),
  });
  const queryClient = createAppQueryClient();
  const router = createMemoryRouter(createAppRoutes({ api, queryClient }), {
    initialEntries: [initialPath],
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, api, queryClient, router };
}

function gradeRequests(
  requests: { url: string; init?: RequestInit; body?: unknown }[],
): Array<Record<string, unknown>> {
  return requests
    .filter(
      ({ url, init }) => new URL(url).pathname === "/api/reviews/grade" && init?.method === "POST",
    )
    .map(({ body }) => body as Record<string, unknown>);
}

function undoRequests(requests: { url: string; init?: RequestInit }[]): string[] {
  return requests
    .filter(({ url, init }) => new URL(url).pathname.endsWith("/undo") && init?.method === "POST")
    .map(({ url }) => new URL(url).pathname);
}

function createdSessionCount(requests: { url: string; init?: RequestInit }[]): number {
  return requests.filter(
    ({ url, init }) =>
      new URL(url).pathname === "/api/study/sessions" && init?.method === "POST",
  ).length;
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("review journey", () => {
  it("starts a review: context cloze first, reveal with contextual meaning and collapsible explanations, then the ratings advance the server queue", async () => {
    const server = createReviewServer({ presetSessions: [] });
    const user = userEvent.setup();
    renderReview(server.stub);

    // IDLE: nothing is auto-created; the user starts explicitly.
    await screen.findByRole("heading", { name: "复习" });
    expect(screen.getByRole("button", { name: "开始复习" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "开始复习" }));

    // Card 1 is the due context card (spec 9.4 default): the exam sentence
    // with the target word blanked — NOT the headword prompt.
    await screen.findByText(/第 1 张 \/ 共 3 张/);
    expect(screen.getByText(/She ＿+ the plan\./)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "abandon" })).toBeNull();
    expect(screen.getByRole("link", { name: "查看完整词条" }).getAttribute("href")).toBe(
      "/dictionary/words/w-1",
    );

    // Reveal: answer, contextual meaning, original sentence, source, and the
    // collapsible explanation block.
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    expect(screen.getByText(/放弃（计划等）/)).toBeTruthy();
    expect(screen.getByText(/She abandoned the plan\./)).toBeTruthy();
    expect(screen.getByText(/2022 全国卷/)).toBeTruthy();
    const details = screen.getByText("查看讲解").closest("details");
    expect(details).toBeTruthy();
    expect(within(details as HTMLDetailsElement).getByText(/abandon 后接名词或动名词作宾语/)).toBeTruthy();
    expect(within(details as HTMLDetailsElement).getByText(/表示「放弃」/)).toBeTruthy();
    expect(within(details as HTMLDetailsElement).getByText(/拼写注意：只有一个 b/)).toBeTruthy();

    // Four rating controls; grading uses the server's presented card key.
    await user.click(screen.getByRole("button", { name: "再次" }));
    await screen.findByText(/第 2 张 \/ 共 3 张/);

    // Card 2 is ability's word-meaning card: headword prompt (the fallback
    // form when the card has no context), still in the server's due order.
    await screen.findByRole("heading", { name: "ability" });
    expect(screen.getByText("əˈbɪləti")).toBeTruthy();
    // Every card requires its own reveal before the rating (spec 5.7).
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await user.click(screen.getByRole("button", { name: "简单" }));
    await screen.findByText(/第 3 张 \/ 共 3 张/);
    await screen.findByRole("heading", { name: "abandon" });
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await user.click(screen.getByRole("button", { name: "困难" }));

    // Queue complete.
    await screen.findByText("本次复习已完成");

    const grades = gradeRequests(server.requests);
    expect(grades).toHaveLength(3);
    expect(grades.map((grade) => grade.card_key)).toEqual([
      K_W1_CONTEXT,
      K_W2_WORD,
      K_W1_WORD,
    ]);
    expect(grades.map((grade) => grade.rating)).toEqual([1, 4, 2]);
    for (const grade of grades) {
      expect(grade.session_id).toBe("sess-review-created-1");
      expect(typeof grade.event_id).toBe("string");
      expect(grade.duration_ms).toBeGreaterThanOrEqual(0);
    }
    expect(server.state.positionOf("sess-review-created-1")).toBe(3);
  });

  it("falls back to the word-meaning prompt for a card whose word has no qualified context", async () => {
    // The queue holds ONLY ability's word-meaning card (w-2 has no context
    // card): the prompt must be the headword, not a sentence.
    const server = createReviewServer({ presetSessions: [], queueKeys: [K_W2_WORD] });
    const user = userEvent.setup();
    renderReview(server.stub);
    await screen.findByRole("heading", { name: "复习" });
    await user.click(screen.getByRole("button", { name: "开始复习" }));

    await screen.findByRole("heading", { name: "ability" });
    expect(screen.queryByText(/＿/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    // Word-meaning answer: the core senses.
    expect(screen.getByText(/能力；才能/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "良好" }));
    await screen.findByText("本次复习已完成");
  });

  it("undoes only the latest grade, rewinds to the undone card, and surfaces a rejection when the worker refuses", async () => {
    const server = createReviewServer({ presetSessions: ["sess-review-1"] });
    const user = userEvent.setup();
    renderReview(server.stub);

    // Auto-resume: the preset session continues at its server position —
    // no new session is created.
    await screen.findByText(/第 1 张 \/ 共 3 张/);
    expect(createdSessionCount(server.requests)).toBe(0);

    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await user.click(screen.getByRole("button", { name: "良好" }));
    await screen.findByText(/第 2 张 \/ 共 3 张/);

    // Latest-only undo: the client undoes ITS latest successful grade.
    await user.click(screen.getByRole("button", { name: "撤销上次评分" }));
    await screen.findByText(/第 1 张 \/ 共 3 张/);
    expect(server.state.positionOf("sess-review-1")).toBe(0);
    const undoneEventId = server.state.events()[0]?.eventId;
    expect(undoneEventId).toBeTruthy();
    expect(undoRequests(server.requests)).toEqual([`/api/reviews/${undoneEventId}/undo`]);
    // The undone card is current again, in the question phase, and the undo
    // control is gone until the next grade.
    expect(screen.getByText(/She ＿+ the plan\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "撤销上次评分" })).toBeNull();

    // Grading again creates a NEW event; the undone event is never replayed.
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await user.click(screen.getByRole("button", { name: "困难" }));
    await screen.findByText(/第 2 张 \/ 共 3 张/);
    const grades = gradeRequests(server.requests);
    expect(grades).toHaveLength(2);
    expect(grades[0]?.event_id).not.toBe(grades[1]?.event_id);
    const events = server.state.events();
    expect(events).toHaveLength(2);

    // A worker rejection (latest-only violation) surfaces on the card
    // without discarding the position.
    server.rejectNextUndoOnce("REVIEW_UNDO_NOT_LATEST");
    await user.click(screen.getByRole("button", { name: "撤销上次评分" }));
    await screen.findByText(/撤销失败/);
    expect(screen.getByText(/第 2 张 \/ 共 3 张/)).toBeTruthy();
    // Exactly two undo posts were made: the successful rewind and the
    // rejected attempt; only the first event stays undone.
    expect(undoRequests(server.requests)).toEqual([
      `/api/reviews/${events[0]?.eventId}/undo`,
      `/api/reviews/${events[1]?.eventId}/undo`,
    ]);
    expect(events.map((event) => event.undoneAt)).toEqual([1_700_000_000_000, null]);
  });

  it("keeps the review position through the full word entry round trip", async () => {
    const server = createReviewServer({ presetSessions: ["sess-review-1"] });
    const user = userEvent.setup();
    const { router } = renderReview(server.stub);

    await screen.findByText(/第 1 张 \/ 共 3 张/);
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await user.click(screen.getByRole("button", { name: "良好" }));
    await screen.findByText(/第 2 张 \/ 共 3 张/);

    // Open the full entry of the current card's word.
    await user.click(screen.getByRole("link", { name: "查看完整词条" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/dictionary/words/w-2");
    });
    await screen.findByRole("heading", { name: "ability" });

    // Return to the review: the session resumes from the server at the SAME
    // position without creating a session.
    const bottomNav = screen.getByRole("navigation", { name: "主导航" });
    await user.click(within(bottomNav).getByRole("link", { name: "复习" }));
    await screen.findByText(/第 2 张 \/ 共 3 张/);
    await screen.findByRole("heading", { name: "ability" });
    expect(createdSessionCount(server.requests)).toBe(0);
  });

  it("drives the journey with the Space/1-4/Z/S desktop shortcuts", async () => {
    const server = createReviewServer({ presetSessions: ["sess-review-1"] });
    const created: string[] = [];
    class RecordingAudio {
      src: string;
      constructor(src: string) {
        this.src = src;
        created.push(src);
      }
      play() {
        return Promise.resolve();
      }
      pause() {}
    }
    vi.stubGlobal("Audio", RecordingAudio);

    const user = userEvent.setup();
    renderReview(server.stub);
    await screen.findByText(/第 1 张 \/ 共 3 张/);

    // Space reveals, 1-4 rate, Z undoes, S plays the word audio.
    await user.keyboard(" ");
    await screen.findByText(/放弃（计划等）/);
    await user.keyboard("4");
    await screen.findByText(/第 2 张 \/ 共 3 张/);

    await user.keyboard("s");
    await waitFor(() => {
      expect(created.some((src) => src.includes("audio/ab/abc333.wav"))).toBe(true);
    });

    await user.keyboard("z");
    await screen.findByText(/第 1 张 \/ 共 3 张/);
    expect(server.state.positionOf("sess-review-1")).toBe(0);
    const grades = gradeRequests(server.requests);
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({ card_key: K_W1_CONTEXT, rating: 4 });
  });

  it("passes an axe audit in the revealed state", async () => {
    const { container } = renderReview(createReviewServer({ presetSessions: ["sess-review-1"] }).stub);
    await screen.findByText(/第 1 张 \/ 共 3 张/);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await screen.findByText(/放弃（计划等）/);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("retries a failed grade with the SAME event id and never generates a second one", async () => {
    const server = createReviewServer({ presetSessions: ["sess-review-1"], failNextGradeOnce: true });
    const user = userEvent.setup();
    renderReview(server.stub);

    await screen.findByText(/第 1 张 \/ 共 3 张/);
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await user.click(screen.getByRole("button", { name: "良好" }));
    await screen.findByText(/评分未提交/);

    await user.click(screen.getByRole("button", { name: "良好" }));
    await screen.findByText(/第 2 张 \/ 共 3 张/);

    const grades = gradeRequests(server.requests);
    expect(grades).toHaveLength(2);
    expect(grades[0]?.event_id).toBe(grades[1]?.event_id);
    expect(server.state.positionOf("sess-review-1")).toBe(1);
  });

  it("plays failing audio inline without blocking the review", async () => {
    const server = createReviewServer({ presetSessions: ["sess-review-1"] });
    class FailingAudio {
      src: string;
      constructor(src: string) {
        this.src = src;
      }
      play() {
        return Promise.reject(new Error("no decoder"));
      }
      pause() {}
    }
    vi.stubGlobal("Audio", FailingAudio);
    const user = userEvent.setup();
    renderReview(server.stub);

    await screen.findByText(/第 1 张 \/ 共 3 张/);
    await user.click(screen.getByRole("button", { name: "播放读音" }));
    await screen.findByText("音频暂时无法播放，可先继续学习。");

    // The failure never blocks reading: reveal still works.
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await screen.findByText(/放弃（计划等）/);
  });

  it("reports an empty due queue instead of creating a doomed session", async () => {
    const server = createReviewServer({ presetSessions: [], emptyQueue: true });
    const user = userEvent.setup();
    renderReview(server.stub);
    await screen.findByRole("heading", { name: "复习" });
    await user.click(screen.getByRole("button", { name: "开始复习" }));
    await screen.findByText("当前没有到期的复习卡。");
    expect(screen.queryByText(/第 1 张/)).toBeNull();
  });
});
