/**
 * The study card of one word (spec 9.3 step 3/4): headword, phonetic,
 * session-pinned audio, core senses, phrases, real-exam examples and
 * explanations, plus the three first-contact familiarity choices
 * (很陌生/有印象/熟悉). The choices only record the first impression via
 * FAMILIARITY_SET — they are never a grade, and they stay disabled until the
 * WORD_PRESENTED patch for this word is acknowledged by the Worker.
 *
 * Failures stay on-card: a failed content read or a failed audio load never
 * discards the study position (the parent simply keeps rendering this card).
 */

import { useEffect, useState } from "react";
import type { FamiliarityChoice } from "../../lib/api-client";
import type { StudyWordState } from "./useStudySession";

const FAMILIARITY_CHOICES: ReadonlyArray<{ value: FamiliarityChoice; label: string }> = [
  { value: "VERY_UNFAMILIAR", label: "很陌生" },
  { value: "SOMEWHAT_FAMILIAR", label: "有印象" },
  { value: "FAMILIAR", label: "熟悉" },
];

export interface WordStudyCardProps {
  /** Zero-based index of this word within the group. */
  position: number;
  total: number;
  word: StudyWordState;
  familiarityPending: boolean;
  /** Fully-qualified audio URL for the word, or null when unavailable. */
  audioUrl: string | null;
  onFamiliarity(choice: FamiliarityChoice): void;
  onRetryPresentation(): void;
  onRetryContent(): void;
  onNext(): void;
  nextLabel: string;
  nextDisabled: boolean;
}

export function WordStudyCard({
  position,
  total,
  word,
  familiarityPending,
  audioUrl,
  onFamiliarity,
  onRetryPresentation,
  onRetryContent,
  onNext,
  nextLabel,
  nextDisabled,
}: WordStudyCardProps): React.JSX.Element {
  const [audioFailed, setAudioFailed] = useState(false);
  useEffect(() => {
    setAudioFailed(false);
  }, [audioUrl]);

  const content = word.content;
  const familiarityDisabled = word.presentation !== "acked" || familiarityPending;
  const wordAudio = content?.audio.find(
    (asset) => asset.entity_type === "word" && asset.entity_key === word.wordKey,
  );

  return (
    <article className="study-card">
      <p>
        第 {position + 1} 词 / 共 {total} 词
      </p>
      {content === null ? (
        word.contentFailed ? (
          <>
            <p role="alert">词条内容加载失败，当前学习位置已保留。</p>
            <button type="button" className="btn" onClick={onRetryContent}>
              重试加载词条
            </button>
          </>
        ) : (
          <p role="status">正在加载词条…</p>
        )
      ) : (
        <>
          <h2>{content.word.headword}</h2>
          {content.word.phonetic ? <p>{content.word.phonetic}</p> : null}
          {wordAudio ? (
            <p>
              {/* Audio failure is announced inline; reading never blocked. */}
              <audio
                controls
                src={audioUrl ?? undefined}
                onError={() => setAudioFailed(true)}
              ></audio>
            </p>
          ) : null}
          {audioFailed ? <p role="status">音频暂时无法播放，可先继续学习。</p> : null}

          <section aria-label="核心词义">
            <h3>核心词义</h3>
            <ul>
              {content.senses.map((sense) => (
                <li key={sense.sense_key}>
                  <span>{sense.pos}</span> <strong>{sense.gloss}</strong>
                </li>
              ))}
            </ul>
          </section>

          {content.phrases.length > 0 ? (
            <section aria-label="短语">
              <h3>短语</h3>
              <ul>
                {content.phrases.map((phrase) => (
                  <li key={phrase.phrase_key}>
                    {phrase.text}（{phrase.gloss}）
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {content.examples.length > 0 ? (
            <section aria-label="例句">
              <h3>例句</h3>
              <ul>
                {content.examples.map((example) => (
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

          {content.explanations.length > 0 ? (
            <section aria-label="讲解">
              <h3>讲解</h3>
              {content.explanations.map((explanation) => (
                <div key={explanation.explanation_key}>
                  {explanation.syntax_notes.length > 0 ? (
                    <p>语法提示：{explanation.syntax_notes.join("；")}</p>
                  ) : null}
                  <p>翻译提示：{explanation.translation_hints}</p>
                  {explanation.pitfalls.length > 0 ? (
                    <p>易错提醒：{explanation.pitfalls.join("；")}</p>
                  ) : null}
                </div>
              ))}
            </section>
          ) : null}
        </>
      )}

      <section aria-label="首印象">
        <h3>首印象</h3>
        <p>首印象仅用于分类与统计，不是评分。</p>
        <div role="group" aria-label="选择首印象">
          {FAMILIARITY_CHOICES.map((choice) => (
            <button
              key={choice.value}
              type="button"
              className="btn"
              disabled={familiarityDisabled}
              aria-pressed={word.familiarity === choice.value}
              onClick={() => onFamiliarity(choice.value)}
            >
              {choice.label}
            </button>
          ))}
        </div>
        {word.presentation === "pending" ? (
          <p role="status">正在记录学习…</p>
        ) : null}
        {word.presentation === "deferred" ? (
          <p role="status">学习记录将在快速回忆时同步，请先继续。</p>
        ) : null}
        {word.presentation === "failed" ? (
          <>
            <p role="alert">学习记录未提交：{word.presentationError ?? "请重试"}</p>
            <button type="button" className="btn" onClick={onRetryPresentation}>
              重试学习记录
            </button>
          </>
        ) : null}
      </section>

      <button type="button" className="btn btn--primary" disabled={nextDisabled} onClick={onNext}>
        {nextLabel}
      </button>
    </article>
  );
}
