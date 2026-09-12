/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    // Component tests run under happy-dom (plan Task 1); no browser-only APIs
    // without guards, so the suite stays runnable in CI without a real browser.
    environment: "happy-dom",
  },
});
