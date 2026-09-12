/**
 * App routes (plan Task 15): `/login`, the authenticated shell layout, and
 * the five destinations `/today`, `/learn`, `/review`, `/dictionary`,
 * `/stats`. Unauthenticated visitors are redirected to `/login` with the
 * attempted route preserved in `state.from` (spec 11.2: re-login resumes the
 * current route).
 */

import { useQuery } from "@tanstack/react-query";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { RouteObject } from "react-router-dom";
import { createBrowserRouter } from "react-router-dom";
import type { ApiClient } from "../lib/api-client";
import { AUTH_ME_QUERY_KEY, type AppQueryClient } from "../lib/query-cache";
import { AppShell, PlaceholderPage } from "./AppShell";
import { LoginPage } from "../features/auth/LoginPage";

export interface AppRoutesOptions {
  api: ApiClient;
  queryClient: AppQueryClient;
}

export const PLACEHOLDER_PAGES = [
  { path: "today", title: "今日" },
  { path: "learn", title: "学习" },
  { path: "review", title: "复习" },
  { path: "dictionary", title: "词典" },
  { path: "stats", title: "数据" },
] as const;

/**
 * Gate for every authenticated route. Pending shows a live status; a 401
 * error redirects to /login preserving the attempted route (the API client's
 * `onUnauthorized` handler performs the personal-state clearing; this
 * Navigate keeps rendering correct even without that wiring, e.g. in tests).
 */
function RequireAuth({ api }: { api: ApiClient }): React.JSX.Element {
  const location = useLocation();
  const me = useQuery({
    queryKey: AUTH_ME_QUERY_KEY,
    queryFn: () => api.me(),
    retry: false,
  });

  if (me.isPending) {
    return (
      <main id="main-content" className="app-main">
        <p role="status">正在加载…</p>
      </main>
    );
  }
  if (me.isError) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

export function createAppRoutes({ api, queryClient }: AppRoutesOptions): RouteObject[] {
  return [
    {
      path: "/login",
      element: <LoginPage api={api} queryClient={queryClient} />,
    },
    {
      path: "/",
      element: <RequireAuth api={api} />,
      children: [
        { index: true, element: <Navigate to="/today" replace /> },
        {
          element: <AppShell api={api} queryClient={queryClient} />,
          children: PLACEHOLDER_PAGES.map((page) => ({
            path: page.path,
            element: <PlaceholderPage title={page.title} />,
          })),
        },
      ],
    },
    { path: "*", element: <Navigate to="/today" replace /> },
  ];
}

export function createAppRouter(options: AppRoutesOptions): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(createAppRoutes(options));
}
