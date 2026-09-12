/**
 * Task 15 acceptance tests: responsive shell navigation (mobile bottom bar /
 * desktop left sidebar), the five destinations, unauthenticated redirect,
 * auth-expiry route preservation with personal-state clearing, logout, and
 * the PWA artifacts (index.html manifest link, theme color, committed icon
 * dimensions, manifest purposes).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { axe } from "vitest-axe";
import { createApiClient } from "../lib/api-client";
import {
  AUTH_ME_QUERY_KEY,
  SW_CACHE_CLEAR_MESSAGE,
  createAppQueryClient,
  clearPersonalState,
} from "../lib/query-cache";
import { createAppRoutes } from "./router";
import { NAV_ITEMS } from "./AppShell";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const ME_OK = {
  user: { user_id: "u-1", username: "alice", status: "ACTIVE" },
  session: { expires_at: 4_102_444_800_000 },
  settings: null,
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

interface RenderedApp {
  container: HTMLElement;
  api: ReturnType<typeof createApiClient>;
  queryClient: ReturnType<typeof createAppQueryClient>;
  router: ReturnType<typeof createMemoryRouter>;
  requests: { url: string; init?: RequestInit }[];
}

function renderApp(options: { initialEntries?: string[]; stub: Stub }): RenderedApp {
  const { initialEntries = ["/today"], stub } = options;
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
  const router = createMemoryRouter(createAppRoutes({ api, queryClient }), { initialEntries });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...utils, api, queryClient, router, requests };
}

function stubFor(routes: Record<string, () => Response>): Stub {
  return (url) => {
    const path = new URL(url).pathname;
    const factory = routes[path];
    if (!factory) {
      throw new Error(`Unexpected request in test stub: ${url}`);
    }
    return factory();
  };
}

function meOkStub(): Stub {
  return stubFor({ "/api/auth/me": () => jsonResponse(ME_OK) });
}

/** Installs a fake service worker container on the test navigator. */
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

function readWebFile(relativePath: string): string {
  return readFileSync(join(WEB_ROOT, relativePath), "utf8");
}

function readWebBytes(relativePath: string): Buffer {
  return readFileSync(join(WEB_ROOT, relativePath));
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  // PNG signature + IHDR: width at byte 16, height at byte 20 (big-endian).
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

let restoreServiceWorker: (() => void) | undefined;

beforeEach(() => {
  document.documentElement.lang = "zh-CN";
});

afterEach(() => {
  restoreServiceWorker?.();
  restoreServiceWorker = undefined;
  cleanup();
});

describe("shell routing", () => {
  it("redirects an unauthenticated user to /login and preserves the attempted route", async () => {
    const { router } = renderApp({
      initialEntries: ["/learn"],
      stub: stubFor({ "/api/auth/me": () => errorEnvelope("AUTH_TOKEN_INVALID", 401) }),
    });

    // findBy* retries, so the assertion survives the gap between the router
    // state updating and React committing the login page render.
    await screen.findByRole("heading", { name: "登录 LexiLoop" });
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.state).toMatchObject({ from: { pathname: "/learn" } });
  });

  it("keeps the five destinations reachable from the navigation", async () => {
    const { router } = renderApp({ initialEntries: ["/today"], stub: meOkStub() });
    await screen.findByRole("heading", { name: "今日" });

    expect(NAV_ITEMS.map((item) => item.path)).toEqual([
      "/today",
      "/learn",
      "/review",
      "/dictionary",
      "/stats",
    ]);
    expect(NAV_ITEMS.map((item) => item.label)).toEqual(["今日", "学习", "复习", "词典", "数据"]);

    const bottomNav = screen.getByRole("navigation", { name: "主导航" });
    const user = userEvent.setup();
    for (const item of NAV_ITEMS) {
      await user.click(within(bottomNav).getByRole("link", { name: item.label }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(item.path);
      });
      expect(screen.getByRole("heading", { name: item.label })).toBeTruthy();
    }
  });

  it("marks the current destination with aria-current", async () => {
    const { router } = renderApp({ initialEntries: ["/today"], stub: meOkStub() });
    await screen.findByRole("heading", { name: "今日" });

    const bottomNav = screen.getByRole("navigation", { name: "主导航" });
    const user = userEvent.setup();
    await user.click(within(bottomNav).getByRole("link", { name: "复习" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/review");
    });
    const active = within(bottomNav).getByRole("link", { name: "复习" });
    expect(active.getAttribute("aria-current")).toBe("page");
  });
});

describe("responsive navigation", () => {
  it("renders a mobile bottom navigation bar", async () => {
    renderApp({ initialEntries: ["/today"], stub: meOkStub() });
    await screen.findByRole("heading", { name: "今日" });

    const bottomNav = screen.getByRole("navigation", { name: "主导航" });
    expect(bottomNav.className).toContain("app-nav--bottom");
    // Tailwind visibility contract: hidden at the md breakpoint (desktop).
    expect(bottomNav.className).toContain("md:hidden");

    const css = readWebFile("src/styles/index.css");
    const bottomRule = /\.app-nav--bottom \{([^}]*)\}/.exec(css);
    expect(bottomRule).toBeTruthy();
    expect(bottomRule?.[1]).toContain("position: fixed");
    expect(bottomRule?.[1]).toContain("bottom: 0");
  });

  it("renders a desktop left navigation sidebar", async () => {
    renderApp({ initialEntries: ["/today"], stub: meOkStub() });
    await screen.findByRole("heading", { name: "今日" });

    const sideNav = screen.getByRole("navigation", { name: "侧边导航" });
    expect(sideNav.className).toContain("app-nav--side");
    // Tailwind visibility contract: hidden on mobile, flex from md upwards.
    expect(sideNav.className).toContain("hidden");
    expect(sideNav.className).toContain("md:flex");

    const css = readWebFile("src/styles/index.css");
    const sideRule = /@media \(min-width: 768px\) \{\s*\.app-nav--side \{([^}]*)\}/.exec(css);
    expect(sideRule).toBeTruthy();
    expect(sideRule?.[1]).toContain("position: sticky");
    expect(sideRule?.[1]).toContain("top: 0");
  });

  it("ships the accessibility contract in the stylesheet", async () => {
    const css = readWebFile("src/styles/index.css");
    // 44px touch targets.
    expect(css).toContain("min-width: 44px");
    expect(css).toContain("min-height: 44px");
    // High-contrast focus states.
    expect(css).toContain(":focus-visible");
    expect(css).toMatch(/:focus-visible \{[^}]*outline: 3px solid/);
    // Reduced-motion support.
    expect(css).toContain("prefers-reduced-motion: reduce");
    // Typography tuned for English/Chinese reading.
    expect(css).toContain('"PingFang SC"');
    expect(css).toContain('"Microsoft YaHei"');
    expect(css).toContain("line-height: 1.7");
  });
});

describe("shell accessibility", () => {
  it("passes an axe audit on the authenticated shell", async () => {
    const { container } = renderApp({ initialEntries: ["/today"], stub: meOkStub() });
    await screen.findByRole("heading", { name: "今日" });
    // vitest-axe's toHaveNoViolations matcher ships broken in 0.1.0 (empty
    // extend-expect.js), so the violations list is asserted directly.
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});

describe("auth expiry", () => {
  it("clears personal state and redirects to /login preserving the route on a 401", async () => {
    const fake = installFakeServiceWorker();
    restoreServiceWorker = fake.restore;
    localStorage.setItem("lexiloop:auth-probe", "1");
    sessionStorage.setItem("lexiloop:session-probe", "1");
    localStorage.setItem("unrelated-key", "keep-me");

    let meFails = false;
    const { queryClient, router } = renderApp({
      initialEntries: ["/today"],
      stub: stubFor({
        "/api/auth/me": () =>
          meFails ? errorEnvelope("AUTH_TOKEN_INVALID", 401) : jsonResponse(ME_OK),
      }),
    });
    await screen.findByRole("heading", { name: "今日" });

    meFails = true;
    await queryClient.refetchQueries({ queryKey: AUTH_ME_QUERY_KEY });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    expect(router.state.location.state).toMatchObject({ from: { pathname: "/today" } });
    // Personal state is gone: query cache and personal storage keys cleared.
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(localStorage.getItem("lexiloop:auth-probe")).toBeNull();
    expect(sessionStorage.getItem("lexiloop:session-probe")).toBeNull();
    expect(localStorage.getItem("unrelated-key")).toBe("keep-me");
    // The Service Worker is told to drop content/audio caches (spec 10).
    expect(fake.messages).toEqual([SW_CACHE_CLEAR_MESSAGE]);
    fake.restore();
  });
});

describe("logout", () => {
  it("restores the CSRF token from the me bootstrap after a cold reload and uses it on logout", async () => {
    const fake = installFakeServiceWorker();
    restoreServiceWorker = fake.restore;
    localStorage.setItem("lexiloop:auth-probe", "1");

    const { queryClient, router, requests } = renderApp({
      initialEntries: ["/today"],
      stub: stubFor({
        "/api/auth/me": () => jsonResponse(ME_OK),
        "/api/auth/logout": () => jsonResponse({ user_id: "u-1" }),
      }),
    });
    // No login happened in this page session: the shell's me() bootstrap is
    // the only source of the CSRF token, and logout must carry it.
    await screen.findByRole("heading", { name: "今日" });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "退出登录" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/login");
    });
    const logout = requests.find(({ url }) => new URL(url).pathname === "/api/auth/logout");
    expect(logout).toBeTruthy();
    expect(new Headers(logout?.init?.headers).get("x-csrf-token")).toBe("csrf-token-1");
    expect(new Headers(logout?.init?.headers).get("origin")).toBe("https://lexiloop.test");
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(localStorage.getItem("lexiloop:auth-probe")).toBeNull();
    expect(fake.messages).toEqual([SW_CACHE_CLEAR_MESSAGE]);
    fake.restore();
  });
});

describe("personal state clearing", () => {
  it("clears only personal keys, the query cache, and messages the worker when present", () => {
    const fake = installFakeServiceWorker();
    restoreServiceWorker = fake.restore;
    localStorage.setItem("lexiloop:auth-probe", "1");
    localStorage.setItem("unrelated-key", "keep-me");
    sessionStorage.setItem("lexiloop:session-probe", "1");
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, ME_OK);

    clearPersonalState(queryClient);

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(localStorage.getItem("lexiloop:auth-probe")).toBeNull();
    expect(localStorage.getItem("unrelated-key")).toBe("keep-me");
    expect(sessionStorage.getItem("lexiloop:session-probe")).toBeNull();
    expect(fake.messages).toEqual([SW_CACHE_CLEAR_MESSAGE]);
    fake.restore();
  });

  it("is safe when no service worker is registered (feature detection)", () => {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(AUTH_ME_QUERY_KEY, ME_OK);
    expect(() => clearPersonalState(queryClient)).not.toThrow();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe("PWA app shell artifacts", () => {
  it("links a valid web-app manifest and theme color from index.html", () => {
    const html = readWebFile("index.html");
    expect(html).toContain('lang="zh-CN"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('<meta name="theme-color" content="#0f766e"');

    const manifest = JSON.parse(readWebFile("public/manifest.webmanifest")) as Record<
      string,
      unknown
    >;
    expect(manifest["name"]).toBe("LexiLoop");
    expect(manifest["short_name"]).toBe("LexiLoop");
    expect(manifest["start_url"]).toBe("/");
    expect(manifest["scope"]).toBe("/");
    expect(manifest["display"]).toBe("standalone");
    expect(manifest["theme_color"]).toBe("#0f766e");
    expect(manifest["background_color"]).toBe("#fafaf9");
    expect(manifest["lang"]).toBe("zh-CN");
    expect(Array.isArray(manifest["icons"])).toBe(true);
  });

  it("commits 192/512/maskable icons with exact dimensions and manifest purposes", () => {
    const manifest = JSON.parse(readWebFile("public/manifest.webmanifest")) as {
      icons: { src: string; sizes: string; type: string; purpose: string }[];
    };
    expect(manifest.icons).toEqual([
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);

    expect(pngDimensions(readWebBytes("public/icons/icon-192.png"))).toEqual({
      width: 192,
      height: 192,
    });
    expect(pngDimensions(readWebBytes("public/icons/icon-512.png"))).toEqual({
      width: 512,
      height: 512,
    });
    expect(pngDimensions(readWebBytes("public/icons/maskable-512.png"))).toEqual({
      width: 512,
      height: 512,
    });
    // The repo-native source asset the icons are generated from.
    expect(readWebBytes("public/icons/lexiloop.svg").subarray(0, 4).toString()).toBe("<svg");
  });
});
