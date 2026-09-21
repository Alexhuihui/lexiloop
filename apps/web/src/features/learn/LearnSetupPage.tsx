/**
 * The /learn page (spec 9.3): the SETUP state of the learning state machine
 * plus the host for the whole journey.
 *
 * Setup lets the user keep the last position (default: the settings'
 * start unit), or pick a Unit and a tier, and previews the expected group in
 * textbook order. The FIXED group itself is always the server's decision
 * (the queue snapshot of POST /api/study/sessions) — the client only
 * previews and never reshuffles; the card count shown after starting is the
 * server's queue length.
 *
 * Phases render from useStudySession: SETUP -> STUDY_WORDS (WordStudyCard)
 * -> QUICK_RECALL_QUESTION / QUICK_RECALL_REVEALED (QuickRecall) ->
 * COMPLETE. All progress persists through the Worker Session APIs only.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type {
  ApiClient,
  MeResponse,
  UnitContentResponse,
  WordProgressResponse,
} from "../../lib/api-client";
import {
  AUTH_ME_QUERY_KEY,
  CONTENT_BOOTSTRAP_QUERY_KEY,
  STUDY_SESSIONS_QUERY_KEY,
  unitContentQueryKey,
} from "../../lib/query-cache";
import { useStudySession, type StudySessionControls } from "./useStudySession";
import { WordStudyCard } from "./WordStudyCard";
import { QuickRecall } from "./QuickRecall";

export interface LearnSetupPageProps {
  api: ApiClient;
}

type SetupWord = UnitContentResponse["words"][number];
type ProgressMap = Record<string, WordProgressResponse["progress"]>;

const ALL_TIERS = "ALL";

/** True when the session's derived group equals the expected group (sets). */
function sameGroup(sessionWordKeys: readonly string[], expectedWordKeys: ReadonlySet<string>): boolean {
  const sessionKeys = new Set(sessionWordKeys);
  return (
    sessionKeys.size === expectedWordKeys.size &&
    [...expectedWordKeys].every((key) => sessionKeys.has(key))
  );
}

/** Status tag of one preview word (personal stage comes from progress only). */
function stageTag(word: SetupWord, progress: ProgressMap, inGroup: boolean): string {
  const stage = progress[word.word_key]?.stage ?? null;
  if (stage === "INTRODUCED") {
    return "已学";
  }
  return inGroup ? "在本组" : "待学";
}

/**
 * The expected group: the first `groupSize` words of the tier-filtered unit
 * list that are not yet INTRODUCED, in the server's textbook order
 * (tier, then source order).
 */
function expectedGroup(
  words: readonly SetupWord[],
  progress: ProgressMap,
  tierFilter: string,
  groupSize: number,
): SetupWord[] {
  return words
    .filter((word) => tierFilter === ALL_TIERS || word.tier === tierFilter)
    .filter((word) => progress[word.word_key]?.stage !== "INTRODUCED")
    .slice(0, groupSize);
}

interface SetupViewProps {
  api: ApiClient;
  settings: MeResponse["settings"];
  study: StudySessionControls;
}

function SetupView({ api, settings, study }: SetupViewProps): React.JSX.Element {
  const [unitKey, setUnitKey] = useState("");
  const [tierFilter, setTierFilter] = useState<string>(ALL_TIERS);

  const bootstrap = useQuery({
    queryKey: CONTENT_BOOTSTRAP_QUERY_KEY,
    queryFn: () => api.bootstrap(),
  });
  const sessions = useQuery({
    queryKey: STUDY_SESSIONS_QUERY_KEY,
    queryFn: () => api.listStudySessions(),
  });

  // 沿用上次位置: default the unit to the settings' start unit, else the
  // first textbook unit.
  useEffect(() => {
    if (unitKey === "") {
      const fallback =
        settings?.start_unit_key ?? bootstrap.data?.units[0]?.unit_key ?? "";
      if (fallback !== "") {
        setUnitKey(fallback);
      }
    }
  }, [unitKey, settings, bootstrap.data]);

  const unit = useQuery({
    queryKey: unitContentQueryKey(unitKey),
    queryFn: () => api.unitContent(unitKey),
    enabled: unitKey !== "",
  });
  const progress = useQuery({
    queryKey: ["progress", "unit", unitKey],
    queryFn: async (): Promise<ProgressMap> => {
      const words = unit.data?.words ?? [];
      const entries = await Promise.all(
        words.map(async (word) => {
          try {
            return [word.word_key, (await api.wordProgress(word.word_key)).progress] as const;
          } catch {
            return [word.word_key, null] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    },
    enabled: unitKey !== "" && unit.data !== undefined,
  });

  const words = unit.data?.words ?? [];
  const progressMap = progress.data ?? {};
  const group = expectedGroup(words, progressMap, tierFilter, settings?.new_words_per_group ?? 10);
  const groupKeys = new Set(group.map((word) => word.word_key));
  const tiers = [...new Set(words.map((word) => word.tier))];
  const resumableSessions = (sessions.data ?? []).filter(
    (session) => session.mode === "NEW_WORDS" && session.expires_at > Date.now(),
  );
  // Only a session whose snapshot group matches the current selection is
  // resumable here; anything else would continue against the wrong words.
  const resumable = resumableSessions.find((session) => sameGroup(session.word_keys, groupKeys));
  const hasUnmatched = resumableSessions.length > 0 && !resumable;
  const expectedGroupWords = group.map(toGroupWord);
  const visibleWords = words.filter((word) => tierFilter === ALL_TIERS || word.tier === tierFilter);

  return (
    <section className="learn-setup">
      <div className="section-heading"><div><p className="eyebrow">SET UP YOUR SESSION</p><h2>开始新词学习</h2><p>选择范围，我们会按教材顺序安排这一组。</p></div></div>
      {bootstrap.isPending || sessions.isPending ? <p role="status">正在加载…</p> : null}
      {bootstrap.isError || sessions.isError ? (
        <p role="alert">学习内容加载失败，请稍后重试。</p>
      ) : null}
      {study.setupError ? <p role="alert">{study.setupError}</p> : null}

      <div className="setup-controls">
      <div className="field-card"><label htmlFor="learn-unit">选择单元</label>
        <select
          id="learn-unit"
          value={unitKey}
          onChange={(event) => setUnitKey(event.target.value)}
        >
          {bootstrap.data?.units.map((unitOption) => (
            <option key={unitOption.unit_key} value={unitOption.unit_key}>
              {unitOption.title}
            </option>
          ))}
        </select>
      </div>
      <div className="field-card"><label htmlFor="learn-tier">选择分层</label>
        <select
          id="learn-tier"
          value={tierFilter}
          onChange={(event) => setTierFilter(event.target.value)}
        >
          <option value={ALL_TIERS}>全部分层</option>
          {tiers.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </select>
      </div>
      </div>

      <section className="word-preview" aria-labelledby="word-preview-heading">
        <div className="word-preview__heading"><div><p className="eyebrow">UP NEXT</p><h3 id="word-preview-heading">本组预览</h3></div><strong>{group.length}<small> 个新词</small></strong></div>
        <p className="word-preview__summary">预计本组 {group.length} 个新词（按教材顺序学习）。</p>
        <ul aria-label="本单元单词顺序">
        {visibleWords.map((word, index) => (
            <li key={word.word_key}>
              <span className="word-preview__index">{String(index + 1).padStart(2, "0")}</span>
              <span><strong>{word.headword}</strong>{word.phonetic ? <small>/{word.phonetic}/</small> : null}</span>
              <span className={`word-status word-status--${stageTag(word, progressMap, groupKeys.has(word.word_key)) === "在本组" ? "active" : "muted"}`}>{stageTag(word, progressMap, groupKeys.has(word.word_key))}</span>
            </li>
          ))}
        </ul>
      </section>

      <div className="setup-actions">
      {resumable ? (
        <button
          type="button"
          className="btn btn--secondary"
          disabled={study.starting}
          onClick={() => void study.resumeSession(expectedGroupWords)}
        >
          继续上次学习
        </button>
      ) : null}
      {hasUnmatched ? (
        <p role="status">已有一个进行中的学习会话，但与当前选择的单元或分层不一致，无法继续。</p>
      ) : null}
      <button
        type="button"
        className="btn btn--primary"
        disabled={study.starting || group.length === 0}
        onClick={() => void study.startGroup(group.map(toGroupWord))}
      >
        开始学习
      </button>
      </div>
      {study.starting ? <p role="status">正在准备学习…</p> : null}
    </section>
  );
}

function toGroupWord(word: SetupWord) {
  return {
    wordKey: word.word_key,
    headword: word.headword,
    phonetic: word.phonetic,
    tier: word.tier,
    sourceOrder: word.source_order,
  };
}

function StudyView({ api, study }: { api: ApiClient; study: StudySessionControls }): React.JSX.Element {
  const word = study.words[study.studyIndex];
  if (!word || !study.session) {
    return (
      <p role="status">正在准备学习…</p>
    );
  }
  const wordAudio = word.content?.audio.find(
    (asset) => asset.entity_type === "word" && asset.entity_key === word.wordKey,
  );
  const exampleAudioUrls = Object.fromEntries(
    (word.content?.audio ?? [])
      .filter((asset) => asset.entity_type === "example")
      .map((asset) => [asset.entity_key, api.audioUrl(asset.asset_key, study.session!.session_id)]),
  );
  const isLastWord = study.studyIndex === study.words.length - 1;
  return (
    <div className="study-flow">
      <div className="session-overview">
        本组共 {study.session.cards.length} 张卡（完成学习后逐卡快速回忆）。
      </div>
      <WordStudyCard
        key={word.wordKey}
        position={study.studyIndex}
        total={study.words.length}
        word={word}
        familiarityPending={study.familiarityPending}
        audioUrl={wordAudio ? api.audioUrl(wordAudio.asset_key, study.session.session_id) : null}
        exampleAudioUrls={exampleAudioUrls}
        onFamiliarity={(choice) => void study.chooseFamiliarity(word.wordKey, choice)}
        onRetryPresentation={() => void study.retryPresentation(word.wordKey)}
        onRetryContent={() => study.retryContent(word.wordKey)}
        onNext={() => void study.advanceStudy()}
        nextLabel={isLastWord ? "开始快速回忆" : "下一词"}
        nextDisabled={study.starting}
      />
    </div>
  );
}

/**
 * A deferred/failed WORD_PRESENTED must never strand a word: its introduction
 * (stage flip) only happens server-side once the presentation lands, so the
 * recall and complete views keep a retry control until every group word is
 * recorded. Retries replay the word's SAME event id.
 */
function PendingPresentationsNotice({ study }: { study: StudySessionControls }): React.JSX.Element | null {
  const pending = study.words.filter(
    (word) => word.presentation === "failed" || word.presentation === "deferred",
  );
  if (pending.length === 0) {
    return null;
  }
  return (
    <div role="status">
      <p>
        有 {pending.length} 个单词的学习记录未提交，可随时重试，不影响已提交的评分。
      </p>
      <button type="button" className="btn" onClick={() => void study.retryPendingPresentations()}>
        重试学习记录
      </button>
    </div>
  );
}

function RecallView({ study }: { study: StudySessionControls }): React.JSX.Element {
  const total = study.session?.cards.length ?? 0;
  return (
    <div>
      <QuickRecall
        cardIndex={study.queueIndex}
        total={total}
        card={study.recallCards?.[study.queueIndex] ?? null}
        revealed={study.phase === "QUICK_RECALL_REVEALED"}
        gradePending={study.gradePending}
        gradeError={study.gradeError}
        onReveal={study.reveal}
        onRate={(rating) => void study.rate(rating)}
      />
      <PendingPresentationsNotice study={study} />
    </div>
  );
}

function CompleteView({ study }: { study: StudySessionControls }): React.JSX.Element {
  return (
    <section>
      <h2>本组学习完成</h2>
      {study.summary ? (
        <p>已引入 {study.summary.introduced} / {study.summary.total} 个单词。</p>
      ) : (
        <p role="status">正在获取学习结果…</p>
      )}
      <PendingPresentationsNotice study={study} />
      <p>之后这些词的卡片将进入正常复习计划。</p>
      <Link className="btn btn--primary" to="/today">
        回到今日
      </Link>
    </section>
  );
}

export function LearnSetupPage({ api }: LearnSetupPageProps): React.JSX.Element {
  const me = useQuery({ queryKey: AUTH_ME_QUERY_KEY, queryFn: () => api.me() });
  const study = useStudySession({ api });

  return (
    <section className="page page--learn">
      <header className="page-heading page-heading--compact"><div><p className="eyebrow">LEARN</p><h1>学习</h1><p>理解一个词，再让记忆接手。</p></div></header>
      {study.phase === "SETUP" ? (
        <SetupView api={api} settings={me.data?.settings ?? null} study={study} />
      ) : null}
      {study.phase === "STUDY_WORDS" ? <StudyView api={api} study={study} /> : null}
      {study.phase === "QUICK_RECALL_QUESTION" || study.phase === "QUICK_RECALL_REVEALED" ? (
        <RecallView study={study} />
      ) : null}
      {study.phase === "COMPLETE" ? <CompleteView study={study} /> : null}
    </section>
  );
}
