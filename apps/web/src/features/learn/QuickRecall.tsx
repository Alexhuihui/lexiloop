/**
 * Quick recall (spec 9.3 step 5/6): after the group's words are studied, the
 * session's queue is graded in the SERVER's snapshot order (the client never
 * reshuffles). Consecutive WORD_MEANING cards for one word are presented as
 * one visible card and batch-graded atomically; context, phrase, and
 * discrimination cards stay independent. Each visible card first shows the
 * prompt, and only after the explicit reveal do the four FSRS ratings appear.
 *
 * `buildQuickRecallCards` aligns the server's queue with the cards the
 * client can derive from the group's word contents (spec 5.7 rule 2 order:
 * card-type rank -> word source order -> target key). The alignment drives
 * PROMPT RENDERING/GROUPING ONLY — graded `card_key`s always come from the
 * server's queue snapshot. When the derivable model does not match the
 * queue's length, every card degrades to a generic prompt instead of risking
 * a mismatched prompt.
 */

import type { GradeRating } from "../../lib/api-client";
import type { StudyWordState } from "./useStudySession";

export interface QuickRecallAnswer {
  senses?: Array<{ pos: string; gloss: string }>;
  contextualGloss?: string;
  fullSentence?: string;
  sourceRef?: string | null;
  phraseGloss?: string;
  note?: string;
}

export type QuickRecallCard =
  | { form: "word"; wordKey: string; headword: string; phonetic: string | null; answer: QuickRecallAnswer }
  | { form: "context"; wordKey: string; sentence: string; answer: QuickRecallAnswer }
  | { form: "phrase"; wordKey: string; text: string; answer: QuickRecallAnswer }
  | { form: "discrimination"; wordKey: string; prompt: string; answer: QuickRecallAnswer }
  | { form: "generic"; wordKey: string | null; prompt: string; answer: QuickRecallAnswer | null };

/** Fixed queue rank per card type (spec 5.7 rule 2 — the FIRST sort key). */
const TYPE_RANK = {
  WORD_MEANING: 0,
  CONTEXT_MEANING: 1,
  PHRASE: 2,
  SENSE_DISCRIMINATION: 3,
} as const;

/** The exam origin that qualifies for CONTEXT_MEANING cards (v1 rules). */
const EXAM_ORIGIN = "exam";

const BLANK = "＿";

/** Blanks the target range of an example sentence (shared with review). */
export function blanked(text: string, start: number, end: number): string {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  return `${text.slice(0, safeStart)}${BLANK.repeat(safeEnd - safeStart)}${text.slice(safeEnd)}`;
}

interface ExpectedEntry {
  rank: number;
  sourceOrder: number;
  target: string;
  card: QuickRecallCard;
}

function entriesForWord(word: StudyWordState, headwordOf: (wordKey: string) => string): ExpectedEntry[] {
  const content = word.content;
  if (!content) {
    return [];
  }
  const entries: ExpectedEntry[] = [];
  const explanation = content.explanations[0] ?? null;

  for (const sense of content.senses) {
    entries.push({
      rank: TYPE_RANK.WORD_MEANING,
      sourceOrder: word.sourceOrder,
      target: sense.sense_key,
      card: {
        form: "word",
        wordKey: word.wordKey,
        headword: word.headword,
        phonetic: word.phonetic,
        answer: {
          senses: [{ pos: sense.pos, gloss: sense.gloss }],
        },
      },
    });
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
      entries.push({
        rank: TYPE_RANK.CONTEXT_MEANING,
        sourceOrder: word.sourceOrder,
        target: meaning.example_key,
        card: {
          form: "context",
          wordKey: word.wordKey,
          sentence: blanked(example.text, example.target_start, example.target_end),
          answer: {
            contextualGloss: meaning.gloss,
            fullSentence: example.text,
            sourceRef: example.source_ref,
          },
        },
      });
    }
  }

  for (const phrase of content.phrases) {
    entries.push({
      rank: TYPE_RANK.PHRASE,
      sourceOrder: word.sourceOrder,
      target: phrase.phrase_key,
      card: {
        form: "phrase",
        wordKey: word.wordKey,
        text: phrase.text,
        answer: { phraseGloss: phrase.gloss },
      },
    });
  }

  if (explanation) {
    for (const candidate of explanation.discrimination_candidates) {
      entries.push({
        rank: TYPE_RANK.SENSE_DISCRIMINATION,
        sourceOrder: word.sourceOrder,
        target: candidate.against_word_key,
        card: {
          form: "discrimination",
          wordKey: word.wordKey,
          prompt: `辨析：${word.headword} 与 ${headwordOf(candidate.against_word_key)}`,
          answer: { note: candidate.note },
        },
      });
    }
  }

  return entries;
}

/**
 * Aligns the group's derivable cards with the server's queue snapshot. The
 * result has EXACTLY `queue.length` entries, aligned index-by-index with the
 * queue; unalignable cards become generic prompts.
 */
export function buildQuickRecallCards(
  words: readonly StudyWordState[],
  queue: ReadonlyArray<{ presented_card_key: string }>,
): QuickRecallCard[] {
  const headwordOf = (wordKey: string): string =>
    words.find((word) => word.wordKey === wordKey)?.headword ?? wordKey;
  const expected = words
    .flatMap((word) => entriesForWord(word, headwordOf))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.sourceOrder - right.sourceOrder ||
        (left.target < right.target ? -1 : left.target > right.target ? 1 : 0),
    );
  if (expected.length !== queue.length) {
    return queue.map((_, index) => ({
      form: "generic" as const,
      wordKey: null,
      prompt: `回忆第 ${index + 1} 张卡片的内容`,
      answer: null,
    }));
  }
  return expected.map((entry) => entry.card);
}

/** One learner-visible recall item. Consecutive WORD_MEANING cards for the
 * same word are one interaction: their distinct sense answers are merged,
 * while `rawLength` preserves how many server-side FSRS cards the rating
 * must update atomically. Other card types remain one visible item each. */
export interface QuickRecallGroup {
  card: QuickRecallCard;
  rawStart: number;
  rawLength: number;
}

export function groupQuickRecallCards(cards: readonly QuickRecallCard[]): QuickRecallGroup[] {
  const groups: QuickRecallGroup[] = [];
  let index = 0;
  while (index < cards.length) {
    const first = cards[index]!;
    if (first.form !== "word") {
      groups.push({ card: first, rawStart: index, rawLength: 1 });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (
      end < cards.length &&
      cards[end]?.form === "word" &&
      cards[end]?.wordKey === first.wordKey
    ) {
      end += 1;
    }
    const senses = cards
      .slice(index, end)
      .flatMap((card) => card.answer?.senses ?? [])
      .filter(
        (sense, senseIndex, all) =>
          all.findIndex(
            (candidate) => candidate.pos === sense.pos && candidate.gloss === sense.gloss,
          ) === senseIndex,
      );
    groups.push({
      card: {
        ...first,
        answer: { ...first.answer, senses },
      },
      rawStart: index,
      rawLength: end - index,
    });
    index = end;
  }
  return groups;
}

const RATINGS: ReadonlyArray<{ value: GradeRating; label: string }> = [
  { value: 1, label: "再次" },
  { value: 2, label: "困难" },
  { value: 3, label: "良好" },
  { value: 4, label: "简单" },
];

export interface QuickRecallProps {
  /** Zero-based index into the session queue. */
  cardIndex: number;
  total: number;
  card: QuickRecallCard | null;
  revealed: boolean;
  gradePending: boolean;
  pendingRating: GradeRating | null;
  gradeError: string | null;
  onReveal(): void;
  onRate(rating: GradeRating): void;
}

function QuestionPrompt({ card }: { card: QuickRecallCard | null }): React.JSX.Element {
  if (!card) {
    return <p>正在准备卡片…</p>;
  }
  switch (card.form) {
    case "word":
      return (
        <div>
          <h2>{card.headword}</h2>
          {card.phonetic ? <p className="phonetic">{card.phonetic}</p> : null}
        </div>
      );
    case "context":
      return (
        <div>
          <p className="eyebrow">CONTEXT RECALL</p>
          <p className="recall-prompt">{card.sentence}</p>
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

function Answer({ card }: { card: QuickRecallCard | null }): React.JSX.Element {
  if (!card || !card.answer) {
    return <p>已揭示。</p>;
  }
  const answer = card.answer;
  return (
    <div className="answer-panel">
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
    </div>
  );
}

export function QuickRecall({
  cardIndex,
  total,
  card,
  revealed,
  gradePending,
  pendingRating,
  gradeError,
  onReveal,
  onRate,
}: QuickRecallProps): React.JSX.Element {
  return (
    <section className="study-card recall-card">
      <div className="study-progress"><span>第 {cardIndex + 1} 张 / 共 {total} 张</span><div className="progress-track"><span style={{ width: `${total === 0 ? 0 : (cardIndex + 1) / total * 100}%` }} /></div></div>
      <div className="recall-card__prompt"><QuestionPrompt card={card} /></div>
      {revealed ? (
        <>
          <Answer card={card} />
          {gradeError ? (
            <p role="alert">评分未提交：{gradeError}（同一评分请求会安全重放，不会重复计分）</p>
          ) : null}
          <div className="rating-grid" role="group" aria-labelledby="recall-rating-label">
            <p id="recall-rating-label">选择评分</p>
            {RATINGS.map((rating) => (
              <button
                key={rating.value}
                type="button"
                className={`rating-btn rating-btn--${rating.value}`}
                disabled={gradePending}
                aria-pressed={pendingRating === rating.value}
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
    </section>
  );
}
