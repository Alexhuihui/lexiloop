/**
 * Task 16 journey-level tests for the complete new-word learning flow
 * (spec 9.3): the SETUP -> STUDY_WORDS -> QUICK_RECALL_QUESTION ->
 * QUICK_RECALL_REVEALED -> COMPLETE state machine, persisted ONLY through
 * the Worker Session APIs.
 *
 * Binding behaviors under test:
 * - one stable WORD_PRESENTED event per visible word, acknowledged BEFORE
 *   familiarity controls enable; same event ID on retry after a failure;
 * - FAMILIARITY_SET is changeable while the word is current and NEVER calls
 *   the grade endpoint (no FSRS write from familiarity);
 * - grades happen only AFTER the quick-recall reveal, one rating per card,
 *   and next-card navigation is disabled while the grade request is pending,
 *   with the SAME event_id replayed after a network failure;
 * - content and audio failures are shown without discarding the position;
 * - the deferred presentation of a non-current word (the Worker only accepts
 *   patches for the current queue item's word) is retried with the same
 *   event ID once grading advances the position;
 * - an interrupted session resumes through GET Session APIs without creating
 *   a new session;
 * - the final grade completes the group and the UI reflects the server-side
 *   word introduction.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { createApiClient } from "../../lib/api-client";
import { createAppQueryClient } from "../../lib/query-cache";
import { createAppRoutes } from "../../app/router";
import { createFakeServer, QUEUE } from "./learn-fixtures";

function renderLearn(stub: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const api = createApiClient({
    fetchFn: async (url, init) => stub(String(url), init),
    baseUrl: "https://lexiloop.test",
    origin: "https://lexiloop.test",
    sleep: () => Promise.resolve(),
  });
  const queryClient = createAppQueryClient();
  const router = createMemoryRouter(createAppRoutes({ api, queryClient }), {
    initialEntries: ["/learn"],
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, api, queryClient, router };
}

async function startSession(): Promise<void> {
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "学习" });
  await user.click(screen.getByRole("button", { name: "开始学习" }));
  await screen.findByText(/第 1 词 \/ 共 2 词/);
}

function gradeRequests(
  requests: { url: string; init?: RequestInit; body?: unknown }[],
): Array<Record<string, unknown>> {
  return requests
    .filter(({ url, init }) => new URL(url).pathname === "/api/reviews/grade" && init?.method === "POST")
    .map(({ body }) => body as Record<string, unknown>);
}

function patchRequests(
  requests: { url: string; init?: RequestInit; body?: unknown }[],
): Array<Record<string, unknown>> {
  return requests
    .filter(
      ({ url, init }) =>
        new URL(url).pathname.startsWith("/api/study/sessions/") && init?.method === "PATCH",
    )
    .map(({ body }) => body as Record<string, unknown>);
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  cleanup();
});

describe("new-word learning journey", () => {
  it("runs the full journey: familiarity for every studied word without grades, multi-card quick recall in queue order, reveal before rating, and group completion", async () => {
    const server = createFakeServer();
    const user = userEvent.setup();
    renderLearn(server.stub);
    await startSession();

    // --- STUDY_WORDS: word 1's presentation acks and enables familiarity.
    await screen.findByRole("heading", { name: "abandon" });
    expect(screen.getByText("əˈbændən")).toBeTruthy();
    expect(screen.getByText(/放弃；抛弃/)).toBeTruthy();
    expect(screen.getByText(/abandon the plan/)).toBeTruthy();
    expect(screen.getByText(/She abandoned the plan\./)).toBeTruthy();
    expect(screen.getByText(/真题/)).toBeTruthy();

    // Familiarity controls wait for the WORD_PRESENTED acknowledgement.
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "很陌生" }) as HTMLButtonElement).disabled).toBe(false);
    });
    const presents = patchRequests(server.requests);
    expect(presents).toHaveLength(1);
    expect(presents[0]).toMatchObject({ action: "WORD_PRESENTED", word_key: "w-1" });

    // Three familiarity choices exist; a choice (and a change) never grades.
    await user.click(screen.getByRole("button", { name: "有印象" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "有印象" }).getAttribute("aria-pressed")).toBe("true");
    });
    await user.click(screen.getByRole("button", { name: "熟悉" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "熟悉" }).getAttribute("aria-pressed")).toBe("true");
    });
    expect(screen.getByRole("button", { name: "很陌生" })).toBeTruthy();
    expect(gradeRequests(server.requests)).toHaveLength(0);
    const familiarity = patchRequests(server.requests).slice(1);
    expect(familiarity).toHaveLength(2);
    expect(familiarity[0]).toMatchObject({
      action: "FAMILIARITY_SET",
      word_key: "w-1",
      familiarity: "SOMEWHAT_FAMILIAR",
    });
    expect(familiarity[1]).toMatchObject({
      action: "FAMILIARITY_SET",
      word_key: "w-1",
      familiarity: "FAMILIAR",
    });
    // Every familiarity change is its own event.
    expect(new Set(familiarity.map((patch) => patch.event_id)).size).toBe(2);

    // --- Word 2 becomes visible: presentation and familiarity reach the
    // server for EVERY group word (spec 9.3 membership validation), still
    // without any grade call.
    await user.click(screen.getByRole("button", { name: "下一词" }));
    await screen.findByRole("heading", { name: "ability" });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "很陌生" }) as HTMLButtonElement).disabled).toBe(false);
    });
    const presentations = patchRequests(server.requests).filter(
      (patch) => patch.action === "WORD_PRESENTED",
    );
    expect(presentations).toHaveLength(2);
    expect(presentations[1]).toMatchObject({ action: "WORD_PRESENTED", word_key: "w-2" });
    expect(server.state.progressOf("w-2")).toMatchObject({ stage: "IN_PROGRESS" });
    await user.click(screen.getByRole("button", { name: "有印象" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "有印象" }).getAttribute("aria-pressed")).toBe("true");
    });
    expect(gradeRequests(server.requests)).toHaveLength(0);

    // --- QUICK_RECALL: five cards in the server's snapshot order.
    await user.click(screen.getByRole("button", { name: "开始快速回忆" }));
    expect(screen.getByText(/第 1 张 \/ 共 5 张/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "abandon" })).toBeTruthy();
    // Reveal gates the rating: no rating buttons and no grade calls yet.
    expect(screen.queryByRole("button", { name: "良好" })).toBeNull();
    expect(gradeRequests(server.requests)).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    expect(screen.getByText(/放弃；抛弃/)).toBeTruthy();
    expect(screen.getByText(/选择评分/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "良好" }));
    // The grade advances the session position server-side; the client
    // re-reads the session before enabling the next card.
    await screen.findByText(/第 2 张 \/ 共 5 张/);
    const grades = gradeRequests(server.requests);
    expect(grades).toHaveLength(1);
    expect(grades[0]).toMatchObject({
      session_id: "sess-created-1",
      card_key: QUEUE[0],
      rating: 3,
    });
    // Nothing is left to sync: every group word presented during study.
    expect(
      patchRequests(server.requests).filter((patch) => patch.action === "WORD_PRESENTED"),
    ).toHaveLength(2);
    expect(server.state.positionOf("sess-created-1")).toBe(1);

    // Card 2 in the same deterministic order, then the CONTEXT_MEANING card
    // shows the exam sentence with the target blanked.
    expect(screen.getByRole("heading", { name: "ability" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await user.click(screen.getByRole("button", { name: "简单" }));
    await screen.findByText(/第 3 张 \/ 共 5 张/);
    expect(screen.getByText(/She ＿+ the plan\./)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    expect(screen.getByText(/放弃（计划等）/)).toBeTruthy();
    expect(screen.getByText(/2022 全国卷/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "良好" }));
    await screen.findByText(/第 4 张 \/ 共 5 张/);
    expect(screen.getByText("abandon the plan")).toBeTruthy(); // PHRASE card

    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    expect(screen.getByText(/放弃计划/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "良好" }));
    await screen.findByText(/第 5 张 \/ 共 5 张/);
    // The SENSE_DISCRIMINATION card prompts with the confusable counterpart.
    expect(screen.getByText(/辨析：abandon 与 ability/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    expect(screen.getByText(/ability 指做某事的能力/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "良好" }));

    // --- COMPLETE: the advanced position and the server-side introduction
    // of the final word are visible.
    await screen.findByText(/本组学习完成/);
    expect(gradeRequests(server.requests)).toHaveLength(5);
    expect(server.state.positionOf("sess-created-1")).toBe(5);
    expect(await screen.findByText(/已引入 2 \/ 2 个单词/)).toBeTruthy();
    const creates = server.requests.filter(
      ({ url, init }) =>
        new URL(url).pathname === "/api/study/sessions" && init?.method === "POST",
    );
    expect(creates).toHaveLength(1); // the whole group ran on one session
  });

  it("keeps rating disabled while the grade request is pending and only advances after it resolves", async () => {
    const server = createFakeServer({ holdGrades: true });
    const user = userEvent.setup();
    renderLearn(server.stub);
    await startSession();
    await screen.findByRole("button", { name: "很陌生" });
    await user.click(screen.getByRole("button", { name: "下一词" }));
    await screen.findByRole("heading", { name: "ability" });
    await user.click(screen.getByRole("button", { name: "开始快速回忆" }));
    await user.click(screen.getByRole("button", { name: "揭示答案" }));

    await user.click(screen.getByRole("button", { name: "良好" }));
    // Pending: every rating control is disabled, the card does not advance.
    expect((screen.getByRole("button", { name: "良好" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "再次" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/第 2 张/)).toBeNull();

    server.resolveGrade();
    await screen.findByText(/第 2 张 \/ 共 5 张/);
    expect(server.state.positionOf("sess-created-1")).toBe(1);
  });

  it("replays the SAME grade event_id after a network failure instead of generating a new one", async () => {
    const server = createFakeServer({ failNextGradeOnce: true });
    const user = userEvent.setup();
    renderLearn(server.stub);
    await startSession();
    await screen.findByRole("button", { name: "很陌生" });
    await user.click(screen.getByRole("button", { name: "下一词" }));
    await screen.findByRole("heading", { name: "ability" });
    await user.click(screen.getByRole("button", { name: "开始快速回忆" }));
    await user.click(screen.getByRole("button", { name: "揭示答案" }));

    await user.click(screen.getByRole("button", { name: "困难" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("评分未提交");
    // The failure must not discard the position: still on revealed card 1.
    expect(screen.getByText(/第 1 张 \/ 共 5 张/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "困难" }));
    await screen.findByText(/第 2 张 \/ 共 5 张/);
    const grades = gradeRequests(server.requests);
    expect(grades).toHaveLength(2);
    expect(grades[0]?.event_id).toBeTruthy();
    expect(grades[0]?.event_id).toBe(grades[1]?.event_id);
    expect(grades[1]).toMatchObject({ card_key: QUEUE[0], rating: 2 });
  });

  it("retries a failed WORD_PRESENTED with the same event id before enabling familiarity", async () => {
    const server = createFakeServer({ failNextPatchOnce: true });
    const user = userEvent.setup();
    renderLearn(server.stub);
    await startSession();
    await screen.findByRole("heading", { name: "abandon" });

    // The presentation patch failed: familiarity stays disabled with a retry.
    await screen.findByRole("button", { name: /重试学习记录/ });
    expect((screen.getByRole("button", { name: "很陌生" }) as HTMLButtonElement).disabled).toBe(true);
    const failed = patchRequests(server.requests);
    expect(failed).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /重试学习记录/ }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "很陌生" }) as HTMLButtonElement).disabled).toBe(false);
    });
    const retries = patchRequests(server.requests);
    expect(retries).toHaveLength(2);
    expect(retries[0]?.event_id).toBe(retries[1]?.event_id);
    expect(server.state.progressOf("w-1")).toMatchObject({ stage: "IN_PROGRESS" });
  });

  it("keeps a failed presentation recoverable from the recall view until it is recorded", async () => {
    const server = createFakeServer();
    const user = userEvent.setup();
    renderLearn(server.stub);
    await startSession();
    await screen.findByRole("button", { name: "很陌生" });

    // Word 2's presentation fails with a network error during study; the
    // user moves on to quick recall with the word unrecorded.
    server.failNextPatch();
    await user.click(screen.getByRole("button", { name: "下一词" }));
    await screen.findByRole("heading", { name: "ability" });
    await screen.findByRole("button", { name: /重试学习记录/ });

    // The recall-time sync retries the failed word — and fails too — but
    // grading continues and the retry control surfaces in the recall view.
    server.failNextPatch();
    await user.click(screen.getByRole("button", { name: "开始快速回忆" }));
    await user.click(screen.getByRole("button", { name: "揭示答案" }));
    await user.click(screen.getByRole("button", { name: "良好" }));
    await screen.findByText(/第 2 张 \/ 共 5 张/);
    const recallRetry = await screen.findByRole("button", { name: /重试学习记录/ });
    expect(screen.getByText(/学习记录未提交/)).toBeTruthy();
    expect(server.state.progressOf("w-2")).toBeNull();

    // A later successful retry presents the word with the SAME event id.
    await user.click(recallRetry);
    await waitFor(() => {
      expect(server.state.progressOf("w-2")).toMatchObject({ stage: "IN_PROGRESS" });
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /重试学习记录/ })).toBeNull();
    });
    const w2Patches = patchRequests(server.requests).filter(
      (patch) => patch.action === "WORD_PRESENTED" && patch.word_key === "w-2",
    );
    expect(w2Patches).toHaveLength(3); // study fail, sync fail, final success
    expect(new Set(w2Patches.map((patch) => patch.event_id)).size).toBe(1);
  });

  it("shows word-content failures without discarding the position and recovers on retry", async () => {
    const server = createFakeServer({ failNextWordContentOnce: true });
    const user = userEvent.setup();
    renderLearn(server.stub);
    await startSession();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("词条内容");
    // Position intact: the study card is still word 1 of 2.
    expect(screen.getByText(/第 1 词 \/ 共 2 词/)).toBeTruthy();
    // Familiarity waits for the content and the presentation ack: all three
    // choices stay disabled.
    for (const name of ["很陌生", "有印象", "熟悉"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }

    await user.click(screen.getByRole("button", { name: /重试加载/ }));
    await screen.findByRole("heading", { name: "abandon" });
    await waitFor(() => {
      expect((screen.getByRole("button", { name: "很陌生" }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("renders study audio from the session-pinned asset URL and shows playback failure without leaving the card", async () => {
    const server = createFakeServer();
    renderLearn(server.stub);
    await startSession();

    const audio = (await screen.findByRole("heading", { name: "abandon" }))
      .closest("article")
      ?.querySelector("audio");
    expect(audio).toBeTruthy();
    const src = audio?.getAttribute("src") ?? "";
    expect(src).toContain("/api/audio/");
    expect(src).toContain("session=sess-created-1");

    fireEvent.error(audio!);
    expect(await screen.findByText(/音频暂时无法播放/)).toBeTruthy();
    // Position intact: still studying word 1 of 2 with the content visible.
    expect(screen.getByText(/第 1 词 \/ 共 2 词/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "abandon" })).toBeTruthy();
  });

  it("offers the session-pinned audio beside each real-exam sentence", async () => {
    const server = createFakeServer();
    renderLearn(server.stub);
    await startSession();

    const button = await screen.findByRole("button", { name: "播放真题句音频" });
    const example = button.closest("li");
    const audio = example?.querySelector("audio");
    expect(audio).toBeTruthy();
    expect(audio?.getAttribute("src")).toContain("audio/ex/def222.wav");
    expect(audio?.getAttribute("src")).toContain("session=sess-created-1");
  });

  it("resumes an interrupted session through the Session APIs without re-presenting studied words", async () => {
    const server = createFakeServer();
    const user = userEvent.setup();

    // First visit: present word 1, then the session is "interrupted".
    const first = renderLearn(server.stub);
    await startSession();
    await screen.findByRole("button", { name: "很陌生" });
    first.unmount();

    // Second visit: the setup offers the interrupted session.
    renderLearn(server.stub);
    await screen.findByRole("heading", { name: "学习" });
    await user.click(await screen.findByRole("button", { name: /继续上次学习/ }));

    // Study resumes at word 2 (word 1 is already presented server-side).
    await screen.findByText(/第 2 词 \/ 共 2 词/);
    expect(screen.getByRole("heading", { name: "ability" })).toBeTruthy();
    const patchBodies = patchRequests(server.requests);
    expect(patchBodies.every((patch) => patch.word_key !== "w-1" || patch.action === "WORD_PRESENTED")).toBe(
      true,
    );
    expect(
      patchBodies.filter((patch) => patch.word_key === "w-1"),
    ).toHaveLength(1); // exactly the original first-visit presentation
    const creates = server.requests.filter(
      ({ url, init }) =>
        new URL(url).pathname === "/api/study/sessions" && init?.method === "POST",
    );
    expect(creates).toHaveLength(1); // only the first visit created a session
  });
});
