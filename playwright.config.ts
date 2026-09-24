/**
 * Root re-export so the plan's repo-root verification command
 * (`pnpm exec playwright test`) drives the real E2E suite config, which
 * lives beside the specs in apps/web (plan Task 18). All paths in that
 * config (testDir, outputDir, webServer command cwd) resolve relative to
 * its own file location, so this file adds no behavior of its own.
 */
export { default } from "./apps/web/playwright.config";
