/**
 * Versioned serialization of FSRS card state (spec 6.4) between the JSON
 * envelope stored in `card_state` and the ts-fsrs v5 card shape the
 * scheduler computes with.
 *
 * v1 mirrors the ts-fsrs v5 card fields we persist; `due_at` /
 * `last_review_at` are UTC epoch milliseconds. All arithmetic downstream is
 * epoch-based, so stored states are timezone- and DST-independent by
 * construction. The schema is strict: malformed or future-versioned blobs
 * fail closed instead of silently corrupting scheduling state. The identical
 * envelope schema lives in @lexiloop/db (storage boundary); the structural
 * compatibility of the two is enforced by TypeScript where the worker passes
 * one into the other.
 */
import { z } from "zod";
import { State, type Card } from "ts-fsrs";

export const FsrsStateV1Schema = z.strictObject({
  version: z.literal(1),
  /** ts-fsrs card state. */
  state: z.enum(["New", "Learning", "Review", "Relearning"]),
  stability: z.number().min(0),
  difficulty: z.number().min(1).max(10),
  due_at: z.number().int().nonnegative(),
  last_review_at: z.number().int().nonnegative().nullable(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  /** Days between the last review and this due date (ts-fsrs scheduled_days). */
  scheduled_days: z.number().int().nonnegative(),
  /** Learning-step index (ts-fsrs learning_steps); -1 outside learning states. */
  learning_steps: z.number().int().min(-1),
  // elapsed_days is intentionally omitted: deprecated upstream in ts-fsrs v5
  // and derivable from due_at/last_review_at.
});

/** The versioned FSRS state envelope (v1). */
export type FsrsStateV1 = z.infer<typeof FsrsStateV1Schema>;

const STATE_BY_NAME: Record<FsrsStateV1["state"], State> = {
  New: State.New,
  Learning: State.Learning,
  Review: State.Review,
  Relearning: State.Relearning,
};

const NAME_BY_STATE: Record<State, FsrsStateV1["state"]> = {
  [State.New]: "New",
  [State.Learning]: "Learning",
  [State.Review]: "Review",
  [State.Relearning]: "Relearning",
};

/** Rebuilds the ts-fsrs card the stored envelope was written from. */
export function stateToCard(state: FsrsStateV1): Card {
  const card: Card = {
    due: new Date(state.due_at),
    stability: state.stability,
    difficulty: state.difficulty,
    // Deprecated upstream, recomputed by the scheduler; always serialized
    // from due_at/last_review_at instead of being stored.
    elapsed_days: 0,
    scheduled_days: state.scheduled_days,
    learning_steps: state.learning_steps,
    reps: state.reps,
    lapses: state.lapses,
    state: STATE_BY_NAME[state.state],
  };
  if (state.last_review_at !== null) {
    card.last_review = new Date(state.last_review_at);
  }
  return card;
}

/** Captures a ts-fsrs card as the versioned envelope (exact epoch ms). */
export function cardToState(card: Card): FsrsStateV1 {
  return FsrsStateV1Schema.parse({
    version: 1,
    state: NAME_BY_STATE[card.state],
    stability: card.stability,
    difficulty: card.difficulty,
    due_at: card.due.getTime(),
    last_review_at: card.last_review ? card.last_review.getTime() : null,
    reps: card.reps,
    lapses: card.lapses,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
  });
}

/** Parses and validates a stored FSRS state blob (JSON string). */
export function parseFsrsStateV1(json: string): FsrsStateV1 {
  return FsrsStateV1Schema.parse(JSON.parse(json) as unknown);
}
