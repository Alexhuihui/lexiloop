/**
 * Playwright driver for the LexiLoop full-stack E2E suite (plan Task 18).
 *
 * The suite runs webServer-less from the specs' point of view: this config
 * starts the deterministic local harness
 * (`apps/worker/e2e-harness/server.ts`), which serves the REAL deps-injectable
 * Worker app (better-sqlite3 D1 shape + a private-store R2 fake) and the
 * freshly built PWA from ONE origin. Teardown of that process removes only
 * the temp directory the harness itself created.
 *
 * Serial by construction (`workers: 1`, no retries): every spec builds on
 * the shared synthetic release fixture and the shared injectable clock, and
 * no failure may be masked by an automatic retry.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL, e2eReadinessUrl } from "./e2e/support/runtime";

const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Absolute paths: this config is also re-exported by the repo-root
  // playwright.config.ts, and Playwright resolves relative paths against the
  // config file named on the command line, not against this file.
  testDir: join(configDir, "e2e"),
  outputDir: join(configDir, "test-results"),
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: E2E_BASE_URL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // `playwright install chromium` could not complete in the original
        // authoring environment (CDN download stalled), so the suite pins
        // the system Google Chrome via the supported `chrome` channel. On a
        // machine without system Chrome, drop this line after running
        // `pnpm exec playwright install chromium`.
        channel: "chrome",
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
      },
    },
  ],
  webServer: {
    // cwd-independent (the root re-export config runs this from the repo
    // root): build the PWA, then boot the harness from the worker package so
    // its imports resolve through the worker's dependency map.
    command:
      "pnpm --filter @lexiloop/web build && pnpm --filter @lexiloop/worker exec tsx e2e-harness/server.ts",
    url: e2eReadinessUrl(),
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
