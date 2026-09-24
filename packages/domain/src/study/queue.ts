/**
 * Study-session queue assembly (spec 5.7/6.4).
 *
 * Pure rules only: the fixed-release queue snapshot every session stores,
 * the 24-hour session lifetime, and the due-review order. The per-card
 * ordering itself is THE Task 8 comparator — the builders in
 * `cards/introduction.ts` (which run `compareCardQueueOrder`) produce the
 * entries consumed here, so the session queue can never drift from the
 * release's deterministic order. Alias resolution to canonical keys is a
 * database concern and is injected by the caller.
 */
import type { IntroductionQueueEntry } from "../cards/types";

/** One queued card in a session snapshot: the canonical state key plus the
 * exact key the pinned release presents (spec 6.4). */
export interface StudyQueueCard {
  canonical_card_key: string;
  presented_card_key: string;
}

/** Versioned queue snapshot stored on `study_session.queue_snapshot` (v1). */
export interface StudyQueueSnapshot {
  version: 1;
  release_id: string;
  cards: StudyQueueCard[];
  /** Patch (WORD_PRESENTED / FAMILIARITY_SET) event ids already applied. */
  patch_event_ids?: string[];
}

/** Sessions live at most 24 hours (spec 6.4); expired temp queues are
 * discarded while committed card_state/review_log rows are kept. */
export const SESSION_TTL_MS = 86_400_000;

/** The expiry timestamp for a session created at `createdAtMs`. */
export function sessionExpiry(createdAtMs: number): number {
  return createdAtMs + SESSION_TTL_MS;
}

/**
 * Maps introduction-queue entries (already in the binding 5.7 order) into
 * snapshot cards. The pinned release presents each card's own key; the
 * caller resolves the canonical state key per presented key through the
 * alias repository, so a queued entry keeps addressing the same canonical
 * state even when releases activate or roll back.
 */
export function queueCardsFromEntries(
  entries: readonly IntroductionQueueEntry[],
  resolveCanonical: (presentedCardKey: string) => string,
): StudyQueueCard[] {
  return entries.map((entry) => ({
    canonical_card_key: resolveCanonical(entry.content_card_key),
    presented_card_key: entry.content_card_key,
  }));
}

/** A due card candidate: the canonical key plus its mirrored due timestamp. */
export interface DueCard {
  content_card_key: string;
  due: number;
}

/**
 * The due-review queue (spec 6.3): cards due at or before `asOfMs`, ordered
 * by due ascending with the canonical stable key as the deterministic
 * tie-break. Due cards are canonical by definition (`card_state` is keyed
 * canonically), so the presented key equals the canonical key.
 */
export function dueQueueCards(due: readonly DueCard[], asOfMs: number): StudyQueueCard[] {
  return due
    .filter((card) => card.due <= asOfMs)
    .slice()
    .sort((a, b) => {
      if (a.due !== b.due) return a.due - b.due;
      if (a.content_card_key !== b.content_card_key) {
        return a.content_card_key < b.content_card_key ? -1 : 1;
      }
      return 0;
    })
    .map((card) => ({ canonical_card_key: card.content_card_key, presented_card_key: card.content_card_key }));
}

/** Assembles the versioned snapshot for a pinned release. */
export function queueSnapshot(releaseId: string, cards: readonly StudyQueueCard[]): StudyQueueSnapshot {
  return { version: 1, release_id: releaseId, cards: [...cards] };
}

/**
 * Records one applied patch event id on a snapshot (immutably). Idempotent:
 * an already-recorded id is returned unchanged, so a retried patch cannot
 * duplicate bookkeeping.
 */
export function withPatchEventId(snapshot: StudyQueueSnapshot, eventId: string): StudyQueueSnapshot {
  const recorded = snapshot.patch_event_ids ?? [];
  if (recorded.includes(eventId)) {
    return snapshot;
  }
  return { ...snapshot, patch_event_ids: [...recorded, eventId] };
}
