/// <reference types="vitest/config" />
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  },
});
