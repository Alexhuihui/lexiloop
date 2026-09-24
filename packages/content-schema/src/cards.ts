import { z } from "zod";
import { LogicalKey } from "./source";

/**
 * Rule-based card contracts (spec 5.7/6.2).
 *
 * Cards are never written freely by agents; the compiler derives them from
 * reviewed content using versioned rules. A card definition records the card
 * type, its semantic target, the template version and its active status —
 * enough to derive a stable `content_card_key` and keep FSRS state continuous
 * across releases.
 */

export const CardType = z.enum([
  "WORD_MEANING",
  "CONTEXT_MEANING",
  "PHRASE",
  "SENSE_DISCRIMINATION",
]);

export const CardStatus = z.enum(["ACTIVE", "DEPRECATED"]);

export const CardDefinition = z.strictObject({
  /** Stable across releases; user FSRS state references this key. */
  content_card_key: LogicalKey,
  card_type: CardType,
  /** Semantic target: word/sense/phrase/example key the card tests. */
  target_entity_key: LogicalKey,
  /** Owning word; used for the fixed first-introduction queue order. */
  word_key: LogicalKey,
  unit_key: LogicalKey,
  template_version: z.string().min(1),
  status: CardStatus,
});
