import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
    await expect(access(path)).resolves.toBeUndefined();
  });
});
