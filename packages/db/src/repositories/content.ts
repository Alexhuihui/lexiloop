import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { LexiloopDatabase } from "../schema";
import {
  audioAsset,
  book,
  cardDefinition,
  contentAudioLink,
  example,
  explanation,
  lexicalRelation,
  phrase,
  sense,
  unit,
  word,
  type AudioAssetRow,
  type BookRow,
  type CardDefinitionRow,
  type ExampleRow,
  type ExplanationRow,
  type LexicalRelationRow,
  type PhraseRow,
  type SenseRow,
  type UnitRow,
  type WordRow,
} from "../schema";

/** Audio link entity types V1 pre-generates audio for (spec 5.8). */
export type AudioEntityType = "word" | "example";

/**
 * Release-scoped content reads (spec 6.2/6.4). Every method takes the
 * release id explicitly: browsing reads pass the active release, in-session
 * reads pass the session's pinned release. No list-everything escape hatches.
 * All statements are awaited so the repositories run unchanged on the sync
 * better-sqlite3 driver and the async D1 driver.
 */
export class ContentRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  async getBook(releaseId: string, bookKey: string): Promise<BookRow | undefined> {
    return await this.db
      .select()
      .from(book)
      .where(and(eq(book.releaseId, releaseId), eq(book.bookKey, bookKey)))
      .get();
  }

  async getUnit(releaseId: string, unitKey: string): Promise<UnitRow | undefined> {
    return await this.db
      .select()
      .from(unit)
      .where(and(eq(unit.releaseId, releaseId), eq(unit.unitKey, unitKey)))
      .get();
  }

  async getWord(releaseId: string, wordKey: string): Promise<WordRow | undefined> {
    return await this.db
      .select()
      .from(word)
      .where(and(eq(word.releaseId, releaseId), eq(word.wordKey, wordKey)))
      .get();
  }

  async listSenses(releaseId: string, wordKey: string): Promise<SenseRow[]> {
    return await this.db
      .select()
      .from(sense)
      .where(and(eq(sense.releaseId, releaseId), eq(sense.wordKey, wordKey)))
      .orderBy(asc(sense.senseOrder));
  }

  async listPhrases(releaseId: string, wordKey: string): Promise<PhraseRow[]> {
    return await this.db
      .select()
      .from(phrase)
      .where(and(eq(phrase.releaseId, releaseId), eq(phrase.wordKey, wordKey)))
      .orderBy(asc(phrase.sourceOrder));
  }

  async listExamples(releaseId: string, wordKey: string): Promise<ExampleRow[]> {
    return await this.db
      .select()
      .from(example)
      .where(and(eq(example.releaseId, releaseId), eq(example.wordKey, wordKey)))
      .orderBy(asc(example.sourceOrder));
  }

  async listExplanations(releaseId: string, wordKey: string): Promise<ExplanationRow[]> {
    return await this.db
      .select()
      .from(explanation)
      .where(and(eq(explanation.releaseId, releaseId), eq(explanation.wordKey, wordKey)));
  }

  async listRelationsFrom(releaseId: string, fromWordKey: string): Promise<LexicalRelationRow[]> {
    return await this.db
      .select()
      .from(lexicalRelation)
      .where(and(eq(lexicalRelation.releaseId, releaseId), eq(lexicalRelation.fromWordKey, fromWordKey)));
  }

  async getCard(releaseId: string, contentCardKey: string): Promise<CardDefinitionRow | undefined> {
    return await this.db
      .select()
      .from(cardDefinition)
      .where(and(eq(cardDefinition.releaseId, releaseId), eq(cardDefinition.contentCardKey, contentCardKey)))
      .get();
  }

  /** Fetches session card definitions without one D1 request per card.
   * Chunks leave room for the release id under D1's 100 bound-parameter cap. */
  async getCards(releaseId: string, contentCardKeys: readonly string[]): Promise<CardDefinitionRow[]> {
    const keys = [...new Set(contentCardKeys)];
    const rows: CardDefinitionRow[] = [];
    for (let start = 0; start < keys.length; start += 90) {
      rows.push(...await this.db
        .select()
        .from(cardDefinition)
        .where(and(eq(cardDefinition.releaseId, releaseId), inArray(cardDefinition.contentCardKey, keys.slice(start, start + 90)))));
    }
    return rows;
  }

  /** Fetches the cards for many words in one D1 request. A JSON array keeps
   * the statement at two bindings regardless of the number of word keys. */
  async listCardsForWords(releaseId: string, wordKeys: readonly string[]): Promise<CardDefinitionRow[]> {
    const keys = [...new Set(wordKeys)];
    if (keys.length === 0) return [];
    return await this.db
      .select()
      .from(cardDefinition)
      .where(and(
        eq(cardDefinition.releaseId, releaseId),
        sql`${cardDefinition.wordKey} IN (SELECT value FROM json_each(${JSON.stringify(keys)}))`,
      ));
  }

  async listCards(releaseId: string, wordKey: string): Promise<CardDefinitionRow[]> {
    return await this.db
      .select()
      .from(cardDefinition)
      .where(and(eq(cardDefinition.releaseId, releaseId), eq(cardDefinition.wordKey, wordKey)));
  }

  /**
   * Audio assets linked to one content entity (spec 5.8/6.2). Implemented as
   * two plain selects: the union handle type does not preserve aliased
   * join-select result shapes, and a link-first lookup avoids the join.
   */
  async listAudio(releaseId: string, entityType: AudioEntityType, entityKey: string): Promise<AudioAssetRow[]> {
    const links = await this.db
      .select()
      .from(contentAudioLink)
      .where(
        and(
          eq(contentAudioLink.releaseId, releaseId),
          eq(contentAudioLink.entityType, entityType),
          eq(contentAudioLink.entityKey, entityKey),
        ),
      );
    if (links.length === 0) {
      return [];
    }
    return await this.db
      .select()
      .from(audioAsset)
      .where(and(eq(audioAsset.releaseId, releaseId), inArray(audioAsset.assetKey, links.map((link) => link.assetKey))));
  }
}
