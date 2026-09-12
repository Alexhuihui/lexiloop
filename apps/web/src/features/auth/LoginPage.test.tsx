/**
 * Task 15 acceptance tests for the login page and the safe API client:
 * login error display, unauthenticated redirect into a preserved route,
 * login request shape (Origin, no CSRF yet), CSRF attachment on subsequent
 * writes, no retry for writes, bounded retry for reads, and no persistence
 * of personal API responses (memory/query cache only).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";
import { ApiError, createApiClient, type ApiClient } from "../../lib/api-client";
import {
  AUTH_ME_QUERY_KEY,
  createAppQueryClient,
  type AppQueryClient,
} from "../../lib/query-cache";
import { createAppRoutes } from "../../app/router";

const ME_OK = {
  user: { user_id: "u-1", username: "alice", status: "ACTIVE" },
  session: { expires_at: 4_102_444_800_000 },
  settings: null,
};
const LOGIN_OK = {
  user: ME_OK.user,
  session: ME_OK.session,
  csrf_token: "csrf-token-1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(code: string, status: number): Response {
  return jsonResponse({ code, message: code, request_id: "req-test-1" }, status);
}

type Stub = (url: string, init?: RequestInit) => Response;

interface CapturedRequest {
  url: string;
  init?: RequestInit;
}

interface RenderedApp {
  container: HTMLElement;
  api: ApiClient;
  queryClient: AppQueryClient;
  router: ReturnType<typeof createMemoryRouter>;
  requests: CapturedRequest[];
}

function renderApp(options: { initialEntries?: string[]; stub: Stub }): RenderedApp {
  const { initialEntries = ["/review"], stub } = options;
  const requests: CapturedRequest[] = [];
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
  const router = createMemoryRouter(createAppRoutes({ api, queryClient }), { initialEntries });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, api, queryClient, router, requests };
}

function loginStub(outcome: () => Response): Stub {
  return (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/auth/me") {
      // The shell only opens the login page when /api/auth/me rejects.
      return errorEnvelope("AUTH_TOKEN_INVALID", 401);
    }
    if (path === "/api/auth/login") {
      return outcome();
    }
    throw new Error(`Unexpected request in test stub: ${url}`);
  };
}

async function submitLogin(credentials: { username: string; password: string }): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("用户名"), credentials.username);
  await user.type(screen.getByLabelText("密码"), credentials.password);
  await user.click(screen.getByRole("button", { name: "登录" }));
}

let restoreServiceWorker: (() => void) | undefined;

function installFakeServiceWorker(): { messages: unknown[]; restore: () => void } {
  const messages: unknown[] = [];
  const fake = { controller: { postMessage: (message: unknown) => messages.push(message) } };
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    configurable: true,
    value: fake,
  });
  return {
    messages,
    restore: () => {
      delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
    },
  };
}

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  restoreServiceWorker?.();
  restoreServiceWorker = undefined;
  cleanup();
});

describe("LoginPage", () => {
  it("renders an accessible login form", async () => {
    const { container } = renderApp({
      initialEntries: ["/login"],
      stub: loginStub(() => jsonResponse(LOGIN_OK)),
    });
    await screen.findByRole("heading", { name: "登录 LexiLoop" });

    const username = screen.getByLabelText("用户名");
    const password = screen.getByLabelText("密码");
    expect(username.getAttribute("autocomplete")).toBe("username");
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(screen.getByRole("button", { name: "登录" })).toBeTruthy();
    // vitest-axe's toHaveNoViolations matcher ships broken in 0.1.0 (empty
    // extend-expect.js), so the violations list is asserted directly.
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });

  it("shows invalid-credential errors and stays on /login", async () => {
    const { router } = renderApp({
      initialEntries: ["/login"],
      stub: loginStub(() => errorEnvelope("AUTH_INVALID_CREDENTIALS", 401)),
    });
    await screen.findByRole("heading", { name: "登录 LexiLoop" });

    await submitLogin({ username: "alice", password: "wrong" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("用户名或密码不正确");
    expect(screen.getByLabelText("用户名").getAttribute("aria-invalid")).toBe("true");
    expect(router.state.location.pathname).toBe("/login");
  });

  it("shows a generic message when the server fails", async () => {
    renderApp({
      initialEntries: ["/login"],
      stub: loginStub(() => errorEnvelope("INTERNAL", 500)),
    });
    await screen.findByRole("heading", { name: "登录 LexiLoop" });

    await submitLogin({ username: "alice", password: "password" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("服务暂时不可用，请稍后重试");
  });

  it("sends credentials as JSON with Origin but without a CSRF token", async () => {
    const { requests } = renderApp({
      initialEntries: ["/login"],
      stub: loginStub(() => jsonResponse(LOGIN_OK)),
    });
    await screen.findByRole("heading", { name: "登录 LexiLoop" });

    await submitLogin({ username: "alice", password: "secret" });

    const login = requests.find(({ url }) => new URL(url).pathname === "/api/auth/login");
    expect(login).toBeTruthy();
    const headers = new Headers(login?.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("origin")).toBe("https://lexiloop.test");
    expect(headers.get("x-csrf-token")).toBeNull();
    expect(JSON.parse(String(login?.init?.body))).toEqual({
      username: "alice",
      password: "secret",
    });
  });

  it("redirects to the preserved route after login and attaches the CSRF token to later writes", async () => {
    const fake = installFakeServiceWorker();
    restoreServiceWorker = fake.restore;
    let sessionExpired = true;
    const { queryClient, router, requests } = renderApp({
      initialEntries: ["/review"],
      stub: (url) => {
        const path = new URL(url).pathname;
        if (path === "/api/auth/me") {
          return sessionExpired ? errorEnvelope("AUTH_TOKEN_INVALID", 401) : jsonResponse(ME_OK);
        }
        if (path === "/api/auth/login") {
          return jsonResponse(LOGIN_OK);
        }
        if (path === "/api/auth/logout") {
          return jsonResponse({ user_id: "u-1" });
        }
        throw new Error(`Unexpected request in test stub: ${url}`);
      },
    });
    await screen.findByRole("heading", { name: "登录 LexiLoop" });
    expect(router.state.location.state).toMatchObject({ from: { pathname: "/review" } });

    await submitLogin({ username: "alice", password: "secret" });
    sessionExpired = false;

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/review");
    });
    // The authenticated session is seeded into the memory-only query cache.
    expect(queryClient.getQueryData(AUTH_ME_QUERY_KEY)).toMatchObject({
      user: { username: "alice" },
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "退出登录" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    const logout = requests.find(({ url }) => new URL(url).pathname === "/api/auth/logout");
    const logoutHeaders = new Headers(logout?.init?.headers);
    expect(logoutHeaders.get("x-csrf-token")).toBe("csrf-token-1");
    expect(logoutHeaders.get("origin")).toBe("https://lexiloop.test");
    // Logout clears the personal query cache and notifies the Service Worker.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(fake.messages.map((message) => (message as { type: string }).type)).toContain(
      "lexiloop:clear-caches",
    );
    fake.restore();
  });
});

describe("safe API client", () => {
  interface TestClient {
    api: ApiClient;
    requests: CapturedRequest[];
    sleeps: number[];
  }

  function makeClient(options: {
    responses: Array<() => Response>;
    readAttempts?: number;
    onUnauthorized?: () => void;
  }): TestClient {
    const requests: CapturedRequest[] = [];
    const sleeps: number[] = [];
    let call = 0;
    const api = createApiClient({
      fetchFn: async (url, init) => {
        const factory = options.responses[Math.min(call, options.responses.length - 1)];
        call += 1;
        requests.push({ url: String(url), init });
        if (!factory) {
          throw new Error("No canned response configured");
        }
        return factory();
      },
      baseUrl: "https://lexiloop.test",
      origin: "https://lexiloop.test",
      readAttempts: options.readAttempts,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      onUnauthorized: options.onUnauthorized,
    });
    return { api, requests, sleeps };
  }

  it("never retries write requests", async () => {
    const { api, requests } = makeClient({
      responses: [() => errorEnvelope("INTERNAL", 503)],
    });

    const failure = await api
      .request("/api/progress/words/w-1", { method: "POST", body: { stage: 2 } })
      .then(
        () => null,
        (cause: unknown) => cause,
      );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(503);
    expect(requests).toHaveLength(1);
  });

  it("attaches Origin and the session CSRF token on writes", async () => {
    const { api, requests } = makeClient({
      responses: [() => jsonResponse({ user_id: "u-1" })],
    });
    api.setCsrfToken("csrf-token-1");

    await api.request("/api/auth/logout", { method: "POST" });

    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("origin")).toBe("https://lexiloop.test");
    expect(headers.get("x-csrf-token")).toBe("csrf-token-1");
  });

  it("retries idempotent reads on server errors with bounded backoff", async () => {
    const { api, requests, sleeps } = makeClient({
      responses: [
        () => errorEnvelope("INTERNAL", 503),
        () => errorEnvelope("INTERNAL", 503),
        () => jsonResponse({ ok: true }),
      ],
    });

    const result = (await api.request("/api/content/bootstrap")) as { ok: boolean };

    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(3);
    expect(sleeps).toEqual([300, 600]);
  });

  it("gives up after the configured read attempt bound", async () => {
    const { api, requests } = makeClient({
      responses: [() => errorEnvelope("INTERNAL", 503)],
      readAttempts: 2,
    });

    const failure = await api.request("/api/stats/overview").then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(503);
    expect(requests).toHaveLength(2);
  });

  it("does not retry 401 reads and signals auth expiry once", async () => {
    let unauthorizedCalls = 0;
    const { api, requests } = makeClient({
      responses: [() => errorEnvelope("AUTH_TOKEN_INVALID", 401)],
      onUnauthorized: () => {
        unauthorizedCalls += 1;
      },
    });

    const failure = await api.request("/api/auth/me").then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(401);
    expect(unauthorizedCalls).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("keeps personal API responses out of persistent storage", async () => {
    const { api, requests } = makeClient({
      responses: [() => jsonResponse(ME_OK), () => jsonResponse({ user_id: "u-1" })],
    });
    api.setCsrfToken("csrf-token-1");

    await api.request("/api/auth/me");
    await api.request("/api/auth/logout", { method: "POST" });

    // The responses were received (two requests) but nothing was persisted.
    expect(requests).toHaveLength(2);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });
});
