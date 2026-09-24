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
import { AppShell } from "./AppShell";
import { LoginPage } from "../features/auth/LoginPage";
import { TodayPage } from "../features/today/TodayPage";
import { LearnSetupPage } from "../features/learn/LearnSetupPage";
import { ReviewPage } from "../features/review/ReviewPage";
import { SearchPage } from "../features/dictionary/SearchPage";
import { WordDetailPage } from "../features/dictionary/WordDetailPage";
import { StatsPage } from "../features/stats/StatsPage";

export interface AppRoutesOptions {
  api: ApiClient;
  queryClient: AppQueryClient;
}

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

/**
 * The five destinations plus the word-detail route reached from search
 * results and review cards. `/today` and `/learn` landed with Task 16;
 * review, dictionary (search + word entry), and stats land with Task 17.
 */
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
          children: [
            { path: "today", element: <TodayPage api={api} /> },
            { path: "learn", element: <LearnSetupPage api={api} /> },
            { path: "review", element: <ReviewPage api={api} /> },
            { path: "dictionary", element: <SearchPage api={api} /> },
            { path: "dictionary/words/:wordKey", element: <WordDetailPage api={api} /> },
            { path: "stats", element: <StatsPage api={api} /> },
          ],
        },
      ],
    },
    { path: "*", element: <Navigate to="/today" replace /> },
  ];
}

export function createAppRouter(options: AppRoutesOptions): ReturnType<typeof createBrowserRouter> {
  return createBrowserRouter(createAppRoutes(options));
}
