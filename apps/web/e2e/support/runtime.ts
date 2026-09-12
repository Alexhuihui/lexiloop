/**
 * Shared E2E runtime plumbing: the ONE place that knows where the local
 * harness listens and where it publishes its per-run state file.
 *
 * Imported by `playwright.config.ts` (webServer wiring), the specs (through
 * `support/harness.ts`), and the harness server itself
 * (`apps/worker/e2e-harness/server.ts`), so no spec ever hardcodes a base
 * URL or port. Pure constants only — no Node built-ins beyond path joining —
 * so both the browser-side tsconfig and the worker tsconfig can compile it.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fixed localhost port of the E2E harness (API + built PWA, one origin). */
export const E2E_PORT = 17653;

/** The harness origin the specs drive; injected via Playwright `baseURL`. */
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * The directory the harness creates for its per-run state. Everything under
 * it is explicitly created by the harness and explicitly removed on
 * teardown — nothing else is ever deleted.
 */
export function e2eStateDir(): string {
  return join(tmpdir(), `lexiloop-e2e-${E2E_PORT}`);
}

/** Per-run harness state (base URL + generated synthetic credentials). */
export function e2eStateFile(): string {
  return join(e2eStateDir(), "state.json");
}

/** URL Playwright polls to decide the harness is ready (static, no auth). */
export function e2eReadinessUrl(): string {
  return `${E2E_BASE_URL}/manifest.webmanifest`;
}
