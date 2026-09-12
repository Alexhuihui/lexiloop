/**
 * Responsive authenticated app shell (spec 9.1, plan Task 15).
 *
 * - Landmarks: banner header, two labelled navigation landmarks (mobile bottom
 *   bar `主导航`, desktop left sidebar `侧边导航` — distinct names keep the
 *   landmark-unique rule satisfied), and the main content region.
 * - Touch targets (44px), high-contrast focus rings, reduced-motion handling
 *   and the English/Chinese reading font stack live in styles/index.css.
 * - Auth expiry: any 401 raised through the API client while the shell is
 *   mounted clears personal state (query cache, personal storage, Service
 *   Worker caches via message) and redirects to /login preserving the route.
 * - Logout follows the same clearing path after a best-effort logout write.
 */

import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import type { ApiClient } from "../lib/api-client";
import { clearPersonalState, type AppQueryClient } from "../lib/query-cache";

export interface NavItem {
  path: "/today" | "/learn" | "/review" | "/dictionary" | "/stats";
  label: string;
}

/** The five destinations (spec 9.1): mobile bottom nav and desktop sidebar. */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: "/today", label: "今日" },
  { path: "/learn", label: "学习" },
  { path: "/review", label: "复习" },
  { path: "/dictionary", label: "词典" },
  { path: "/stats", label: "数据" },
] as const;

export interface AppShellProps {
  api: ApiClient;
  queryClient: AppQueryClient;
}

function NavList(): React.JSX.Element {
  return (
    <ul className="app-nav__list">
      {NAV_ITEMS.map((item) => (
        <li key={item.path}>
          <NavLink
            to={item.path}
            className={({ isActive }) =>
              isActive ? "app-nav__item app-nav__item--active" : "app-nav__item"
            }
          >
            {item.label}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function AppShell({ api, queryClient }: AppShellProps): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  // Central auth-expiry handling: every 401 from any API call lands here.
  useEffect(() => {
    api.setOnUnauthorized(() => {
      // Redirect first and commit synchronously (flushSync), so authenticated
      // pages and their query observers unmount BEFORE the cache is dropped —
      // otherwise a still-mounted observer immediately re-creates and
      // refetches a personal query with a dead session.
      navigate("/login", {
        replace: true,
        state: { from: locationRef.current },
        flushSync: true,
      });
      clearPersonalState(queryClient);
    });
    return () => {
      api.setOnUnauthorized(undefined);
    };
  }, [api, queryClient, navigate]);

  async function handleLogout(): Promise<void> {
    setLoggingOut(true);
    try {
      await api.logout();
    } catch {
      // Best effort: even a failed logout write must clear local state.
    } finally {
      clearPersonalState(queryClient);
      navigate("/login", { replace: true });
    }
  }

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      <header className="app-header">
        <p className="app-title">LexiLoop</p>
        <button type="button" className="btn" onClick={handleLogout} disabled={loggingOut}>
          {loggingOut ? "退出中…" : "退出登录"}
        </button>
      </header>
      <div className="app-body">
        {/* Mobile: fixed bottom bar (spec 9.1). Hidden at the md breakpoint. */}
        <nav aria-label="主导航" className="app-nav app-nav--bottom md:hidden">
          <NavList />
        </nav>
        {/* Desktop: left sidebar (spec 9.1). Hidden until the md breakpoint. */}
        <nav aria-label="侧边导航" className="app-nav app-nav--side hidden md:flex">
          <NavList />
        </nav>
        <main id="main-content" className="app-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/**
 * Minimal destination page used until the feature tasks (16/17) provide the
 * real Today/Learn/Review/Dictionary/Stats pages.
 */
export function PlaceholderPage({ title }: { title: string }): React.JSX.Element {
  return (
    <section>
      <h1>{title}</h1>
      <p>此页面将在后续任务中实现。</p>
    </section>
  );
}
