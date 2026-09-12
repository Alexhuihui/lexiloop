/**
 * The /today page (spec 9.2): due review and textbook new words shown
 * separately, due review recommended but never forced (the new-words entry
 * stays equally available), plus the consecutive-day streak, the current
 * Unit progress, and resumable sessions — including the supplemental
 * 待引入卡 quick-test count. All numbers come from GET /api/stats/overview,
 * the auth bootstrap (user settings) and GET /api/study/sessions.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ApiClient } from "../../lib/api-client";
import {
  AUTH_ME_QUERY_KEY,
  STATS_OVERVIEW_QUERY_KEY,
  STUDY_SESSIONS_QUERY_KEY,
} from "../../lib/query-cache";

export interface TodayPageProps {
  api: ApiClient;
}

/** Default when the user has no settings row (the Worker schema default). */
const DEFAULT_DAILY_GOAL = 10;

export function TodayPage({ api }: TodayPageProps): React.JSX.Element {
  const me = useQuery({ queryKey: AUTH_ME_QUERY_KEY, queryFn: () => api.me() });
  const stats = useQuery({
    queryKey: STATS_OVERVIEW_QUERY_KEY,
    queryFn: () => api.statsOverview(),
  });
  const sessions = useQuery({
    queryKey: STUDY_SESSIONS_QUERY_KEY,
    queryFn: () => api.listStudySessions(),
  });

  // Overdue cards are bucketed into day 0 of the forecast (spec 9.6), so
  // day 0 IS the due count.
  const dueToday = stats.data?.due_forecast[0]?.cards ?? 0;
  const dailyGoal = me.data?.settings?.daily_goal ?? DEFAULT_DAILY_GOAL;
  const startUnitKey = me.data?.settings?.start_unit_key ?? null;
  const currentUnit =
    stats.data?.units.find((unit) => unit.unit_key === startUnitKey) ??
    stats.data?.units[0] ??
    null;
  const resumable = (sessions.data ?? []).filter((session) => session.expires_at > Date.now());
  const learnSession = resumable.find((session) => session.mode === "NEW_WORDS");
  const supplementalCards = resumable
    .filter((session) => session.mode === "QUICK_TEST")
    .reduce((total, session) => total + session.cards.length, 0);

  return (
    <section>
      <h1>今日</h1>
      {stats.isPending || me.isPending ? <p role="status">正在加载…</p> : null}
      {stats.isError ? <p role="alert">统计数据加载失败，部分内容不可用。</p> : null}

      <section aria-labelledby="today-due-heading">
        <h2 id="today-due-heading">到期复习</h2>
        <p>
          <strong>{dueToday}</strong> 张卡到期
        </p>
        <p>建议先处理到期复习，但不强制；也可以直接开始学习新词。</p>
        <Link className="btn" to="/review">
          去复习
        </Link>
      </section>

      <section aria-labelledby="today-new-heading">
        <h2 id="today-new-heading">教材新词</h2>
        <p>
          今日新词目标 <strong>{dailyGoal}</strong> 个
        </p>
        <p>
          已学单词 <strong>{stats.data?.learned_words ?? 0}</strong> 个
        </p>
        <Link className="btn btn--primary" to="/learn">
          去学习
        </Link>
      </section>

      <p>
        连续学习 <strong>{stats.data?.streak_days ?? 0}</strong> 天
      </p>
      {currentUnit ? (
        <p>
          当前进度 {currentUnit.title}：已学 {currentUnit.studied_cards} /{" "}
          {currentUnit.total_cards} 张卡
        </p>
      ) : null}

      {learnSession || supplementalCards > 0 ? (
        <section aria-labelledby="today-resume-heading">
          <h2 id="today-resume-heading">继续学习</h2>
          {learnSession ? (
            <p>
              <Link className="btn" to="/learn">
                继续新词学习（第 {learnSession.position + 1} / {learnSession.cards.length} 张）
              </Link>
            </p>
          ) : null}
          {supplementalCards > 0 ? <p>快测待引入卡 {supplementalCards} 张</p> : null}
        </section>
      ) : null}
    </section>
  );
}
