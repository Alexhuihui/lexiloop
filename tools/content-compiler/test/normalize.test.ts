/**
 * Deterministic normalization unit tests (spec 5.4).
 *
 * Everything here runs on synthetic OCR blocks: cross-column reading order for
 * the single-page two-column raster, hyphenated line joins, page-furniture
 * removal, cross-page entries, Unicode/full-width punctuation, OCR confusion
 * flags, provenance retention, and the fail-closed routing of low-confidence
 * critical fields to visual-agent packets (never guessed). The stage-level
 * tests at the bottom cover LAYOUT_OCR/STRUCTURE_NORMALIZE ledger hash
 * chaining, resume-skip, and packet-gated normalization.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Book,
  Example,
  Phrase,
  Sense,
  Unit,
  Word,
} from "@lexiloop/content-schema";
import { assignReadingOrder, type PositionedBlock } from "../src/normalize/reading-order";
import { normalizeUnicodeText } from "../src/normalize/punctuation";
import { joinHyphenatedLines } from "../src/normalize/joins";
import { flagOcrConfusions } from "../src/normalize/confusions";
import {
  DEFAULT_FURNITURE_CONFIG,
  partitionPageFurniture,
  type FurnitureConfig,
} from "../src/normalize/furniture";
import { MAX_PACKET_ROUND } from "../src/agents/visual-ocr";
import type { VisualCorrection } from "../src/normalize/quality";
import {
  segmentStructure,
  type NormalizeBookConfig,
  type NormalizeInputBlock,
  type NormalizeOutput,
} from "../src/normalize/segmentation";
import {
  createLayoutOcrStage,
  createStructureNormalizeStage,
  LayoutOcrOutputSchema,
  type MediaStageOptions,
} from "../src/stage-registry";
import { createFileLedger } from "../src/ledger";
import { silentLogger } from "../src/logging";
import { runPipeline } from "../src/pipeline";
import { MediaSpawnError, type SpawnPythonFn } from "../src/media";
import type { StageRunContext } from "../src/stage";
import { ingestResult, loadQueue } from "../src/agents/visual-ocr";

// ---------------------------------------------------------------------------
// Synthetic two-column page fixtures (modeled on the real book raster)
// ---------------------------------------------------------------------------

const SOURCE_HASH = "c3".repeat(32);
const PAGE1_IMAGE = "d4".repeat(32);
const PAGE2_IMAGE = "e5".repeat(32);
const RAW_REF_1 = "aa".repeat(32);
const RAW_REF_2 = "bb".repeat(32);

type Bbox = [number, number, number, number];

function makeBlock(
  key: string,
  page: number,
  bbox: Bbox,
  text: string,
  confidence = 0.98,
  pageImageSha256 = page === 1 ? PAGE1_IMAGE : PAGE2_IMAGE,
): NormalizeInputBlock {
  return {
    blockKey: key,
    sourcePdfSha256: SOURCE_HASH,
    page,
    pageImageSha256,
    bbox,
    text,
    confidence,
    layoutRole: "other",
    sourceRawRefHash: page === 1 ? RAW_REF_1 : RAW_REF_2,
  };
}

/** Page-1 body modeled on the real government/govern page (two columns). */
function governmentPageBlocks(): NormalizeInputBlock[] {
  return [
    makeBlock("p1.footer", 1, [0.1, 0.94, 0.9, 0.975], "18 你知道什么叫作意外吗？就是我从来没想过遇见你，但我遇见了。"),
    makeBlock("p1.sidebar", 1, [0.0, 0.2, 0.04, 0.35], "Chapter\n01"),
    makeBlock("p1.chapter.opener", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
    makeBlock("p1.unit", 1, [0.08, 0.11, 0.92, 0.16], "Unit 1"),
    makeBlock(
      "p1.gov.head",
      1,
      [0.1, 0.14, 0.48, 0.2],
      "government /ɡʌvənmənt/\nn. 政府；治理 (2022 年阅读)",
    ),
    makeBlock(
      "p1.gov.note",
      1,
      [0.1, 0.21, 0.48, 0.27],
      "词根记忆：govern( 治理 )+ment( 名词后缀 )→政府；治理",
    ),
    makeBlock(
      "p1.gov.ex",
      1,
      [0.1, 0.28, 0.48, 0.4],
      "真 However, the mechanisms proposed were unwieldy and the Bill was voted down following the change in government later that year. 然而，提出的这些方法难以执行。",
    ),
    makeBlock(
      "p1.govlt.head",
      1,
      [0.1, 0.42, 0.48, 0.47],
      "governmental [,ɡʌvn'mentl] adj. 政府的；统治的",
      0.55, // low confidence: critical headword must route to visual review
    ),
    makeBlock(
      "p1.govlt.phr",
      1,
      [0.1, 0.48, 0.48, 0.53],
      "governmental pressure 政府压力",
      0.55, // low confidence but non-critical: no packet
    ),
    makeBlock(
      "p1.govlt.ex",
      1,
      [0.1, 0.54, 0.48, 0.6],
      "真 a governmental job-training program 一个政府职业培训项目",
      0.55,
    ),
    makeBlock(
      "p1.govern.head",
      1,
      [0.52, 0.14, 0.9, 0.2],
      "govern /ɡʌvn/ vt. 治理；控制；统治",
    ),
    makeBlock(
      "p1.govern.ex",
      1,
      [0.52, 0.21, 0.9, 0.35],
      "真 Sensible ideas have been around for a long time, but the state-level bodies that govern the profession have been too conservative to implement them. 改革的良策早已呼之欲出。",
    ),
    makeBlock(
      "p1.governence.head",
      1,
      [0.52, 0.36, 0.9, 0.42],
      "governance /ɡʌvən0ns/ n. 控制；治理", // digit 0 in phonetic: confusion flag
      0.95,
    ),
    makeBlock(
      "p1.governor.head",
      1,
      [0.52, 0.5, 0.9, 0.56],
      "governor /ɡʌvən1r/ n. 州长；总督", // digit 1 in phonetic: confusion flag
      0.95,
    ),
    makeBlock(
      "p1.governor.ex",
      1,
      [0.52, 0.57, 0.9, 0.63],
      "真 California Governor 加利福尼亚州州长",
    ),
  ];
}

/** Page-2 body: cross-page continuation, then a new unit. */
function secondPageBlocks(): NormalizeInputBlock[] {
  return [
    makeBlock("p2.footer", 2, [0.1, 0.94, 0.9, 0.975], "20 脚步越快，越清醒该走在怎样的路上。"),
    // Top of page 2 continues the governor entry from page 1 (no headword).
    makeBlock(
      "p2.continuation",
      2,
      [0.1, 0.06, 0.48, 0.14],
      "真 The governor signed the bill yesterday. 州长昨天签署了该法案。",
    ),
    makeBlock("p2.unit", 2, [0.08, 0.16, 0.92, 0.21], "Unit 2"),
    makeBlock(
      "p2.abandon.head",
      2,
      [0.1, 0.23, 0.48, 0.29],
      "abandon /əˈbændən/\n① v. 放弃；抛弃\n② n. 放任",
    ),
    makeBlock(
      "p2.abandon.ex",
      2,
      [0.1, 0.3, 0.48, 0.38],
      "真 They abandoned the plan at the last minute. 他们在最后一刻放弃了计划。",
    ),
  ];
}

function normalizeConfig(): NormalizeBookConfig {
  return {
    book_key: "llcy-2024",
    book_title: "LLRC 6500",
    book_edition: "2024",
    default_tier: "core",
    unit_title_patterns: ["^Unit\\s*(\\d+)$"],
    unit_tab_number_pattern: "^\\d{2}$",
    unit_tab_x_min: 0.9,
    unit_tab_y_min: 0.1,
    unit_tab_y_max: 0.9,
    chapter_opener_pattern: "^Chapter\\s*0?([1-9])$",
    chapter_opener_y_max: 0.25,
    back_matter_patterns: ["^索引$"],
    back_matter_y_max: 0.5,
    pos_markers: [
      "n.",
      "v.",
      "vi.",
      "vt.",
      "adj.",
      "adv.",
      "prep.",
      "conj.",
      "pron.",
      "interj.",
      "art.",
      "num.",
      "aux.",
      "modal.",
      "abbr.",
      "phr.",
    ],
    exam_marker: "真",
    note_patterns: ["^词根记忆", "^词根", "^同根词", "^相关词", "^近义词", "^反义词", "^注释"],
    critical_confidence_min: 0.9,
    non_critical_confidence_min: 0.5,
  };
}

function orderedBookBlocks(): NormalizeInputBlock[] {
  return [
    ...assignReadingOrder(governmentPageBlocks()),
    ...assignReadingOrder(secondPageBlocks()),
  ];
}

function normalizeAll(corrections?: readonly VisualCorrection[]): NormalizeOutput {
  return segmentStructure(orderedBookBlocks(), normalizeConfig(), corrections ?? []);
}

// ---------------------------------------------------------------------------
// Pure transforms
// ---------------------------------------------------------------------------

describe("reading order", () => {
  it("orders full-width blocks first, then left column top-to-bottom, then right column", () => {
    const blocks: PositionedBlock[] = [
      { key: "right-top", page: 1, bbox: [0.52, 0.1, 0.9, 0.2], text: "R1" },
      { key: "left-bottom", page: 1, bbox: [0.1, 0.5, 0.48, 0.6], text: "L2" },
      { key: "banner", page: 1, bbox: [0.08, 0.02, 0.92, 0.07], text: "banner" },
      { key: "right-bottom", page: 1, bbox: [0.52, 0.5, 0.9, 0.6], text: "R2" },
      { key: "left-top", page: 1, bbox: [0.1, 0.1, 0.48, 0.2], text: "L1" },
    ];
    const ordered = assignReadingOrder(blocks);
    expect(ordered.map((b) => b.key)).toEqual([
      "banner",
      "left-top",
      "left-bottom",
      "right-top",
      "right-bottom",
    ]);
  });

  it("handles a 180° two-page-spread raster: the left book page precedes the right", () => {
    const blocks: PositionedBlock[] = [
      { key: "right-page-a", page: 1, bbox: [0.55, 0.1, 0.95, 0.2], text: "RA" },
      { key: "left-page-b", page: 1, bbox: [0.05, 0.4, 0.45, 0.5], text: "LB" },
      { key: "left-page-a", page: 1, bbox: [0.05, 0.1, 0.45, 0.2], text: "LA" },
      { key: "right-page-b", page: 1, bbox: [0.55, 0.4, 0.95, 0.5], text: "RB" },
    ];
    const ordered = assignReadingOrder(blocks);
    expect(ordered.map((b) => b.key)).toEqual([
      "left-page-a",
      "left-page-b",
      "right-page-a",
      "right-page-b",
    ]);
  });

  it("does not mutate the input array and keeps pages in ascending order", () => {
    const blocks: PositionedBlock[] = [
      { key: "p2", page: 2, bbox: [0.1, 0.1, 0.9, 0.2], text: "B" },
      { key: "p1", page: 1, bbox: [0.1, 0.1, 0.9, 0.2], text: "A" },
    ];
    const ordered = assignReadingOrder(blocks);
    expect(ordered.map((b) => b.key)).toEqual(["p1", "p2"]);
    expect(blocks.map((b) => b.key)).toEqual(["p2", "p1"]);
  });
});

describe("hyphenated line joins", () => {
  it("joins a word broken across lines and drops the hyphen", () => {
    expect(joinHyphenatedLines("govern-\nment of the people")).toEqual({
      text: "government of the people",
      joinedCount: 1,
    });
  });

  it("keeps the hyphen when the next line starts an uppercase word", () => {
    expect(joinHyphenatedLines("end of line-\nNext sentence")).toEqual({
      text: "end of line- Next sentence",
      joinedCount: 0,
    });
  });

  it("joins unicode hyphen variants", () => {
    expect(joinHyphenatedLines("coordina\u2010\ntion").text).toBe("coordination");
  });
});

describe("unicode / full-width punctuation normalization", () => {
  it("folds full-width latin, digits, and punctuation to half-width", () => {
    expect(normalizeUnicodeText("ｇｏｖｅｒｎｍｅｎｔ")).toBe("government");
    expect(normalizeUnicodeText("（２０２２年阅读）")).toBe("(2022年阅读)");
  });

  it("keeps CJK sentence punctuation and composes NFC", () => {
    const out = normalizeUnicodeText("政府；治理。坚持");
    expect(out).toContain("；");
    expect(out).toContain("。");
  });

  it("collapses ideographic spaces and repeated whitespace", () => {
    expect(normalizeUnicodeText("a\u3000\u3000b   c")).toBe("a b c");
  });
});

describe("OCR confusion flags (flag, never rewrite)", () => {
  it("flags digits inside phonetics (l↔1, O↔0)", () => {
    expect(flagOcrConfusions("/ɡʌvən1r/", "phonetic")).toContain(
      "OCR_CONFUSION_DIGIT_IN_PHONETIC",
    );
    expect(flagOcrConfusions("/ɡʌvən0ns/", "phonetic")).toContain(
      "OCR_CONFUSION_DIGIT_IN_PHONETIC",
    );
  });

  it("flags digits and rn↔m patterns inside headwords", () => {
    expect(flagOcrConfusions("g0vernment", "headword")).toContain(
      "OCR_CONFUSION_DIGIT_IN_HEADWORD",
    );
    expect(flagOcrConfusions("govern", "headword")).toContain("OCR_CONFUSION_RN_M");
  });

  it("does not flag clean text", () => {
    expect(flagOcrConfusions("abandon", "headword")).toEqual([]);
    expect(flagOcrConfusions("/əˈbændən/", "phonetic")).toEqual([]);
    expect(flagOcrConfusions("政府；治理", "gloss")).toEqual([]);
  });
});

describe("page furniture removal", () => {
  const furnitureConfig: FurnitureConfig = {
    header_y_max: 0.06,
    footer_y_min: 0.93,
    sidebar_x_max: 0.055,
    min_header_repeat_pages: 3,
  };

  it("removes footer-band blocks and the sidebar chapter tab", () => {
    const blocks = [
      makeBlock("footer", 1, [0.1, 0.94, 0.9, 0.975], "18 你知道什么叫作意外吗"),
      makeBlock("sidebar", 1, [0.0, 0.2, 0.04, 0.35], "Chapter\n01"),
      makeBlock("body", 1, [0.1, 0.3, 0.48, 0.4], "government /ɡʌvənmənt/"),
    ];
    const { content, furniture } = partitionPageFurniture(blocks, furnitureConfig);
    expect(content.map((b) => b.blockKey)).toEqual(["body"]);
    expect(furniture.map((b) => b.blockKey).sort()).toEqual(["footer", "sidebar"]);
  });

  it("removes headers only when the same text repeats on enough distinct pages", () => {
    const blocks = [
      makeBlock("h1", 1, [0.3, 0.02, 0.7, 0.05], "Unit 1 Review"),
      makeBlock("h2", 2, [0.3, 0.02, 0.7, 0.05], "Unit 1 Review"),
      makeBlock("h3", 3, [0.3, 0.02, 0.7, 0.05], "Unit 1 Review"),
      makeBlock("once1", 1, [0.3, 0.03, 0.7, 0.055], "once-only header"),
    ];
    const { content, furniture } = partitionPageFurniture(blocks, furnitureConfig);
    expect(furniture.map((b) => b.blockKey)).toEqual(["h1", "h2", "h3"]);
    expect(content.map((b) => b.blockKey)).toEqual(["once1"]);
  });

  it("keeps body blocks below the header band without repetition", () => {
    const blocks = [makeBlock("body", 1, [0.3, 0.055, 0.7, 0.5], "govern /ɡʌvn/")];
    const { content } = partitionPageFurniture(blocks, furnitureConfig);
    expect(content).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Structure segmentation
// ---------------------------------------------------------------------------

describe("structure segmentation", () => {
  let output: NormalizeOutput;

  it("detects unit boundaries from title blocks", () => {
    output = normalizeAll();
    expect(output.units.map((u) => u.title)).toEqual(["Unit 1", "Unit 2"]);
    expect(output.unitBoundaries).toEqual([
      { unit_key: "c1.u1", unit_order: 1, title: "Unit 1", first_page: 1, last_page: 2 },
      { unit_key: "c1.u2", unit_order: 2, title: "Unit 2", first_page: 2, last_page: 2 },
    ]);
  });

  it("assigns words to units in reading order with stable keys", () => {
    output = normalizeAll();
    expect(output.words.map((w) => w.headword)).toEqual([
      "government",
      "governmental",
      "govern",
      "governance",
      "governor",
      "abandon",
    ]);
    const gov = output.words[0]!;
    expect(gov.word_key).toBe("w.c1.u1.0001.government");
    expect(gov.unit_key).toBe("c1.u1");
    expect(gov.source_order).toBe(1);
    expect(gov.phonetic).toBe("/ɡʌvənmənt/");
    const abandon = output.words[5]!;
    expect(abandon.unit_key).toBe("c1.u2");
    expect(abandon.source_order).toBe(1);
  });

  it("senses, phrases, and examples attach to their word with origin and source_ref", () => {
    output = normalizeAll();
    const gov = output.words[0]!;
    const govSenses = output.senses.filter((s) => s.word_key === gov.word_key);
    expect(govSenses).toHaveLength(1);
    expect(govSenses[0]!.pos).toBe("n");
    expect(govSenses[0]!.gloss).toContain("政府");
    const govExamples = output.examples.filter((e) => e.word_key === gov.word_key);
    expect(govExamples).toHaveLength(1);
    expect(govExamples[0]!.origin).toBe("exam");
    expect(govExamples[0]!.source_ref).toBe("2022 阅读");
    expect(govExamples[0]!.text).toContain("However, the mechanisms");

    const abandon = output.words[5]!;
    expect(output.senses.filter((s) => s.word_key === abandon.word_key)).toHaveLength(2);

    const govlt = output.words[1]!;
    const phrases = output.phrases.filter((p) => p.word_key === govlt.word_key);
    expect(phrases).toHaveLength(1);
    expect(phrases[0]!.text).toBe("governmental pressure");
    expect(phrases[0]!.gloss).toBe("政府压力");
  });

  it("merges cross-page entries: the page-2 continuation attaches to the last page-1 word", () => {
    output = normalizeAll();
    const governor = output.words.find((w) => w.headword === "governor")!;
    const continuation = output.examples.find(
      (e) => e.page_number === 2 && e.word_key === governor.word_key,
    );
    expect(continuation).toBeDefined();
    expect(continuation!.text).toContain("signed the bill");
  });

  it("retains page + bbox provenance for every source entity", () => {
    output = normalizeAll();
    const entities = [
      ...output.units,
      ...output.words,
      ...output.senses,
      ...output.phrases,
      ...output.examples,
    ];
    expect(entities.length).toBeGreaterThan(10);
    for (const entity of entities) {
      expect(entity.source_pdf_sha256).toBe(SOURCE_HASH);
      expect([1, 2]).toContain(entity.page_number);
      expect([PAGE1_IMAGE, PAGE2_IMAGE]).toContain(entity.page_image_sha256);
      expect(entity.source_raw_ref_hash).toMatch(/^[0-9a-f]{64}$/);
      const [x0, y0, x1, y1] = entity.bbox;
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(1);
      expect(y1).toBeGreaterThanOrEqual(y0);
    }
  });

  it("emits records that validate against the shared content schema", () => {
    output = normalizeAll();
    expect(() => Book.parse(output.book)).not.toThrow();
    for (const unit of output.units) expect(() => Unit.parse(unit)).not.toThrow();
    for (const word of output.words) expect(() => Word.parse(word)).not.toThrow();
    for (const sense of output.senses) expect(() => Sense.parse(sense)).not.toThrow();
    for (const phrase of output.phrases) expect(() => Phrase.parse(phrase)).not.toThrow();
    for (const example of output.examples) expect(() => Example.parse(example)).not.toThrow();
  });

  it("normalizes unicode in retained text", () => {
    const out = segmentStructure(
      assignReadingOrder([
        makeBlock("fw", 1, [0.1, 0.1, 0.48, 0.2], "ａｂａｎｄｏｎ /əˈbændən/\nv. 放弃"),
      ]),
      normalizeConfig(),
      [],
    );
    expect(out.words[0]!.headword).toBe("abandon");
  });

  it("routes low-confidence critical fields to review instead of guessing", () => {
    output = normalizeAll();
    const govlt = output.words.find((w) => w.headword === "governmental")!;
    const review = output.fieldReviews.find((r) => r.field === "headword");
    expect(review).toBeDefined();
    expect(review!.current_text).toBe("governmental");
    expect(review!.word_key).toBe(govlt.word_key);
    expect(review!.evidence_codes).toContain("LOW_CONFIDENCE_CRITICAL_FIELD");
    // The word is emitted unmodified: no contextual guessing.
    expect(govlt.headword).toBe("governmental");
    // Non-critical low-confidence fields never create reviews.
    expect(
      output.fieldReviews.find((r) => r.current_text === "governmental pressure"),
    ).toBeUndefined();
  });

  it("flags confused phonetics on critical fields for visual review", () => {
    output = normalizeAll();
    // The two high-confidence but digit-confused phonetics are flagged.
    const confused = output.fieldReviews.filter((r) =>
      r.evidence_codes.includes("OCR_CONFUSION_DIGIT_IN_PHONETIC"),
    );
    expect(confused.map((r) => r.current_text).sort()).toEqual([
      "/ɡʌvən0ns/",
      "/ɡʌvən1r/",
    ]);
    // The low-confidence block also reviews its phonetic (critical field).
    const lowConfPhonetic = output.fieldReviews.filter(
      (r) =>
        r.field === "phonetic" &&
        r.evidence_codes.includes("LOW_CONFIDENCE_CRITICAL_FIELD"),
    );
    expect(lowConfPhonetic.length).toBe(1);
    // Confused text is never rewritten in place.
    const governor = output.words.find((w) => w.headword === "governor")!;
    expect(governor.phonetic).toBe("/ɡʌvən1r/");
  });
});

// ---------------------------------------------------------------------------
// Visual corrections (agent decisions) and the three-round repair cap
// ---------------------------------------------------------------------------

describe("visual corrections", () => {
  it("derives stable per-field packet ids with an explicit round", () => {
    const first = normalizeAll();
    const reviews = first.fieldReviews;
    expect(reviews.length).toBeGreaterThanOrEqual(3);
    for (const review of reviews) {
      expect(review.packet_id).toMatch(new RegExp(`^vo\\.${review.field}\\.p${review.page_number}\\.r1\\.`));
      expect(review.round).toBe(1);
    }
    // Distinct fields never share a packet id.
    const ids = new Set(reviews.map((r) => r.packet_id));
    expect(ids.size).toBe(reviews.length);
  });

  it("applies a corrected REPAIR and escalates a still-invalid repair to round 2", () => {
    const first = normalizeAll();
    const headReview = first.fieldReviews.find((r) => r.field === "headword")!;
    const phonReviews = first.fieldReviews.filter((r) => r.field === "phonetic");
    const second = normalizeAll([
      {
        packet_id: headReview.packet_id,
        verdict: "REPAIR",
        corrected_text: "governmental",
        agent_run_id: "agent-run-1",
        round: 1,
      },
      ...phonReviews.map((review, index) => ({
        packet_id: review.packet_id,
        verdict: "REPAIR" as const,
        corrected_text: "/ɡʌvən1r/", // still contains a digit: must escalate
        agent_run_id: `agent-run-phon-${index}`,
        round: 1,
      })),
    ]);
    // The repaired headword is resolved and applied; no new headword review.
    expect(second.fieldReviews.filter((r) => r.field === "headword")).toEqual([]);
    const govlt = second.words.find((w) => w.headword === "governmental")!;
    expect(govlt.headword).toBe("governmental");
    // Every still-confused phonetic escalates to a round-2 packet.
    const escalated = second.fieldReviews.filter((r) => r.field === "phonetic");
    expect(escalated.length).toBe(phonReviews.length);
    for (const review of escalated) {
      expect(review.round).toBe(2);
      expect(review.packet_id).toContain(".r2.");
    }
    expect(second.appliedCorrections).toHaveLength(1);
    expect(second.appliedCorrections[0]!.agent_run_id).toBe("agent-run-1");
  });

  it("caps repair rounds at three and blocks the field afterwards", () => {
    let current = normalizeAll();
    for (let round = 1; round <= MAX_PACKET_ROUND; round += 1) {
      const reviews = current.fieldReviews.filter((r) => r.field === "phonetic");
      if (reviews.length === 0) break;
      current = normalizeAll(
        reviews.map((review) => ({
          packet_id: review.packet_id,
          verdict: "REPAIR" as const,
          corrected_text: "/ɡʌvən1r/", // never becomes valid
          agent_run_id: `agent-run-r${round}-${review.packet_id}`,
          round,
        })),
      );
    }
    expect(current.fieldReviews.filter((r) => r.field === "phonetic")).toEqual([]);
    expect(current.blockedFields.length).toBeGreaterThanOrEqual(3);
    expect(current.blockedFields.every((f) => f.round === MAX_PACKET_ROUND)).toBe(true);
  });

  it("treats an explicit BLOCK decision as a blocked field", () => {
    const first = normalizeAll();
    const review = first.fieldReviews[0]!;
    const out = normalizeAll([
      { packet_id: review.packet_id, verdict: "BLOCK", agent_run_id: "agent-run-b", round: 1 },
    ]);
    expect(out.blockedFields.map((f) => f.packet_id)).toContain(review.packet_id);
    expect(out.fieldReviews.map((r) => r.packet_id)).not.toContain(review.packet_id);
  });

  it("resolves fields with an explicit PASS decision (agent affirmed the OCR text)", () => {
    const first = normalizeAll();
    const review = first.fieldReviews.find((r) => r.field === "headword")!;
    const out = normalizeAll([
      { packet_id: review.packet_id, verdict: "PASS", agent_run_id: "agent-run-p", round: 1 },
    ]);
    expect(out.fieldReviews.map((r) => r.packet_id)).not.toContain(review.packet_id);
    expect(out.blockedFields).toHaveLength(0);
    expect(out.appliedCorrections).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stage handlers: ledger hash chaining, resume-skip, packet gating
// ---------------------------------------------------------------------------

describe("LAYOUT_OCR + STRUCTURE_NORMALIZE stages", () => {
  let workDir = ""; // private root: holds work/<source-hash> like production
  let sourceDir = ""; // the per-source work directory for this fixture
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  function sha256(data: Buffer | string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  /** Seed clean.jsonl + cleaned page images, as WATERMARK_CLEAN would leave them. */
  async function seedCleanArtifacts(): Promise<void> {
    workDir = await mkdtemp(path.join(tmpdir(), "ocr-stage-"));
    tempDirs.push(workDir);
    sourceDir = path.join(workDir, "work", SOURCE_HASH);
    const rows: unknown[] = [];
    for (const page of [1, 2]) {
      const imageBytes = Buffer.from(`cleaned-${page}`);
      const rel = `pages-clean/page-000${page}.cleaned.png`;
      await mkdir(path.dirname(path.join(sourceDir, rel)), { recursive: true });
      await writeFile(path.join(sourceDir, rel), imageBytes);
      rows.push({
        source_sha256: SOURCE_HASH,
        page,
        rule_version: 3,
        original_image_path: `pages/page-000${page}.original.png`,
        original_image_sha256: sha256(Buffer.from(`original-${page}`)),
        cleaned_image_sha256: sha256(imageBytes),
        cleaned_image_path: rel,
        mask_bounds: null,
        region_names: [],
        changed_pixels: 12,
        changed_pixels_outside: 0,
        body_overlap_detected: false,
      });
    }
    await writeFile(
      path.join(sourceDir, "clean.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );
  }

  function cleanedImageHash(page: number): string {
    return sha256(Buffer.from(`cleaned-${page}`));
  }

  /** The ocr.jsonl rows the (stubbed) Python worker must emit. */
  function ocrRows(): unknown[] {
    return orderedBookBlocks().map((block) => ({
      schema_version: 1,
      pipeline: "PP-StructureV3",
      pipeline_version: "3.0.0",
      model_version: "pp-structurev3-test",
      config_version: 1,
      source_sha256: block.sourcePdfSha256,
      page: block.page,
      page_image_sha256: cleanedImageHash(block.page),
      bbox: block.bbox,
      layout_label: "text",
      text: block.text,
      confidence: block.confidence,
      source_raw_ref_hash: block.sourceRawRefHash,
    }));
  }

  function makeStagesWithRows(rows: Array<{ page: number; text: string; confidence: number }>) {
    const options: MediaStageOptions = {
      privateRoot: workDir,
      runPython: async () => {
        // Emulate `lexiloop_media ocr`: write ocr.jsonl + per-page raw files.
        await mkdir(path.join(sourceDir, "ocr-raw"), { recursive: true });
        for (const page of [1, 2]) {
          const texts = rows.filter((row) => row.page === page).map((row) => row.text);
          await writeFile(
            path.join(sourceDir, `ocr-raw/page-${String(page).padStart(4, "0")}.txt`),
            texts.join("\n") + "\n",
            "utf8",
          );
        }
        await writeFile(
          path.join(sourceDir, "ocr.jsonl"),
          rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
          "utf8",
        );
        return { stdout: `${JSON.stringify({ ok: true })}\n` };
      },
    };
    return [createLayoutOcrStage(options), createStructureNormalizeStage(options)];
  }

  async function makeStages() {
    await seedCleanArtifacts();
    const rows = ocrRows() as Array<{ page: number; text: string; confidence: number }>;
    return makeStagesWithRows(rows);
  }

  function pipelineConfig() {
    return { media: { sourcePath: "unused.pdf", pages: [1, 2], dpi: 300 } };
  }

  function runLedger(stages: unknown) {
    const ledger = createFileLedger({ directory: path.join(workDir, "ledger") });
    return runPipeline(stages as never, ledger, {
      sourceHash: SOURCE_HASH,
      config: pipelineConfig(),
      logger: silentLogger,
    });
  }

  it("gates normalization on visual packets and resumes after the last resolved packet", async () => {
    const stages = await makeStages();
    const first = await runLedger(stages);
    expect(first.status).toBe("FAILED"); // critical fields await visual decisions
    expect(first.results.map((r) => r.status)).toEqual(["PASSED", "FAILED"]);
    const ledger = createFileLedger({ directory: path.join(workDir, "ledger") });
    const layout = await ledger.load("LAYOUT_OCR");
    const normalize = await ledger.load("STRUCTURE_NORMALIZE");
    expect(layout!.status).toBe("PASSED");
    expect(layout!.output_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(normalize!.status).toBe("FAILED");
    expect(normalize!.error_code).toBe("VISUAL_PACKETS_PENDING");

    // Resume with unchanged inputs: LAYOUT_OCR skips via its ledger hashes.
    const second = await runLedger(stages);
    expect(second.results[0]!.status).toBe("SKIPPED");

    // Ingest visual decisions for every pending packet, then resume.
    const queueDir = path.join(sourceDir, "agent-queue", "visual-ocr");
    const entries = await loadQueue(queueDir);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) {
      await ingestResult(queueDir, SOURCE_HASH, {
        packet_id: entry.packet.packet_id,
        packet_hash: entry.packetHash,
        source_hash: SOURCE_HASH,
        agent_run_id: `ingest-${entry.packet.packet_id}`,
        verdict: "PASS",
        evidence_codes: ["VISUAL_CONFIRMED"],
        reviewed_at: "2026-09-10T10:00:00.000Z",
      });
    }
    const third = await runLedger(stages);
    expect(third.status).toBe("COMPLETED");
    expect(third.results.map((r) => r.status)).toEqual(["SKIPPED", "PASSED"]);
    const done = await createFileLedger({ directory: path.join(workDir, "ledger") }).load(
      "STRUCTURE_NORMALIZE",
    );
    expect(done!.output_hash).toMatch(/^[0-9a-f]{64}$/);
    // The normalized artifact was written with provenance-bearing entity rows.
    const entities = await readFile(path.join(sourceDir, "normalized.jsonl"), "utf8");
    expect(entities).toContain('"entity_type":"word"');
  });

  it("fails closed when the OCR worker produced no artifacts", async () => {
    await seedCleanArtifacts();
    const options: MediaStageOptions = {
      privateRoot: workDir,
      runPython: async () => ({ stdout: "{}" }), // claims success, writes nothing
    };
    const report = await runLedger([createLayoutOcrStage(options)]);
    expect(report.status).toBe("FAILED");
    expect(report.results[0]!.error_code).toBe("MEDIA_OUTPUT_INVALID");
  });

  it("fails BLOCKED when words reference a unit that no banner emitted", async () => {
    await seedCleanArtifacts();
    // Word entries without any unit signal: with the chapter opener also
    // stripped there is no chapter context at all (no unit may open, and no
    // chapter-level fallback applies), so the synthetic fallback unit would
    // dangle and the stage must fail closed instead of emitting a structurally
    // invalid book (review finding: unit detection fails open).
    const rows = (
      ocrRows() as Array<{ page: number; text: string; confidence: number }>
    ).filter((row) => !row.text.startsWith("Unit") && !/^Chapter \d$/.test(row.text));
    expect(rows.length).toBeGreaterThan(0);
    const stages = await makeStagesWithRows(rows);

    const first = await runLedger(stages);
    expect(first.status).toBe("BLOCKED");
    expect(first.results.map((r) => r.status)).toEqual(["PASSED", "BLOCKED"]);
    expect(first.results[1]!.error_code).toBe("DANGLING_UNIT_REFERENCE");

    const ledger = createFileLedger({ directory: path.join(workDir, "ledger") });
    const normalize = await ledger.load("STRUCTURE_NORMALIZE");
    expect(normalize!.status).toBe("BLOCKED");
    expect(normalize!.error_code).toBe("DANGLING_UNIT_REFERENCE");
    // No normalized artifact may exist for a structurally invalid book.
    await expect(
      readFile(path.join(sourceDir, "normalized.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // Terminal: the ledger BLOCKED status stops any further run from advancing.
    const second = await runLedger(stages);
    expect(second.status).toBe("BLOCKED");
    expect(second.results.map((r) => r.status)).toEqual(["SKIPPED", "BLOCKED"]);
    expect(second.results[1]!.error_code).toBe("DANGLING_UNIT_REFERENCE");
  });
});

// ---------------------------------------------------------------------------
// LAYOUT_OCR chunked resumable execution: the worker is spawned once per chunk
// of missing pages (`--pages`), so a 440-page book never needs one spawn to
// cover the whole OCR in a single timeout window. Reconciliation reads the
// existing ocr.jsonl first: a page counts as complete only when rows exist for
// it and every row's page_image_sha256 matches the clean record, so retries
// after a mid-chunk failure re-spawn exactly the missing pages. The fake
// worker below emulates the Python merge (drop re-run pages, append, stable
// page sort), so chunked composition stays byte-equivalent to a full run.
// ---------------------------------------------------------------------------

describe("LAYOUT_OCR chunked resumable OCR", () => {
  let workDir = ""; // private root: holds work/<source-hash> like production
  let sourceDir = ""; // the per-source work directory for this fixture
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  function sha256(data: Buffer | string): string {
    return createHash("sha256").update(data).digest("hex");
  }

  /** Seed clean.jsonl + cleaned page images for the given pages. */
  async function seedCleanPages(pages: number[]): Promise<void> {
    workDir = await mkdtemp(path.join(tmpdir(), "ocr-chunk-"));
    tempDirs.push(workDir);
    sourceDir = path.join(workDir, "work", SOURCE_HASH);
    const rows: unknown[] = [];
    for (const page of pages) {
      const imageBytes = Buffer.from(`cleaned-${page}`);
      const rel = `pages-clean/page-${String(page).padStart(4, "0")}.cleaned.png`;
      await mkdir(path.dirname(path.join(sourceDir, rel)), { recursive: true });
      await writeFile(path.join(sourceDir, rel), imageBytes);
      rows.push({
        source_sha256: SOURCE_HASH,
        page,
        rule_version: 3,
        original_image_path: `pages/page-${String(page).padStart(4, "0")}.original.png`,
        original_image_sha256: sha256(Buffer.from(`original-${page}`)),
        cleaned_image_sha256: sha256(imageBytes),
        cleaned_image_path: rel,
        mask_bounds: null,
        region_names: [],
        changed_pixels: 12,
        changed_pixels_outside: 0,
        body_overlap_detected: false,
      });
    }
    await writeFile(
      path.join(sourceDir, "clean.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );
  }

  function cleanedImageHash(page: number): string {
    return sha256(Buffer.from(`cleaned-${page}`));
  }

  /** One deterministic OCR row (two blocks per page, in reading order). */
  function ocrRow(page: number, index: number): { page: number; text: string } & Record<string, unknown> {
    const text = `page ${page} block ${index} 词块`;
    return {
      schema_version: 1,
      pipeline: "PP-StructureV3",
      pipeline_version: "3.0.0",
      model_version: "pp-structurev3-test",
      config_version: 1,
      source_sha256: SOURCE_HASH,
      page,
      page_image_sha256: cleanedImageHash(page),
      bbox: [0.1, 0.1 + index * 0.05, 0.4, 0.14 + index * 0.05] as const,
      layout_label: "text",
      text,
      confidence: 0.95,
      source_raw_ref_hash: sha256(text),
    };
  }

  function chunkPages(args: readonly string[]): number[] {
    const index = args.indexOf("--pages");
    return index === -1 ? [] : (args[index + 1] ?? "").split(",").map(Number);
  }

  /** Fake worker: records spawns and merges chunk pages like the Python worker. */
  function makeFakeOcrWorker(options: { failPages?: ReadonlySet<number> } = {}) {
    const calls: Array<{ args: string[]; timeoutMs?: number }> = [];
    const runner: SpawnPythonFn = async (args, callOptions) => {
      calls.push({
        args: [...args],
        ...(callOptions?.timeoutMs !== undefined ? { timeoutMs: callOptions.timeoutMs } : {}),
      });
      const chunk = chunkPages(args);
      if (options.failPages !== undefined && chunk.some((page) => options.failPages!.has(page))) {
        throw new MediaSpawnError("MEDIA_TIMEOUT", "fake chunk timed out", null, "");
      }
      await emulateOcrMerge(chunk);
      return { stdout: `${JSON.stringify({ ok: true })}\n` };
    };
    return { calls, runner };
  }

  /** Emulate the Python merge: drop re-run pages, append rows, stable page sort. */
  async function emulateOcrMerge(chunk: number[]): Promise<void> {
    const ocrPath = path.join(sourceDir, "ocr.jsonl");
    const existing = existsSync(ocrPath)
      ? (await readFile(ocrPath, "utf8"))
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line) as { page: number })
      : [];
    const kept = existing.filter((row) => !chunk.includes(row.page));
    const fresh = chunk.map((page) => [ocrRow(page, 0), ocrRow(page, 1)]).flat();
    const merged = [...kept, ...fresh].sort((a, b) => a.page - b.page);
    await mkdir(path.join(sourceDir, "ocr-raw"), { recursive: true });
    for (const page of chunk) {
      const texts = fresh
        .filter((row) => row.page === page)
        .map((row) => String(row.text));
      await writeFile(
        path.join(sourceDir, `ocr-raw/page-${String(page).padStart(4, "0")}.txt`),
        texts.join("\n") + "\n",
        "utf8",
      );
    }
    await writeFile(
      ocrPath,
      merged.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );
  }

  function stageContext(pages: number[]): StageRunContext {
    return {
      runId: "ocr-chunk-test",
      sourceHash: SOURCE_HASH,
      config: { media: { sourcePath: "unused.pdf", pages, dpi: 300 } },
      ledger: createFileLedger({ directory: path.join(workDir, "ledger") }),
      logger: silentLogger,
      upstream: null,
    };
  }

  function makeStage(runner: SpawnPythonFn, chunkOptions: Partial<MediaStageOptions> = {}) {
    return createLayoutOcrStage({
      privateRoot: workDir,
      runPython: runner,
      ...chunkOptions,
    });
  }

  function runPipelineOnce(stages: unknown, pages: number[]) {
    return runPipeline(
      stages as never,
      createFileLedger({ directory: path.join(workDir, "ledger") }),
      {
        sourceHash: SOURCE_HASH,
        config: { media: { sourcePath: "unused.pdf", pages, dpi: 300 } },
        logger: silentLogger,
      },
    );
  }

  it("chunks the missing pages with --pages lists and forwards the per-chunk timeout", async () => {
    const pages = [1, 2, 3, 4, 5];
    await seedCleanPages(pages);
    const { calls, runner } = makeFakeOcrWorker();
    const stage = makeStage(runner, { ocrChunkPages: 2, ocrChunkTimeoutMs: 42_000 });

    const output = LayoutOcrOutputSchema.parse(await stage.run(undefined, stageContext(pages)));

    expect(output.pages.map((p) => p.page)).toEqual(pages);
    expect(calls.map((call) => chunkPages(call.args))).toEqual([[1, 2], [3, 4], [5]]);
    expect(calls.map((call) => call.timeoutMs)).toEqual([42_000, 42_000, 42_000]);
  });

  it("applies the default chunk size of 12 pages and 15-minute per-chunk timeout", async () => {
    const pages = Array.from({ length: 13 }, (_, index) => index + 1);
    await seedCleanPages(pages);
    const { calls, runner } = makeFakeOcrWorker();
    const stage = makeStage(runner);

    await stage.run(undefined, stageContext(pages));

    expect(calls.map((call) => chunkPages(call.args))).toEqual([
      Array.from({ length: 12 }, (_, index) => index + 1),
      [13],
    ]);
    expect(calls.map((call) => call.timeoutMs)).toEqual([
      15 * 60 * 1000,
      15 * 60 * 1000,
    ]);
  });

  it("spawns nothing when ocr.jsonl already covers every page with matching hashes", async () => {
    const pages = [1, 2, 3];
    await seedCleanPages(pages);
    const first = makeFakeOcrWorker();
    await makeStage(first.runner).run(undefined, stageContext(pages));
    expect(first.calls).toHaveLength(1);

    const second = makeFakeOcrWorker();
    const output = LayoutOcrOutputSchema.parse(
      await makeStage(second.runner).run(undefined, stageContext(pages)),
    );

    expect(second.calls).toEqual([]);
    expect(output.pages.map((p) => p.page)).toEqual(pages);
  });

  it("spawns only chunks for the missing pages when some pages are complete", async () => {
    const pages = [1, 2, 3];
    await seedCleanPages(pages);
    // Page 1 complete; page 2 carries stale rows whose image hash no longer
    // matches the clean record; page 3 has no rows at all.
    const stale = { ...ocrRow(2, 0), page_image_sha256: "a".repeat(64) };
    const rows = [ocrRow(1, 0), ocrRow(1, 1), stale];
    await mkdir(path.join(sourceDir, "ocr-raw"), { recursive: true });
    await writeFile(
      path.join(sourceDir, "ocr-raw/page-0001.txt"),
      "page 1 block 0 词块\npage 1 block 1 词块\n",
      "utf8",
    );
    await writeFile(
      path.join(sourceDir, "ocr.jsonl"),
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );

    const { calls, runner } = makeFakeOcrWorker();
    const output = LayoutOcrOutputSchema.parse(
      await makeStage(runner).run(undefined, stageContext(pages)),
    );

    expect(calls.map((call) => chunkPages(call.args))).toEqual([[2, 3]]);
    expect(output.pages.map((p) => p.page)).toEqual(pages);
  });

  it("resumes after a mid-chunk failure and re-spawns only the remainder", async () => {
    const pages = [1, 2, 3, 4];
    await seedCleanPages(pages);
    const chunkOptions = { ocrChunkPages: 2, ocrChunkTimeoutMs: 42_000 };
    const failing = makeFakeOcrWorker({ failPages: new Set([3, 4]) });
    const firstStage = makeStage(failing.runner, chunkOptions);

    const first = await runPipelineOnce([firstStage], pages);
    expect(first.status).toBe("FAILED");
    expect(first.results[0]!.error_code).toBe("MEDIA_TIMEOUT");
    expect(failing.calls.map((call) => chunkPages(call.args))).toEqual([[1, 2], [3, 4]]);

    // Retry with a healthy worker: the reconcile step re-spawns exactly the
    // pages the failed run never completed.
    const retry = makeFakeOcrWorker();
    const retryStage = makeStage(retry.runner, chunkOptions);
    const report = await runPipelineOnce([retryStage], pages);
    expect(report.status).toBe("COMPLETED");
    expect(retry.calls.map((call) => chunkPages(call.args))).toEqual([[3, 4]]);

    // Composition equivalence: the merged artifact must be byte-identical to
    // a single full OCR run over the same pages.
    const mergedArtifact = await readFile(path.join(sourceDir, "ocr.jsonl"), "utf8");
    await seedCleanPages(pages);
    const single = makeFakeOcrWorker();
    await makeStage(single.runner).run(undefined, stageContext(pages));
    expect(await readFile(path.join(sourceDir, "ocr.jsonl"), "utf8")).toBe(mergedArtifact);
  });
});

// ---------------------------------------------------------------------------
// Real-banner calibration (llcy-2024 raster): side tabs + opener banners
//
// The real book marks units with (a) a large "Unit N" opener banner on the
// unit's first page and (b) a bare 1-2 digit unit number as a side tab in the
// RIGHT rail (x0 >= 0.9) repeated on every subsequent page of the unit.
// Chapters get their own banners (a "Chapter N" opener block and a LEFT-rail
// tab pair) that must never start a unit. Geometry below mirrors the measured
// private calibration pages; every text is a synthetic lookalike (tab digits
// and "Unit N"/"Chapter N" placeholders, generic headwords).
// ---------------------------------------------------------------------------

describe("llcy-2024 banner calibration", () => {
  it("drops the leaking left-rail chapter tab number as sidebar furniture", () => {
    // Measured geometry: the word block ends at x1=0.0536 (already furniture)
    // but the number block ends at x1=0.0599, past the old 0.055 cutoff.
    const blocks = [
      makeBlock("chapter.tab", 1, [0.0286, 0.7825, 0.0536, 0.8308], "Chapter"),
      makeBlock("chapter.num", 1, [0.0249, 0.8371, 0.0599, 0.8571], "01"),
      makeBlock("body", 1, [0.1, 0.14, 0.48, 0.2], "kappa /ˈkæpə/ n. 希腊字母"),
    ];
    const { content, furniture } = partitionPageFurniture(blocks, DEFAULT_FURNITURE_CONFIG);
    expect(content.map((b) => b.blockKey)).toEqual(["body"]);
    expect(furniture.map((b) => b.blockKey).sort()).toEqual(["chapter.num", "chapter.tab"]);
  });

  it("starts units from right-rail tab digits and keeps one unit per number", () => {
    const blocks = [
      // Page 1: chapter 1 opener + right-rail tab "7" + one entry.
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      makeBlock("p1.tab", 1, [0.9359, 0.8278, 0.9709, 0.8478], "07"),
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "alpha /ˈælfə/ n. 阿尔法"),
      // Page 2: same tab digit -> the same unit stays open.
      makeBlock("p2.tab", 2, [0.9359, 0.8278, 0.9709, 0.8478], "07"),
      makeBlock("p2.head", 2, [0.1, 0.14, 0.48, 0.2], "beta /ˈbiːtə/ n. 贝塔"),
      // Page 3: tab flips to 8 -> a new unit starts.
      makeBlock("p3.tab", 3, [0.9359, 0.8278, 0.9709, 0.8478], "08"),
      makeBlock("p3.head", 3, [0.1, 0.14, 0.48, 0.2], "gamma /ˈɡæmə/ n. 伽马"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.unitBoundaries).toEqual([
      { unit_key: "c1.u7", unit_order: 1, title: "Unit 7", first_page: 1, last_page: 2 },
      { unit_key: "c1.u8", unit_order: 2, title: "Unit 8", first_page: 3, last_page: 3 },
    ]);
    expect(output.units.map((u) => [u.unit_key, u.unit_order, u.title])).toEqual([
      ["c1.u7", 1, "Unit 7"],
      ["c1.u8", 2, "Unit 8"],
    ]);
    expect(output.words.map((w) => [w.headword, w.unit_key])).toEqual([
      ["alpha", "c1.u7"],
      ["beta", "c1.u7"],
      ["gamma", "c1.u8"],
    ]);
  });

  it("starts units from the opener banner with the captured number, not discovery order", () => {
    const blocks = [
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      // Unit opener: a single large "Unit 12" banner block on the first page.
      makeBlock("p1.opener", 1, [0.16, 0.16, 0.46, 0.22], "Unit 12"),
      makeBlock("p1.tab", 1, [0.9359, 0.8278, 0.9709, 0.8478], "12"),
      makeBlock("p1.head", 1, [0.1, 0.26, 0.48, 0.32], "delta /ˈdeltə/ n. 德尔塔"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units).toHaveLength(1);
    expect(output.units[0]).toMatchObject({ unit_key: "c1.u12", unit_order: 1 });
    expect(output.words[0]!.unit_key).toBe("c1.u12");
  });

  it("never starts units from entry numbers, chapter tabs, or chapter openers", () => {
    const blocks = [
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      makeBlock("p1.entrynum", 1, [0.1262, 0.095, 0.1877, 0.1224], "118"),
      makeBlock("p1.opener", 1, [0.16, 0.16, 0.46, 0.22], "Unit 9"),
      makeBlock("p1.head", 1, [0.1, 0.3, 0.48, 0.36], "epsilon /ˈepsɪlɒn/ n. 艾普西隆"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units).toHaveLength(1);
    expect(output.units[0]).toMatchObject({ unit_key: "c1.u9", unit_order: 1 });
  });
});

describe("llcy-2024 signal-less page attribution", () => {
  // Opener pages (even printed) carry no OCR-able unit signal: the stylized
  // script banner defeats the recognizer and the left rail is chapter
  // furniture. Trailing pages (even printed) look the same. Both must be
  // attributed by nearest tab signal: an opener page sits closest to the
  // FOLLOWING unit's first tab page, a trailing page closest to the open
  // unit's last tab page.
  it("attributes a signal-less opener page to the unit the following tab names", () => {
    const blocks = [
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      // Page 1: unit opener page — no tab survived OCR, content only.
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "alpha /ˈælfə/ n. 阿尔法"),
      // Page 2: first tabbed page of unit 7.
      makeBlock("p2.tab", 2, [0.9359, 0.8278, 0.9709, 0.8478], "07"),
      makeBlock("p2.head", 2, [0.1, 0.14, 0.48, 0.2], "beta /ˈbiːtə/ n. 贝塔"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.unitBoundaries).toEqual([
      { unit_key: "c1.u7", unit_order: 1, title: "Unit 7", first_page: 1, last_page: 2 },
    ]);
    expect(output.words.map((w) => [w.headword, w.unit_key])).toEqual([
      ["alpha", "c1.u7"],
      ["beta", "c1.u7"],
    ]);
  });

  it("keeps a trailing signal-less page with the unit that most recently signaled", () => {
    const blocks = [
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      makeBlock("p1.tab", 1, [0.9359, 0.8278, 0.9709, 0.8478], "07"),
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "alpha /ˈælfə/ n. 阿尔法"),
      // Page 2: trailing signal-less page of unit 7.
      makeBlock("p2.head", 2, [0.1, 0.14, 0.48, 0.2], "beta /ˈbiːtə/ n. 贝塔"),
      // Page 3: next unit's opener (signal-less)...
      makeBlock("p3.head", 3, [0.1, 0.14, 0.48, 0.2], "gamma /ˈɡæmə/ n. 伽马"),
      // Page 4: ...named by its first tab page.
      makeBlock("p4.tab", 4, [0.9359, 0.8278, 0.9709, 0.8478], "08"),
      makeBlock("p4.head", 4, [0.1, 0.14, 0.48, 0.2], "delta /ˈdeltə/ n. 德尔塔"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.unitBoundaries).toEqual([
      { unit_key: "c1.u7", unit_order: 1, title: "Unit 7", first_page: 1, last_page: 2 },
      { unit_key: "c1.u8", unit_order: 2, title: "Unit 8", first_page: 3, last_page: 4 },
    ]);
    expect(output.words.map((w) => [w.headword, w.unit_key])).toEqual([
      ["alpha", "c1.u7"],
      ["beta", "c1.u7"],
      ["gamma", "c1.u8"],
      ["delta", "c1.u8"],
    ]);
  });
});

describe("llcy-2024 tab misread tolerance", () => {
  it("treats a single misread tab between two runs of one unit as noise", () => {
    const blocks = [
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      makeBlock("p1.tab", 1, [0.9359, 0.8278, 0.9709, 0.8478], "07"),
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "alpha /ˈælfə/ n. 阿尔法"),
      makeBlock("p2.tab", 2, [0.9396, 0.8327, 0.9767, 0.8536], "40"), // OCR misread of "07"
      makeBlock("p2.head", 2, [0.1, 0.14, 0.48, 0.2], "beta /ˈbiːtə/ n. 贝塔"),
      makeBlock("p3.tab", 3, [0.9327, 0.8306, 0.9719, 0.8532], "07"),
      makeBlock("p3.head", 3, [0.1, 0.14, 0.48, 0.2], "gamma /ˈɡæmə/ n. 伽马"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units).toHaveLength(1);
    expect(output.units[0]).toMatchObject({ unit_key: "c1.u7", unit_order: 1 });
    expect(output.words.map((w) => w.unit_key)).toEqual(["c1.u7", "c1.u7", "c1.u7"]);
  });

  it("never reads a one-digit truncated tab (real tabs always print two digits)", () => {
    // Real case: the tail page of a unit run truncates its tab to a single
    // digit ("6" for "19"). Real tabs are zero-padded two-digit blocks, so a
    // lone digit is truncation noise, not a unit signal.
    const blocks = [
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      makeBlock("p1.tab", 1, [0.9376, 0.6135, 0.9765, 0.6335], "19"),
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "alpha /ˈælfə/ n. 阿尔法"),
      makeBlock("p2.tab", 2, [0.9384, 0.6168, 0.9752, 0.6368], "6"),
      makeBlock("p2.head", 2, [0.1, 0.14, 0.48, 0.2], "beta /ˈbiːtə/ n. 贝塔"),
      makeBlock("p3.tab", 3, [0.9398, 0.6178, 0.9798, 0.6378], "19"),
      makeBlock("p3.head", 3, [0.1, 0.14, 0.48, 0.2], "gamma /ˈɡæmə/ n. 伽马"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units.map((u) => u.unit_key)).toEqual(["c1.u19"]);
    expect(output.words.map((w) => w.unit_key)).toEqual(["c1.u19", "c1.u19", "c1.u19"]);
  });
});

describe("llcy-2024 monotonic unit invariant", () => {
  it("fails closed when a later tab decreases within the same chapter", () => {
    const blocks = [
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      makeBlock("p1.tab", 1, [0.9359, 0.8278, 0.9709, 0.8478], "07"),
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "alpha /ˈælfə/ n. 阿尔法"),
      // A decreasing tab inside chapter 1 is always a misread: fail closed.
      makeBlock("p2.tab", 2, [0.9327, 0.8306, 0.9719, 0.8532], "02"),
      makeBlock("p2.head", 2, [0.1, 0.14, 0.48, 0.2], "beta /ˈbiːtə/ n. 贝塔"),
    ];
    expect(() => segmentStructure(assignReadingOrder(blocks), normalizeConfig())).toThrow(
      /must strictly increase/,
    );
  });

  it("fails closed when a closed unit's number re-appears in the same chapter", () => {
    const blocks = [
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      makeBlock("p1.tab", 1, [0.9359, 0.8278, 0.9709, 0.8478], "07"),
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "alpha /ˈælfə/ n. 阿尔法"),
      makeBlock("p2.tab", 2, [0.9359, 0.8278, 0.9709, 0.8478], "08"),
      makeBlock("p2.head", 2, [0.1, 0.14, 0.48, 0.2], "beta /ˈbiːtə/ n. 贝塔"),
      makeBlock("p3.tab", 3, [0.9359, 0.8278, 0.9709, 0.8478], "08"),
      makeBlock("p3.head", 3, [0.1, 0.14, 0.48, 0.2], "gamma /ˈɡæmə/ n. 伽马"),
      // Unit 7 is closed (its run ended); its number re-appearing on a
      // multi-page run is not a repeating tab misread.
      makeBlock("p4.tab", 4, [0.9327, 0.8306, 0.9719, 0.8532], "07"),
      makeBlock("p4.head", 4, [0.1, 0.14, 0.48, 0.2], "delta /ˈdeltə/ n. 德尔塔"),
      makeBlock("p5.tab", 5, [0.9327, 0.8306, 0.9719, 0.8532], "07"),
      makeBlock("p5.head", 5, [0.1, 0.14, 0.48, 0.2], "epsilon /ˈepsɪlɒn/ n. 艾普西隆"),
    ];
    expect(() => segmentStructure(assignReadingOrder(blocks), normalizeConfig())).toThrow(
      /re-appeared/,
    );
  });

  it("passes a legitimate strictly-increasing unit sequence", () => {
    const blocks = [
      makeBlock("p1.chapter", 1, [0.2, 0.065, 0.44, 0.1], "Chapter 1"),
      makeBlock("p1.tab", 1, [0.9359, 0.8278, 0.9709, 0.8478], "07"),
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "alpha /ˈælfə/ n. 阿尔法"),
      makeBlock("p2.tab", 2, [0.9359, 0.8278, 0.9709, 0.8478], "08"),
      makeBlock("p2.head", 2, [0.1, 0.14, 0.48, 0.2], "beta /ˈbiːtə/ n. 贝塔"),
      makeBlock("p3.tab", 3, [0.9359, 0.8278, 0.9709, 0.8478], "09"),
      makeBlock("p3.head", 3, [0.1, 0.14, 0.48, 0.2], "gamma /ˈɡæmə/ n. 伽马"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units.map((unit) => unit.unit_key)).toEqual(["c1.u7", "c1.u8", "c1.u9"]);
    expect(output.unitBoundaries.map((b) => [b.first_page, b.last_page])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(output.words.map((word) => word.unit_key)).toEqual(["c1.u7", "c1.u8", "c1.u9"]);
  });
});

// ---------------------------------------------------------------------------
// Chapter-aware calibration (config v3): measured on the full 440-page raster.
//
// Unit tabs are GLOBAL book-wide numbers (chapter 1 = units 1-7, chapter 2 =
// 8-14, ...), printed as a bare 1-2 digit thumb-tab in the RIGHT rail
// (x0 >= 0.9, y in [0.1, 0.9]) that slides DOWN the rail as the unit
// advances. The LEFT-rail digits are chapter tabs (sidebar furniture, never
// unit signals), and the bare digits at y >= 0.9 on the outer edges are PAGE
// numbers (footer furniture) — never unit tabs. Chapter openers ("Chapter N"
// near the page top) are authoritative chapter context; the contents page
// lists unit lines that must yield nothing (front-matter suppression before
// the first opener). Synthetic lookalikes only.
// ---------------------------------------------------------------------------

describe("llcy-2024 chapter-aware calibration (v3)", () => {
  const chapterOpener = (page: number, n: number): NormalizeInputBlock =>
    makeBlock(`p${page}.chapter`, page, [0.2, 0.065, 0.44, 0.1], `Chapter ${n}`);
  const unitTab = (page: number, digits: string): NormalizeInputBlock =>
    makeBlock(`p${page}.tab`, page, [0.9359, 0.8278, 0.9709, 0.8478], digits);
  const head = (page: number, word: string, gloss: string): NormalizeInputBlock =>
    makeBlock(`p${page}.head`, page, [0.1, 0.14, 0.48, 0.2], `${word} /ˈwɜːd/ n. ${gloss}`);

  it("qualifies unit keys with the chapter and keeps restarts legal", () => {
    const blocks = [
      chapterOpener(1, 1),
      unitTab(1, "01"),
      head(1, "alpha", "阿尔法"),
      unitTab(2, "01"),
      head(2, "alkali", "碱"),
      unitTab(3, "02"),
      head(3, "beta", "贝塔"),
      unitTab(4, "02"),
      head(4, "basil", "罗勒"),
      // Chapter 2 legally restarts at unit 1.
      chapterOpener(5, 2),
      unitTab(5, "01"),
      head(5, "gamma", "伽马"),
      unitTab(6, "01"),
      head(6, "guest", "客人"),
      unitTab(7, "02"),
      head(7, "delta", "德尔塔"),
      unitTab(8, "02"),
      head(8, "dawn", "黎明"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.unitBoundaries).toEqual([
      { unit_key: "c1.u1", unit_order: 1, title: "Unit 1", first_page: 1, last_page: 2 },
      { unit_key: "c1.u2", unit_order: 2, title: "Unit 2", first_page: 3, last_page: 4 },
      { unit_key: "c2.u1", unit_order: 3, title: "Unit 1", first_page: 5, last_page: 6 },
      { unit_key: "c2.u2", unit_order: 4, title: "Unit 2", first_page: 7, last_page: 8 },
    ]);
    expect(output.words.map((w) => [w.headword, w.unit_key])).toEqual([
      ["alpha", "c1.u1"],
      ["alkali", "c1.u1"],
      ["beta", "c1.u2"],
      ["basil", "c1.u2"],
      ["gamma", "c2.u1"],
      ["guest", "c2.u1"],
      ["delta", "c2.u2"],
      ["dawn", "c2.u2"],
    ]);
  });

  it("numbers units globally across a chapter change when the tabs keep counting", () => {
    // The real raster: chapter 2 opens with unit 8 (global numbering).
    const blocks = [
      chapterOpener(1, 1),
      unitTab(1, "07"),
      head(1, "alpha", "阿尔法"),
      chapterOpener(2, 2),
      unitTab(2, "08"),
      head(2, "beta", "贝塔"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units.map((u) => [u.unit_key, u.unit_order])).toEqual([
      ["c1.u7", 1],
      ["c2.u8", 2],
    ]);
    // unit_order is the global encounter ordinal: textbook reading order.
    expect(output.unitBoundaries.map((b) => b.unit_order)).toEqual([1, 2]);
  });

  it("yields no units from front-matter noise before the first chapter opener", () => {
    const blocks = [
      // Contents-page lookalike: a TOC listing chapter + unit lines mid-page
      // (the real page 13 lists Unit01..Unit 21 this way) plus stray digits.
      makeBlock("p1.toc.chapter", 1, [0.092, 0.256, 0.254, 0.281], "Chapter01"),
      makeBlock("p1.toc.u1", 1, [0.092, 0.326, 0.181, 0.346], "Unit01"),
      makeBlock("p1.toc.u2", 1, [0.093, 0.367, 0.183, 0.386], "Unit 02"),
      makeBlock("p1.toc.u3", 1, [0.532, 0.255, 0.623, 0.275], "Unit 03"),
      makeBlock("p1.stray", 1, [0.208, 0.619, 0.257, 0.64], "00"),
      unitTab(1, "04"), // even a tab-zone digit is noise before any opener
      // Preface word-family sampler (the real pages 11-12): entry-shaped
      // lines that are book apparatus, not unit vocabulary.
      makeBlock("p1.preface.head", 1, [0.1, 0.4, 0.48, 0.46], "workplace /ˈwɜːkpleɪs/ n. 职场"),
      // Chapter 1's opener page: the first legal signal source.
      chapterOpener(2, 1),
      unitTab(2, "01"),
      head(2, "alpha", "阿尔法"),
      unitTab(3, "01"),
      head(3, "beta", "贝塔"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units).toHaveLength(1);
    expect(output.units[0]).toMatchObject({ unit_key: "c1.u1", unit_order: 1 });
    expect(output.units[0]!.title).toBe("Unit 1"); // the "Unit01" TOC line never titles a unit
    expect(output.unitBoundaries[0]).toMatchObject({ first_page: 2, last_page: 3 });
    // The preface sampler is apparatus in a calibrated (chaptered) book: no
    // word records from front matter, hence nothing dangling in u0.
    expect(output.words.map((w) => [w.headword, w.unit_key])).toEqual([
      ["alpha", "c1.u1"],
      ["beta", "c1.u1"],
    ]);
  });

  it("tolerates digit-reversed tabs of the open unit across spreads", () => {
    const blocks = [
      chapterOpener(1, 1),
      // "10" is the 180° misread of "01": the chapter's first tab resolves to
      // the only sub-10 candidate, then every reversed repeat is a no-op.
      unitTab(1, "10"),
      head(1, "alpha", "阿尔法"),
      unitTab(2, "01"),
      head(2, "beta", "贝塔"),
      unitTab(3, "10"),
      head(3, "gamma", "伽马"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units).toHaveLength(1);
    expect(output.units[0]).toMatchObject({ unit_key: "c1.u1", unit_order: 1 });
    expect(output.words.map((w) => w.unit_key)).toEqual(["c1.u1", "c1.u1", "c1.u1"]);
  });

  it("never opens a unit from the left-rail chapter tab digits", () => {
    const blocks = [
      chapterOpener(1, 1),
      // Left-rail chapter tab pair, measured geometry (sidebar furniture).
      makeBlock("p1.chapter.tab", 1, [0.0286, 0.7825, 0.0536, 0.8308], "Chapter"),
      makeBlock("p1.chapter.num", 1, [0.0249, 0.8371, 0.0599, 0.8571], "02"),
      unitTab(1, "07"),
      head(1, "alpha", "阿尔法"),
      unitTab(2, "07"),
      head(2, "beta", "贝塔"),
    ];
    const { content, furniture } = partitionPageFurniture(blocks, DEFAULT_FURNITURE_CONFIG);
    expect(content.map((b) => b.blockKey)).not.toContain("p1.chapter.num");
    expect(furniture.map((b) => b.blockKey)).toContain("p1.chapter.num");
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units.map((u) => u.unit_key)).toEqual(["c1.u7"]); // not c1.u2
  });

  it("ignores rail digits after the back-matter (index) opener", () => {
    const blocks = [
      chapterOpener(1, 1),
      unitTab(1, "01"),
      head(1, "alpha", "阿尔法"),
      // Index opener page with stray rail digits (the real index pages carry
      // them); everything after it must be signal-inert.
      makeBlock("p2.index.opener", 2, [0.54, 0.37, 0.68, 0.4], "索引"),
      unitTab(2, "18"),
      head(2, "beta", "贝塔"),
      unitTab(3, "02"),
      head(3, "gamma", "伽马"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units.map((u) => u.unit_key)).toEqual(["c1.u1"]);
    expect(output.words.map((w) => [w.headword, w.unit_key])).toEqual([
      ["alpha", "c1.u1"],
      ["beta", "c1.u1"],
      ["gamma", "c1.u1"],
    ]);
  });

  it("never reads the y>=0.9 outer-edge digits (page numbers) as unit tabs", () => {
    const blocks = [
      chapterOpener(1, 1),
      unitTab(1, "07"),
      head(1, "alpha", "阿尔法"),
      // Bottom-outer corner page number in the right rail (y0 >= 0.9).
      makeBlock("p2.pagenum", 2, [0.9381, 0.9152, 0.9741, 0.9352], "26"),
      head(2, "beta", "贝塔"),
      unitTab(3, "07"),
      head(3, "gamma", "伽马"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.units.map((u) => u.unit_key)).toEqual(["c1.u7"]); // not c1.u26
  });

  it("opens one chapter-level unit when a chapter carries no unit signal at all", () => {
    const blocks = [
      chapterOpener(1, 1),
      unitTab(1, "01"),
      head(1, "alpha", "阿尔法"),
      // Chapter 2: opener + entries, but the stylized tabs defeat OCR entirely
      // (the real chapter 4). Its pages must not drain into chapter 1's unit.
      chapterOpener(2, 2),
      head(2, "beta", "贝塔"),
      head(3, "gamma", "伽马"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.unitBoundaries).toEqual([
      { unit_key: "c1.u1", unit_order: 1, title: "Unit 1", first_page: 1, last_page: 1 },
      { unit_key: "c2.u1", unit_order: 2, title: "Chapter 2", first_page: 2, last_page: 3 },
    ]);
    expect(output.words.map((w) => [w.headword, w.unit_key])).toEqual([
      ["alpha", "c1.u1"],
      ["beta", "c2.u1"],
      ["gamma", "c2.u1"],
    ]);
  });

  it("fails closed when a chapter opener skips a chapter number", () => {
    const blocks = [
      chapterOpener(1, 1),
      unitTab(1, "01"),
      head(1, "alpha", "阿尔法"),
      chapterOpener(2, 3), // chapter 2 never opened: the sequence must be contiguous
      unitTab(2, "01"),
      head(2, "beta", "贝塔"),
    ];
    expect(() => segmentStructure(assignReadingOrder(blocks), normalizeConfig())).toThrow(
      /chapter opener/,
    );
  });
});
