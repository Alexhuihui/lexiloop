/**
 * Task 16 journey-level tests for the Today page (spec 9.2): due review and
 * textbook new words shown separately, due review recommended but not forced,
 * streak, current Unit progress, and resumable sessions (including the
 * supplemental 待引入卡 quick-test count) rendered from the Worker contracts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";
import { createApiClient } from "../../lib/api-client";
import { createAppQueryClient } from "../../lib/query-cache";
import { createAppRoutes } from "../../app/router";

const ME_OK = {
  user: { user_id: "u-1", username: "alice", status: "ACTIVE" },
  session: { expires_at: 4_102_444_800_000 },
  settings: {
    start_unit_key: "u-1",
    new_words_per_group: 2,
    daily_goal: 10,
    timezone: "Asia/Shanghai",
  },
  csrf_token: "csrf-token-1",
};

const STATS_OK = {
  learned_words: 21,
  learned_cards: 34,
  estimated_retention: 0.91,
  reviews_today: 5,
  reviews_total: 210,
  streak_days: 6,
  due_forecast: [
    { date: "2026-09-11", cards: 4 },
    { date: "2026-09-12", cards: 2 },
  ],
  difficult_words: [],
  units: [
    {
      unit_key: "u-1",
      title: "Unit 1",
      total_cards: 8,
      studied_cards: 2,
      coverage: 0.25,
      estimated_retention: null,
    },
  ],
};

const SESSION_NEW = {
  session_id: "sess-new-1",
  mode: "NEW_WORDS",
  release_id: "rel-1",
  position: 1,
  created_at: 1_700_000_000_000,
  expires_at: 4_102_444_800_000,
  cards: [
    { canonical_card_key: "k-wm-1", presented_card_key: "k-wm-1" },
    { canonical_card_key: "k-wm-2", presented_card_key: "k-wm-2" },
    { canonical_card_key: "k-cm-1", presented_card_key: "k-cm-1" },
  ],
  current_card_key: "k-wm-2",
  unit_keys: ["u-1"],
  word_keys: ["w-1", "w-2"],
};

const SESSION_SUPPLEMENTAL = {
  session_id: "sess-qt-1",
  mode: "QUICK_TEST",
  release_id: "rel-1",
  position: 0,
  created_at: 1_700_000_000_000,
  expires_at: 4_102_444_800_000,
  cards: [
    { canonical_card_key: "k-sd-6", presented_card_key: "k-sd-6" },
    { canonical_card_key: "k-ph-5", presented_card_key: "k-ph-5" },
  ],
  current_card_key: "k-sd-6",
  unit_keys: ["u-1"],
  word_keys: ["w-1"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Stub = (url: string, init?: RequestInit) => Response;

function renderToday(stub: Stub) {
  const requests: { url: string; init?: RequestInit }[] = [];
  const api = createApiClient({
    fetchFn: async (url, init) => {
      requests.push({ url: String(url), init });
      return stub(String(url), init);
    },
    baseUrl: "https://lexiloop.test",
    origin: "https://lexiloop.test",
    sleep: () => Promise.resolve(),
  });
  const queryClient = createAppQueryClient();
  const router = createMemoryRouter(createAppRoutes({ api, queryClient }), {
    initialEntries: ["/today"],
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, api, queryClient, router, requests };
}

/** Full happy stub: auth bootstrap plus the two Today reads. */
function todayStub(options: { sessions?: unknown[]; stats?: unknown } = {}): Stub {
  return (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/auth/me") {
      return jsonResponse(ME_OK);
    }
    if (path === "/api/stats/overview") {
      return jsonResponse(options.stats ?? STATS_OK);
    }
    if (path === "/api/study/sessions") {
      return jsonResponse({ sessions: options.sessions ?? [] });
    }
    throw new Error(`Unexpected request in test stub: ${url}`);
  };
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  cleanup();
});

describe("TodayPage", () => {
  it("shows due review, new-word target, streak, and current Unit progress as separate sections", async () => {
    const { container } = renderToday(todayStub());

    await screen.findByRole("heading", { name: "今日" });
    // Wait for both reads to land before asserting the rendered numbers.
    await screen.findByText("4");
    await screen.findByText("10");
    const due = screen.getByRole("region", { name: /到期复习/ });
    expect(within(due).getByText("4")).toBeTruthy();
    const fresh = screen.getByRole("region", { name: /教材新词/ });
    // New-word target comes from the user settings (10/day), separate from due.
    expect(within(fresh).getByText("10")).toBeTruthy();
    expect(within(fresh).getByText("21")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy(); // consecutive study days
    expect(screen.getByText(/Unit 1/)).toBeTruthy();
    expect(screen.getByText(/2 \/ 8/)).toBeTruthy(); // current unit card progress

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("recommends due review first without forcing it: both CTAs stay available", async () => {
    const { router } = renderToday(todayStub());
    await screen.findByRole("heading", { name: "今日" });
    await screen.findByText("4");

    const due = screen.getByRole("region", { name: /到期复习/ });
    const fresh = screen.getByRole("region", { name: /教材新词/ });
    within(due).getByRole("link", { name: "去复习" });
    const learnLink = within(fresh).getByRole("link", { name: "去学习" });
    // Recommendation, not compulsion: the recommendation text is on the due
    // section and the new-words CTA is not disabled by pending due cards.
    expect(within(due).getByText(/建议/)).toBeTruthy();
    expect(learnLink.hasAttribute("disabled")).toBe(false);

    const user = userEvent.setup();
    await user.click(learnLink);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/learn");
    });
  });

  it("lists resumable sessions and the supplemental 待引入卡 count separately", async () => {
    renderToday(todayStub({ sessions: [SESSION_NEW, SESSION_SUPPLEMENTAL] }));
    await screen.findByRole("heading", { name: "今日" });
    await screen.findByText(/待引入卡/);

    const resume = screen.getByRole("region", { name: /继续学习/ });
    const newWords = within(resume).getByRole("link", {
      name: /继续新词学习/,
    });
    expect(newWords.getAttribute("href")).toBe("/learn");
    // Supplemental (待引入卡) cards counted separately from due and new words.
    expect(within(resume).getByText(/待引入卡/).textContent).toContain("2");
  });

  it("keeps the page usable and announces the failure when the stats read fails", async () => {
    renderToday(
      (url) => {
        const path = new URL(url).pathname;
        if (path === "/api/auth/me") {
          return jsonResponse(ME_OK);
        }
        if (path === "/api/stats/overview") {
          return jsonResponse(
            { code: "INTERNAL", message: "boom", request_id: "req-1" },
            500,
          );
        }
        if (path === "/api/study/sessions") {
          return jsonResponse({ sessions: [] });
        }
        throw new Error(`Unexpected request in test stub: ${url}`);
      },
    );
    await screen.findByRole("heading", { name: "今日" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("统计数据");
    // The new-words entry stays reachable even with failed stats.
    expect(screen.getByRole("link", { name: "去学习" })).toBeTruthy();
  });
});
