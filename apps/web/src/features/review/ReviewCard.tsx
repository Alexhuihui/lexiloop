/**
 * One review card (spec 9.4): the prompt defaults to the context cloze (the
 * exam sentence with the target blanked) and falls back to the word-meaning
 * prompt when the card has no qualified context. The reveal shows the
 * answer, the contextual meaning, and a COLLAPSIBLE explanation block; the
 * card also links to the full word entry (returning later keeps the
 * server-side review position) and offers headword audio plus the latest
 * grade's undo.
 *
 * Prompt derivation (`buildReviewCards`): the session's due queue is ordered
 * by due time (spec 6.3) and may be an arbitrary SUBSET of the words' cards,
 * so position alignment (the NEW_WORDS approach) would present wrong
 * prompts. Instead each presented card key is matched against the stable
 * `content_card_key` values the compiler derives (packages/domain
 * stable-key.ts + cards/generator.ts), recomputed here from the pinned word
 * content plus the bootstrap unit→book map. A key that cannot be derived
 * (unknown book/unit, Web Crypto unavailable, aliased old key) degrades to a
 * generic prompt — never to a guessed prompt. The graded `card_key` ALWAYS
 * comes from the server's queue snapshot.
 */

import { Link } from "react-router-dom";
import type { GradeRating, WordContentResponse } from "../../lib/api-client";
import { blanked, type QuickRecallAnswer, type QuickRecallCard } from "../learn/QuickRecall";

/** The exam origin that qualifies for CONTEXT_MEANING cards (v1 rules). */
const EXAM_ORIGIN = "exam";

/** Stable-key slug prefix per card type (packages/domain cards/generator.ts). */
const CARD_KEY_SLUGS = {
  WORD_MEANING: "word_meaning",
  CONTEXT_MEANING: "context_meaning",
  PHRASE: "phrase",
  SENSE_DISCRIMINATION: "sense_discrimination",
} as const;

/**
 * SHA-256 stable card key over the canonical JSON shape of
 * packages/domain/src/stable-key.ts (keys sorted book < ordinal < slug <
 * type < unit, NFC strings, hex digest). Returns null without Web Crypto.
 */
async function stableCardKey(input: {
  book: string;
  unit: string;
  ordinal: number;
  slug: string;
}): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return null;
  }
  const canonical = `{"book":${JSON.stringify(input.book.normalize("NFC"))},"ordinal":${input.ordinal},"slug":${JSON.stringify(input.slug.normalize("NFC"))},"type":"card","unit":${JSON.stringify(input.unit.normalize("NFC"))}}`;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derives the review prompt for every queue card: each presented key is
 * matched against the word contents' recomputed card keys; unmatched keys
 * and failed word contents degrade to a generic prompt. The result has
 * EXACTLY `queue.length` cards.
 */
export async function buildReviewCards(
  contents: ReadonlyMap<string, WordContentResponse | null>,
  queue: ReadonlyArray<{ presented_card_key: string }>,
  bookByUnit: ReadonlyMap<string, string> | null,
): Promise<QuickRecallCard[]> {
  const generic = (index: number): QuickRecallCard => ({
    form: "generic",
    wordKey: null,
    prompt: `回忆第 ${index + 1} 张卡片的内容`,
    answer: null,
  });

  const cardByKey = new Map<string, QuickRecallCard>();
  for (const content of contents.values()) {
    if (!content) {
      continue;
    }
    const book = bookByUnit?.get(content.word.unit_key);
    if (book === undefined) {
      continue;
    }
    const ordinal = content.word.source_order;
    const explanation = content.explanations[0] ?? null;
    /** Recomputes the compiler's card key and files the prompt under it. */
    const push = async (slug: string, makeCard: () => QuickRecallCard): Promise<void> => {
      const key = await stableCardKey({ book, unit: content.word.unit_key, ordinal, slug });
      if (key !== null) {
        cardByKey.set(key, makeCard());
      }
    };

    for (const sense of content.senses) {
      await push(`${CARD_KEY_SLUGS.WORD_MEANING}:${sense.sense_key}`, () => ({
        form: "word",
        wordKey: content.word.word_key,
        headword: content.word.headword,
        phonetic: content.word.phonetic,
        answer: { senses: content.senses } satisfies QuickRecallAnswer,
      }));
    }

    if (explanation) {
      const seenExamples = new Set<string>();
      for (const meaning of explanation.context_meanings) {
        if (seenExamples.has(meaning.example_key)) {
          continue;
        }
        const example = content.examples.find(
          (candidate) => candidate.example_key === meaning.example_key,
        );
        if (!example || example.origin !== EXAM_ORIGIN) {
          continue;
        }
        seenExamples.add(meaning.example_key);
        await push(`${CARD_KEY_SLUGS.CONTEXT_MEANING}:${meaning.example_key}`, () => ({
          form: "context",
          wordKey: content.word.word_key,
          sentence: blanked(example.text, example.target_start, example.target_end),
          answer: {
            contextualGloss: meaning.gloss,
            fullSentence: example.text,
            sourceRef: example.source_ref,
          } satisfies QuickRecallAnswer,
        }));
      }
    }

    for (const phrase of content.phrases) {
      await push(`${CARD_KEY_SLUGS.PHRASE}:${phrase.phrase_key}`, () => ({
        form: "phrase",
        wordKey: content.word.word_key,
        text: phrase.text,
        answer: { phraseGloss: phrase.gloss } satisfies QuickRecallAnswer,
      }));
    }

    if (explanation) {
      for (const candidate of explanation.discrimination_candidates) {
        const against = contents.get(candidate.against_word_key);
        const againstHeadword = against?.word.headword ?? candidate.against_word_key;
        await push(
          `${CARD_KEY_SLUGS.SENSE_DISCRIMINATION}:${content.word.word_key}:${candidate.against_word_key}`,
          () => ({
            form: "discrimination",
            wordKey: content.word.word_key,
            prompt: `辨析：${content.word.headword} 与 ${againstHeadword}`,
            answer: { note: candidate.note } satisfies QuickRecallAnswer,
          }),
        );
      }
    }
  }

  return queue.map((item, index) => {
    const matched = cardByKey.get(item.presented_card_key);
    return matched ?? generic(index);
  });
}

const RATINGS: ReadonlyArray<{ value: GradeRating; label: string }> = [
  { value: 1, label: "再次" },
  { value: 2, label: "困难" },
  { value: 3, label: "良好" },
  { value: 4, label: "简单" },
];

export interface ReviewCardProps {
  /** Zero-based index into the session queue. */
  position: number;
  total: number;
  card: QuickRecallCard | null;
  /** Full entry of the card's word (drives the collapsible explanations). */
  content: WordContentResponse | null;
  revealed: boolean;
  gradePending: boolean;
  gradeError: string | null;
  canUndo: boolean;
  undoPending: boolean;
  undoError: string | null;
  /** Fully-qualified audio URL of the card's word, or null. */
  audioUrl: string | null;
  audioFailed: boolean;
  onReveal(): void;
  onRate(rating: GradeRating): void;
  onUndo(): void;
  onPlayAudio(): void;
}

function Prompt({ card }: { card: QuickRecallCard | null }): React.JSX.Element {
  if (!card) {
    return <p role="status">正在准备卡片…</p>;
  }
  switch (card.form) {
    case "context":
      return (
        <div>
          <p className="eyebrow">CONTEXT RECALL</p>
          <p className="recall-prompt">{card.sentence}</p>
        </div>
      );
    case "word":
      return (
        <div>
          <p className="eyebrow">WORD MEANING</p>
          <h2>{card.headword}</h2>
          {card.phonetic ? <p className="phonetic">{card.phonetic}</p> : null}
        </div>
      );
    case "phrase":
      return (
        <div>
          <p className="eyebrow">PHRASE RECALL</p>
          <p className="recall-prompt">{card.text}</p>
        </div>
      );
    case "discrimination":
      return (
        <div>
          <p className="eyebrow">WORD CHOICE</p>
          <p className="recall-prompt">{card.prompt}</p>
        </div>
      );
    case "generic":
      return <p>{card.prompt}</p>;
    default: {
      const exhaustive: never = card;
      return exhaustive;
    }
  }
}

/** The collapsible explanations of the card's word entry (spec 9.4). */
function Explanations({
  content,
}: {
  content: WordContentResponse | null;
}): React.JSX.Element | null {
  const explanation = content?.explanations[0] ?? null;
  if (!explanation) {
    return null;
  }
  return (
    <details className="explanation-block">
      <summary>查看讲解</summary>
      {explanation.syntax_notes.length > 0 ? (
        <p>语法提示：{explanation.syntax_notes.join("；")}</p>
      ) : null}
      <p>翻译提示：{explanation.translation_hints}</p>
      {explanation.pitfalls.length > 0 ? (
        <p>易错提醒：{explanation.pitfalls.join("；")}</p>
      ) : null}
      {/* Contextual meanings are the answer's 语境义 line, not repeated here. */}
    </details>
  );
}

function Answer({
  card,
  content,
}: {
  card: QuickRecallCard | null;
  content: WordContentResponse | null;
}): React.JSX.Element {
  if (!card || !card.answer) {
    return <p>已揭示。</p>;
  }
  const answer = card.answer;
  return (
    <section className="answer-panel" aria-label="参考答案">
      {answer.senses ? (
        <ul>
          {answer.senses.map((sense) => (
            <li key={`${sense.pos}-${sense.gloss}`}>
              <span>{sense.pos}</span> <strong>{sense.gloss}</strong>
            </li>
          ))}
        </ul>
      ) : null}
      {answer.contextualGloss !== undefined ? (
        <p>
          语境义：<strong>{answer.contextualGloss}</strong>
        </p>
      ) : null}
      {answer.fullSentence ? <p>原句：{answer.fullSentence}</p> : null}
      {answer.sourceRef ? <p>来源：{answer.sourceRef}</p> : null}
      {answer.phraseGloss ? (
        <p>
          释义：<strong>{answer.phraseGloss}</strong>
        </p>
      ) : null}
      {answer.note ? <p>{answer.note}</p> : null}
      <Explanations content={content} />
    </section>
  );
}

export function ReviewCard({
  position,
  total,
  card,
  content,
  revealed,
  gradePending,
  gradeError,
  canUndo,
  undoPending,
  undoError,
  audioUrl,
  audioFailed,
  onReveal,
  onRate,
  onUndo,
  onPlayAudio,
}: ReviewCardProps): React.JSX.Element {
  const wordKey = card && card.form !== "generic" ? card.wordKey : null;
  return (
    <article className="study-card recall-card">
      <div className="study-progress"><span>第 {position + 1} 张 / 共 {total} 张</span><div className="progress-track"><span style={{ width: `${total === 0 ? 0 : (position + 1) / total * 100}%` }} /></div></div>
      <div className="recall-card__prompt"><Prompt card={card} /></div>
      {revealed ? (
        <>
          <Answer card={card} content={content} />
          {gradeError ? (
            <p role="alert">评分未提交：{gradeError}（同一评分请求会安全重放，不会重复计分）</p>
          ) : null}
          <div className="rating-grid" role="group" aria-label="选择评分">
            {RATINGS.map((rating) => (
              <button
                key={rating.value}
                type="button"
                className={`rating-btn rating-btn--${rating.value}`}
                disabled={gradePending}
                onClick={() => onRate(rating.value)}
              >
                {rating.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <button type="button" className="btn btn--primary btn--block" onClick={onReveal}>
          揭示答案
        </button>
      )}

      <div className="study-card__utilities">
      {wordKey ? (
          <Link className="btn" to={`/dictionary/words/${wordKey}`}>
            查看完整词条
          </Link>
      ) : null}

      {audioUrl ? (
          <button type="button" className="btn" onClick={onPlayAudio}>
            播放读音
          </button>
      ) : null}
      </div>
      {/* Audio failure is announced inline; the review is never blocked. */}
      {audioFailed ? <p role="status">音频暂时无法播放，可先继续学习。</p> : null}

      {canUndo ? (
        <div className="undo-row">
          <button type="button" className="btn" disabled={undoPending} onClick={onUndo}>
            {undoPending ? "撤销中…" : "撤销上次评分"}
          </button>
        </div>
      ) : null}
      {undoError ? <p role="alert">撤销失败：{undoError}</p> : null}
    </article>
  );
}
