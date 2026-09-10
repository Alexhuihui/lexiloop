import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentGenerationOutput,
  AgentReviewOutput,
  AgentWorkPacket,
  AudioAsset,
  Book,
  CardDefinition,
  Explanation,
  Example,
  LexicalRelation,
  Phrase,
  ReleaseManifest,
  RepairOutput,
  Sense,
  SourceBlock,
  Unit,
  UnitValidationReport,
  Word,
} from "../src/index";

const sha = (label: string): string => createHash("sha256").update(label).digest("hex");

/** Shallow copy without one key, for missing-field rejection tests. */
function without<T extends object, K extends keyof T & string>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete (copy as Record<string, unknown>)[key];
  return copy as Omit<T, K>;
}

// Spec 5.5: every source entity carries full provenance. Built fresh per call
// so tests never share mutable fixture state.
const makeProvenance = () => ({
  source_pdf_sha256: sha("source.pdf"),
  page_number: 12,
  bbox: [0.1, 0.2, 0.4, 0.6] as [number, number, number, number],
  page_image_sha256: sha("page-00012"),
  source_raw_ref_hash: sha("raw-ocr-block:p12:1"),
  source_normalized_text: "abandon vt. 放弃；抛弃",
  ocr_confidence: 0.98,
  structure_confidence: 0.95,
});

const makeSourceBlock = () => ({ block_key: "b-p12-0001", layout_role: "word_entry", ...makeProvenance() });
const makeBook = () => ({ book_key: "llcy", title: "恋练有词", edition: "2024", ...makeProvenance() });
const makeUnit = () => ({
  unit_key: "u01",
  book_key: "llcy",
  level: 1,
  unit_order: 1,
  title: "Unit 1",
  ...makeProvenance(),
});
const makeWord = () => ({
  word_key: "w-u01-0003",
  unit_key: "u01",
  headword: "abandon",
  phonetic: "/əˈbændən/",
  tier: "core",
  source_order: 3,
  ...makeProvenance(),
});
const makeSense = () => ({
  sense_key: "s-u01-0003-1",
  word_key: "w-u01-0003",
  pos: "vt",
  gloss: "放弃；抛弃",
  sense_order: 1,
  ...makeProvenance(),
});
const makePhrase = () => ({
  phrase_key: "p-u01-0003-1",
  word_key: "w-u01-0003",
  text: "abandon oneself to",
  gloss: "沉溺于",
  source_order: 1,
  ...makeProvenance(),
});
const makeExample = () => ({
  example_key: "ex-u01-0003-1",
  word_key: "w-u01-0003",
  origin: "exam",
  source_ref: "2019 阅读 Text 2",
  text: "He abandoned the plan without a second thought.",
  target_span: [4, 13] as [number, number],
  source_order: 1,
  ...makeProvenance(),
});
const makeRelation = () => ({
  relation_key: "r-u01-0003-1",
  from_word_key: "w-u01-0003",
  to_word_key: "w-u01-0004",
  relation_type: "synonym",
  ...makeProvenance(),
});

const makeGeneratedProvenance = () => ({
  input_hash: sha("packet:pkt-u01-0001"),
  prompt_version: "prompt-v1",
  model_id: "generation-model",
  agent_run_id: "run-u01-0001",
  generated_at: "2026-09-10T01:00:00Z",
});

const makeExplanation = () => ({
  explanation_key: "e-u01-0003",
  word_key: "w-u01-0003",
  unit_key: "u01",
  syntax_notes: ["及物动词，后接名词作宾语"],
  translation_hints: "放弃；中止",
  pitfalls: ["易与 desert（抛弃职责）混淆"],
  context_meanings: [{ example_key: "ex-u01-0003-1", gloss: "（语境中）放弃了计划" }],
  discrimination_candidates: [{ against_word_key: "w-u01-0004", note: "desert 强调违背职责" }],
  ...makeGeneratedProvenance(),
});

const makeCard = () => ({
  content_card_key: sha("card:llcy-2024:u01:word:3:abandon:WORD_MEANING"),
  card_type: "WORD_MEANING",
  target_entity_key: "w-u01-0003",
  word_key: "w-u01-0003",
  unit_key: "u01",
  template_version: "cards-v1",
  status: "ACTIVE",
});

const makeAudioAsset = () => ({
  asset_key: `audio/${sha("audio:abandon").slice(0, 2)}/${sha("audio:abandon")}.wav`,
  content_sha256: sha("audio-bytes:abandon"),
  text_hash: sha("abandon"),
  provider: "mimo",
  model_id: "mimo-v2.5-tts",
  voice: "en-female-01",
  synthesis_config_version: "tts-v1",
  format: { container: "wav", sample_rate_hz: 24000, channels: 1, encoding: "pcm_s16le" },
  duration_ms: 640,
  validation: "PASSED",
});

const makeGenerationOutput = () => ({
  unit_key: "u01",
  packet_id: "pkt-u01-0001",
  ...makeGeneratedProvenance(),
  explanations: [makeExplanation()],
});

const makeReviewOutput = () => ({
  review_id: "rev-u01-0001",
  unit_key: "u01",
  reviewed_agent_run_id: "run-u01-0001",
  unit_verdict: "REPAIR",
  field_verdicts: [
    {
      field_path: "explanations[0].translation_hints",
      verdict: "REPAIR",
      issue_code: "TRANSLATION_MISMATCH",
      evidence: "源义项 gloss 为「放弃；抛弃」，生成结果为「坚持」",
    },
  ],
});

const makeRepairOutput = () => ({
  repair_id: "fix-u01-0001",
  unit_key: "u01",
  review_id: "rev-u01-0001",
  repairs: [
    {
      field_path: "explanations[0].translation_hints",
      issue_code: "TRANSLATION_MISMATCH",
      revised_value: "放弃；中止",
    },
  ],
});

const makeSourceSnapshot = () => ({
  unit: makeUnit(),
  words: [makeWord()],
  senses: [makeSense()],
  phrases: [makePhrase()],
  examples: [makeExample()],
  relations: [makeRelation()],
});

const makeValidationReport = () => ({
  unit_key: "u01",
  compile_run_id: "compile-0001",
  status: "PASSED",
  repair_rounds: 1,
  findings: [
    {
      check: "CONFIDENCE_BELOW_THRESHOLD",
      severity: "WARNING",
      field_path: "words[0].phonetic",
      message: "OCR 置信度低于阈值，已由视觉 Agent 复核",
    },
  ],
});

const makeManifest = () => ({
  release_id: "rel-2026-09-10-0001",
  status: "DRAFT",
  created_at: "2026-09-10T06:00:00Z",
  book: { book_key: "llcy", edition: "2024" },
  source_pdf_sha256: sha("source.pdf"),
  config_versions: {
    schema_version: "schema-v1",
    watermark_rules_version: "wm-v1",
    ocr_config_version: "ocr-v1",
    prompt_version: "prompt-v1",
    card_rules_version: "cards-v1",
    synthesis_config_version: "tts-v1",
  },
  model_config: {
    generation_model_id: "generation-model",
    review_model_id: "review-model",
    repair_model_id: "repair-model",
    tts_model_id: "mimo-v2.5-tts",
    tts_voice: "en-female-01",
  },
  units: [
    {
      unit_key: "u01",
      status: "PASSED",
      counts: { words: 30, senses: 45, phrases: 12, examples: 20, explanations: 30, cards: 80 },
    },
  ],
  totals: { units: 1, units_passed: 1, units_blocked: 0, words: 30, cards: 80, audio_assets: 50 },
  files: [
    { path: "d1/001-content.sql", sha256: sha("001-content.sql"), bytes: 2048 },
    { path: "r2/audio-manifest.jsonl", sha256: sha("audio-manifest.jsonl"), bytes: 512 },
  ],
  gates: [{ name: "UNITS_ALL_PASSED", passed: true }],
});

describe("source entities (spec 5.4/5.5 provenance)", () => {
  it("parses a normalized OCR source block", () => {
    expect(SourceBlock.parse(makeSourceBlock())).toMatchObject({ block_key: "b-p12-0001" });
  });

  it("rejects source blocks with unknown keys", () => {
    expect(() => SourceBlock.parse({ ...makeSourceBlock(), agent_suggestion: "rewrite" })).toThrow();
  });

  it("rejects bbox coordinates outside [0,1] or with reversed corners", () => {
    expect(() =>
      SourceBlock.parse({ ...makeSourceBlock(), bbox: [0.1, 0.2, 1.4, 0.6] }),
    ).toThrow();
    expect(() =>
      SourceBlock.parse({ ...makeSourceBlock(), bbox: [0.1, 0.6, 0.4, 0.2] }),
    ).toThrow();
  });

  it("parses a book with title and edition", () => {
    expect(Book.parse(makeBook())).toMatchObject({ book_key: "llcy", edition: "2024" });
  });

  it("rejects a book without a title", () => {
    expect(() => Book.parse(without(makeBook(), "title"))).toThrow();
  });

  it("parses a unit nested in a book", () => {
    expect(Unit.parse(makeUnit())).toMatchObject({ unit_key: "u01", unit_order: 1 });
  });

  it("rejects units with unknown keys", () => {
    expect(() => Unit.parse({ ...makeUnit(), release_id: "rel-1" })).toThrow();
  });

  it("parses a word with headword, tier and source order", () => {
    const word = Word.parse(makeWord());
    expect(word).toMatchObject({ headword: "abandon", source_order: 3 });
  });

  it("rejects words missing source_order or with out-of-range confidence", () => {
    expect(() => Word.parse(without(makeWord(), "source_order"))).toThrow();
    expect(() => Word.parse({ ...makeWord(), ocr_confidence: 1.5 })).toThrow();
  });

  it("parses a sense and rejects unknown parts of speech", () => {
    expect(Sense.parse(makeSense())).toMatchObject({ pos: "vt", sense_order: 1 });
    expect(() => Sense.parse({ ...makeSense(), pos: "adjective" })).toThrow();
  });

  it("parses a phrase linked to a word", () => {
    expect(Phrase.parse(makePhrase())).toMatchObject({ text: "abandon oneself to" });
    expect(() => Phrase.parse({ ...makePhrase(), gloss: "" })).toThrow();
  });

  it("parses an exam example with a target word span", () => {
    const example = Example.parse(makeExample());
    expect(example).toMatchObject({ origin: "exam", target_span: [4, 13] });
  });

  it("rejects examples with inverted spans or unknown origins", () => {
    expect(() => Example.parse({ ...makeExample(), target_span: [13, 4] })).toThrow();
    expect(() => Example.parse({ ...makeExample(), origin: "wikipedia" })).toThrow();
  });

  it("parses a lexical relation and rejects unknown relation types", () => {
    expect(LexicalRelation.parse(makeRelation())).toMatchObject({ relation_type: "synonym" });
    expect(() => LexicalRelation.parse({ ...makeRelation(), relation_type: "rhymes_with" })).toThrow();
  });
});

describe("generated entities (spec 4.1 source/generated separation)", () => {
  it("parses a generated explanation with model provenance", () => {
    const explanation = Explanation.parse(makeExplanation());
    expect(explanation).toMatchObject({ model_id: "generation-model", prompt_version: "prompt-v1" });
  });

  it("rejects explanations carrying source-field keys", () => {
    expect(() => Explanation.parse({ ...makeExplanation(), headword: "changed" })).toThrow();
  });

  it("rejects explanations missing generation provenance", () => {
    expect(() => Explanation.parse(without(makeExplanation(), "input_hash"))).toThrow();
  });
});

describe("card definitions (spec 5.7)", () => {
  it("parses an active card of each known type", () => {
    for (const card_type of ["WORD_MEANING", "CONTEXT_MEANING", "PHRASE", "SENSE_DISCRIMINATION"]) {
      expect(CardDefinition.parse({ ...makeCard(), card_type })).toMatchObject({ card_type });
    }
  });

  it("rejects unknown card types and statuses", () => {
    expect(() => CardDefinition.parse({ ...makeCard(), card_type: "CLOZE" })).toThrow();
    expect(() => CardDefinition.parse({ ...makeCard(), status: "RETIRED" })).toThrow();
  });

  it("parses a deprecated card", () => {
    expect(CardDefinition.parse({ ...makeCard(), status: "DEPRECATED" })).toMatchObject({
      status: "DEPRECATED",
    });
  });
});

describe("audio assets (spec 5.8)", () => {
  it("parses a content-addressed audio asset", () => {
    const asset = AudioAsset.parse(makeAudioAsset());
    expect(asset.asset_key.startsWith("audio/")).toBe(true);
  });

  it("rejects non-content-addressed object keys and malformed hashes", () => {
    expect(() => AudioAsset.parse({ ...makeAudioAsset(), asset_key: "https://example.com/a.wav" })).toThrow();
    expect(() => AudioAsset.parse({ ...makeAudioAsset(), content_sha256: "deadbeef" })).toThrow();
  });
});

describe("agent protocol (spec 5.6)", () => {
  it("rejects generated content that mutates source fields", () => {
    expect(() =>
      AgentGenerationOutput.parse({
        sourcePatch: { headword: "changed" },
        generated: {},
      }),
    ).toThrow();
  });

  it("parses a valid generation output for a unit", () => {
    const output = AgentGenerationOutput.parse(makeGenerationOutput());
    expect(output.explanations).toHaveLength(1);
  });

  it("rejects generation outputs with unknown top-level keys", () => {
    expect(() => AgentGenerationOutput.parse({ ...makeGenerationOutput(), unit_verdict: "PASS" })).toThrow();
  });

  it("parses generation and repair work packets with source snapshots", () => {
    const generation = AgentWorkPacket.parse({
      role: "generation",
      packet_id: "pkt-u01-0001",
      unit_key: "u01",
      prompt_version: "prompt-v1",
      source: makeSourceSnapshot(),
    });
    expect(generation.role).toBe("generation");

    const repair = AgentWorkPacket.parse({
      role: "repair",
      packet_id: "pkt-u01-0002",
      unit_key: "u01",
      prompt_version: "prompt-v1",
      source: makeSourceSnapshot(),
      generation: makeGenerationOutput(),
      review: makeReviewOutput(),
    });
    expect(repair.role).toBe("repair");
  });

  it("rejects work packets with unknown roles or extra keys", () => {
    expect(() => AgentWorkPacket.parse({ role: "audit", packet_id: "pkt-x", unit_key: "u01" })).toThrow();
    expect(() =>
      AgentWorkPacket.parse({
        role: "generation",
        packet_id: "pkt-u01-0001",
        unit_key: "u01",
        prompt_version: "prompt-v1",
        source: makeSourceSnapshot(),
        sourcePatch: {},
      }),
    ).toThrow();
  });

  it("parses a review output with per-field verdicts", () => {
    const review = AgentReviewOutput.parse(makeReviewOutput());
    expect(review.unit_verdict).toBe("REPAIR");
    expect(review.field_verdicts[0]?.issue_code).toBe("TRANSLATION_MISMATCH");
  });

  it("rejects review outputs with invalid verdicts", () => {
    expect(() => AgentReviewOutput.parse({ ...makeReviewOutput(), unit_verdict: "MAYBE" })).toThrow();
    expect(() =>
      AgentReviewOutput.parse({
        ...makeReviewOutput(),
        field_verdicts: [{ field_path: "x", verdict: "SKIP", evidence: "none" }],
      }),
    ).toThrow();
  });

  it("parses a per-issue repair mapping and rejects empty mappings", () => {
    const repair = RepairOutput.parse(makeRepairOutput());
    expect(repair.repairs[0]?.issue_code).toBe("TRANSLATION_MISMATCH");
    expect(() => RepairOutput.parse({ ...makeRepairOutput(), repairs: [] })).toThrow();
    expect(() => RepairOutput.parse({ ...makeRepairOutput(), rewrite_all: true })).toThrow();
  });
});

describe("unit validation and release manifest (spec 5.1/5.6/5.9)", () => {
  it("parses a passed unit validation report", () => {
    const report = UnitValidationReport.parse(makeValidationReport());
    expect(report.status).toBe("PASSED");
  });

  it("rejects reports exceeding the three-round repair cap or unknown statuses", () => {
    expect(() => UnitValidationReport.parse({ ...makeValidationReport(), repair_rounds: 4 })).toThrow();
    expect(() => UnitValidationReport.parse({ ...makeValidationReport(), status: "PARTIAL" })).toThrow();
  });

  it("parses a release manifest with hashes, counts and gates", () => {
    const manifest = ReleaseManifest.parse(makeManifest());
    expect(manifest.files).toHaveLength(2);
    expect(manifest.units[0]?.status).toBe("PASSED");
  });

  it("rejects manifests with unhashed files or no units", () => {
    expect(() =>
      ReleaseManifest.parse({ ...makeManifest(), files: [without(makeManifest().files[0]!, "sha256")] }),
    ).toThrow();
    expect(() => ReleaseManifest.parse({ ...makeManifest(), units: [] })).toThrow();
  });
});
