/**
 * The full word entry page (spec 9.5): the word's Unit, all senses,
 * phrases, examples, explanations, related words, and the caller's personal
 * study state (the ONLY personal fields, read from /api/progress/words).
 * Reached from search results and from review cards ("查看完整词条"); going
 * back to /review resumes the server-side review position.
 */

import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { ApiError, type ApiClient } from "../../lib/api-client";

export interface WordDetailPageProps {
  api: ApiClient;
}

/** Stored stage -> visible label (schema values, apps/worker). */
function stageLabel(stage: string): string {
  switch (stage) {
    case "UNSEEN":
      return "未学";
    case "IN_PROGRESS":
      return "学习中";
    case "INTRODUCED":
      return "已学";
    default:
      return stage;
  }
}

/** Stored first-contact familiarity -> visible label (spec 9.3 vocabulary). */
function familiarityLabel(value: string | null): string | null {
  switch (value) {
    case "UNKNOWN":
    case "VERY_UNFAMILIAR":
      return "很陌生";
    case "RECOGNIZABLE":
    case "SOMEWHAT_FAMILIAR":
      return "有印象";
    case "KNOWN":
    case "FAMILIAR":
      return "熟悉";
    default:
      return null;
  }
}

export function WordDetailPage({ api }: WordDetailPageProps): React.JSX.Element {
  const params = useParams();
  const wordKey = params.wordKey ?? "";

  const content = useQuery({
    queryKey: ["content", "word", wordKey],
    queryFn: () => api.wordContent(wordKey),
    enabled: wordKey !== "",
  });

  const progress = useQuery({
    queryKey: ["progress", "word", wordKey],
    queryFn: () => api.wordProgress(wordKey),
    enabled: wordKey !== "",
  });

  // Related words resolve to their headwords so the links read naturally;
  // unresolved entries fall back to the key.
  const related = useQuery({
    queryKey: ["content", "related", wordKey],
    queryFn: async (): Promise<Map<string, string>> => {
      const entries = content.data?.related ?? [];
      const resolved = await Promise.all(
        entries.map(async (entry) => {
          try {
            return [entry.to_word_key, (await api.wordContent(entry.to_word_key)).word.headword] as const;
          } catch {
            return [entry.to_word_key, entry.to_word_key] as const;
          }
        }),
      );
      return new Map(resolved);
    },
    enabled: content.isSuccess,
  });

  if (wordKey === "") {
    return (
      <section>
        <h1>词条</h1>
        <p role="alert">缺少词条参数。</p>
      </section>
    );
  }

  if (content.isError) {
    const notFound = content.error instanceof ApiError && content.error.status === 404;
    return (
      <section>
        <h1>词条</h1>
        <p role="alert">
          {notFound ? "词条不存在或已下架。" : "词条加载失败，请稍后重试。"}
        </p>
      </section>
    );
  }

  if (!content.isSuccess) {
    return (
      <section>
        <h1>词条</h1>
        <p role="status">正在加载词条…</p>
      </section>
    );
  }

  const data = content.data;
  const wordAudio = data.audio.find(
    (asset) => asset.entity_type === "word" && asset.entity_key === data.word.word_key,
  );
  const progressRow = progress.data?.progress ?? null;

  return (
    <article>
      <h1>{data.word.headword}</h1>
      {data.word.phonetic ? <p>{data.word.phonetic}</p> : null}
      <p>
        {data.unit ? (
          <>
            所属 Unit：<span>{data.unit.title}</span>
          </>
        ) : null}
      </p>
      {wordAudio ? (
        <p>
          <audio controls src={api.audioUrl(wordAudio.asset_key)}></audio>
        </p>
      ) : null}

      <section aria-label="全部义项">
        <h2>全部义项</h2>
        <ul>
          {data.senses.map((sense) => (
            <li key={sense.sense_key}>
              <span>{sense.pos}</span> <strong>{sense.gloss}</strong>
            </li>
          ))}
        </ul>
      </section>

      {data.phrases.length > 0 ? (
        <section aria-label="短语">
          <h2>短语</h2>
          <ul>
            {data.phrases.map((phrase) => (
              <li key={phrase.phrase_key}>
                {phrase.text}（{phrase.gloss}）
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.examples.length > 0 ? (
        <section aria-label="例句">
          <h2>例句</h2>
          <ul>
            {data.examples.map((example) => (
              <li key={example.example_key}>
                <p>
                  {example.origin === "exam" ? <span>真题 </span> : null}
                  {example.text}
                </p>
                {example.source_ref ? <p>来源：{example.source_ref}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.explanations.length > 0 ? (
        <section aria-label="讲解">
          <h2>讲解</h2>
          {data.explanations.map((explanation) => (
            <div key={explanation.explanation_key}>
              {explanation.syntax_notes.length > 0 ? (
                <p>语法提示：{explanation.syntax_notes.join("；")}</p>
              ) : null}
              <p>翻译提示：{explanation.translation_hints}</p>
              {explanation.pitfalls.length > 0 ? (
                <p>易错提醒：{explanation.pitfalls.join("；")}</p>
              ) : null}
              {explanation.context_meanings.length > 0 ? (
                <p>
                  语境义：
                  {explanation.context_meanings.map((meaning) => meaning.gloss).join("；")}
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      {data.related.length > 0 ? (
        <section aria-label="相关词">
          <h2>相关词</h2>
          <ul>
            {data.related.map((entry) => (
              <li key={`${entry.to_word_key}-${entry.relation_type}`}>
                <Link to={`/dictionary/words/${entry.to_word_key}`}>
                  {related.data?.get(entry.to_word_key) ?? entry.to_word_key}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label="个人学习状态">
        <h2>个人学习状态</h2>
        {progressRow ? (
          <>
            <p>
              阶段：<strong>{stageLabel(progressRow.stage)}</strong>
            </p>
            {familiarityLabel(progressRow.initial_familiarity) ? (
              <p>
                首印象：<strong>{familiarityLabel(progressRow.initial_familiarity)}</strong>
              </p>
            ) : null}
          </>
        ) : (
          <p>未学</p>
        )}
      </section>
    </article>
  );
}
