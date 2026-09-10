import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Resolve from the repo root (tests/smoke/ -> two levels up) so the test does
// not depend on the process cwd once real vitest projects exist.
const repoRoot = join(import.meta.dirname, "..", "..");

describe("workspace", () => {
  it.each([
    "apps/web/package.json",
    "apps/worker/package.json",
    "packages/content-schema/package.json",
    "packages/db/package.json",
    "packages/domain/package.json",
    "packages/fsrs/package.json",
    "tools/content-compiler/package.json",
  ])("contains %s", async (path) => {
    await expect(access(join(repoRoot, path))).resolves.toBeUndefined();
  });
});
