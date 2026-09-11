/**
 * Server-authoritative FSRS adapter (spec 5.7/8.3): the ONLY place the
 * scheduler runs. The Worker calls `gradeCard` during grade handling; the
 * client never computes or supplies scheduling state.
 *
 * The scheduler uses the pinned ts-fsrs default parameters
 * (request_retention 0.9, fuzz disabled, learning steps [1m 10m], relearning
 * step [10m]) so every produced state is deterministic and locked by the
 * vector fixtures in test/fixtures.test.ts. All inputs and outputs are UTC
 * epoch milliseconds; ts-fsrs Date objects never leak past this module.
 */
import { createEmptyCard, fsrs, generatorParameters, Rating, type FSRSParameters, type Grade } from "ts-fsrs";
import { cardToState, stateToCard, type FsrsStateV1 } from "./serialization";

/** Client rating (spec 5.7): Again=1, Hard=2, Good=3, Easy=4. */
export type GradeRating = 1 | 2 | 3 | 4;

export interface GradeInput {
  /** Current stored state; null marks the card's first grade ever. */
  before: FsrsStateV1 | null;
  rating: GradeRating;
  /** UTC epoch ms of the review. */
  reviewedAt: number;
}

export interface GradeOutcome {
  /** Echoed input state (null on a first grade) — review_log.before_state. */
  before: FsrsStateV1 | null;
  /** Next scheduled state — card_state and review_log.after_state. */
  after: FsrsStateV1;
}

const RATING_BY_NUMBER: Record<GradeRating, Grade> = {
  1: Rating.Again,
  2: Rating.Hard,
  3: Rating.Good,
  4: Rating.Easy,
};

/** Locked default parameters; shared so repeated grades reuse one scheduler. */
const DEFAULT_PARAMETERS: FSRSParameters = generatorParameters();
const scheduler = fsrs(DEFAULT_PARAMETERS);

/**
 * Applies one review to a card's state. A null `before` starts from a fresh
 * New card created at `reviewedAt` (so the very first grade already carries
 * the answer timestamp); otherwise the stored envelope is rebuilt and handed
 * to the scheduler unchanged.
 */
export function gradeCard(input: GradeInput): GradeOutcome {
  const at = new Date(input.reviewedAt);
  const current = input.before === null ? createEmptyCard(at) : stateToCard(input.before);
  const { card } = scheduler.next(current, at, RATING_BY_NUMBER[input.rating]);
  return { before: input.before, after: cardToState(card) };
}
