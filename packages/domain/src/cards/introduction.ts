/**
 * Multi-card introduction queues (spec 5.7).
 *
 * Rule 1: after a group of words completes content learning, ALL active
 * `card_definition`s generated for those words enter the group's quick-recall
 * queue — no card type is silently omitted.
 * Rule 2: the queue is built under the one fixed sort key `card_type_rank`
 * (WORD_MEANING, CONTEXT_MEANING, PHRASE, SENSE_DISCRIMINATION) ->
 * `word.source_order` -> `target_entity_key` -> `content_card_key`, so the
 * same release, word group, and configuration always yield the same queue.
 * Rule 7: "cards to introduce" (待引入卡) are cards of the active release the
 * user has no `card_state` for whose word is already INTRODUCED; they enter
 * quick recall under the same fixed order.
 *
 * Pure ordering rules only — no FSRS scheduling, no persistence, and no
 * `card_state` creation: a card enters its `card_state` only after its first
 * reveal + rating in a Session.
 */
import { z } from "zod";
import type { CardDefinition } from "@lexiloop/content-schema";
import { compareCardQueueOrder } from "./types";
import type { IntroductionQueueEntry, QueueWord } from "./types";

type CardDefinitionT = Pick<
  z.output<typeof CardDefinition>,
  "content_card_key" | "card_type" | "target_entity_key" | "word_key" | "status"
>;

function toEntry(definition: CardDefinitionT, sourceOrder: number): IntroductionQueueEntry {
  return {
    card_type: definition.card_type,
    word_key: definition.word_key,
    source_order: sourceOrder,
    target_entity_key: definition.target_entity_key,
    content_card_key: definition.content_card_key,
  };
}

/**
 * The quick-recall queue for one freshly-learned word group: every ACTIVE
 * card definition of the group's words (and nothing else), one entry per
 * card, in the exact fixed order of spec 5.7 rule 2.
 */
export function buildInitialQueue(
  words: readonly QueueWord[],
  cardDefinitions: readonly CardDefinitionT[],
): IntroductionQueueEntry[] {
  const orderByWord = new Map(words.map((word) => [word.word_key, word.source_order] as const));
  const seen = new Set<string>();
  const entries: IntroductionQueueEntry[] = [];
  for (const definition of cardDefinitions) {
    if (definition.status !== "ACTIVE") continue;
    const sourceOrder = orderByWord.get(definition.word_key);
    if (sourceOrder === undefined) continue;
    if (seen.has(definition.content_card_key)) continue;
    seen.add(definition.content_card_key);
    entries.push(toEntry(definition, sourceOrder));
  }
  return entries.sort(compareCardQueueOrder);
}

/**
 * The supplemental "cards to introduce" queue (待引入卡): ACTIVE cards of
 * already-INTRODUCED words that have no `card_state` for the user yet, in the
 * exact fixed order of spec 5.7 rule 2. Grading these creates the card's
 * `card_state` but never changes the word's INTRODUCED stage (that concern
 * lives in the study domain, not here).
 */
export function buildSupplementalQueue(
  introducedWords: readonly QueueWord[],
  cardStates: ReadonlyArray<{ content_card_key: string }>,
  activeDefinitions: readonly CardDefinitionT[],
): IntroductionQueueEntry[] {
  const orderByWord = new Map(
    introducedWords.map((word) => [word.word_key, word.source_order] as const),
  );
  const stateKeys = new Set(cardStates.map((state) => state.content_card_key));
  const seen = new Set<string>();
  const entries: IntroductionQueueEntry[] = [];
  for (const definition of activeDefinitions) {
    if (definition.status !== "ACTIVE") continue;
    const sourceOrder = orderByWord.get(definition.word_key);
    if (sourceOrder === undefined) continue;
    if (stateKeys.has(definition.content_card_key)) continue;
    if (seen.has(definition.content_card_key)) continue;
    seen.add(definition.content_card_key);
    entries.push(toEntry(definition, sourceOrder));
  }
  return entries.sort(compareCardQueueOrder);
}
