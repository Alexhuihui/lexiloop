/**
 * Rule-driven card generation (spec 5.7).
 *
 * Cards are never freely written: the compiler derives them from reviewed,
 * validated structured content under fixed, versioned rules. Under test:
 * - all eligible cards of the four types are generated, one WORD_MEANING card
 *   per learnable sense, CONTEXT_MEANING only for a qualified (real-exam)
 *   example carrying a contextual meaning, PHRASE per approved phrase, and
 *   SENSE_DISCRIMINATION per review-confirmed confusable candidate;
 * - every learnable word ends with at least one card or the whole Unit is
 *   rejected (fail closed, machine-readable);
 * - content_card_key values are stable, release-independent, and keyed by the
 *   semantic target only — a template-version change must never create new
 *   cards;
 * - reruns are byte-identical and emit the exact fixed card order
 *   (card_type_rank -> word.source_order -> target_entity_key ->
 *   content_card_key).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentGenerationOutput,
  CardDefinition,
  Example,
  Phrase,
  Sense,
  SourceSnapshot,
  Unit,
  Word,
} from "@lexiloop/content-schema";
import { z } from "zod";
import { generateUnitCards } from "../../src/cards/generator";
import { CardRuleError, type CardRulesConfig } from "../../src/cards/types";

/** Value types of the strict contracts (the schema exports are value-only). */
type SourceSnapshotT = z.output<typeof SourceSnapshot>;
type AgentGenerationOutputT = z.output<typeof AgentGenerationOutput>;
type CardDefinitionT = z.output<typeof CardDefinition>;

const UNIT_KEY = "u01";
const W1 = `${UNIT_KEY}-abandon`;
const W2 = `${UNIT_KEY}-ability`;
const W3 = `${UNIT_KEY}-zeal`;

const CONFIG: CardRulesConfig = {
  card_rules_version: "cards-v1",
  template_versions: {
    WORD_MEANING: "v1",
    CONTEXT_MEANING: "v1",
    PHRASE: "v1",
    SENSE_DISCRIMINATION: "v1",
  },
  context_meaning_origins: ["exam"],
  notes: "test rule parameters",
};

const PDF_HASH = "b1".repeat(32);
const sha = (label: string): string => createHash("sha256").update(label).digest("hex");

function provenance(page: number, text: string) {
  return {
    source_pdf_sha256: PDF_HASH,
    page_number: page,
    bbox: [0.1, 0.2, 0.5, 0.6] as [number, number, number, number],
    page_image_sha256: sha(`page-${page}`),
    source_raw_ref_hash: sha(`raw-${page}`),
    source_normalized_text: text,
    ocr_confidence: 0.98,
    structure_confidence: 0.97,
  };
}

/**
 * One unit, two learnable words:
 * - abandon (order 1): two senses, one phrase, one real-exam example (with a
 *   valid target span) plus one textbook example, a review-passed explanation
 *   citing both examples and confirming abandon/ability as confusable;
 * - ability (order 2): one sense and a review-confirmed reverse candidate.
 */
function makeSource(withZeal = false): SourceSnapshotT {
  const unit = Unit.parse({
    unit_key: UNIT_KEY,
    book_key: "llcy",
    level: 1,
    unit_order: 1,
    title: "Unit 1",
    ...provenance(12, "Unit 1"),
  });
  const words = [
    Word.parse({
      word_key: W1,
      unit_key: UNIT_KEY,
      headword: "abandon",
      phonetic: "/\u0259\u02c8b\u00e6nd\u0259n/",
      tier: "core",
      source_order: 1,
      ...provenance(12, "abandon vt. \u653e\u5f03"),
    }),
    Word.parse({
      word_key: W2,
      unit_key: UNIT_KEY,
      headword: "ability",
      tier: "core",
      source_order: 2,
      ...provenance(12, "ability n. \u80fd\u529b"),
    }),
    ...(withZeal
      ? [
          Word.parse({
            word_key: W3,
            unit_key: UNIT_KEY,
            headword: "zeal",
            tier: "core",
            source_order: 3,
            ...provenance(12, "zeal n. \u70ed\u60c5"),
          }),
        ]
      : []),
  ];
  const senses = [
    Sense.parse({
      sense_key: `${W1}-s1`,
      word_key: W1,
      pos: "vt",
      gloss: "\u653e\u5f03\uff1b\u629b\u5f03",
      sense_order: 1,
      ...provenance(12, "\u653e\u5f03\uff1b\u629b\u5f03"),
    }),
    Sense.parse({
      sense_key: `${W1}-s2`,
      word_key: W1,
      pos: "n",
      gloss: "\u653e\u7eb5\uff0c\u7eb5\u60c5",
      sense_order: 2,
      ...provenance(12, "\u653e\u7eb5\uff0c\u7eb5\u60c5"),
    }),
    Sense.parse({
      sense_key: `${W2}-s1`,
      word_key: W2,
      pos: "n",
      gloss: "\u80fd\u529b\uff0c\u624d\u80fd",
      sense_order: 1,
      ...provenance(12, "\u80fd\u529b\uff0c\u624d\u80fd"),
    }),
  ];
  const phrases = [
    Phrase.parse({
      phrase_key: `${W1}-p1`,
      word_key: W1,
      text: "abandon oneself to",
      gloss: "\u6c89\u6eaf\u4e8e",
      source_order: 1,
      ...provenance(12, "abandon oneself to \u6c89\u6eaf\u4e8e"),
    }),
  ];
  const examples = [
    Example.parse({
      example_key: `${W1}-ex1`,
      word_key: W1,
      origin: "exam",
      source_ref: "2019 \u9605\u8bfb Text 2",
      text: "He abandoned the plan without a second thought.",
      target_span: [4, 13],
      source_order: 1,
      ...provenance(12, "He abandoned the plan without a second thought."),
    }),
    Example.parse({
      example_key: `${W1}-ex2`,
      word_key: W1,
      origin: "textbook",
      text: "She abandoned herself to grief.",
      target_span: [4, 22],
      source_order: 2,
      ...provenance(12, "She abandoned herself to grief."),
    }),
  ];
  return SourceSnapshot.parse({
    unit,
    words,
    senses,
    phrases,
    examples,
    relations: [],
  });
}

/** Review-passed generation output: one explanation per word. */
function makeGeneration(source: SourceSnapshotT): AgentGenerationOutputT {
  const explanations = source.words.map((word) => {
    const examples = source.examples.filter((example) => example.word_key === word.word_key);
    const candidates =
      word.word_key === W1
        ? [{ against_word_key: W2, note: "abandon \u8868\u201c\u653e\u5f03\u201d\uff0cability \u8868\u201c\u80fd\u529b\u201d\uff0c\u8bcd\u6027\u4e0e\u642d\u914d\u5747\u4e0d\u540c" }]
        : word.word_key === W2
          ? [{ against_word_key: W1, note: "ability \u4e3a\u540d\u8bcd\uff0c\u4e0d\u63a5\u5bbe\u8bed\u76f4\u63a5\u5bbe\u8865" }]
          : [];
    return {
      explanation_key: `exp.${word.word_key}`,
      word_key: word.word_key,
      unit_key: source.unit.unit_key,
      syntax_notes: [`\u53ca\u7269\u52a8\u8bcd\uff0c\u540e\u63a5\u540d\u8bcd\u4f5c\u5bbe\u8bed (${word.headword})`],
      translation_hints: `\u91ca\u4e49\u63d0\u793a (${word.headword})`,
      pitfalls: [`\u6613\u4e0e\u8fd1\u4e49\u8bcd\u6df7\u6dc6 (${word.headword})`],
      context_meanings: examples.map((example) => ({
        example_key: example.example_key,
        gloss: `\u8bed\u5883\u4e2d\u6307\u201c\u653e\u5f03\u201d (${word.headword})`,
      })),
      discrimination_candidates: candidates,
      input_hash: "0".repeat(64),
      prompt_version: "semantic-v1",
      model_id: "generation-model",
      agent_run_id: "run-gen",
      generated_at: "2026-09-11T00:00:00.000Z",
    };
  });
  return AgentGenerationOutput.parse({
    unit_key: source.unit.unit_key,
    packet_id: "packet-1",
    input_hash: "0".repeat(64),
    prompt_version: "semantic-v1",
    model_id: "generation-model",
    agent_run_id: "run-gen",
    generated_at: "2026-09-11T00:00:00.000Z",
    explanations,
  });
}

const cards = (source = makeSource(), generation = makeGeneration(source), config = CONFIG) =>
  generateUnitCards({ config, source, generation });

const byType = (definitions: readonly CardDefinitionT[], type: CardDefinitionT["card_type"]) =>
  definitions.filter((definition) => definition.card_type === type);

/** Run the generator and return the thrown CardRuleError code. */
function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof CardRuleError) return err.code;
    throw err;
  }
  throw new Error("expected generateUnitCards to throw a CardRuleError");
}

describe("generateUnitCards (spec 5.7)", () => {
  it("generates every eligible card of all four types", () => {
    const definitions = cards();
    expect(definitions).toHaveLength(7);
    expect(byType(definitions, "WORD_MEANING")).toHaveLength(3);
    expect(byType(definitions, "CONTEXT_MEANING")).toHaveLength(1);
    expect(byType(definitions, "PHRASE")).toHaveLength(1);
    expect(byType(definitions, "SENSE_DISCRIMINATION")).toHaveLength(2);
    for (const definition of definitions) {
      expect(definition.status).toBe("ACTIVE");
      expect(definition.template_version).toBe("v1");
      expect(definition.unit_key).toBe(UNIT_KEY);
      expect(definition.content_card_key).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("creates one WORD_MEANING card per learnable sense, targeting the sense", () => {
    const targets = byType(cards(), "WORD_MEANING").map((card) => card.target_entity_key);
    expect(targets).toEqual([`${W1}-s1`, `${W1}-s2`, `${W2}-s1`]);
    const wordKeys = new Set(byType(cards(), "WORD_MEANING").map((card) => card.word_key));
    expect(wordKeys).toEqual(new Set([W1, W2]));
  });

  it("requires a qualified real-exam example plus a contextual meaning for CONTEXT_MEANING", () => {
    // Both examples carry review-passed contextual meanings, but only the
    // real-exam origin qualifies for a CONTEXT_MEANING card (spec: 真题句).
    const contextCards = byType(cards(), "CONTEXT_MEANING");
    expect(contextCards.map((card) => card.target_entity_key)).toEqual([`${W1}-ex1`]);
    // The textbook example is reviewed and cited, yet generates no card.
    expect(contextCards.map((card) => card.target_entity_key)).not.toContain(`${W1}-ex2`);
  });

  it("rejects a contextual meaning that cites an example outside the word's evidence", () => {
    const source = makeSource();
    const generation = makeGeneration(source);
    const explanation = generation.explanations[1]!;
    explanation.context_meanings = [{ example_key: `${W1}-ex1`, gloss: "外词例句" }];
    expect(errorCode(() => cards(source, generation))).toBe("CITATION_SCOPE_MISMATCH");
  });

  it("requires an approved phrase for PHRASE cards", () => {
    const phraseCards = byType(cards(), "PHRASE");
    expect(phraseCards.map((card) => card.target_entity_key)).toEqual([`${W1}-p1`]);
    expect(phraseCards[0]!.word_key).toBe(W1);
  });

  it("requires review-confirmed confusable senses for SENSE_DISCRIMINATION", () => {
    const discriminationCards = byType(cards(), "SENSE_DISCRIMINATION");
    // The semantic target is the explained word; the confusable counterpart
    // disambiguates the stable key.
    expect(discriminationCards.map((card) => card.target_entity_key)).toEqual([W1, W2]);
    expect(discriminationCards.map((card) => card.word_key)).toEqual([W1, W2]);
  });

  it("rejects a discrimination candidate against an unknown or self word", () => {
    const source = makeSource();
    const generation = makeGeneration(source);
    generation.explanations[0]!.discrimination_candidates = [
      { against_word_key: "u01-nonexistent", note: "悬空引用" },
    ];
    expect(errorCode(() => cards(source, generation))).toBe("CARD_TARGET_UNKNOWN");

    const selfSource = makeSource();
    const selfGeneration = makeGeneration(selfSource);
    selfGeneration.explanations[0]!.discrimination_candidates = [
      { against_word_key: W1, note: "指向自身" },
    ];
    expect(errorCode(() => cards(selfSource, selfGeneration))).toBe("CITATION_SCOPE_MISMATCH");
  });

  it("rejects the Unit when a learnable word has zero cards (fail closed)", () => {
    // zeal has no senses, phrases, qualifying examples, or candidates: it can
    // never produce a card, so the whole unit must be rejected.
    const source = makeSource(true);
    try {
      generateUnitCards({ config: CONFIG, source, generation: makeGeneration(source) });
      expect.unreachable("expected WORD_HAS_NO_CARDS");
    } catch (err) {
      expect(err).toBeInstanceOf(CardRuleError);
      expect((err as CardRuleError).code).toBe("WORD_HAS_NO_CARDS");
      expect((err as CardRuleError).message).toContain("zeal");
      expect((err as CardRuleError).message).toContain(W3);
    }
  });

  it("rejects two cards colliding on the same semantic target", () => {
    const source = makeSource();
    const generation = makeGeneration(source);
    generation.explanations[0]!.discrimination_candidates = [
      { against_word_key: W2, note: "第一条" },
      { against_word_key: W2, note: "第二条（同一目标）" },
    ];
    expect(errorCode(() => cards(source, generation))).toBe("CARD_KEY_DUPLICATE");
  });

  it("keys cards by semantic target only: template changes never create new cards", () => {
    const reference = cards();
    const v2Config: CardRulesConfig = {
      ...CONFIG,
      template_versions: {
        WORD_MEANING: "v2",
        CONTEXT_MEANING: "v2",
        PHRASE: "v2",
        SENSE_DISCRIMINATION: "v2",
      },
    };
    const revised = cards(makeSource(), makeGeneration(makeSource()), v2Config);
    expect(revised.map((card) => card.content_card_key)).toEqual(
      reference.map((card) => card.content_card_key),
    );
    expect(revised.every((card) => card.template_version === "v2")).toBe(true);
    expect(reference.every((card) => card.template_version === "v1")).toBe(true);
  });

  it("derives the same key for the same target even when sibling content changes", () => {
    // Dropping abandon's second sense must not re-key the surviving card:
    // keys track the semantic target, not the surrounding content.
    const full = byType(cards(), "WORD_MEANING").find((card) => card.target_entity_key === `${W1}-s1`)!;
    const reducedSource = makeSource();
    const reducedGeneration = makeGeneration(reducedSource);
    const reduced = generateUnitCards({
      config: CONFIG,
      source: SourceSnapshot.parse({
        ...reducedSource,
        senses: reducedSource.senses.filter((sense) => sense.sense_key === `${W1}-s1`),
      }),
      generation: reducedGeneration,
    });
    const reducedCard = byType(reduced, "WORD_MEANING").find(
      (card) => card.target_entity_key === `${W1}-s1`,
    )!;
    expect(reducedCard.content_card_key).toBe(full.content_card_key);
  });

  it("is byte-identical across reruns and emits the exact fixed card order", () => {
    const first = cards();
    const second = cards();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // card_type_rank -> word.source_order -> target_entity_key -> content_card_key
    expect(first.map((card) => [card.card_type, card.target_entity_key])).toEqual([
      ["WORD_MEANING", `${W1}-s1`],
      ["WORD_MEANING", `${W1}-s2`],
      ["WORD_MEANING", `${W2}-s1`],
      ["CONTEXT_MEANING", `${W1}-ex1`],
      ["PHRASE", `${W1}-p1`],
      ["SENSE_DISCRIMINATION", W1],
      ["SENSE_DISCRIMINATION", W2],
    ]);
  });

  it("fails closed on a config that violates the versioned contract", () => {
    const source = makeSource();
    const generation = makeGeneration(source);
    expect(() =>
      cards(
        source,
        generation,
        { ...CONFIG, template_versions: { WORD_MEANING: "v1" } } as unknown as CardRulesConfig,
      ),
    ).toThrow();
    expect(() =>
      cards(source, generation, { ...CONFIG, unexpected_key: true } as unknown as CardRulesConfig),
    ).toThrow();
    expect(() =>
      cards(source, generation, { ...CONFIG, card_rules_version: "" }),
    ).toThrow();
  });
});
