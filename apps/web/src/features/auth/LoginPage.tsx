/**
 * Login page (spec 7/8.1, plan Task 15): username/password form for the
 * preseeded accounts. Login validates Origin only — the CSRF token arrives in
 * the login response and is kept in the API client's memory for later writes.
 *
 * The router state `{ from }` (set by the unauthenticated redirect and the
 * auth-expiry path) names the route to restore after a successful login, so
 * an expired session resumes exactly where the user was (spec 11.2).
 */

import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError, type ApiClient } from "../../lib/api-client";
import { AUTH_ME_QUERY_KEY, type AppQueryClient } from "../../lib/query-cache";

export interface LoginPageProps {
  api: ApiClient;
  queryClient: AppQueryClient;
}

interface RouteState {
  from?: { pathname?: string };
}

/** Stable, user-facing messages; never surfaces raw server error text. */
function errorMessageFor(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case "AUTH_INVALID_CREDENTIALS":
        return "用户名或密码不正确";
      case "AUTH_ACCOUNT_DISABLED":
        return "账户已被禁用";
      case "RATE_LIMITED":
        return "尝试次数过多，请稍后再试";
      case "NETWORK_ERROR":
        return "网络连接失败，请检查网络后重试";
      default:
        break;
    }
  }
  return "服务暂时不可用，请稍后重试";
}

export function LoginPage({ api, queryClient }: LoginPageProps): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const fromPathname = (location.state as RouteState | null)?.from?.pathname ?? "/today";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const login = await api.login(username.trim(), password);
      // Seed the memory-only session cache so the shell does not re-probe.
      queryClient.setQueryData(AUTH_ME_QUERY_KEY, {
        user: login.user,
        session: login.session,
        settings: null,
      });
      navigate(fromPathname, { replace: true });
    } catch (cause) {
      setError(errorMessageFor(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <main id="main-content" className="login-page">
      <h1>登录 LexiLoop</h1>
      <form className="login-form" onSubmit={handleSubmit} noValidate>
        <div>
          <label htmlFor="login-username">用户名</label>
          <input
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            aria-invalid={error === null ? undefined : "true"}
            aria-describedby={error === null ? undefined : "login-error"}
          />
        </div>
        <div>
          <label htmlFor="login-password">密码</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={error === null ? undefined : "true"}
            aria-describedby={error === null ? undefined : "login-error"}
          />
        </div>
        {error !== null ? (
          <p id="login-error" role="alert" className="form-error">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn btn--primary" disabled={pending}>
          {pending ? "登录中…" : "登录"}
        </button>
      </form>
    </main>
  );
}
