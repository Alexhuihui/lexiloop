/**
 * Shared card-rule types (spec 5.7).
 *
 * The binding introduction-queue order (`card_type_rank` -> word.source_order
 * -> target_entity_key -> content_card_key), the versioned rule-parameter
 * contract read from `config/cards/v1.json`, and the queue entry shape live
 * here so the generator and the queue builders cannot drift apart.
 */
import { z } from "zod";
import { CardType, ExampleOrigin } from "@lexiloop/content-schema";

/** Value type of the CardType contract (the schema export is value-only). */
export type CardTypeName = z.output<typeof CardType>;

/**
 * Fixed queue rank per card type (spec 5.7 rule 2) — the FIRST sort key of
 * every introduction queue. The order is normative: reordering it would
 * silently change every learner's first-introduction sequence.
 */
export const CARD_TYPE_RANK: Readonly<Record<CardTypeName, number>> = {
  WORD_MEANING: 0,
  CONTEXT_MEANING: 1,
  PHRASE: 2,
  SENSE_DISCRIMINATION: 3,
};

/**
 * Versioned rule parameters for deterministic card generation (spec 5.7),
 * read from the versioned `config/cards/v1.json`. Strict: unknown keys fail
 * closed. Template versions are recorded on generated cards but NEVER
 * participate in `content_card_key` derivation, so a template change cannot
 * create new cards or sever user FSRS state.
 */
export const CardRulesConfigSchema = z.strictObject({
  /** Rule-set version; surfaces in release manifests as card_rules_version. */
  card_rules_version: z.string().min(1),
  /** Template version written onto every generated card, per card type. */
  template_versions: z.strictObject({
    WORD_MEANING: z.string().min(1),
    CONTEXT_MEANING: z.string().min(1),
    PHRASE: z.string().min(1),
    SENSE_DISCRIMINATION: z.string().min(1),
  }),
  /** Example origins that qualify for CONTEXT_MEANING cards (v1: exam only). */
  context_meaning_origins: z.array(ExampleOrigin).min(1),
  notes: z.string().min(1),
});
export type CardRulesConfig = z.output<typeof CardRulesConfigSchema>;

/** Error with a stable machine-readable code raised by the card rules. */
export class CardRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CardRuleError";
    this.code = code;
  }
}

/** Minimal word shape the queue builders need (Word rows satisfy it). */
export interface QueueWord {
  word_key: string;
  source_order: number;
}

/** One quick-recall queue slot: a card plus the ordering data it needs. */
export interface IntroductionQueueEntry {
  card_type: CardTypeName;
  word_key: string;
  /** Textbook order of the word inside its unit (second sort key). */
  source_order: number;
  target_entity_key: string;
  content_card_key: string;
}

type QueueSortKey = Pick<
  IntroductionQueueEntry,
  "card_type" | "source_order" | "target_entity_key" | "content_card_key"
>;

/**
 * THE binding introduction-queue comparator (spec 5.7 rule 2):
 * `card_type_rank` -> `word.source_order` -> `target_entity_key` ->
 * `content_card_key`. Both queue builders and the deterministic card
 * artifact ordering go through this one function, so the queues can never
 * drift from the release bytes.
 */
export function compareCardQueueOrder(a: QueueSortKey, b: QueueSortKey): number {
  const rank = CARD_TYPE_RANK[a.card_type] - CARD_TYPE_RANK[b.card_type];
  if (rank !== 0) return rank;
  if (a.source_order !== b.source_order) return a.source_order - b.source_order;
  if (a.target_entity_key !== b.target_entity_key) {
    return a.target_entity_key < b.target_entity_key ? -1 : 1;
  }
  if (a.content_card_key !== b.content_card_key) {
    return a.content_card_key < b.content_card_key ? -1 : 1;
  }
  return 0;
}
