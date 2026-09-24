/**
 * Task 17 acceptance tests for the statistics page (spec 9.6): learned
 * word/card counts, the estimated memory retention, today + historical review
 * counts, the consecutive-study-day streak, the 30-day due forecast,
 * difficult (high-lapse) words, and Unit mastery (coverage + predicted
 * retention), with "no data yet" handling for nullable estimates.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";
import { createApiClient } from "../../lib/api-client";
import { createAppQueryClient } from "../../lib/query-cache";
import { createAppRoutes } from "../../app/router";

const ME_OK = {
  user: { user_id: "u-1", username: "alice", status: "ACTIVE" },
  session: { expires_at: 4_102_444_800_000 },
  settings: null,
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
    { date: "2026-10-10", cards: 7 },
  ],
  difficult_words: [
    { word_key: "w-1", headword: "abandon", lapses: 3, max_difficulty: 8.2, cards: 2 },
    { word_key: "w-9", headword: null, lapses: 1, max_difficulty: 6.5, cards: 1 },
  ],
  units: [
    {
      unit_key: "u-1",
      title: "Unit 1",
      total_cards: 8,
      studied_cards: 2,
      coverage: 0.25,
      estimated_retention: 0.88,
    },
    {
      unit_key: "u-2",
      title: "Unit 2",
      total_cards: 10,
      studied_cards: 0,
      coverage: 0,
      estimated_retention: null,
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderStats(options: { stats?: unknown; status?: number } = {}) {
  const api = createApiClient({
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/auth/me") {
        return jsonResponse(ME_OK);
      }
      if (path === "/api/stats/overview") {
        return jsonResponse(
          options.stats ?? STATS_OK,
          options.status ?? 200,
        );
      }
      throw new Error(`Unexpected request in test stub: ${url}`);
    },
    baseUrl: "https://lexiloop.test",
    origin: "https://lexiloop.test",
    sleep: () => Promise.resolve(),
  });
  const queryClient = createAppQueryClient();
  const router = createMemoryRouter(createAppRoutes({ api, queryClient }), {
    initialEntries: ["/stats"],
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router };
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  cleanup();
});

describe("statistics overview", () => {
  it("renders every spec 9.6 statistic", async () => {
    const { container } = renderStats();
    // Await the data itself: the heading renders while the query is pending.
    await screen.findByText("21");

    // Learned counts and retention.
    expect(screen.getByText("21")).toBeTruthy(); // 已学单词
    expect(screen.getByText("34")).toBeTruthy(); // 已学卡片
    expect(screen.getByText("91%")).toBeTruthy(); // 估算记忆保持率

    // Today + historical reviews and the streak.
    expect(screen.getByText("5")).toBeTruthy(); // 今日复习
    expect(screen.getByText("210")).toBeTruthy(); // 历史复习
    expect(screen.getByText("6")).toBeTruthy(); // 连续学习天数

    // The 30-day due forecast, including the last day of the window.
    const forecast = within(screen.getByLabelText("未来 30 天到期预测"));
    expect(forecast.getByText(/2026-09-11/)).toBeTruthy();
    expect(forecast.getByText(/2026-10-10/)).toBeTruthy();
    expect(forecast.getByText(/4 张/)).toBeTruthy();
    expect(forecast.getByText(/7 张/)).toBeTruthy();

    // Difficult words: headword or key fallback, lapses and difficulty.
    const difficult = within(screen.getByLabelText("困难词"));
    expect(difficult.getByText(/abandon/)).toBeTruthy();
    expect(difficult.getByText(/3/)).toBeTruthy();
    expect(difficult.getByText(/8\.2/)).toBeTruthy();
    expect(difficult.getByText(/w-9/)).toBeTruthy();

    // Unit mastery: coverage plus predicted retention, 暂无数据 when null.
    const units = within(screen.getByLabelText("Unit 掌握度"));
    expect(units.getByText(/Unit 1/)).toBeTruthy();
    expect(units.getByText(/2 \/ 8/)).toBeTruthy();
    expect(units.getByText(/覆盖率 25%/)).toBeTruthy();
    expect(units.getByText(/预测保持率 88%/)).toBeTruthy();
    expect(units.getByText(/Unit 2/)).toBeTruthy();
    expect(units.getByText(/覆盖率 0%/)).toBeTruthy();
    expect(units.getAllByText(/暂无数据/).length).toBeGreaterThan(0);

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("renders 暂无数据 when no retention can be estimated yet", async () => {
    renderStats({
      stats: { ...STATS_OK, estimated_retention: null, difficult_words: [], due_forecast: [] },
    });
    await screen.findByText("暂无数据");
    expect(screen.getByText(/暂无到期预测/)).toBeTruthy();
    expect(screen.getByText(/暂无困难词/)).toBeTruthy();
  });

  it("renders a stable error message when the overview fails to load", async () => {
    renderStats({ status: 500 });
    await screen.findByRole("alert");
    expect(screen.getByText(/统计数据加载失败/)).toBeTruthy();
  });
});
