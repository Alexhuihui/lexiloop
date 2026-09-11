/**
 * Multi-card introduction queues (spec 5.7, binding order).
 *
 * After a group of words completes content learning, ALL active
 * card_definitions generated for those words enter the quick-recall queue —
 * no card type is silently omitted. The queue order is EXACTLY
 * `card_type_rank` (WORD_MEANING, CONTEXT_MEANING, PHRASE,
 * SENSE_DISCRIMINATION) -> `word.source_order` -> `target_entity_key` ->
 * `content_card_key`. "Cards to introduce" (待引入卡) are active cards whose
 * word is already INTRODUCED but which have no card_state for the user yet;
 * they follow the same fixed order. No FSRS scheduling lives here.
 */
import { describe, expect, it } from "vitest";
import { CardDefinition } from "@lexiloop/content-schema";
import { buildInitialQueue, buildSupplementalQueue } from "../../src/cards/introduction";
import type { CardTypeName, QueueWord } from "../../src/cards/types";

type CardDefinitionT = ReturnType<typeof CardDefinition.parse>;

const UNIT_KEY = "u01";
const W1 = `${UNIT_KEY}-word1`;
const W2 = `${UNIT_KEY}-word2`;
const W3 = `${UNIT_KEY}-word3`;

const WORDS: QueueWord[] = [
  { word_key: W1, source_order: 1 },
  { word_key: W2, source_order: 2 },
  { word_key: W3, source_order: 3 },
];

function definition(input: {
  cardType: CardTypeName;
  wordKey: string;
  target: string;
  key: string;
  status?: "ACTIVE" | "DEPRECATED";
}): CardDefinitionT {
  return CardDefinition.parse({
    content_card_key: input.key,
    card_type: input.cardType,
    target_entity_key: input.target,
    word_key: input.wordKey,
    unit_key: UNIT_KEY,
    template_version: "v1",
    status: input.status ?? "ACTIVE",
  });
}

/**
 * A deck exercising every tie-break level of the fixed sort:
 * - WORD_MEANING cards of word1 (source_order 1) tie on rank + order, so the
 *   target_entity_key decides (t-wm-1 < t-wm-2);
 * - word2's WORD_MEANING card follows on source_order;
 * - two SENSE_DISCRIMINATION cards of word1 tie on rank + order + target, so
 *   the content_card_key decides (k-sd-0 < k-sd-6).
 */
const DECK: CardDefinitionT[] = [
  definition({ cardType: "PHRASE", wordKey: W3, target: "t-ph", key: "k-ph-5" }),
  definition({ cardType: "SENSE_DISCRIMINATION", wordKey: W1, target: "t-sd", key: "k-sd-6" }),
  definition({ cardType: "WORD_MEANING", wordKey: W2, target: "t-wm-3", key: "k-wm-3" }),
  definition({ cardType: "WORD_MEANING", wordKey: W1, target: "t-wm-2", key: "k-wm-2" }),
  definition({ cardType: "SENSE_DISCRIMINATION", wordKey: W1, target: "t-sd", key: "k-sd-0" }),
  definition({ cardType: "CONTEXT_MEANING", wordKey: W1, target: "t-cm", key: "k-cm-4" }),
  definition({ cardType: "WORD_MEANING", wordKey: W1, target: "t-wm-1", key: "k-wm-1" }),
];

describe("buildInitialQueue (spec 5.7 rule 1-2)", () => {
  it("enters ALL active cards of the group's words, omitting no card type", () => {
    const queue = buildInitialQueue(WORDS, DECK);
    expect(queue).toHaveLength(7);
    const byType = (type: CardTypeName) =>
      queue.filter((entry) => entry.card_type === type).length;
    expect(byType("WORD_MEANING")).toBe(3);
    expect(byType("CONTEXT_MEANING")).toBe(1);
    expect(byType("PHRASE")).toBe(1);
    expect(byType("SENSE_DISCRIMINATION")).toBe(2);
  });

  it("sorts exactly by card_type_rank -> source_order -> target_entity_key -> content_card_key", () => {
    const queue = buildInitialQueue(WORDS, DECK);
    expect(queue.map((entry) => entry.content_card_key)).toEqual([
      "k-wm-1",
      "k-wm-2",
      "k-wm-3",
      "k-cm-4",
      "k-ph-5",
      "k-sd-0",
      "k-sd-6",
    ]);
    for (const entry of queue) {
      expect(entry.source_order).toBe(WORDS.find((word) => word.word_key === entry.word_key)!.source_order);
      expect(entry.word_key).toBeDefined();
      expect(entry.target_entity_key).toBeDefined();
    }
  });

  it("excludes DEPRECATED cards and cards of words outside the group", () => {
    const deck = [
      ...DECK,
      definition({ cardType: "WORD_MEANING", wordKey: W1, target: "t-dep", key: "k-dep", status: "DEPRECATED" }),
      definition({ cardType: "PHRASE", wordKey: "u01-foreign", target: "t-foreign", key: "k-foreign" }),
    ];
    const keys = buildInitialQueue(WORDS, deck).map((entry) => entry.content_card_key);
    expect(keys).not.toContain("k-dep");
    expect(keys).not.toContain("k-foreign");
    expect(keys).toHaveLength(7);
  });

  it("keeps one entry per card even when definitions duplicate a key", () => {
    const queue = buildInitialQueue(WORDS, [...DECK, ...DECK]);
    const keys = queue.map((entry) => entry.content_card_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(7);
  });

  it("returns an empty queue for a group with no active cards", () => {
    expect(buildInitialQueue([], DECK)).toEqual([]);
  });
});

describe("buildSupplementalQueue (spec 5.7 rule 7, 待引入卡)", () => {
  const CARD_STATES = [
    { content_card_key: "k-wm-1" },
    { content_card_key: "k-sd-0" },
    { content_card_key: "k-unknown" }, // states of foreign cards are ignored
  ];
  const INTRODUCED: QueueWord[] = [
    { word_key: W1, source_order: 1 },
    { word_key: W2, source_order: 2 },
  ];

  it("lists active cards of INTRODUCED words that have no card_state, in the fixed order", () => {
    const queue = buildSupplementalQueue(INTRODUCED, CARD_STATES, DECK);
    // word3's phrase card exists but word3 is not INTRODUCED; k-wm-1 and
    // k-sd-0 already have card_state; the rest follow the fixed order.
    expect(queue.map((entry) => entry.content_card_key)).toEqual([
      "k-wm-2",
      "k-wm-3",
      "k-cm-4",
      "k-sd-6",
    ]);
    const phraseEntry = queue.find((entry) => entry.card_type === "PHRASE");
    expect(phraseEntry).toBeUndefined();
  });

  it("excludes every card of a word that is not yet INTRODUCED", () => {
    const queue = buildSupplementalQueue([{ word_key: W2, source_order: 2 }], CARD_STATES, DECK);
    expect(queue.map((entry) => entry.content_card_key)).toEqual(["k-wm-3"]);
  });

  it("returns nothing once every active card of the introduced words has state", () => {
    const states = buildSupplementalQueue(INTRODUCED, [], DECK).map((entry) => ({
      content_card_key: entry.content_card_key,
    }));
    expect(buildSupplementalQueue(INTRODUCED, states, DECK)).toEqual([]);
  });

  it("excludes DEPRECATED cards even for introduced words without state", () => {
    const deck = [
      definition({ cardType: "WORD_MEANING", wordKey: W2, target: "t-wm-3", key: "k-wm-3" }),
      definition({ cardType: "WORD_MEANING", wordKey: W2, target: "t-dep", key: "k-dep", status: "DEPRECATED" }),
    ];
    expect(buildSupplementalQueue(INTRODUCED, [], deck).map((entry) => entry.content_card_key)).toEqual([
      "k-wm-3",
    ]);
  });
});
