import { and, asc, eq } from "drizzle-orm";
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
 */
export class ContentRepository {
  constructor(private readonly db: LexiloopDatabase) {}

  getBook(releaseId: string, bookKey: string): BookRow | undefined {
    return this.db
      .select()
      .from(book)
      .where(and(eq(book.releaseId, releaseId), eq(book.bookKey, bookKey)))
      .get();
  }

  getUnit(releaseId: string, unitKey: string): UnitRow | undefined {
    return this.db
      .select()
      .from(unit)
      .where(and(eq(unit.releaseId, releaseId), eq(unit.unitKey, unitKey)))
      .get();
  }

  getWord(releaseId: string, wordKey: string): WordRow | undefined {
    return this.db
      .select()
      .from(word)
      .where(and(eq(word.releaseId, releaseId), eq(word.wordKey, wordKey)))
      .get();
  }

  listSenses(releaseId: string, wordKey: string): SenseRow[] {
    return this.db
      .select()
      .from(sense)
      .where(and(eq(sense.releaseId, releaseId), eq(sense.wordKey, wordKey)))
      .orderBy(asc(sense.senseOrder))
      .all();
  }

  listPhrases(releaseId: string, wordKey: string): PhraseRow[] {
    return this.db
      .select()
      .from(phrase)
      .where(and(eq(phrase.releaseId, releaseId), eq(phrase.wordKey, wordKey)))
      .orderBy(asc(phrase.sourceOrder))
      .all();
  }

  listExamples(releaseId: string, wordKey: string): ExampleRow[] {
    return this.db
      .select()
      .from(example)
      .where(and(eq(example.releaseId, releaseId), eq(example.wordKey, wordKey)))
      .orderBy(asc(example.sourceOrder))
      .all();
  }

  listExplanations(releaseId: string, wordKey: string): ExplanationRow[] {
    return this.db
      .select()
      .from(explanation)
      .where(and(eq(explanation.releaseId, releaseId), eq(explanation.wordKey, wordKey)))
      .all();
  }

  listRelationsFrom(releaseId: string, fromWordKey: string): LexicalRelationRow[] {
    return this.db
      .select()
      .from(lexicalRelation)
      .where(and(eq(lexicalRelation.releaseId, releaseId), eq(lexicalRelation.fromWordKey, fromWordKey)))
      .all();
  }

  getCard(releaseId: string, contentCardKey: string): CardDefinitionRow | undefined {
    return this.db
      .select()
      .from(cardDefinition)
      .where(and(eq(cardDefinition.releaseId, releaseId), eq(cardDefinition.contentCardKey, contentCardKey)))
      .get();
  }

  listCards(releaseId: string, wordKey: string): CardDefinitionRow[] {
    return this.db
      .select()
      .from(cardDefinition)
      .where(and(eq(cardDefinition.releaseId, releaseId), eq(cardDefinition.wordKey, wordKey)))
      .all();
  }

  /** Audio assets linked to one content entity (spec 5.8/6.2). */
  listAudio(releaseId: string, entityType: AudioEntityType, entityKey: string): AudioAssetRow[] {
    return this.db
      .select({ asset: audioAsset })
      .from(contentAudioLink)
      .innerJoin(
        audioAsset,
        and(
          eq(contentAudioLink.releaseId, audioAsset.releaseId),
          eq(contentAudioLink.assetKey, audioAsset.assetKey),
        ),
      )
      .where(
        and(
          eq(contentAudioLink.releaseId, releaseId),
          eq(contentAudioLink.entityType, entityType),
          eq(contentAudioLink.entityKey, entityKey),
        ),
      )
      .all()
      .map((row) => row.asset);
  }
}
