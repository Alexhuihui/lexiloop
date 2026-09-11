/**
 * Dictionary search (spec 9.5): exact headword, prefix headword, Chinese sense
 * gloss, phrase, and example full-text — combined into ONE deterministic
 * result order. The first two steps use the release-scoped primary key prefix
 * of `word`; the last three use the `content_search_fts` FTS5 index
 * (infra/migrations/0002) and resolve hits back to their word through the
 * sense/phrase/example primary keys.
 *
 * Ranking (spec 9.5 priority): field rank (exact < prefix < gloss < phrase <
 * example), then the textbook teaching order (unit_order, word source_order),
 * then the word key — so the same release and query always produce the same
 * order. A word appears at most once, with its best matching field.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { schema, type LexiloopDatabase } from "@lexiloop/db";
import { example, phrase, sense, unit, word } from "@lexiloop/db";

/**
 * Drizzle mirror of the FTS5 virtual table. The DDL stays in the migration;
 * this object only generates SELECTs (unicode61 tokenizer, UNINDEXED metadata
 * columns — spec 6.2/9.5).
 */
export const contentSearchFts = sqliteTable("content_search_fts", {
  text: text("text").notNull(),
  releaseId: text("release_id").notNull(),
  entityType: text("entity_type").notNull(),
  entityKey: text("entity_key").notNull(),
});

export type SearchMatchedField = "headword_exact" | "headword_prefix" | "sense_gloss" | "phrase" | "example";

/** spec 9.5: exact headword, prefix headword, Chinese gloss, phrase, example. */
const FIELD_RANK: Readonly<Record<SearchMatchedField, number>> = {
  headword_exact: 0,
  headword_prefix: 1,
  sense_gloss: 2,
  phrase: 3,
  example: 4,
};

export interface SearchHit {
  word_key: string;
  headword: string;
  phonetic: string | null;
  tier: string;
  unit_key: string;
  matched_field: SearchMatchedField;
  matched_text: string;
}

export interface SearchOptions {
  /** Maximum hits returned; clamped into [1, 50], default 20. */
  limit?: number;
}

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
/** Upper bound on FTS rows considered per query; ranking happens in memory. */
const FTS_SCAN_LIMIT = 200;
const MAX_QUERY_TOKENS = 8;

/**
 * Builds the FTS5 MATCH expression from raw user input: every run of letters/
 * digits becomes a quoted prefix term (`"tok"*`, ANDed). Quoting keeps FTS5
 * syntax characters out; tokenization mirrors unicode61 (Han runs are single
 * tokens, so Chinese gloss search is a token-prefix query per the 0002
 * migration decision). Returns null when the query has no searchable tokens.
 */
export function buildFtsMatchExpression(rawQuery: string): string | null {
  const tokens = rawQuery.match(/[\p{L}\p{N}]+/gu)?.slice(0, MAX_QUERY_TOKENS) ?? [];
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `"${token}"*`).join(" ");
}

/** Escapes LIKE wildcards so a prefix query matches literal characters only. */
function escapeLikePrefix(rawQuery: string): string {
  return `${rawQuery.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/**
 * Builder-typed handle for query FACTORIES only. The union handle cannot
 * express drizzle's field-select overloads at the type level; both drivers
 * share the builder runtime, and every statement is executed with `await`
 * (the same documented cast the repositories use for transactions).
 */
function builder(db: LexiloopDatabase): BetterSQLite3Database<typeof schema> {
  return db as BetterSQLite3Database<typeof schema>;
}

const wordWithUnitSelection = {
  wordKey: word.wordKey,
  headword: word.headword,
  phonetic: word.phonetic,
  tier: word.tier,
  sourceOrder: word.sourceOrder,
  unitKey: word.unitKey,
  unitOrder: unit.unitOrder,
};

function wordWithUnitJoin() {
  return and(eq(unit.releaseId, word.releaseId), eq(unit.unitKey, word.unitKey));
}

/** Exact headword match, scoped by the release prefix of the word primary key. */
export function exactHeadwordQuery(db: LexiloopDatabase, releaseId: string, headword: string) {
  return builder(db)
    .select(wordWithUnitSelection)
    .from(word)
    .innerJoin(unit, wordWithUnitJoin())
    .where(and(eq(word.releaseId, releaseId), sql`lower(${word.headword}) = lower(${headword})`));
}

/** Case-insensitive literal prefix match over the release's headwords. */
export function prefixHeadwordQuery(db: LexiloopDatabase, releaseId: string, prefix: string, limit: number) {
  return builder(db)
    .select(wordWithUnitSelection)
    .from(word)
    .innerJoin(unit, wordWithUnitJoin())
    .where(and(eq(word.releaseId, releaseId), sql`${word.headword} LIKE ${escapeLikePrefix(prefix)} ESCAPE '\\'`))
    .orderBy(asc(unit.unitOrder), asc(word.sourceOrder), asc(word.wordKey))
    .limit(limit);
}

/** FTS5 lookup restricted to the three non-headword searchable entity types. */
export function ftsSearchQuery(db: LexiloopDatabase, releaseId: string, matchExpression: string, limit: number) {
  return builder(db)
    .select({ entityType: contentSearchFts.entityType, entityKey: contentSearchFts.entityKey, text: contentSearchFts.text })
    .from(contentSearchFts)
    .where(
      and(
        eq(contentSearchFts.releaseId, releaseId),
        inArray(contentSearchFts.entityType, ["sense", "phrase", "example"]),
        sql`${contentSearchFts.text} MATCH ${matchExpression}`,
      ),
    )
    .orderBy(asc(contentSearchFts.entityKey))
    .limit(limit);
}

/** FTS sense hits -> word keys (sense primary key lookup). */
export function senseRowsQuery(db: LexiloopDatabase, releaseId: string, senseKeys: readonly string[]) {
  return builder(db)
    .select({ senseKey: sense.senseKey, wordKey: sense.wordKey })
    .from(sense)
    .where(and(eq(sense.releaseId, releaseId), inArray(sense.senseKey, [...senseKeys])));
}

/** FTS phrase hits -> word keys (phrase primary key lookup). */
export function phraseRowsQuery(db: LexiloopDatabase, releaseId: string, phraseKeys: readonly string[]) {
  return builder(db)
    .select({ phraseKey: phrase.phraseKey, wordKey: phrase.wordKey })
    .from(phrase)
    .where(and(eq(phrase.releaseId, releaseId), inArray(phrase.phraseKey, [...phraseKeys])));
}

/** FTS example hits -> word keys (example primary key lookup). */
export function exampleRowsQuery(db: LexiloopDatabase, releaseId: string, exampleKeys: readonly string[]) {
  return builder(db)
    .select({ exampleKey: example.exampleKey, wordKey: example.wordKey })
    .from(example)
    .where(and(eq(example.releaseId, releaseId), inArray(example.exampleKey, [...exampleKeys])));
}

/** Word rows (with unit order) for an arbitrary set of word keys. */
function wordsWithUnitQuery(db: LexiloopDatabase, releaseId: string, wordKeys: readonly string[]) {
  return builder(db)
    .select(wordWithUnitSelection)
    .from(word)
    .innerJoin(unit, wordWithUnitJoin())
    .where(and(eq(word.releaseId, releaseId), inArray(word.wordKey, [...wordKeys])));
}

interface Candidate {
  field: SearchMatchedField;
  matchedText: string;
}

/**
 * Runs the combined search for one release. All steps are release-scoped;
 * hits merge into a single deterministic order (see module doc).
 */
export async function searchWords(
  db: LexiloopDatabase,
  releaseId: string,
  rawQuery: string,
  options: SearchOptions = {},
): Promise<SearchHit[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? SEARCH_DEFAULT_LIMIT), 1), SEARCH_MAX_LIMIT);
  const query = rawQuery.trim();
  if (query === "") {
    return [];
  }

  // wordKey -> best candidate so far (lowest field rank wins).
  const candidates = new Map<string, Candidate>();
  const consider = (wordKey: string, field: SearchMatchedField, matchedText: string): void => {
    const existing = candidates.get(wordKey);
    if (existing === undefined || FIELD_RANK[field] < FIELD_RANK[existing.field]) {
      candidates.set(wordKey, { field, matchedText });
    }
  };

  for (const row of await exactHeadwordQuery(db, releaseId, query)) {
    consider(row.wordKey, "headword_exact", row.headword);
  }
  if (candidates.size < limit) {
    for (const row of await prefixHeadwordQuery(db, releaseId, query, SEARCH_MAX_LIMIT)) {
      consider(row.wordKey, "headword_prefix", row.headword);
    }
  }

  const matchExpression = buildFtsMatchExpression(query);
  if (matchExpression !== null) {
    const ftsRows = await ftsSearchQuery(db, releaseId, matchExpression, FTS_SCAN_LIMIT);
    const senseKeys: string[] = [];
    const phraseKeys: string[] = [];
    const exampleKeys: string[] = [];
    for (const row of ftsRows) {
      if (row.entityType === "sense") senseKeys.push(row.entityKey);
      else if (row.entityType === "phrase") phraseKeys.push(row.entityKey);
      else if (row.entityType === "example") exampleKeys.push(row.entityKey);
    }
    const entityWord = new Map<string, { field: SearchMatchedField; wordKey: string }>();
    if (senseKeys.length > 0) {
      for (const row of await senseRowsQuery(db, releaseId, senseKeys)) {
        entityWord.set(row.senseKey, { field: "sense_gloss", wordKey: row.wordKey });
      }
    }
    if (phraseKeys.length > 0) {
      for (const row of await phraseRowsQuery(db, releaseId, phraseKeys)) {
        entityWord.set(row.phraseKey, { field: "phrase", wordKey: row.wordKey });
      }
    }
    if (exampleKeys.length > 0) {
      for (const row of await exampleRowsQuery(db, releaseId, exampleKeys)) {
        entityWord.set(row.exampleKey, { field: "example", wordKey: row.wordKey });
      }
    }
    for (const row of ftsRows) {
      const resolved = entityWord.get(row.entityKey);
      if (resolved) {
        consider(resolved.wordKey, resolved.field, row.text);
      }
    }
  }

  if (candidates.size === 0) {
    return [];
  }

  const wordRows = await wordsWithUnitQuery(db, releaseId, [...candidates.keys()]);
  const hits: Array<SearchHit & { rank: number; unitOrder: number; sourceOrder: number }> = [];
  for (const row of wordRows) {
    const candidate = candidates.get(row.wordKey);
    if (candidate === undefined) {
      continue;
    }
    hits.push({
      word_key: row.wordKey,
      headword: row.headword,
      phonetic: row.phonetic,
      tier: row.tier,
      unit_key: row.unitKey,
      matched_field: candidate.field,
      matched_text: candidate.matchedText,
      rank: FIELD_RANK[candidate.field],
      unitOrder: row.unitOrder,
      sourceOrder: row.sourceOrder,
    });
  }
  hits.sort(
    (left, right) =>
      left.rank - right.rank ||
      left.unitOrder - right.unitOrder ||
      left.sourceOrder - right.sourceOrder ||
      (left.word_key < right.word_key ? -1 : left.word_key > right.word_key ? 1 : 0),
  );
  return hits
    .slice(0, limit)
    .map((hit) => ({
      word_key: hit.word_key,
      headword: hit.headword,
      phonetic: hit.phonetic,
      tier: hit.tier,
      unit_key: hit.unit_key,
      matched_field: hit.matched_field,
      matched_text: hit.matched_text,
    }));
}
