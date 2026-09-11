/**
 * Locked ts-fsrs vectors for the server-authoritative scheduler (spec 5.7/8.3).
 *
 * Every expected value below was produced ONCE by running the pinned
 * ts-fsrs@5.4.2 (default parameters: request_retention 0.9, fuzz disabled,
 * learning steps [1m,10m], relearning steps [10m]) and is now LOCKED: the
 * adapter must reproduce these exact envelopes or the package is broken.
 * All times are UTC epoch milliseconds, so the vectors are timezone- and
 * DST-independent by construction; the DST cases prove interval math never
 * crosses a local wall clock.
 */
import { describe, expect, it } from "vitest";
import { gradeCard } from "../src/adapter";
import { FsrsStateV1Schema, cardToState, stateToCard, type FsrsStateV1 } from "../src/serialization";

/** 2026-01-15T00:00:00Z. */
const T1 = 1_768_435_200_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function state(overrides: Partial<FsrsStateV1>): FsrsStateV1 {
  return FsrsStateV1Schema.parse({
    version: 1,
    state: "Learning",
    stability: 0,
    difficulty: 5,
    due_at: T1,
    last_review_at: T1,
    reps: 0,
    lapses: 0,
    scheduled_days: 0,
    learning_steps: 0,
    ...overrides,
  });
}

describe("first grade of a New card (locked vectors, all four ratings)", () => {
  const cases: Array<{
    rating: 1 | 2 | 3 | 4;
    name: string;
    expected: FsrsStateV1;
  }> = [
    {
      rating: 1,
      name: "Again starts a 1m learning step",
      expected: state({
        state: "Learning",
        stability: 0.212,
        difficulty: 6.4133,
        due_at: T1 + 1 * MINUTE,
        reps: 1,
        learning_steps: 0,
      }),
    },
    {
      rating: 2,
      name: "Hard starts a 6m learning step",
      expected: state({
        state: "Learning",
        stability: 1.2931,
        difficulty: 5.11217071,
        due_at: T1 + 6 * MINUTE,
        reps: 1,
        learning_steps: 0,
      }),
    },
    {
      rating: 3,
      name: "Good advances to the 10m learning step",
      expected: state({
        state: "Learning",
        stability: 2.3065,
        difficulty: 2.11810397,
        due_at: T1 + 10 * MINUTE,
        reps: 1,
        learning_steps: 1,
      }),
    },
    {
      rating: 4,
      name: "Easy graduates straight to Review with an 8d interval",
      expected: state({
        state: "Review",
        stability: 8.2956,
        difficulty: 1,
        due_at: T1 + 8 * DAY,
        reps: 1,
        scheduled_days: 8,
        learning_steps: 0,
      }),
    },
  ];

  for (const { rating, name, expected } of cases) {
    it(name, () => {
      const outcome = gradeCard({ before: null, rating, reviewedAt: T1 });
      expect(outcome.before).toBeNull();
      expect(outcome.after).toEqual(expected);
    });
  }
});

describe("multi-review chains (locked vectors)", () => {
  it("Good -> Good graduates a learning card into Review", () => {
    const first = gradeCard({ before: null, rating: 3, reviewedAt: T1 });
    const t2 = T1 + MINUTE;
    const second = gradeCard({ before: first.after, rating: 3, reviewedAt: t2 });
    expect(second.before).toEqual(first.after);
    expect(second.after).toEqual(
      state({
        state: "Review",
        stability: 2.3065,
        difficulty: 2.11121424,
        due_at: t2 + 2 * DAY,
        last_review_at: t2,
        reps: 2,
        scheduled_days: 2,
        learning_steps: 0,
      }),
    );
  });

  it("Good -> Good -> Good keeps growing the Review interval, Hard then cuts it", () => {
    const first = gradeCard({ before: null, rating: 3, reviewedAt: T1 });
    const t2 = T1 + MINUTE;
    const second = gradeCard({ before: first.after, rating: 3, reviewedAt: t2 });
    const t3 = T1 + 2 * MINUTE;
    const third = gradeCard({ before: second.after, rating: 3, reviewedAt: t3 });
    expect(third.after).toEqual(
      state({
        state: "Review",
        stability: 2.3065,
        difficulty: 2.1043314,
        due_at: t3 + 3 * DAY,
        last_review_at: t3,
        reps: 3,
        scheduled_days: 3,
        learning_steps: 0,
      }),
    );
    const t4 = Date.UTC(2026, 0, 16);
    const fourth = gradeCard({ before: third.after, rating: 2, reviewedAt: t4 });
    expect(fourth.after).toEqual(
      state({
        state: "Review",
        stability: 5.3234637,
        difficulty: 4.74371562,
        due_at: t4 + 5 * DAY,
        last_review_at: t4,
        reps: 4,
        scheduled_days: 5,
        learning_steps: 0,
      }),
    );
  });

  it("Again on a Review card lapses it into Relearning and Good recovers it", () => {
    const first = gradeCard({ before: null, rating: 4, reviewedAt: T1 });
    const t2 = T1 + DAY;
    const lapse = gradeCard({ before: first.after, rating: 1, reviewedAt: t2 });
    expect(lapse.after).toEqual(
      state({
        state: "Relearning",
        stability: 1.21617837,
        difficulty: 7.02698957,
        due_at: t2 + 10 * MINUTE,
        last_review_at: t2,
        reps: 2,
        lapses: 1,
        learning_steps: 0,
      }),
    );
    const t3 = t2 + 10 * MINUTE;
    const recovered = gradeCard({ before: lapse.after, rating: 3, reviewedAt: t3 });
    expect(recovered.after).toEqual(
      state({
        state: "Review",
        stability: 1.26151265,
        difficulty: 7.01519095,
        due_at: t3 + DAY,
        last_review_at: t3,
        reps: 3,
        lapses: 1,
        scheduled_days: 1,
        learning_steps: 0,
      }),
    );
  });

  it("is deterministic: identical inputs yield byte-identical envelopes", () => {
    const a = gradeCard({ before: null, rating: 3, reviewedAt: T1 });
    const b = gradeCard({ before: null, rating: 3, reviewedAt: T1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("UTC/timezone/DST safety", () => {
  it("schedules by epoch deltas across the US 2026 spring-forward gap", () => {
    // 2026-03-08T06:00:00Z is 1am EST; the next local hour (2am) does not
    // exist because 07:00Z is already 3am EDT. Learning steps must still be
    // plain 10-minute epoch deltas.
    const review = Date.UTC(2026, 2, 8, 6, 0, 0);
    const outcome = gradeCard({ before: null, rating: 3, reviewedAt: review });
    expect(outcome.after.due_at).toBe(review + 10 * MINUTE);
    expect(outcome.after.last_review_at).toBe(review);
  });

  it("schedules by epoch deltas across the US 2026 fall-back repeated hour", () => {
    // 2026-11-01T05:00:00Z is the FIRST 1am; 06:00Z repeats it as EST.
    const review = Date.UTC(2026, 10, 1, 5, 0, 0);
    const outcome = gradeCard({ before: null, rating: 2, reviewedAt: review });
    expect(outcome.after.due_at).toBe(review + 6 * MINUTE);
  });

  it("graduates a card whose chain spans the spring-forward boundary", () => {
    const first = gradeCard({ before: null, rating: 3, reviewedAt: Date.UTC(2026, 2, 7, 12, 0, 0) });
    const second = gradeCard({ before: first.after, rating: 3, reviewedAt: first.after.due_at });
    expect(second.after.state).toBe("Review");
    expect(second.after.due_at).toBe(1_773_058_200_000);
    const third = gradeCard({
      before: second.after,
      rating: 4,
      reviewedAt: Date.UTC(2026, 2, 9, 12, 10, 0),
    });
    expect(third.after).toEqual(
      state({
        state: "Review",
        stability: 18.53433169,
        difficulty: 1,
        due_at: 1_774_699_800_000,
        last_review_at: Date.UTC(2026, 2, 9, 12, 10, 0),
        reps: 3,
        scheduled_days: 19,
        learning_steps: 0,
      }),
    );
  });
});

describe("state serialization (versioned envelope <-> ts-fsrs card)", () => {
  it("round-trips every locked state without loss", () => {
    const locked: FsrsStateV1[] = [
      state({ state: "Learning", stability: 0.212, difficulty: 6.4133, due_at: T1 + MINUTE, reps: 1 }),
      state({ state: "Review", stability: 8.2956, difficulty: 1, due_at: T1 + 8 * DAY, reps: 1, scheduled_days: 8 }),
      state({
        state: "Relearning",
        stability: 1.21617837,
        difficulty: 7.02698957,
        due_at: T1 + DAY + 10 * MINUTE,
        reps: 2,
        lapses: 1,
      }),
    ];
    for (const value of locked) {
      expect(cardToState(stateToCard(value))).toEqual(value);
    }
  });

  it("round-trips a due date exactly on the skipped DST local hour", () => {
    const value = state({ state: "Review", due_at: Date.UTC(2026, 2, 8, 7, 0, 0) });
    expect(cardToState(stateToCard(value))).toEqual(value);
  });

  it("accepts a null last_review (fresh card shape) and keeps it null", () => {
    const value = state({ last_review_at: null, reps: 0 });
    expect(cardToState(stateToCard(value))).toEqual(value);
  });

  it("rejects malformed or future-versioned envelopes", () => {
    expect(FsrsStateV1Schema.safeParse({ ...state({}), version: 2 }).success).toBe(false);
    expect(FsrsStateV1Schema.safeParse({ ...state({}), state: "Paused" }).success).toBe(false);
    expect(FsrsStateV1Schema.safeParse({ ...state({}), difficulty: 0 }).success).toBe(false);
    expect(FsrsStateV1Schema.safeParse({ ...state({}), stability: -1 }).success).toBe(false);
    expect(FsrsStateV1Schema.safeParse({ ...state({}), extra: 1 }).success).toBe(false);
  });
});
