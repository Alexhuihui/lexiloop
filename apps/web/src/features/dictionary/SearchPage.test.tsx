/**
 * Task 17 acceptance tests for the dictionary search page (spec 9.5): the
 * five-field search priority (exact headword, prefix headword, Chinese gloss,
 * phrase, example full text) rendered with per-field labels, the matched
 * field highlighted, links into the word detail page, and stable empty and
 * error states.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

interface Hit {
  word_key: string;
  headword: string;
  phonetic: string | null;
  tier: string;
  unit_key: string;
  matched_field: string;
  matched_text: string;
}

function hit(overrides: Partial<Hit> & { word_key: string; headword: string }): Hit {
  return {
    phonetic: null,
    tier: "CORE",
    unit_key: "u-1",
    matched_field: "headword_exact",
    matched_text: overrides.headword,
    ...overrides,
  };
}

/** One hit per matched field, in the server's priority order (spec 9.5). */
const SEARCH_HITS: Hit[] = [
  hit({
    word_key: "w-1",
    headword: "abandon",
    phonetic: "əˈbændən",
    matched_field: "headword_exact",
  }),
  hit({
    word_key: "w-9",
    headword: "abandonment",
    matched_field: "headword_prefix",
  }),
  hit({
    word_key: "w-3",
    headword: "desert",
    matched_field: "sense_gloss",
    matched_text: "放弃；抛弃",
  }),
  hit({
    word_key: "w-4",
    headword: "abandon",
    matched_field: "phrase",
    matched_text: "abandon the plan",
  }),
  hit({
    word_key: "w-5",
    headword: "abandon",
    matched_field: "example",
    matched_text: "She abandoned the plan.",
  }),
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderSearch() {
  const requests: string[] = [];
  const api = createApiClient({
    fetchFn: async (url) => {
      requests.push(new URL(String(url)).pathname + new URL(String(url)).search);
      const path = new URL(String(url)).pathname;
      const query = new URL(String(url)).searchParams.get("q");
      if (path === "/api/auth/me") {
        return jsonResponse(ME_OK);
      }
      if (path === "/api/content/search") {
        if (query === "放弃") {
          return jsonResponse({
            query,
            release_id: "rel-1",
            hits: [
              hit({
                word_key: "w-3",
                headword: "desert",
                matched_field: "sense_gloss",
                matched_text: "放弃；抛弃",
              }),
            ],
          });
        }
        if (query === "abandon") {
          return jsonResponse({ query, release_id: "rel-1", hits: SEARCH_HITS });
        }
        if (query === "empty") {
          return jsonResponse({ query, release_id: "rel-1", hits: [] });
        }
        return jsonResponse(
          { code: "INTERNAL", message: "boom", request_id: "req-1" },
          500,
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
    initialEntries: ["/dictionary"],
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, router, requests };
}

async function search(term: string): Promise<void> {
  const user = userEvent.setup();
  await screen.findByRole("heading", { name: "词典" });
  await user.type(screen.getByLabelText("搜索词或释义"), term);
  await user.click(screen.getByRole("button", { name: "搜索" }));
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  cleanup();
});

describe("dictionary search", () => {
  it("renders all five matched-field kinds in the server's priority order with links", async () => {
    const { router } = renderSearch();
    await search("abandon");

    const results = await screen.findByRole("list", { name: "搜索结果" });
    const items = results.querySelectorAll("li");
    expect(items).toHaveLength(5);

    // The per-field labels expose the spec 9.5 priority.
    expect(screen.getByText("精确词头")).toBeTruthy();
    expect(screen.getByText("词头前缀")).toBeTruthy();
    expect(screen.getByText("中文释义")).toBeTruthy();
    expect(screen.getByText("短语")).toBeTruthy();
    expect(screen.getByText("例句")).toBeTruthy();

    // Every hit links to its full word entry.
    const firstLink = screen.getByRole("link", { name: "abandon əˈbændən" });
    expect(firstLink.getAttribute("href")).toBe("/dictionary/words/w-1");
    await userEvent.click(firstLink);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/dictionary/words/w-1");
    });
  });

  it("highlights the matched portion of the matched field", async () => {
    renderSearch();
    await search("abandon");
    await screen.findByRole("list", { name: "搜索结果" });

    const marks = screen.getAllByText("abandon", { selector: "mark" });
    // Exact headword, prefix inside "abandonment", phrase, and the match
    // inside the inflected example "abandoned" all highlight the query.
    expect(marks.length).toBeGreaterThanOrEqual(4);
    // The Chinese gloss hit renders its text without a false-positive mark.
    expect(screen.getByText("放弃；抛弃").querySelector("mark")).toBeNull();
  });

  it("highlights Chinese gloss matches for a Chinese query", async () => {
    renderSearch();
    await search("放弃");
    await screen.findByRole("list", { name: "搜索结果" });
    const mark = screen.getByText("放弃", { selector: "mark" });
    expect(mark).toBeTruthy();
  });

  it("renders an empty state without fabricating results", async () => {
    renderSearch();
    await search("empty");
    await screen.findByText("没有找到相关词条。");
  });

  it("renders a stable error message when the search fails", async () => {
    renderSearch();
    await search("boom");
    await screen.findByRole("alert");
    expect(screen.getByText(/搜索失败/)).toBeTruthy();
  });

  it("does not fetch for a whitespace-only query", async () => {
    const { requests } = renderSearch();
    await screen.findByRole("heading", { name: "词典" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("搜索词或释义"), "   ");
    await user.click(screen.getByRole("button", { name: "搜索" }));
    await waitFor(() => {
      expect((screen.getByLabelText("搜索词或释义") as HTMLInputElement).value).toBe("   ");
    });
    expect(requests.filter((request) => request.startsWith("/api/content/search"))).toEqual([]);
  });

  it("passes an axe audit in the loaded state", async () => {
    const { container } = renderSearch();
    await search("abandon");
    await screen.findByRole("list", { name: "搜索结果" });
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
