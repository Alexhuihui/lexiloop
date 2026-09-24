/**
 * The /stats page (spec 9.6): every overview statistic — learned word/card
 * counts, the estimated memory retention, today + historical review counts,
 * the consecutive-study-day streak, the 30-day due forecast, difficult
 * (high-lapse) words, and Unit mastery (coverage + predicted retention).
 * Nullable estimates render 暂无数据 instead of a misleading zero.
 */

import { useQuery } from "@tanstack/react-query";
import type { ApiClient, StatsOverview } from "../../lib/api-client";
import { STATS_OVERVIEW_QUERY_KEY } from "../../lib/query-cache";

export interface StatsPageProps {
  api: ApiClient;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function DifficultList({ stats }: { stats: StatsOverview }): React.JSX.Element {
  if (stats.difficult_words.length === 0) {
    return <p>暂无困难词。</p>;
  }
  return (
    <ul className="difficult-list">
      {stats.difficult_words.map((word) => (
        <li key={word.word_key}>
          <div><strong>{word.headword ?? word.word_key}</strong><span>遗忘 {word.lapses} 次 · {word.cards} 张卡</span></div>
          <span className="difficulty-score">难度 {word.max_difficulty}</span>
        </li>
      ))}
    </ul>
  );
}

function ForecastList({ stats }: { stats: StatsOverview }): React.JSX.Element {
  if (stats.due_forecast.length === 0) {
    return <p>暂无到期预测。</p>;
  }
  const maxCards = Math.max(1, ...stats.due_forecast.map((day) => day.cards));
  return (
    <ul className="forecast-chart">
      {stats.due_forecast.map((day) => (
        <li key={day.date}>
          <strong>{day.cards} 张</strong>
          <span className="forecast-bar"><i style={{ height: `${Math.max(6, day.cards / maxCards * 100)}%` }} /></span>
          <span>{day.date}</span>
        </li>
      ))}
    </ul>
  );
}

export function StatsPage({ api }: StatsPageProps): React.JSX.Element {
  const stats = useQuery({
    queryKey: STATS_OVERVIEW_QUERY_KEY,
    queryFn: () => api.statsOverview(),
  });

  if (stats.isPending) {
    return (
      <section className="page">
        <header className="page-heading"><div><p className="eyebrow">INSIGHTS</p><h1>数据</h1></div></header>
        <p role="status">正在加载…</p>
      </section>
    );
  }

  if (stats.isError || !stats.data) {
    return (
      <section className="page">
        <header className="page-heading"><div><p className="eyebrow">INSIGHTS</p><h1>数据</h1></div></header>
        <p role="alert">统计数据加载失败，请稍后重试。</p>
      </section>
    );
  }

  const data = stats.data;
  return (
    <section className="page page--stats">
      <header className="page-heading"><div><p className="eyebrow">INSIGHTS</p><h1>数据</h1><p className="page-heading__lead">你的学习轨迹。看见积累，也看见下一步。</p></div></header>

      <section aria-labelledby="stats-overview-heading">
        <h2 id="stats-overview-heading" className="sr-only">学习概览</h2>
        <div className="metric-grid">
          <article className="metric-card metric-card--primary"><span className="metric-card__icon">Aa</span><p>已学单词</p><strong>{data.learned_words}</strong><small>个词</small></article>
          <article className="metric-card"><span className="metric-card__icon">▤</span><p>已学卡片</p><strong>{data.learned_cards}</strong><small>张卡</small></article>
          <article className="metric-card"><span className="metric-card__icon">◉</span><p>记忆保持率</p><strong>{data.estimated_retention === null ? "暂无数据" : percent(data.estimated_retention)}</strong><small>估算值</small></article>
        </div>
      </section>

      <section className="surface compact-stats" aria-label="复习统计">
        <div><strong>{data.reviews_today}</strong><span>今日复习</span></div>
        <div><strong>{data.reviews_total}</strong><span>历史复习</span></div>
        <div><strong>{data.streak_days}</strong><span>连续天数</span></div>
      </section>

      <section className="surface stats-section" aria-label="未来 30 天到期预测">
        <div className="section-heading"><div><p className="eyebrow">FORECAST</p><h2>未来 30 天到期预测</h2></div><span className="tag">卡片 / 天</span></div>
        <ForecastList stats={data} />
      </section>

      <section className="surface stats-section" aria-label="困难词">
        <div className="section-heading"><div><p className="eyebrow">FOCUS</p><h2>困难词</h2></div></div>
        <DifficultList stats={data} />
      </section>

      <section className="surface stats-section" aria-label="Unit 掌握度">
        <div className="section-heading"><div><p className="eyebrow">MASTERY</p><h2>Unit 掌握度</h2></div></div>
        {data.units.length === 0 ? <p>暂无 Unit 数据。</p> : null}
        <ul className="unit-list">
          {data.units.map((unit) => (
            <li key={unit.unit_key}>
              <div><strong>{unit.title}</strong><span>已学 {unit.studied_cards} / {unit.total_cards} 张卡</span></div>
              <div className="unit-list__numbers"><span>覆盖率 {percent(unit.coverage)}</span><span>预测保持率 {unit.estimated_retention === null ? "暂无数据" : percent(unit.estimated_retention)}</span></div>
              <div className="progress-track"><span style={{ width: percent(unit.coverage) }} /></div>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
