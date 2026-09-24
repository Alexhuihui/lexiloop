/**
 * Spec-side harness helpers (plan Task 18): reads the per-run state file the
 * harness server writes (base URL + generated synthetic credentials — never
 * committed), and provides the login helpers plus a thin cookie/CSRF-aware
 * API client for API-level journey steps.
 *
 * The specs must never know HOW the server is hosted (wrangler dev vs the
 * Node adapter) — everything goes through the injected base URL.
 */
import { readFile } from "node:fs/promises";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { e2eStateFile } from "./runtime";

export interface HarnessUser {
  username: string;
  password: string;
}

export interface HarnessState {
  baseUrl: string;
  pid: number;
  users: HarnessUser[];
}

let cachedState: HarnessState | null = null;

/** Loads (and caches) the harness state; fails loudly when absent. */
export async function harnessState(): Promise<HarnessState> {
  if (cachedState !== null) {
    return cachedState;
  }
  const raw = await readFile(e2eStateFile(), "utf8");
  cachedState = JSON.parse(raw) as HarnessState;
  expect(cachedState.users.length).toBeGreaterThanOrEqual(2);
  return cachedState;
}

export function alice(state: HarnessState): HarnessUser {
  return state.users[0]!;
}

export function bob(state: HarnessState): HarnessUser {
  return state.users[1]!;
}

/** Fills and submits the login form, waiting for the shell to take over. */
export async function loginViaUi(page: Page, user: HarnessUser): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("用户名").fill(user.username);
  await page.getByLabel("密码").fill(user.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("button", { name: "退出登录" })).toBeVisible();
}

/** Clicks the shell logout button and waits for the login page. */
export async function logoutViaUi(page: Page): Promise<void> {
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("button", { name: "登录" })).toBeVisible();
}

// ---------------------------------------------------------------------------
// Cookie/CSRF-aware API client for API-level journey steps
// ---------------------------------------------------------------------------

export class SpecApi {
  private cookie: string | null = null;
  private csrf: string | null = null;

  constructor(
    private readonly request: APIRequestContext,
    private readonly baseUrl: string,
  ) {}

  private writeHeaders(): Record<string, string> {
    if (this.cookie === null || this.csrf === null) {
      throw new Error("SpecApi used before login()");
    }
    return {
      cookie: this.cookie,
      origin: this.baseUrl,
      "x-csrf-token": this.csrf,
      "content-type": "application/json",
    };
  }

  private readCookies(headers: Record<string, string>): void {
    const setCookie = headers["set-cookie"] ?? "";
    const match = /lexiloop_session=([^;]+)/.exec(setCookie);
    if (match) {
      this.cookie = `lexiloop_session=${match[1]}`;
    }
  }

  async login(user: HarnessUser): Promise<void> {
    const response = await this.request.post("/api/auth/login", {
      headers: { origin: this.baseUrl, "content-type": "application/json" },
      data: { username: user.username, password: user.password },
    });
    expect(response.status()).toBe(200);
    this.readCookies(response.headers());
    const body = (await response.json()) as { csrf_token: string };
    this.csrf = body.csrf_token;
  }

  /** The raw session cookie (revocation checks reuse it verbatim). */
  sessionCookie(): string {
    if (this.cookie === null) {
      throw new Error("SpecApi used before login()");
    }
    return this.cookie;
  }

  async get(path: string): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {};
    if (this.cookie !== null) {
      headers.cookie = this.cookie;
    }
    const response = await this.request.get(path, { headers });
    const body = response.status() === 204 ? null : await response.json().catch(() => null);
    return { status: response.status(), body };
  }

  async post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const response = await this.request.post(path, { headers: this.writeHeaders(), data: body });
    return { status: response.status(), body: await response.json().catch(() => null) };
  }

  async patch(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const response = await this.request.patch(path, { headers: this.writeHeaders(), data: body });
    return { status: response.status(), body: await response.json().catch(() => null) };
  }

  /** Unauthenticated-shaped request: no cookie, no CSRF (denial checks). */
  async anonGet(path: string): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
    const response = await this.request.get(path, { headers: {} });
    return {
      status: response.status(),
      body: await response.json().catch(() => null),
      headers: response.headers(),
    };
  }

  async createStudySession(mode: "NEW_WORDS" | "QUICK_TEST" | "REVIEW"): Promise<SessionShape> {
    const { body } = await this.post("/api/study/sessions", { mode });
    return body as SessionShape;
  }

  async studySession(sessionId: string): Promise<SessionShape> {
    const { body } = await this.get(`/api/study/sessions/${sessionId}`);
    return body as SessionShape;
  }

  async presentWord(sessionId: string, eventId: string, wordKey: string): Promise<void> {
    const result = await this.patch(`/api/study/sessions/${sessionId}`, {
      event_id: eventId,
      action: "WORD_PRESENTED",
      word_key: wordKey,
    });
    expect(result.status).toBe(200);
  }

  async grade(input: {
    event_id: string;
    session_id: string;
    card_key: string;
    rating: 1 | 2 | 3 | 4;
  }): Promise<GradeShape> {
    const result = await this.post("/api/reviews/grade", input);
    expect(result.status).toBe(200);
    return result.body as GradeShape;
  }

  async undo(eventId: string): Promise<UndoShape> {
    const result = await this.post(`/api/reviews/${eventId}/undo`, {});
    expect(result.status).toBe(200);
    return result.body as UndoShape;
  }

  async stats(): Promise<StatsShape> {
    const { body } = await this.get("/api/stats/overview");
    return body as StatsShape;
  }

  async bootstrap(sessionId?: string): Promise<BootstrapShape> {
    const { body } = await this.get(
      sessionId === undefined ? "/api/content/bootstrap" : `/api/content/bootstrap?session=${sessionId}`,
    );
    return body as BootstrapShape;
  }
}

/** Minimal shapes the specs assert on (mirrors the API client schemas). */
export interface SessionShape {
  session_id: string;
  mode: string;
  release_id: string;
  position: number;
  cards: Array<{ canonical_card_key: string; presented_card_key: string }>;
  current_card_key: string | null;
  unit_keys: string[];
  word_keys: string[];
}

/** Return type of `SpecApi.createStudySession` (specs reference it). */
export type CreatedStudySession = Awaited<ReturnType<SpecApi["createStudySession"]>>;

export interface GradeShape {
  event_id: string;
  card_key: string;
  presented_card_key: string;
  release_id: string;
  before_state: { due_at: number; reps: number } | null;
  after_state: { due_at: number; reps: number };
  replayed: boolean;
}

export interface UndoShape {
  event_id: string;
  card_key: string;
  restored_state: { due_at: number } | null;
  word_stage: string | null;
}

export interface StatsShape {
  learned_words: number;
  learned_cards: number;
  reviews_total: number;
  due_forecast: Array<{ date: string; cards: number }>;
}

export interface BootstrapShape {
  release_id: string;
  release: { status: string; activated_at: number | null };
  units: Array<{ unit_key: string; title: string }>;
}
