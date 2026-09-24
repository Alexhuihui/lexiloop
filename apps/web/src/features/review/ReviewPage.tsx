/**
 * The /review page (spec 9.4, plan Task 17): the FSRS review flow host.
 *
 * - IDLE offers an explicit start (creating a session is a write); mount
 *   auto-resumes an unexpired REVIEW session read-only, so the full-entry
 *   round trip (dictionary -> back) keeps the server-side position.
 * - QUESTION/REVEALED render ReviewCard; the desktop shortcuts Space
 *   (reveal), 1-4 (rate), Z (undo) and S (audio) are registered globally but
 *   only fire outside editable controls (lib/keyboard.ts).
 * - Audio failures are announced inline and never block the flow (spec 10).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ApiClient } from "../../lib/api-client";
import { CONTENT_BOOTSTRAP_QUERY_KEY } from "../../lib/query-cache";
import { createAudioPlayer, type AudioPlayer } from "../../lib/audio";
import { useKeyboardShortcuts } from "../../lib/keyboard";
import { useAudioPrefetch } from "../../lib/audio-prefetch";
import { groupReviewCards, ReviewCard } from "./ReviewCard";
import { useReviewSession } from "./useReviewSession";

export interface ReviewPageProps {
  api: ApiClient;
}

const RATE_KEYS: ReadonlyArray<{ key: string; rating: 1 | 2 | 3 | 4 }> = [
  { key: "1", rating: 1 },
  { key: "2", rating: 2 },
  { key: "3", rating: 3 },
  { key: "4", rating: 4 },
];

export function ReviewPage({ api }: ReviewPageProps): React.JSX.Element {
  const bootstrap = useQuery({
    queryKey: CONTENT_BOOTSTRAP_QUERY_KEY,
    queryFn: () => api.bootstrap(),
  });
  const bookByUnit = useMemo(
    () =>
      bootstrap.isSuccess
        ? new Map(bootstrap.data.units.map((unit) => [unit.unit_key, unit.book_key]))
        : null,
    [bootstrap.isSuccess, bootstrap.data],
  );
  const study = useReviewSession({ api, bookByUnit });

  const [audioFailed, setAudioFailed] = useState(false);
  const playerRef = useRef<AudioPlayer | null>(null);
  if (playerRef.current === null) {
    playerRef.current = createAudioPlayer({ onFailed: () => setAudioFailed(true) });
  }
  useEffect(() => () => playerRef.current?.dispose(), []);

  const reviewGroups = useMemo(() => groupReviewCards(study.cards), [study.cards]);
  const visibleIndex = reviewGroups.findIndex(
    (group) =>
      study.queueIndex >= group.rawStart &&
      study.queueIndex < group.rawStart + group.rawLength,
  );
  const currentCard = visibleIndex >= 0 ? reviewGroups[visibleIndex]!.card : null;
  const currentWordKey = currentCard && currentCard.form !== "generic" ? currentCard.wordKey : null;
  const currentContent = currentWordKey ? (study.contents.get(currentWordKey) ?? null) : null;
  const currentAudioUrl = useMemo(() => {
    if (!currentWordKey || !currentContent || !study.session) {
      return null;
    }
    const asset = currentContent.audio.find(
      (candidate) => candidate.entity_type === "word" && candidate.entity_key === currentWordKey,
    );
    return asset ? api.audioUrl(asset.asset_key, study.session.session_id) : null;
  }, [api, currentContent, currentWordKey, study.session]);
  useAudioPrefetch(currentAudioUrl ? [currentAudioUrl] : [], api.prefetchAudio);

  const playCurrentAudio = useCallback(() => {
    if (!currentAudioUrl) {
      setAudioFailed(true);
      return;
    }
    setAudioFailed(false);
    playerRef.current?.play(currentAudioUrl);
  }, [currentAudioUrl]);

  useKeyboardShortcuts([
    { key: " ", handler: study.reveal },
    ...RATE_KEYS.map(({ key, rating }) => ({
      key,
      handler: () => void study.rate(rating),
    })),
    { key: "z", handler: () => void study.undoLast() },
    { key: "s", handler: playCurrentAudio },
  ]);

  return (
    <section className="page page--review">
      <header className="page-heading page-heading--compact"><div><p className="eyebrow">REVIEW</p><h1>复习</h1><p className="page-heading__lead">在刚好要忘记之前，再想起一次。</p></div></header>
      {study.phase === "IDLE" ? (
        <div className="empty-state review-start">
          <span aria-hidden="true">↻</span>
          <h2>准备好开始了吗？</h2>
          <p>复习会优先使用语境回忆，帮助你真正把词用起来。</p>
          {study.loadError ? <p role="alert">复习记录加载失败：{study.loadError}</p> : null}
          {study.startError ? <p role="alert">{study.startError}</p> : null}
          {study.queueEmpty ? <p role="status">当前没有到期的复习卡。</p> : null}
          <button
            type="button"
            className="btn btn--primary btn--wide"
            onClick={() => void study.start()}
          >
            开始复习
          </button>
        </div>
      ) : null}
      {study.phase === "PREPARING" ? <p role="status">正在准备复习…</p> : null}
      {study.phase === "QUESTION" || study.phase === "REVEALED" ? (
        <ReviewCard
          position={Math.max(visibleIndex, 0)}
          total={reviewGroups.length}
          card={currentCard}
          content={currentContent}
          revealed={study.phase === "REVEALED"}
          gradePending={study.gradePending}
          gradeError={study.gradeError}
          canUndo={study.canUndo}
          undoPending={study.undoPending}
          undoError={study.undoError}
          audioUrl={currentAudioUrl}
          audioFailed={audioFailed}
          onReveal={study.reveal}
          onRate={(rating) => void study.rate(rating)}
          onUndo={() => void study.undoLast()}
          onPlayAudio={playCurrentAudio}
        />
      ) : null}
      {study.phase === "COMPLETE" ? (
        <div className="empty-state complete-state">
          <span aria-hidden="true">✓</span>
          <h2>本次复习已完成</h2>
          <p>共 {reviewGroups.length} 个单词已评分。</p>
          <Link className="btn btn--primary" to="/today">
            回到今日
          </Link>
        </div>
      ) : null}
    </section>
  );
}
