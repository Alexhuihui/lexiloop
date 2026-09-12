/**
 * Auth, security-header, and PWA-installability journeys (plan Task 18
 * step 1): login/logout/revocation, security headers on HTML/API/error
 * responses, PWA installability (manifest + icons + a registering and page-
 * controlling Service Worker), and logout cache clearing. All assertions are
 * user-visible behavior — status codes, rendered messages, cache state.
 */
import { expect, test, type Page } from "@playwright/test";
import { alice, harnessState, loginViaUi, logoutViaUi, type HarnessState } from "./support/harness";

let state: HarnessState;
let user: { username: string; password: string };

test.beforeAll(async () => {
  state = await harnessState();
  user = alice(state);
});

/** Fetches a URL inside the page (session cookie + SW intercession apply). */
async function pageFetchStatus(page: Page, path: string): Promise<number> {
  return await page.evaluate(async (target) => {
    const response = await fetch(target);
    return response.status;
  }, path);
}

test.describe.configure({ mode: "serial" });

test("logs in with the seeded synthetic account and reaches 今日", async ({ page }) => {
  await loginViaUi(page, user);
  await expect(page).toHaveURL(/\/today$/);
  await expect(page.getByRole("heading", { name: "今日" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "到期复习" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "教材新词" })).toBeVisible();
});

test("rejects wrong credentials with a stable message and no session", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(user.username);
  await page.getByLabel("密码").fill("definitely-not-the-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("alert")).toContainText("用户名或密码不正确");
  // Still unauthenticated: navigating to an app route bounces to /login.
  await page.goto("/today");
  await expect(page).toHaveURL(/\/login$/);
});

test("revokes the session server-side on logout", async ({ page }) => {
  await loginViaUi(page, user);
  // The browser's cookie authenticates an API request right now.
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name === "lexiloop_session");
  expect(sessionCookie).toBeDefined();
  const cookieHeader = `lexiloop_session=${sessionCookie!.value}`;
  const cookieJar = page.context().request;
  const beforeLogout = await cookieJar.get("/api/auth/me", { headers: { cookie: cookieHeader } });
  expect(beforeLogout.status()).toBe(200);

  await logoutViaUi(page);

  // The SAME cookie no longer resolves: logout revoked the session row.
  const afterLogout = await cookieJar.get("/api/auth/me", { headers: { cookie: cookieHeader } });
  expect(afterLogout.status()).toBe(401);

  // And the browser itself is signed out.
  await page.goto("/today");
  await expect(page).toHaveURL(/\/login$/);
});

test("sends security headers on HTML, API, and error responses", async ({ request }) => {
  const expected = {
    "content-security-policy": /default-src 'self'/,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": /camera=\(\)/,
    "strict-transport-security": /max-age=31536000/,
  };

  // HTML: the PWA shell document.
  const html = await request.get("/");
  expect(html.status()).toBe(200);
  for (const [header, pattern] of Object.entries(expected)) {
    expect(html.headers()[header], `HTML ${header}`).toMatch(pattern as RegExp);
  }

  // API: an authenticated-shape JSON response (401 without a session).
  const api = await request.get("/api/stats/overview");
  expect(api.status()).toBe(401);
  for (const [header, pattern] of Object.entries(expected)) {
    expect(api.headers()[header], `API ${header}`).toMatch(pattern as RegExp);
  }
  const apiBody = (await api.json()) as { code?: string };
  expect(apiBody.code).toBe("AUTH_SESSION_INVALID");

  // Error: the 404 envelope carries the same header set.
  const missing = await request.get("/api/no-such-route");
  expect(missing.status()).toBe(404);
  for (const [header, pattern] of Object.entries(expected)) {
    expect(missing.headers()[header], `error ${header}`).toMatch(pattern as RegExp);
  }
  const missingBody = (await missing.json()) as { code?: string };
  expect(missingBody.code).toBe("NOT_FOUND");
});

test("exposes an installable PWA shell: manifest, icons, controlling service worker", async ({ page }) => {
  await page.goto("/login");

  // The document links the manifest; the manifest is fetchable and declares
  // standalone display with its icons.
  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveAttribute("href", "/manifest.webmanifest");
  const manifestStatus = await pageFetchStatus(page, "/manifest.webmanifest");
  expect(manifestStatus).toBe(200);
  const manifest = await page.evaluate(async () => {
    return (await fetch("/manifest.webmanifest").then((response) => response.json())) as {
      name?: string;
      start_url?: string;
      display?: string;
      icons?: Array<{ src: string; sizes: string; purpose: string }>;
    };
  });
  expect(manifest.name).toBe("LexiLoop");
  expect(manifest.display).toBe("standalone");
  const iconSrcs = (manifest.icons ?? []).map((icon) => icon.src);
  expect(iconSrcs).toContain("/icons/icon-192.png");
  expect(iconSrcs).toContain("/icons/icon-512.png");
  expect(iconSrcs).toContain("/icons/maskable-512.png");
  for (const icon of iconSrcs) {
    expect(await pageFetchStatus(page, icon), `icon ${icon}`).toBe(200);
  }

  // The production build registers /sw.js, activates, and controls the page
  // (a real beforeinstallprompt needs a browser flag; registration and
  // control are the reliably assertable installability signals).
  const registration = await page.evaluate(async () => {
    const existing = await navigator.serviceWorker.getRegistration();
    return existing === undefined ? null : { scope: existing.scope, active: existing.active !== null };
  });
  expect(registration).not.toBeNull();
  expect(registration!.scope).toBe(`${state.baseUrl}/`);
  expect(registration!.active).toBe(true);
  await page.evaluate(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (navigator.serviceWorker.controller !== null) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("service worker never took control of the page");
  });
});

test("clears content and audio caches on logout while the shell precache survives", async ({ page }) => {
  await loginViaUi(page, user);

  // Drive REAL Service Worker traffic: the bootstrap read is written through
  // into the release-scoped content cache, and an audio read into the audio
  // cache (both happen only when the SW controls the page).
  await page.goto("/learn");
  await expect(page.getByRole("heading", { name: "学习", exact: true })).toBeVisible();
  const audioFetched = await page.evaluate(async () => {
    const bootstrap = (await fetch("/api/content/bootstrap").then((response) => response.json())) as {
      release_id: string;
    };
    return bootstrap.release_id.length > 0;
  });
  expect(audioFetched).toBe(true);
  // Give the SW's write-through a moment to land, then require the cache.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const names = await caches.keys();
        return names.some((name) => name.startsWith("lexiloop-content-"));
      }),
    )
    .toBe(true);

  await logoutViaUi(page);

  const cacheNames = await page.evaluate(async () => await caches.keys());
  expect(cacheNames.filter((name) => name.startsWith("lexiloop-content-"))).toEqual([]);
  expect(cacheNames).not.toContain("lexiloop-audio-v1");
  expect(cacheNames).toContain("lexiloop-shell-v1");
});
