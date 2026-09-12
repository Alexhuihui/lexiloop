/**
 * Task 16 journey-level tests for the learn setup state (spec 9.3 step 1/2):
 * Unit/tier selection with a continue-from-last-position default, the
 * expected word group shown in textbook order, resume of an interrupted
 * session, and session creation through the Worker (the server decides the
 * fixed group — the client never reshuffles).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { createApiClient } from "../../lib/api-client";
import { createAppQueryClient } from "../../lib/query-cache";
import { createAppRoutes } from "../../app/router";
import {
  ME,
  createFakeServer,
} from "./learn-fixtures";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderLearn(stub: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const requests: { url: string; init?: RequestInit; body?: unknown }[] = [];
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
    initialEntries: ["/learn"],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { requests, router };
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  cleanup();
});

describe("LearnSetupPage", () => {
  it("selects the Unit (defaulting to the settings start unit) and a tier, and previews the group in textbook order", async () => {
    const { requests } = renderLearn(createFakeServer().stub);
    await screen.findByRole("heading", { name: "学习" });

    // Default unit comes from settings.start_unit_key (沿用上次位置).
    const unitSelect = screen.getByLabelText("选择单元") as HTMLSelectElement;
    expect(unitSelect.value).toBe("u-1");
    // Expected group: the first `new_words_per_group` un-learned words of the
    // unit in textbook order (CORE tier before EXTENSION, then source order).
    expect(await screen.findByText(/abandon/)).toBeTruthy();
    expect(screen.getByText(/ability/)).toBeTruthy();
    expect(screen.getByText(/预计本组 2 个新词/)).toBeTruthy();
    expect(screen.getByText(/abnormal/)).toBeTruthy(); // rest of the unit visible

    const tierSelect = screen.getByLabelText("选择分层");
    await userEvent.setup().selectOptions(tierSelect, "EXTENSION");
    await waitFor(() => {
      expect(screen.getByText(/预计本组 1 个新词/)).toBeTruthy();
    });
    expect(screen.getByText(/abnormal/)).toBeTruthy();
    expect(screen.queryByText(/abandon/)).toBeNull();
    // No session is created by previewing.
    expect(
      requests.some(
        ({ url, init }) =>
          new URL(url).pathname === "/api/study/sessions" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("offers to continue an interrupted session instead of creating a new one", async () => {
    const server = createFakeServer({ presetSessions: ["sess-resume-1"] });
    const { requests } = renderLearn(server.stub);
    await screen.findByRole("heading", { name: "学习" });

    await userEvent.setup().click(screen.getByRole("button", { name: /继续上次学习/ }));

    // The study view opens on the first group word without a new session.
    await screen.findByText(/第 1 词 \/ 共 2 词/);
    expect(
      requests.some(
        ({ url, init }) =>
          new URL(url).pathname === "/api/study/sessions" && init?.method === "POST",
      ),
    ).toBe(false);
    expect(
      requests.some(
        ({ url }) => new URL(url).pathname === "/api/study/sessions/sess-resume-1",
      ),
    ).toBe(true);
  });

  it("starts a NEW_WORDS session through POST /api/study/sessions and shows the server card count", async () => {
    const server = createFakeServer();
    const { requests } = renderLearn(server.stub);
    await screen.findByRole("heading", { name: "学习" });

    await userEvent.setup().click(screen.getByRole("button", { name: "开始学习" }));
    await screen.findByText(/共 5 张卡/);

    const create = requests.find(
      ({ url, init }) =>
        new URL(url).pathname === "/api/study/sessions" && init?.method === "POST",
    );
    expect(create).toBeTruthy();
    expect(JSON.parse(String(create?.init?.body))).toEqual({ mode: "NEW_WORDS" });
    // The fixed group is the client preview; the card count is the server's
    // queue snapshot length (the server decides the group, spec 9.3 step 2).
    expect(screen.getByText(/第 1 词 \/ 共 2 词/)).toBeTruthy();
  });

  it("handles a missing settings row with the schema defaults", async () => {
    const server = createFakeServer();
    const stub = (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/api/auth/me") {
        return jsonResponse({ ...ME, settings: null });
      }
      return server.stub(url, init);
    };
    renderLearn(stub);
    await screen.findByRole("heading", { name: "学习" });
    // Default group size 10 covers every unit word (3 words total).
    expect(await screen.findByText(/预计本组 3 个新词/)).toBeTruthy();
  });
});
