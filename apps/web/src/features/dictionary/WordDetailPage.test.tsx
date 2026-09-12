/**
 * Task 17 acceptance tests for the word detail page (spec 9.5): the entry
 * shows its Unit, all senses, phrases, examples, explanations, related words,
 * and the caller's personal study state; a missing word fails with a stable
 * message.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
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

const WORD_CONTENT: Record<string, unknown> = {
  "w-1": {
    word: {
      word_key: "w-1",
      unit_key: "u-1",
      headword: "abandon",
      phonetic: "əˈbændən",
      tier: "CORE",
      source_order: 1,
    },
    unit: { unit_key: "u-1", title: "Unit 1" },
    senses: [
      { sense_key: "s-1-1", pos: "v.", gloss: "放弃；抛弃", sense_order: 1 },
      { sense_key: "s-1-2", pos: "n.", gloss: "放纵；放任", sense_order: 2 },
    ],
    phrases: [
      {
        phrase_key: "p-1-1",
        sense_key: "s-1-1",
        text: "abandon the plan",
        gloss: "放弃计划",
        source_order: 1,
      },
    ],
    examples: [
      {
        example_key: "e-1-1",
        sense_key: "s-1-1",
        phrase_key: null,
        origin: "exam",
        source_ref: "2022 全国卷",
        text: "She abandoned the plan.",
        target_start: 4,
        target_end: 13,
        source_order: 1,
      },
    ],
    explanations: [
      {
        explanation_key: "x-1-1",
        syntax_notes: ["abandon 后接名词或动名词作宾语"],
        translation_hints: "表示「放弃」；注意宾语的位置",
        pitfalls: ["拼写注意：只有一个 b"],
        context_meanings: [{ example_key: "e-1-1", gloss: "放弃（计划等）" }],
        discrimination_candidates: [{ against_word_key: "w-2", note: "ability 指做某事的能力" }],
      },
    ],
    related: [{ to_word_key: "w-2", relation_type: "confusable" }],
    audio: [{ entity_type: "word", entity_key: "w-1", asset_key: "audio/ab/abc111.wav" }],
  },
  "w-2": {
    word: {
      word_key: "w-2",
      unit_key: "u-1",
      headword: "ability",
      phonetic: "əˈbɪləti",
      tier: "CORE",
      source_order: 2,
    },
    unit: { unit_key: "u-1", title: "Unit 1" },
    senses: [{ sense_key: "s-2-1", pos: "n.", gloss: "能力；才能", sense_order: 1 }],
    phrases: [],
    examples: [],
    explanations: [],
    related: [],
    audio: [],
  },
};

const PROGRESS: Record<string, unknown> = {
  "w-1": {
    word_key: "w-1",
    // The progress route returns the raw stored familiarity value
    // (UNKNOWN / RECOGNIZABLE / KNOWN), not the API choice enum.
    progress: {
      stage: "INTRODUCED",
      initial_familiarity: "RECOGNIZABLE",
      first_seen_at: 1_700_000_000_000,
      introduced_release_id: "rel-1",
      introduced_at: 1_700_000_000_000,
      last_seen_at: 1_700_000_060_000,
    },
  },
  "w-2": { word_key: "w-2", progress: null },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderDetail(initialPath: string) {
  const api = createApiClient({
    fetchFn: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/auth/me") {
        return jsonResponse(ME_OK);
      }
      if (path.startsWith("/api/content/words/")) {
        const key = decodeURIComponent(path.replace("/api/content/words/", ""));
        const content = WORD_CONTENT[key];
        return content
          ? jsonResponse(content)
          : jsonResponse(
              { code: "CONTENT_WORD_NOT_FOUND", message: "missing", request_id: "req-1" },
              404,
            );
      }
      if (path.startsWith("/api/progress/words/")) {
        const key = decodeURIComponent(path.replace("/api/progress/words/", ""));
        return jsonResponse(PROGRESS[key] ?? { word_key: key, progress: null });
      }
      throw new Error(`Unexpected request in test stub: ${url}`);
    },
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
  return { ...utils, router };
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  cleanup();
});

describe("word detail", () => {
  it("renders the Unit, all senses, phrases, examples, explanations, and word audio", async () => {
    const { container } = renderDetail("/dictionary/words/w-1");
    await screen.findByRole("heading", { name: "abandon" });
    expect(screen.getByText("əˈbændən")).toBeTruthy();

    // Unit membership.
    expect(screen.getByText("Unit 1")).toBeTruthy();

    // ALL senses, in order.
    const senses = within(screen.getByLabelText("全部义项"));
    expect(senses.getByText(/放弃；抛弃/)).toBeTruthy();
    expect(senses.getByText(/放纵；放任/)).toBeTruthy();

    // Phrases.
    const phrases = within(screen.getByLabelText("短语"));
    expect(phrases.getByText(/abandon the plan/)).toBeTruthy();
    expect(phrases.getByText(/放弃计划/)).toBeTruthy();

    // Examples: origin tag, text, and source reference.
    const examples = within(screen.getByLabelText("例句"));
    expect(examples.getByText("真题")).toBeTruthy();
    expect(examples.getByText("She abandoned the plan.")).toBeTruthy();
    expect(examples.getByText("来源：2022 全国卷")).toBeTruthy();

    // Explanations, including the contextual meaning of the example.
    const explanations = within(screen.getByLabelText("讲解"));
    expect(explanations.getByText(/abandon 后接名词或动名词作宾语/)).toBeTruthy();
    expect(explanations.getByText(/表示「放弃」/)).toBeTruthy();
    expect(explanations.getByText(/拼写注意：只有一个 b/)).toBeTruthy();
    expect(explanations.getByText(/放弃（计划等）/)).toBeTruthy();

    // The headword audio is offered as a playable element.
    const audio = container.querySelector("audio");
    expect(audio?.getAttribute("src")).toContain("audio/ab/abc111.wav");

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("shows related words as links and the personal study state", async () => {
    const { router } = renderDetail("/dictionary/words/w-1");
    await screen.findByRole("heading", { name: "abandon" });

    // Related words resolve to their headwords and link to their entries.
    const related = await screen.findByLabelText("相关词");
    const link = within(related).getByRole("link", { name: "ability" });
    expect(link.getAttribute("href")).toBe("/dictionary/words/w-2");

    // Personal study state: stage plus first-contact familiarity.
    const state = within(screen.getByLabelText("个人学习状态"));
    expect(state.getByText("已学")).toBeTruthy();
    expect(state.getByText("有印象")).toBeTruthy();

    await userEvent.click(link);
    await screen.findByRole("heading", { name: "ability" });
    expect(router.state.location.pathname).toBe("/dictionary/words/w-2");
    // w-2 has no progress row yet.
    const other = within(screen.getByLabelText("个人学习状态"));
    expect(other.getByText("未学")).toBeTruthy();
  });

  it("renders a stable not-found message for a word outside the release", async () => {
    renderDetail("/dictionary/words/missing");
    await screen.findByRole("alert");
    expect(screen.getByText(/词条不存在/)).toBeTruthy();
  });
});
