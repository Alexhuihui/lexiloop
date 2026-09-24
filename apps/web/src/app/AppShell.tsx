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
  icon: "today" | "learn" | "review" | "dictionary" | "stats";
}

/** The five destinations (spec 9.1): mobile bottom nav and desktop sidebar. */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: "/today", label: "今日", icon: "today" },
  { path: "/learn", label: "学习", icon: "learn" },
  { path: "/review", label: "复习", icon: "review" },
  { path: "/dictionary", label: "词典", icon: "dictionary" },
  { path: "/stats", label: "数据", icon: "stats" },
] as const;

function NavIcon({ name }: { name: NavItem["icon"] }): React.JSX.Element {
  const paths = {
    today: <><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10M9 20v-6h6v6"/></>,
    learn: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22Z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22Z"/></>,
    review: <><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 1-2.05-4.95L20 10"/></>,
    dictionary: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
    stats: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
  } as const;
  return <svg className="app-nav__icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

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
            <NavIcon name={item.icon} />
            <span>{item.label}</span>
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

  // Section changes should begin at their own heading. Without this reset,
  // React Router can carry a long page's scroll offset into the next tab.
  useEffect(() => {
    globalThis.scrollTo?.(0, 0);
  }, [location.pathname]);

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
        <p className="app-title"><span className="app-title__mark">L</span><span>LexiLoop</span></p>
        <button type="button" className="header-action" onClick={handleLogout} disabled={loggingOut} aria-label="退出登录">
          <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 17l5-5-5-5M15 12H3"/><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/></svg>
          <span>{loggingOut ? "退出中…" : "退出"}</span>
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
