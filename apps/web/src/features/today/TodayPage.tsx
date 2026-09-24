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
    <section className="page page--today">
      <header className="page-heading">
        <div><p className="eyebrow">TODAY</p><h1>今日</h1><p className="page-heading__lead">今天学什么？保持一点节奏，进步会慢慢累积。</p></div>
        <div className="streak-pill" aria-label={`连续学习 ${stats.data?.streak_days ?? 0} 天`}><span>✦</span><strong>{stats.data?.streak_days ?? 0}</strong><small>天连续</small></div>
      </header>
      {stats.isPending || me.isPending ? <p role="status">正在加载…</p> : null}
      {stats.isError ? <p role="alert">统计数据加载失败，部分内容不可用。</p> : null}

      <div className="today-actions">
        <section className="action-card action-card--review" aria-labelledby="today-due-heading">
          <div className="action-card__top"><span className="action-card__icon">↻</span><span className="status-dot">推荐先完成</span></div>
          <div><p className="eyebrow">SPACED REVIEW</p><h2 id="today-due-heading">到期复习</h2></div>
          <p className="action-card__number"><strong>{dueToday}</strong><span>张卡待复习</span></p>
          <p className="action-card__copy">建议趁记忆还清晰时巩固一下，几分钟就能完成。</p>
          <Link aria-label="去复习" className="btn btn--secondary btn--block" to="/review">开始复习 <span aria-hidden="true">→</span></Link>
        </section>

        <section className="action-card action-card--learn" aria-labelledby="today-new-heading">
          <div className="action-card__top"><span className="action-card__icon">Aa</span><span className="status-dot status-dot--warm">每日目标 {dailyGoal}</span></div>
          <div><p className="eyebrow">NEW WORDS</p><h2 id="today-new-heading">教材新词</h2></div>
          <p className="action-card__number"><strong>{dailyGoal}</strong><span>个今日目标</span></p>
          <p className="action-card__copy">已学单词 <strong>{stats.data?.learned_words ?? 0}</strong> 个 · 跟随教材顺序继续积累。</p>
          <Link aria-label="去学习" className="btn btn--primary btn--block" to="/learn">进入学习 <span aria-hidden="true">→</span></Link>
        </section>
      </div>

      {currentUnit ? (
        <section className="surface progress-card" aria-label="当前进度">
          <div className="section-heading"><div><p className="eyebrow">YOUR PROGRESS</p><h2>学习进度</h2></div><strong>{currentUnit.title}</strong></div>
          <div className="progress-track"><span style={{ width: `${Math.min(100, currentUnit.total_cards === 0 ? 0 : currentUnit.studied_cards / currentUnit.total_cards * 100)}%` }} /></div>
          <div className="progress-meta"><span>已学 {currentUnit.studied_cards} / {currentUnit.total_cards} 张卡</span><span>累计 {stats.data?.learned_words ?? 0} 个词</span></div>
        </section>
      ) : null}

      {learnSession || supplementalCards > 0 ? (
        <section className="surface resume-card" aria-labelledby="today-resume-heading">
          <div><p className="eyebrow">PICK UP WHERE YOU LEFT</p><h2 id="today-resume-heading">继续学习</h2></div>
          {learnSession ? (
              <Link className="btn btn--secondary" to="/learn">继续新词学习 · 第 {learnSession.position + 1} / {learnSession.cards.length} 张</Link>
          ) : null}
          {supplementalCards > 0 ? <span className="tag">快测待引入卡 {supplementalCards} 张</span> : null}
        </section>
      ) : null}
    </section>
  );
}
