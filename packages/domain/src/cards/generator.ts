/**
 * Rule-driven card generation (spec 5.7).
 *
 * Cards are never freely written by agents: the compiler derives them from
 * reviewed, validated structured content under fixed, versioned rules read
 * from `config/cards/v1.json`:
 *
 * - WORD_MEANING — one per learnable sense (front: headword + optional
 *   phonetic/audio; back: core sense + part of speech);
 * - CONTEXT_MEANING — per qualified (real-exam) example the review-passed
 *   explanation gives a contextual meaning for (front: exam sentence with the
 *   target word blanked; back: contextual meaning, original sentence,
 *   explanation);
 * - PHRASE — one per approved source phrase (front: phrase; back: meaning,
 *   collocations, source sentence);
 * - SENSE_DISCRIMINATION — per review-confirmed confusable candidate
 *   (front: discrimination prompt; back: distinguishing basis + example).
 *
 * Every card gets a stable `content_card_key` derived ONLY from the semantic
 * target (never the template version or release), and every learnable word
 * must end with at least one card or the whole Unit is rejected — a word with
 * zero cards must block the Unit here, never surface as an unstudiable word
 * later.
 */
import {
  AgentGenerationOutput,
  CardDefinition,
  SourceSnapshot,
} from "@lexiloop/content-schema";
import { z } from "zod";
import { stableKey } from "../stable-key";
import {
  CardRuleError,
  CardRulesConfigSchema,
  compareCardQueueOrder,
  type CardRulesConfig,
  type CardTypeName,
} from "./types";

/** Value types of the strict contracts (the schema exports are value-only). */
type SourceSnapshotT = z.output<typeof SourceSnapshot>;
type AgentGenerationOutputT = z.output<typeof AgentGenerationOutput>;
type CardDefinitionT = z.output<typeof CardDefinition>;

/** Stable-key slug prefix per card type (part of the semantic target). */
const CARD_KEY_SLUGS: Readonly<Record<CardTypeName, string>> = {
  WORD_MEANING: "word_meaning",
  CONTEXT_MEANING: "context_meaning",
  PHRASE: "phrase",
  SENSE_DISCRIMINATION: "sense_discrimination",
};

/**
 * Derive the stable `content_card_key` (spec 5.5/5.7): a SHA-256 stable key
 * over book, unit, ordinal (the word's textbook order) and a slug naming the
 * semantic target. Release-independent and template-independent: changing a
 * template version never re-keys a card; changing the semantic target does.
 * SENSE_DISCRIMINATION cards carry the confusable counterpart as the
 * discriminator so same-word candidates get distinct keys.
 */
export function contentCardKey(input: {
  bookKey: string;
  unitKey: string;
  wordSourceOrder: number;
  cardType: CardTypeName;
  targetEntityKey: string;
  discriminator?: string;
}): string {
  const slug = [
    CARD_KEY_SLUGS[input.cardType],
    input.targetEntityKey,
    ...(input.discriminator !== undefined ? [input.discriminator] : []),
  ].join(":");
  return stableKey({
    book: input.bookKey,
    unit: input.unitKey,
    type: "card",
    ordinal: input.wordSourceOrder,
    slug,
  });
}

export interface GenerateUnitCardsInput {
  /** Versioned rule parameters (validated `config/cards/v1.json`). */
  config: CardRulesConfig;
  /** Schema-validated source snapshot of one unit (spec 5.5). */
  source: SourceSnapshotT;
  /** Review-passed generated content for the unit's words (spec 5.6). */
  generation: AgentGenerationOutputT;
}

interface WordRuleInput {
  unitKey: string;
  bookKey: string;
  wordSourceOrder: number;
  config: CardRulesConfig;
}

function wordMeaningCard(
  input: WordRuleInput & { wordKey: string; senseKey: string },
): CardDefinitionT {
  return CardDefinition.parse({
    content_card_key: contentCardKey({
      bookKey: input.bookKey,
      unitKey: input.unitKey,
      wordSourceOrder: input.wordSourceOrder,
      cardType: "WORD_MEANING",
      targetEntityKey: input.senseKey,
    }),
    card_type: "WORD_MEANING",
    target_entity_key: input.senseKey,
    word_key: input.wordKey,
    unit_key: input.unitKey,
    template_version: input.config.template_versions.WORD_MEANING,
    status: "ACTIVE",
  });
}

function contextMeaningCard(
  input: WordRuleInput & { wordKey: string; exampleKey: string },
): CardDefinitionT {
  return CardDefinition.parse({
    content_card_key: contentCardKey({
      bookKey: input.bookKey,
      unitKey: input.unitKey,
      wordSourceOrder: input.wordSourceOrder,
      cardType: "CONTEXT_MEANING",
      targetEntityKey: input.exampleKey,
    }),
    card_type: "CONTEXT_MEANING",
    target_entity_key: input.exampleKey,
    word_key: input.wordKey,
    unit_key: input.unitKey,
    template_version: input.config.template_versions.CONTEXT_MEANING,
    status: "ACTIVE",
  });
}

function phraseCard(
  input: WordRuleInput & { wordKey: string; phraseKey: string },
): CardDefinitionT {
  return CardDefinition.parse({
    content_card_key: contentCardKey({
      bookKey: input.bookKey,
      unitKey: input.unitKey,
      wordSourceOrder: input.wordSourceOrder,
      cardType: "PHRASE",
      targetEntityKey: input.phraseKey,
    }),
    card_type: "PHRASE",
    target_entity_key: input.phraseKey,
    word_key: input.wordKey,
    unit_key: input.unitKey,
    template_version: input.config.template_versions.PHRASE,
    status: "ACTIVE",
  });
}

function senseDiscriminationCard(
  input: WordRuleInput & { wordKey: string; againstWordKey: string },
): CardDefinitionT {
  return CardDefinition.parse({
    content_card_key: contentCardKey({
      bookKey: input.bookKey,
      unitKey: input.unitKey,
      wordSourceOrder: input.wordSourceOrder,
      cardType: "SENSE_DISCRIMINATION",
      targetEntityKey: input.wordKey,
      discriminator: input.againstWordKey,
    }),
    card_type: "SENSE_DISCRIMINATION",
    // The semantic target is the explained word; the confusable counterpart
    // is part of the key slug, so same-word candidates never collide.
    target_entity_key: input.wordKey,
    word_key: input.wordKey,
    unit_key: input.unitKey,
    template_version: input.config.template_versions.SENSE_DISCRIMINATION,
    status: "ACTIVE",
  });
}

/**
 * Generate the active card definitions for one unit from validated inputs.
 * Deterministic: same inputs -> same cards in the same fixed order
 * (card_type_rank -> word.source_order -> target_entity_key ->
 * content_card_key). Fails closed with a `CardRuleError` when a learnable
 * word would end with zero cards (spec 5.7 rule 7), when citations leave the
 * unit's evidence, or when two cards collide on one key.
 */
export function generateUnitCards(input: GenerateUnitCardsInput): CardDefinitionT[] {
  const config = CardRulesConfigSchema.parse(input.config);
  const { unit, words, senses, phrases, examples } = input.source;

  const explanationsByWord = new Map<string, AgentGenerationOutputT["explanations"][number]>();
  for (const explanation of input.generation.explanations) {
    if (explanationsByWord.has(explanation.word_key)) {
      throw new CardRuleError(
        "CARD_INPUT_INVALID",
        `word ${explanation.word_key} carries more than one reviewed explanation`,
      );
    }
    explanationsByWord.set(explanation.word_key, explanation);
  }

  const examplesByKey = new Map(examples.map((example) => [example.example_key, example]));
  const wordKeys = new Set(words.map((word) => word.word_key));

  const cards: CardDefinitionT[] = [];
  const cardlessWords: string[] = [];
  for (const word of [...words].sort(
    (a, b) => a.source_order - b.source_order || (a.word_key < b.word_key ? -1 : 1),
  )) {
    const ruleInput: WordRuleInput = {
      unitKey: unit.unit_key,
      bookKey: unit.book_key,
      wordSourceOrder: word.source_order,
      config,
    };
    const wordCards: CardDefinitionT[] = [];

    // WORD_MEANING: one per learnable sense, straight from reviewed source.
    const wordSenses = senses
      .filter((sense) => sense.word_key === word.word_key)
      .sort((a, b) => a.sense_order - b.sense_order || (a.sense_key < b.sense_key ? -1 : 1));
    for (const sense of wordSenses) {
      wordCards.push(
        wordMeaningCard({ ...ruleInput, wordKey: word.word_key, senseKey: sense.sense_key }),
      );
    }

    // CONTEXT_MEANING: only where a review-passed contextual meaning cites a
    // qualified (real-exam) example of this word.
    const explanation = explanationsByWord.get(word.word_key);
    if (explanation) {
      for (const meaning of explanation.context_meanings) {
        const example = examplesByKey.get(meaning.example_key);
        if (!example) {
          throw new CardRuleError(
            "CARD_TARGET_UNKNOWN",
            `context meaning cites example ${meaning.example_key} that does not exist in unit ${unit.unit_key}`,
          );
        }
        if (example.word_key !== word.word_key) {
          throw new CardRuleError(
            "CITATION_SCOPE_MISMATCH",
            `context meaning cites example ${meaning.example_key} of another word (${example.word_key})`,
          );
        }
        if (!config.context_meaning_origins.includes(example.origin)) continue;
        wordCards.push(
          contextMeaningCard({ ...ruleInput, wordKey: word.word_key, exampleKey: example.example_key }),
        );
      }

      // SENSE_DISCRIMINATION: one per review-confirmed confusable candidate.
      for (const candidate of explanation.discrimination_candidates) {
        if (!wordKeys.has(candidate.against_word_key)) {
          throw new CardRuleError(
            "CARD_TARGET_UNKNOWN",
            `discrimination candidate ${candidate.against_word_key} does not exist in unit ${unit.unit_key}`,
          );
        }
        if (candidate.against_word_key === word.word_key) {
          throw new CardRuleError(
            "CITATION_SCOPE_MISMATCH",
            "discrimination candidate targets the explained word itself",
          );
        }
        wordCards.push(
          senseDiscriminationCard({
            ...ruleInput,
            wordKey: word.word_key,
            againstWordKey: candidate.against_word_key,
          }),
        );
      }
    }

    // PHRASE: one per approved source phrase.
    const wordPhrases = phrases
      .filter((phrase) => phrase.word_key === word.word_key)
      .sort((a, b) => a.source_order - b.source_order || (a.phrase_key < b.phrase_key ? -1 : 1));
    for (const phrase of wordPhrases) {
      wordCards.push(
        phraseCard({ ...ruleInput, wordKey: word.word_key, phraseKey: phrase.phrase_key }),
      );
    }

    if (wordCards.length === 0) {
      cardlessWords.push(`${word.headword} (${word.word_key})`);
      continue;
    }
    cards.push(...wordCards);
  }

  if (cardlessWords.length > 0) {
    throw new CardRuleError(
      "WORD_HAS_NO_CARDS",
      `${cardlessWords.length} learnable word(s) would have zero active cards: ` +
        `${cardlessWords.join(", ")}; the unit is blocked until every learnable word has a card`,
    );
  }

  const byKey = new Map<string, CardDefinitionT>();
  for (const card of cards) {
    if (byKey.has(card.content_card_key)) {
      throw new CardRuleError(
        "CARD_KEY_DUPLICATE",
        `two cards collide on content_card_key ${card.content_card_key} ` +
          `(${card.card_type} targeting ${card.target_entity_key})`,
      );
    }
    byKey.set(card.content_card_key, card);
  }
  // The generated definitions are emitted in the exact binding queue order
  // (spec 5.7 rule 2) so the release artifact bytes and every queue agree.
  const orderByWord = new Map(words.map((word) => [word.word_key, word.source_order] as const));
  return [...byKey.values()].sort((a, b) =>
    compareCardQueueOrder(
      {
        card_type: a.card_type,
        source_order: orderByWord.get(a.word_key) ?? 0,
        target_entity_key: a.target_entity_key,
        content_card_key: a.content_card_key,
      },
      {
        card_type: b.card_type,
        source_order: orderByWord.get(b.word_key) ?? 0,
        target_entity_key: b.target_entity_key,
        content_card_key: b.content_card_key,
      },
    ),
  );
}
