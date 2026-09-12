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
    <ul>
      {stats.difficult_words.map((word) => (
        <li key={word.word_key}>
          <strong>{word.headword ?? word.word_key}</strong>（遗忘 {word.lapses} 次，难度{" "}
          {word.max_difficulty}，{word.cards} 张卡）
        </li>
      ))}
    </ul>
  );
}

function ForecastList({ stats }: { stats: StatsOverview }): React.JSX.Element {
  if (stats.due_forecast.length === 0) {
    return <p>暂无到期预测。</p>;
  }
  return (
    <ul>
      {stats.due_forecast.map((day) => (
        <li key={day.date}>
          {day.date}：{day.cards} 张
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
      <section>
        <h1>数据</h1>
        <p role="status">正在加载…</p>
      </section>
    );
  }

  if (stats.isError || !stats.data) {
    return (
      <section>
        <h1>数据</h1>
        <p role="alert">统计数据加载失败，请稍后重试。</p>
      </section>
    );
  }

  const data = stats.data;
  return (
    <section>
      <h1>数据</h1>

      <section aria-label="学习概览">
        <h2>学习概览</h2>
        <p>
          已学单词 <strong>{data.learned_words}</strong> 个
        </p>
        <p>
          已学卡片 <strong>{data.learned_cards}</strong> 张
        </p>
        <p>
          估算记忆保持率{" "}
          <strong>{data.estimated_retention === null ? "暂无数据" : percent(data.estimated_retention)}</strong>
        </p>
      </section>

      <section aria-label="复习统计">
        <h2>复习统计</h2>
        <p>
          今日复习 <strong>{data.reviews_today}</strong> 次
        </p>
        <p>
          历史复习 <strong>{data.reviews_total}</strong> 次
        </p>
        <p>
          连续学习 <strong>{data.streak_days}</strong> 天
        </p>
      </section>

      <section aria-label="未来 30 天到期预测">
        <h2>未来 30 天到期预测</h2>
        <ForecastList stats={data} />
      </section>

      <section aria-label="困难词">
        <h2>困难词</h2>
        <DifficultList stats={data} />
      </section>

      <section aria-label="Unit 掌握度">
        <h2>Unit 掌握度</h2>
        {data.units.length === 0 ? <p>暂无 Unit 数据。</p> : null}
        <ul>
          {data.units.map((unit) => (
            <li key={unit.unit_key}>
              <p>
                <strong>{unit.title}</strong>：已学 {unit.studied_cards} / {unit.total_cards}{" "}
                张卡
              </p>
              <p>覆盖率 {percent(unit.coverage)}</p>
              <p>
                预测保持率{" "}
                {unit.estimated_retention === null ? "暂无数据" : percent(unit.estimated_retention)}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </section>
  );
}
