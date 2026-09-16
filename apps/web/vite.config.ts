/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Make every production build publish a distinct Service Worker. The worker
// uses this id for its shell cache, so a newly deployed frontend cannot keep
// serving an older cached document while its hashed assets have changed.
const buildId = Date.now().toString(36);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __LEXILOOP_BUILD_ID__: JSON.stringify(buildId),
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // The Service Worker is a separate entry so the build emits a stable
        // /sw.js next to the hashed app assets.
        sw: fileURLToPath(new URL("./src/sw.ts", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
      },
    },
  },
  test: {
    // Component tests run under happy-dom (plan Task 1); no browser-only APIs
    // without guards, so the suite stays runnable in CI without a real browser.
    environment: "happy-dom",
    // The Playwright specs in e2e/ are driven by apps/web/playwright.config.ts
    // (Task 18) — they must never run inside the vitest suite.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
