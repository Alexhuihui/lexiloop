/**
 * Release-scoped content reads (spec 6.4/8.2): every read is served from
 * exactly one release — the `app_meta.active_release_id` for normal browsing,
 * or the release pinned by a valid `study_session` for in-session reads (the
 * pinned-release seam; study sessions themselves arrive in Task 13). All
 * payloads contain ONLY shared textbook data: no familiarity, due, stage, or
 * user fields ever enter a content response (spec 8.2) — personal state lives
 * exclusively behind `/api/progress|study|stats|reviews`.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { Explanation } from "@lexiloop/content-schema";
import { schema, type LexiloopDatabase } from "@lexiloop/db";
import {
  ContentRepository,
  ReleaseRepository,
  StudySessionRepository,
  audioAsset,
  book,
  contentAudioLink,
  releaseUnit,
  unit,
  word,
  type AudioAssetRow,
} from "@lexiloop/db";
import type { UserContext } from "@lexiloop/db";
import { searchWords, type SearchHit, type SearchOptions } from "./search";

/** How the content release for a request was resolved. */
export type ReleaseResolution =
  | { ok: true; releaseId: string; pinned: boolean }
  | { ok: false; reason: "NO_ACTIVE_RELEASE" | "SESSION_INVALID" };

export interface BootstrapContent {
  release_id: string;
  config_version: number;
  release: { status: string; activated_at: number | null };
  books: Array<{ book_key: string; title: string; edition: string }>;
  units: Array<{ unit_key: string; book_key: string; level: number; unit_order: number; title: string }>;
}

export interface UnitContent {
  unit: { unit_key: string; book_key: string; level: number; unit_order: number; title: string };
  summary: {
    status: string;
    words: number;
    senses: number;
    phrases: number;
    examples: number;
    explanations: number;
    cards: number;
  } | null;
  words: Array<{ word_key: string; headword: string; phonetic: string | null; tier: string; source_order: number }>;
}

export interface WordContent {
  word: { word_key: string; unit_key: string; headword: string; phonetic: string | null; tier: string; source_order: number };
  unit: { unit_key: string; title: string } | null;
  senses: Array<{ sense_key: string; pos: string; gloss: string; sense_order: number }>;
  phrases: Array<{ phrase_key: string; sense_key: string | null; text: string; gloss: string; source_order: number }>;
  examples: Array<{
    example_key: string;
    sense_key: string | null;
    phrase_key: string | null;
    origin: string;
    source_ref: string | null;
    text: string;
    target_start: number;
    target_end: number;
    source_order: number;
  }>;
  explanations: Array<{
    explanation_key: string;
    syntax_notes: string[];
    translation_hints: string;
    pitfalls: string[];
    context_meanings: Array<{ example_key: string; gloss: string }>;
    discrimination_candidates: Array<{ against_word_key: string; note: string }>;
  }>;
  related: Array<{ to_word_key: string; relation_type: string }>;
  audio: Array<{ entity_type: string; entity_key: string; asset_key: string }>;
}

export type { SearchHit };

/**
 * Release resolution seam (spec 6.4): `?session=` selects the pinned release
 * of a valid study session (existing, owned by the caller, unexpired); every
 * other request resolves `active_release_id`. The study routes of Task 13 can
 * reuse `service.<read>(sessionReleaseId, ...)` unchanged.
 */
export class ContentService {
  constructor(private readonly db: LexiloopDatabase) {}

  async resolveRelease(ctx: UserContext, now: number, sessionId?: string): Promise<ReleaseResolution> {
    if (sessionId !== undefined && sessionId !== "") {
      const session = await new StudySessionRepository(this.db).get(ctx, sessionId);
      if (!session || session.expiresAt <= now) {
        return { ok: false, reason: "SESSION_INVALID" };
      }
      return { ok: true, releaseId: session.releaseId, pinned: true };
    }
    const active = await new ReleaseRepository(this.db).getActive();
    if (!active) {
      return { ok: false, reason: "NO_ACTIVE_RELEASE" };
    }
    return { ok: true, releaseId: active.releaseId, pinned: false };
  }

  /** Current release, books, units, and client content config (spec 8.2). */
  async bootstrap(releaseId: string): Promise<BootstrapContent> {
    const releases = new ReleaseRepository(this.db);
    const [release, meta] = await Promise.all([releases.getById(releaseId), releases.getMeta()]);
    const books = await builder(this.db)
      .select({ bookKey: book.bookKey, title: book.title, edition: book.edition })
      .from(book)
      .where(eq(book.releaseId, releaseId))
      .orderBy(asc(book.bookKey));
    const units = await builder(this.db)
      .select({
        unitKey: unit.unitKey,
        bookKey: unit.bookKey,
        level: unit.level,
        unitOrder: unit.unitOrder,
        title: unit.title,
      })
      .from(unit)
      .where(eq(unit.releaseId, releaseId))
      .orderBy(asc(unit.unitOrder));
    return {
      release_id: releaseId,
      config_version: meta?.configVersion ?? 1,
      release: { status: release?.status ?? "ACTIVE", activated_at: release?.activatedAt ?? null },
      books: books.map((row) => ({ book_key: row.bookKey, title: row.title, edition: row.edition })),
      units: units.map((row) => ({
        unit_key: row.unitKey,
        book_key: row.bookKey,
        level: row.level,
        unit_order: row.unitOrder,
        title: row.title,
      })),
    };
  }

  /** Unit teaching structure plus per-unit content summary (spec 8.2). */
  async unitContent(releaseId: string, unitKey: string): Promise<UnitContent | undefined> {
    const unitRow = await this.db
      .select()
      .from(unit)
      .where(and(eq(unit.releaseId, releaseId), eq(unit.unitKey, unitKey)))
      .get();
    if (!unitRow) {
      return undefined;
    }
    const [summary, words] = await Promise.all([
      this.db
        .select()
        .from(releaseUnit)
        .where(and(eq(releaseUnit.releaseId, releaseId), eq(releaseUnit.unitKey, unitKey)))
        .get(),
      unitWordsQuery(this.db, releaseId, unitKey),
    ]);
    return {
      unit: {
        unit_key: unitRow.unitKey,
        book_key: unitRow.bookKey,
        level: unitRow.level,
        unit_order: unitRow.unitOrder,
        title: unitRow.title,
      },
      summary: summary
        ? {
            status: summary.status,
            words: summary.words,
            senses: summary.senses,
            phrases: summary.phrases,
            examples: summary.examples,
            explanations: summary.explanations,
            cards: summary.cards,
          }
        : null,
      words: words.map((row) => ({
        word_key: row.wordKey,
        headword: row.headword,
        phonetic: row.phonetic,
        tier: row.tier,
        source_order: row.sourceOrder,
      })),
    };
  }

  /** Full dictionary entry: senses, phrases, examples, explanations (spec 8.2). */
  async wordContent(releaseId: string, wordKey: string): Promise<WordContent | undefined> {
    const repo = new ContentRepository(this.db);
    const wordRow = await repo.getWord(releaseId, wordKey);
    if (!wordRow) {
      return undefined;
    }
    const [unitRow, senses, phrases, examples, explanationRows, relations] = await Promise.all([
      repo.getUnit(releaseId, wordRow.unitKey),
      repo.listSenses(releaseId, wordKey),
      repo.listPhrases(releaseId, wordKey),
      repo.listExamples(releaseId, wordKey),
      repo.listExplanations(releaseId, wordKey),
      repo.listRelationsFrom(releaseId, wordKey),
    ]);
    // Audio links for the word itself and its examples (spec 5.8); the link
    // FK guarantees every referenced asset row exists.
    const audioLinks = await builder(this.db)
      .select({
        entityType: contentAudioLink.entityType,
        entityKey: contentAudioLink.entityKey,
        assetKey: contentAudioLink.assetKey,
      })
      .from(contentAudioLink)
      .where(
        and(
          eq(contentAudioLink.releaseId, releaseId),
          inArray(contentAudioLink.entityType, ["word", "example"]),
          inArray(contentAudioLink.entityKey, [wordKey, ...examples.map((row) => row.exampleKey)]),
        ),
      );
    return {
      word: {
        word_key: wordRow.wordKey,
        unit_key: wordRow.unitKey,
        headword: wordRow.headword,
        phonetic: wordRow.phonetic,
        tier: wordRow.tier,
        source_order: wordRow.sourceOrder,
      },
      unit: unitRow ? { unit_key: unitRow.unitKey, title: unitRow.title } : null,
      senses: senses.map((row) => ({
        sense_key: row.senseKey,
        pos: row.pos,
        gloss: row.gloss,
        sense_order: row.senseOrder,
      })),
      phrases: phrases.map((row) => ({
        phrase_key: row.phraseKey,
        sense_key: row.senseKey,
        text: row.text,
        gloss: row.gloss,
        source_order: row.sourceOrder,
      })),
      examples: examples.map((row) => ({
        example_key: row.exampleKey,
        sense_key: row.senseKey,
        phrase_key: row.phraseKey,
        origin: row.origin,
        source_ref: row.sourceRef,
        text: row.text,
        target_start: row.targetStart,
        target_end: row.targetEnd,
        source_order: row.sourceOrder,
      })),
      explanations: explanationRows
        .sort((left, right) => (left.explanationKey < right.explanationKey ? -1 : 1))
        .map((row) => {
          const parsed = parseExplanation(row.explanationKey, row.generatedJson);
          return {
            explanation_key: row.explanationKey,
            syntax_notes: parsed.syntax_notes,
            translation_hints: parsed.translation_hints,
            pitfalls: parsed.pitfalls,
            context_meanings: parsed.context_meanings,
            discrimination_candidates: parsed.discrimination_candidates,
          };
        }),
      related: relations
        .sort((left, right) => (left.relationKey < right.relationKey ? -1 : 1))
        .map((row) => ({ to_word_key: row.toWordKey, relation_type: row.relationType })),
      audio: audioLinks
        .map((row) => ({ entity_type: row.entityType, entity_key: row.entityKey, asset_key: row.assetKey }))
        .sort(
          (left, right) =>
            (left.entity_type < right.entity_type ? -1 : left.entity_type > right.entity_type ? 1 : 0) ||
            (left.entity_key < right.entity_key ? -1 : left.entity_key > right.entity_key ? 1 : 0) ||
            (left.asset_key < right.asset_key ? -1 : left.asset_key > right.asset_key ? 1 : 0),
        ),
    };
  }

  /** Deterministic combined search over one release (spec 9.5). */
  async search(releaseId: string, query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    return await searchWords(this.db, releaseId, query, options);
  }

  /**
   * Audio association check (spec 8.2): the asset must belong to the resolved
   * release, and that release must be ACTIVE or RETAINED (RETIRED) — never a
   * DRAFT/READY/FAILED one.
   */
  async audioAsset(releaseId: string, assetKey: string): Promise<AudioAssetRow | undefined> {
    const release = await new ReleaseRepository(this.db).getById(releaseId);
    if (!release || (release.status !== "ACTIVE" && release.status !== "RETIRED")) {
      return undefined;
    }
    return await this.db
      .select()
      .from(audioAsset)
      .where(and(eq(audioAsset.releaseId, releaseId), eq(audioAsset.assetKey, assetKey)))
      .get();
  }
}

/**
 * Builder-typed handle for query factories: the union handle cannot express
 * drizzle's field-select overloads at the type level; both drivers share the
 * builder runtime and every statement runs behind `await` (the same
 * documented cast the repositories use for transactions).
 */
function builder(db: LexiloopDatabase): BetterSQLite3Database<typeof schema> {
  return db as BetterSQLite3Database<typeof schema>;
}

/**
 * Teaching-order word list for one unit: `tier` then `source_order`
 * (spec 6.3 index `word_release_unit_tier_order_idx`). Exported so the query
 * plan tests EXPLAIN the exact statement the service runs.
 */
export function unitWordsQuery(db: LexiloopDatabase, releaseId: string, unitKey: string) {
  return builder(db)
    .select({
      wordKey: word.wordKey,
      headword: word.headword,
      phonetic: word.phonetic,
      tier: word.tier,
      sourceOrder: word.sourceOrder,
    })
    .from(word)
    .where(and(eq(word.releaseId, releaseId), eq(word.unitKey, unitKey)))
    .orderBy(asc(word.tier), asc(word.sourceOrder), asc(word.wordKey));
}

/** Validates the stored generated blob and strips compilation provenance. */
function parseExplanation(explanationKey: string, generatedJson: string) {
  let parsed: unknown;
  try {
    parsed = Explanation.parse(JSON.parse(generatedJson));
  } catch (cause) {
    throw new Error(`explanation blob invalid for ${explanationKey}`, { cause });
  }
  return parsed as {
    syntax_notes: string[];
    translation_hints: string;
    pitfalls: string[];
    context_meanings: Array<{ example_key: string; gloss: string }>;
    discrimination_candidates: Array<{ against_word_key: string; note: string }>;
  };
}
