/**
 * Learning statistics (spec 9.6) behind `GET /api/stats/overview`.
 *
 * Every number is derived from the user's own rows and stays honest about
 * what "learned" and "mastered" mean:
 * - learned words  = `word_progress.stage = 'INTRODUCED'` rows;
 * - learned cards  = rows with a (valid) `card_state` envelope;
 * - estimated retention = mean ts-fsrs retrievability over those graded
 *   cards (see `estimateRetrievability` in @lexiloop/fsrs), null with no data;
 * - review counts and the consecutive-day streak use only non-undone
 *   `review_log` rows, bucketed by the USER'S timezone calendar (from
 *   `user_settings.timezone`, default UTC) — never the server's clock zone;
 * - the 30-day due forecast buckets `card_state.due` into the next 30 local
 *   days, with overdue cards counted in day 0;
 * - difficult words aggregate lapses / max difficulty per word;
 * - Unit mastery = graded-card coverage plus the predicted retention of those
 *   graded cards — a merely "seen" (IN_PROGRESS, ungraded) word contributes
 *   nothing.
 *
 * All statements are awaited so the queries run unchanged on the sync
 * better-sqlite3 driver and the async D1 driver.
 */

import { and, eq, gte, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  ReleaseRepository,
  UserSettingsRepository,
  cardDefinition,
  cardState,
  contentKeyAlias,
  parseFsrsState,
  reviewLog,
  schema,
  unit,
  word,
  type LexiloopDatabase,
  type UserContext,
} from "@lexiloop/db";
import { estimateRetrievability } from "@lexiloop/fsrs";

/** Length of the due-forecast window (spec 9.6: 未来 30 天). */
export const FORECAST_DAYS = 30;

/** Lookback bound for streak computation (a streak longer than a year is not tracked). */
const STREAK_LOOKBACK_DAYS = 366;

/** Difficult-word threshold: any lapse, or ts-fsrs difficulty at/above this. */
const DIFFICULT_DIFFICULTY = 8;

/** Maximum difficult words returned. */
const DIFFICULT_LIMIT = 10;

export interface ForecastDay {
  /** Local calendar day (YYYY-MM-DD in the user's timezone). */
  date: string;
  cards: number;
}

export interface DifficultWord {
  word_key: string;
  headword: string | null;
  lapses: number;
  max_difficulty: number;
  cards: number;
}

export interface UnitMastery {
  unit_key: string;
  title: string;
  total_cards: number;
  studied_cards: number;
  /** Graded cards / active cards; 0 when the unit has no cards. */
  coverage: number;
  /** Mean predicted retention over the unit's graded cards; null when none. */
  estimated_retention: number | null;
}

export interface StatsOverview {
  learned_words: number;
  learned_cards: number;
  estimated_retention: number | null;
  reviews_today: number;
  reviews_total: number;
  streak_days: number;
  due_forecast: ForecastDay[];
  difficult_words: DifficultWord[];
  units: UnitMastery[];
}

// ---------------------------------------------------------------------------
// Timezone calendar helpers (all math epoch-based, zone via Intl)
// ---------------------------------------------------------------------------

/**
 * Builder-typed handle for drizzle's field-select overloads: the union handle
 * cannot express them at the type level (the same documented cast the study
 * service uses); both drivers share the builder runtime and every statement
 * runs behind `await`.
 */
function builder(db: LexiloopDatabase): BetterSQLite3Database<typeof schema> {
  return db as BetterSQLite3Database<typeof schema>;
}

function partsOf(instant: number, timeZone: string, hour12: boolean): Map<string, string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(hour12 ? {} : { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  });
  const parts = new Map<string, string>();
  for (const part of formatter.formatToParts(new Date(instant))) {
    parts.set(part.type, part.value);
  }
  return parts;
}

/** The local calendar date key (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDateKey(instant: number, timeZone: string): string {
  const parts = partsOf(instant, timeZone, true);
  const year = parts.get("year") ?? "1970";
  const month = parts.get("month") ?? "01";
  const day = parts.get("day") ?? "01";
  return `${year}-${month}-${day}`;
}

/** The zone's offset in ms at `instant` (east of UTC positive). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = partsOf(instant, timeZone, false);
  const asUtc = Date.UTC(
    Number(parts.get("year")),
    Number(parts.get("month")) - 1,
    Number(parts.get("day")),
    Number(parts.get("hour")) % 24,
    Number(parts.get("minute")),
    Number(parts.get("second")),
  );
  return asUtc - instant;
}

/** The epoch ms of local midnight that starts `dateKey` in `timeZone`. */
export function startOfLocalDay(dateKey: string, timeZone: string): number {
  const guess = Date.parse(`${dateKey}T00:00:00Z`);
  // Two passes: the first lands within the correct (possibly DST-shifted)
  // day, the second re-reads the offset from inside it.
  const first = guess - zoneOffsetMs(guess, timeZone);
  return guess - zoneOffsetMs(first, timeZone);
}

/** Steps a YYYY-MM-DD key by whole days via UTC noon, so DST shifts cannot drift. */
export function addDays(dateKey: string, days: number): string {
  const noon = Date.parse(`${dateKey}T12:00:00Z`) + days * 86_400_000;
  return new Date(noon).toISOString().slice(0, 10);
}

/** The user's timezone from settings (schema default "UTC"). */
async function timezoneOf(db: LexiloopDatabase, ctx: UserContext): Promise<string> {
  const settings = await new UserSettingsRepository(db).get(ctx);
  return settings?.timezone ?? "UTC";
}

/** One alias-walk resolver over a preloaded edge map (AliasRepository semantics). */
class LocalAliasResolver {
  private readonly edgesByFrom = new Map<string, Array<{ toKey: string; canonicalKey: string }>>();

  constructor(rows: Array<{ fromKey: string; toKey: string; canonicalKey: string }>) {
    for (const row of rows) {
      const edges = this.edgesByFrom.get(row.fromKey) ?? [];
      edges.push({ toKey: row.toKey, canonicalKey: row.canonicalKey });
      this.edgesByFrom.set(row.fromKey, edges);
    }
  }

  resolve(key: string): string {
    let current = key;
    const visited = new Set<string>([key]);
    for (;;) {
      const edges = this.edgesByFrom.get(current) ?? [];
      if (edges.length > 1) {
        throw new Error(`content_key_alias: key ${current} has ${edges.length} outgoing edges; refusing ambiguous resolution`);
      }
      const edge = edges[0];
      if (!edge) {
        return current;
      }
      if (visited.has(edge.toKey)) {
        throw new Error(`content_key_alias cycle detected at key ${edge.toKey}`);
      }
      visited.add(edge.toKey);
      current = edge.toKey;
    }
  }
}

// ---------------------------------------------------------------------------
// The overview query
// ---------------------------------------------------------------------------

async function scalar(db: LexiloopDatabase, query: SQL): Promise<number> {
  const rows = (await db.all(query)) as Array<{ n?: number | string | null }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Computes the full spec 9.6 overview for one user at `now` (epoch ms).
 * Undone reviews are excluded from every count; "seen" words never count as
 * learned or mastered.
 */
export async function statsOverview(db: LexiloopDatabase, ctx: UserContext, now: number): Promise<StatsOverview> {
  const timeZone = await timezoneOf(db, ctx);
  const todayKey = localDateKey(now, timeZone);

  // -- Graded cards: the base for counts, retention, forecast, difficulty. --
  const stateRows = await db.select().from(cardState).where(eq(cardState.userId, ctx.userId));
  const retrievability = new Map<string, number>();
  let retentionSum = 0;
  for (const row of stateRows) {
    const value = estimateRetrievability(parseFsrsState(row.fsrsState), now);
    retrievability.set(row.contentCardKey, value);
    retentionSum += value;
  }
  const estimatedRetention = stateRows.length === 0 ? null : retentionSum / stateRows.length;

  // -- Learned words / cards. ----------------------------------------------
  const learnedWords = await scalar(
    db,
    sql`SELECT COUNT(*) AS n FROM word_progress WHERE user_id = ${ctx.userId} AND stage = 'INTRODUCED'`,
  );
  const learnedCards = stateRows.length;

  // -- Review counts: non-undone only, today measured on the local calendar. -
  const notUndone = and(eq(reviewLog.userId, ctx.userId), isNull(reviewLog.undoneAt));
  const reviewsTotal = await builder(db)
    .select({ n: sql<number>`count(*)` })
    .from(reviewLog)
    .where(notUndone);
  const todayStart = startOfLocalDay(todayKey, timeZone);
  const reviewsToday = await builder(db)
    .select({ n: sql<number>`count(*)` })
    .from(reviewLog)
    .where(and(notUndone, gte(reviewLog.reviewedAt, todayStart)));

  // -- Streak: consecutive LOCAL study days ending today or yesterday. ------
  const lookbackStart = startOfLocalDay(addDays(todayKey, -STREAK_LOOKBACK_DAYS), timeZone);
  const activityRows = await builder(db)
    .select({ reviewedAt: reviewLog.reviewedAt })
    .from(reviewLog)
    .where(and(notUndone, gte(reviewLog.reviewedAt, lookbackStart)));
  const activeDays = new Set<string>();
  for (const row of activityRows) {
    activeDays.add(localDateKey(row.reviewedAt, timeZone));
  }
  let streakDays = 0;
  if (activeDays.has(todayKey) || activeDays.has(addDays(todayKey, -1))) {
    let cursor = activeDays.has(todayKey) ? todayKey : addDays(todayKey, -1);
    while (activeDays.has(cursor)) {
      streakDays += 1;
      cursor = addDays(cursor, -1);
    }
  }

  // -- 30-day due forecast on local calendar days (overdue counts in day 0). -
  const forecastKeys = Array.from({ length: FORECAST_DAYS }, (_, index) => addDays(todayKey, index));
  const bucketStarts = forecastKeys.map((key) => startOfLocalDay(key, timeZone));
  const windowEnd = startOfLocalDay(addDays(todayKey, FORECAST_DAYS), timeZone);
  const buckets = new Array<number>(FORECAST_DAYS).fill(0);
  for (const row of stateRows) {
    const due = row.due;
    if (due >= windowEnd) {
      continue; // beyond the 30-day window
    }
    let index = 0;
    for (let candidate = FORECAST_DAYS - 1; candidate >= 0; candidate -= 1) {
      const start = bucketStarts[candidate];
      if (start !== undefined && due >= start) {
        index = candidate;
        break;
      }
    }
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  const dueForecast: ForecastDay[] = forecastKeys.map((date, index) => ({ date, cards: buckets[index] ?? 0 }));

  // -- Card -> word mapping for difficult words and Unit mastery. -----------
  const stateKeys = stateRows.map((row) => row.contentCardKey);
  const wordByCardKey = new Map<string, string>();
  if (stateKeys.length > 0) {
    const definitions = await builder(db)
      .select({ contentCardKey: cardDefinition.contentCardKey, wordKey: cardDefinition.wordKey })
      .from(cardDefinition)
      .where(inArray(cardDefinition.contentCardKey, stateKeys));
    for (const definition of definitions) {
      if (!wordByCardKey.has(definition.contentCardKey)) {
        wordByCardKey.set(definition.contentCardKey, definition.wordKey);
      }
    }
  }

  // -- Difficult words: aggregate lapses / difficulty per word. -------------
  interface WordAggregate {
    lapses: number;
    maxDifficulty: number;
    cards: number;
    retrievabilitySum: number;
    retrievabilityCards: number;
  }
  const byWord = new Map<string, WordAggregate>();
  for (const row of stateRows) {
    const wordKey = wordByCardKey.get(row.contentCardKey);
    if (!wordKey) {
      continue;
    }
    const aggregate = byWord.get(wordKey) ?? {
      lapses: 0,
      maxDifficulty: 0,
      cards: 0,
      retrievabilitySum: 0,
      retrievabilityCards: 0,
    };
    aggregate.lapses += row.lapses;
    aggregate.maxDifficulty = Math.max(aggregate.maxDifficulty, parseFsrsState(row.fsrsState).difficulty);
    aggregate.cards += 1;
    const r = retrievability.get(row.contentCardKey);
    if (r !== undefined) {
      aggregate.retrievabilitySum += r;
      aggregate.retrievabilityCards += 1;
    }
    byWord.set(wordKey, aggregate);
  }
  const difficultCandidates = [...byWord.entries()]
    .filter(([, aggregate]) => aggregate.lapses > 0 || aggregate.maxDifficulty >= DIFFICULT_DIFFICULTY)
    .sort((a, b) =>
      b[1].lapses - a[1].lapses ||
      b[1].maxDifficulty - a[1].maxDifficulty ||
      (a[0] < b[0] ? -1 : 1),
    )
    .slice(0, DIFFICULT_LIMIT);
  let difficultWords: DifficultWord[] = [];
  if (difficultCandidates.length > 0) {
    const wordKeys = difficultCandidates.map(([wordKey]) => wordKey);
    const headwords = await builder(db)
      .select({ wordKey: word.wordKey, headword: word.headword })
      .from(word)
      .where(inArray(word.wordKey, wordKeys));
    const headwordByKey = new Map<string, string>();
    for (const row of headwords) {
      if (!headwordByKey.has(row.wordKey)) {
        headwordByKey.set(row.wordKey, row.headword);
      }
    }
    difficultWords = difficultCandidates.map(([wordKey, aggregate]) => ({
      word_key: wordKey,
      headword: headwordByKey.get(wordKey) ?? null,
      lapses: aggregate.lapses,
      max_difficulty: aggregate.maxDifficulty,
      cards: aggregate.cards,
    }));
  }

  // -- Unit mastery for the ACTIVE release: graded coverage + retention. -----
  const units: UnitMastery[] = [];
  const active = await new ReleaseRepository(db).getActive();
  if (active) {
    const releaseId = active.releaseId;
    const unitRows = await db
      .select()
      .from(unit)
      .where(eq(unit.releaseId, releaseId))
      .orderBy(unit.unitOrder, unit.unitKey);
    const activeCards = await builder(db)
      .select({ contentCardKey: cardDefinition.contentCardKey, unitKey: cardDefinition.unitKey })
      .from(cardDefinition)
      .where(and(eq(cardDefinition.releaseId, releaseId), eq(cardDefinition.status, "ACTIVE")));
    // Presented keys in the active release resolve to canonical state keys.
    const aliasRows = await builder(db)
      .select({ fromKey: contentKeyAlias.fromKey, toKey: contentKeyAlias.toKey, canonicalKey: contentKeyAlias.canonicalKey })
      .from(contentKeyAlias);
    const resolver = new LocalAliasResolver(aliasRows);
    const studiedByUnit = new Map<string, { total: number; studied: number; retentionSum: number; retentionCards: number }>();
    for (const card of activeCards) {
      const bucket = studiedByUnit.get(card.unitKey) ?? { total: 0, studied: 0, retentionSum: 0, retentionCards: 0 };
      bucket.total += 1;
      let canonical = card.contentCardKey;
      try {
        canonical = resolver.resolve(card.contentCardKey);
      } catch {
        // An unresolvable alias graph fails loudly in grading; statistics
        // degrade to the presented key rather than taking the route down.
      }
      const r = retrievability.get(canonical);
      if (r !== undefined) {
        bucket.studied += 1;
        bucket.retentionSum += r;
        bucket.retentionCards += 1;
      }
      studiedByUnit.set(card.unitKey, bucket);
    }
    for (const unitRow of unitRows) {
      const bucket = studiedByUnit.get(unitRow.unitKey) ?? { total: 0, studied: 0, retentionSum: 0, retentionCards: 0 };
      units.push({
        unit_key: unitRow.unitKey,
        title: unitRow.title,
        total_cards: bucket.total,
        studied_cards: bucket.studied,
        coverage: bucket.total === 0 ? 0 : bucket.studied / bucket.total,
        estimated_retention: bucket.retentionCards === 0 ? null : bucket.retentionSum / bucket.retentionCards,
      });
    }
  }

  return {
    learned_words: learnedWords,
    learned_cards: learnedCards,
    estimated_retention: estimatedRetention,
    reviews_today: Number(reviewsToday[0]?.n ?? 0),
    reviews_total: Number(reviewsTotal[0]?.n ?? 0),
    streak_days: streakDays,
    due_forecast: dueForecast,
    difficult_words: difficultWords,
    units,
  };
}
