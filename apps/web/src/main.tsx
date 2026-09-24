/**
 * LexiLoop web entry point (plan Task 15): React root, memory-only query
 * client, the safe API client, and the app router. Personal data never leaves
 * memory here; persistence is the Service Worker's static-shell-only job
 * (Task 17) plus the HTTP session cookie owned by the worker.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { createApiClient } from "./lib/api-client";
import { createAppQueryClient } from "./lib/query-cache";
import { createAppRouter } from "./app/router";
import "./styles/index.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Missing #root element in index.html");
}

const api = createApiClient();
const queryClient = createAppQueryClient();
const router = createAppRouter({ api, queryClient });

// Service Worker (spec 10): the static-shell-only precache and the strict
// content/audio cache policy live in src/sw.ts; registration is
// production-only and best-effort (tests and dev run without it).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js", { type: "module" }).catch(() => {
    // Offline support is progressive: a failed registration is silent.
  });
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
