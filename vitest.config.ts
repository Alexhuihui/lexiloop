import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 5 removed the dedicated workspace file; projects live here.
    // Each workspace package that gains tests gets its own vitest config and
    // is picked up through these globs.
    projects: ["apps/*", "packages/*", "tools/*", "tests/*"],
  },
});
