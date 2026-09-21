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
  sourceVerifiedSpacing,
  sourceVerifiedExamCharacterRepairs,
  segmentStructure,
  type NormalizeBookConfig,
  type NormalizeInputBlock,
  type NormalizeOutput,
} from "../src/normalize/segmentation";
import { findContentOwnershipFindings } from "../src/normalize/content-quality";
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

describe("original-page spacing transcription", () => {
  it("restores confirmed phrase spaces only on the matching source page", () => {
    expect(sourceVerifiedSpacing(24, "meanwell本意是好的；出于好心"))
      .toBe("mean well本意是好的；出于好心");
    expect(sourceVerifiedSpacing(25, "meanwell本意是好的；出于好心"))
      .toBe("meanwell本意是好的；出于好心");
  });

  it("restores the printed English in a glued exam example", () => {
    expect(sourceVerifiedSpacing(293, "真 avastdatacentre一个大型数据中心"))
      .toBe("真 a vast data centre一个大型数据中心");
  });
});

describe("original-page exam sentence transcription", () => {
  it("repairs visually confirmed Unit 1 OCR letters only on their source pages", () => {
    expect(sourceVerifiedExamCharacterRepairs(17, "Gverstate losses reflect the temnorary illiquidity"))
      .toBe("overstate losses reflect the temporary illiquidity");
    expect(sourceVerifiedExamCharacterRepairs(18, "Manyvoung icans cast douhts"))
      .toBe("Many young Americans cast doubts");
    expect(sourceVerifiedExamCharacterRepairs(17, "reflect wo mpol iqun vl iho l o the temporary illiquidity of markets not the likelyextentofbaddebts."))
      .toBe("reflect the temporary illiquidity of markets, not the likely extent of bad debts.");
    expect(sourceVerifiedExamCharacterRepairs(19, "abilitytohandleinformation."))
      .toBe("ability to handle information.");
    expect(sourceVerifiedExamCharacterRepairs(19, "Gverstate losses"))
      .toBe("Gverstate losses");
  });
});

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
    note_patterns: ["^(?:词)?根记忆", "^词根", "^联想记忆", "^同根词", "^相关词", "^近义词", "^反义词", "^注释", "^串词(?:记忆|成句)", "^小词有话说", "^英语中表达", "^文化休息站$", "^易混词辨析$", "^本单元资源$", "^真题词组小记$", "^组合词[：:]"],
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

  it("keeps a left-column sentence whose OCR box slightly crosses the gutter", () => {
    const blocks: PositionedBlock[] = [
      { key: "left-marker", page: 1, bbox: [0.124, 0.302, 0.147, 0.316], text: "真" },
      { key: "left-line-1", page: 1, bbox: [0.153, 0.301, 0.519, 0.316], text: "Enraged by Entergy's behavior" },
      { key: "left-line-2", page: 1, bbox: [0.121, 0.322, 0.519, 0.336], text: "the Vermont Senate voted" },
      { key: "right-headword", page: 1, bbox: [0.564, 0.223, 0.669, 0.241], text: "diffuse" },
    ];

    expect(assignReadingOrder(blocks).map((block) => block.key)).toEqual([
      "left-marker",
      "left-line-1",
      "left-line-2",
      "right-headword",
    ]);
  });

  it("keeps a normal-width right line in the right column when its box bleeds into the gutter", () => {
    const blocks: PositionedBlock[] = [
      { key: "left-tail", page: 1, bbox: [0.46, 0.72, 0.523, 0.74], text: "left" },
      { key: "right-head", page: 1, bbox: [0.489, 0.62, 0.664, 0.65], text: "exceptional" },
      { key: "right-marker", page: 1, bbox: [0.482, 0.708, 0.511, 0.723], text: "真" },
      { key: "right-line", page: 1, bbox: [0.478, 0.724, 0.887, 0.743], text: "right sentence" },
    ];

    expect(assignReadingOrder(blocks).map((block) => block.key)).toEqual([
      "left-tail",
      "right-head",
      "right-marker",
      "right-line",
    ]);
  });

  it("keeps a narrow right-column gloss out of the left-column sequence", () => {
    const blocks: PositionedBlock[] = [
      { key: "left-example", page: 1, bbox: [0.04, 0.62, 0.44, 0.64], text: "left example" },
      { key: "right-gloss", page: 1, bbox: [0.48, 0.65, 0.593, 0.668], text: "的；例外的" },
      { key: "left-next", page: 1, bbox: [0.05, 0.8, 0.2, 0.82], text: "exception" },
    ];

    expect(assignReadingOrder(blocks).map((block) => block.key)).toEqual([
      "left-example",
      "left-next",
      "right-gloss",
    ]);
  });

  it("places a mid-page full-width line at its vertical position before reading both columns below", () => {
    const blocks: PositionedBlock[] = [
      { key: "right-prior", page: 1, bbox: [0.52, 0.1, 0.9, 0.15], text: "P" },
      { key: "right-below", page: 1, bbox: [0.52, 0.4, 0.9, 0.45], text: "R" },
      { key: "header", page: 1, bbox: [0.1, 0.22, 0.45, 0.25], text: "H" },
      { key: "divider", page: 1, bbox: [0.1, 0.26, 0.8, 0.29], text: "D" },
      { key: "left-below", page: 1, bbox: [0.1, 0.35, 0.45, 0.39], text: "L" },
      { key: "narrow-crossing", page: 1, bbox: [0.49, 0.7, 0.64, 0.74], text: "N" },
    ];

    expect(assignReadingOrder(blocks).map((block) => block.key)).toEqual([
      "right-prior",
      "header",
      "divider",
      "left-below",
      "right-below",
      "narrow-crossing",
    ]);
  });

  it("uses a three-digit entry badge as a two-column section boundary", () => {
    const blocks: PositionedBlock[] = [
      { key: "left-prior", page: 1, bbox: [0.1, 0.1, 0.48, 0.2], text: "left prior" },
      { key: "right-prior", page: 1, bbox: [0.52, 0.1, 0.9, 0.2], text: "right prior" },
      { key: "badge", page: 1, bbox: [0.11, 0.42, 0.18, 0.46], text: "007" },
      { key: "headword", page: 1, bbox: [0.2, 0.44, 0.39, 0.47], text: "company" },
      { key: "phonetic", page: 1, bbox: [0.39, 0.44, 0.52, 0.47], text: "['kʌmpəni]" },
      { key: "summary", page: 1, bbox: [0.12, 0.48, 0.43, 0.5], text: "n. 公司" },
      { key: "left-entry", page: 1, bbox: [0.11, 0.58, 0.48, 0.62], text: "accompany" },
      { key: "left-example", page: 1, bbox: [0.11, 0.66, 0.48, 0.84], text: "example starts" },
      { key: "right-continuation", page: 1, bbox: [0.52, 0.54, 0.9, 0.7], text: "example continues" },
      { key: "right-next-entry", page: 1, bbox: [0.52, 0.73, 0.9, 0.78], text: "companion" },
    ];

    expect(assignReadingOrder(blocks).map((block) => block.key)).toEqual([
      "left-prior",
      "right-prior",
      "badge",
      "headword",
      "phonetic",
      "summary",
      "left-entry",
      "left-example",
      "right-continuation",
      "right-next-entry",
    ]);
  });

  it("orders slightly misaligned OCR fragments on the same printed line from left to right", () => {
    const blocks: PositionedBlock[] = [
      { key: "word", page: 1, bbox: [0.8, 0.201, 0.86, 0.22], text: "intended" },
      { key: "sentence", page: 1, bbox: [0.56, 0.202, 0.79, 0.221], text: "Either Entergy never really" },
      { key: "marker", page: 1, bbox: [0.52, 0.2, 0.55, 0.219], text: "真" },
      { key: "tail", page: 1, bbox: [0.87, 0.203, 0.9, 0.221], text: "to" },
    ];

    expect(assignReadingOrder(blocks).map((block) => block.key)).toEqual([
      "marker",
      "sentence",
      "word",
      "tail",
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

  it("removes a separately detected left-rail chapter number", () => {
    const railNumber = makeBlock("rail-number", 1, [0.037, 0.725, 0.078, 0.746], "02");
    const { content, furniture } = partitionPageFurniture(
      [railNumber, makeBlock("body", 1, [0.1, 0.72, 0.48, 0.75], "example")],
      DEFAULT_FURNITURE_CONFIG,
    );

    expect(furniture.map((block) => block.blockKey)).toEqual(["rail-number"]);
    expect(content.map((block) => block.blockKey)).toEqual(["body"]);
  });

  it("removes the low footer slogan and bottom-right brand banner", () => {
    const blocks = [
      makeBlock("slogan", 1, [0.071, 0.929, 0.489, 0.944], "长大后才发现早睡早起只是愿望"),
      makeBlock("brand", 1, [0.545, 0.828, 0.645, 0.854], "考研人"),
      makeBlock("brand-tail", 1, [0.656, 0.829, 0.828, 0.853], "相关词家园"),
      makeBlock("promo-wechat", 1, [0.491, 0.794, 0.565, 0.821], "微信"),
      makeBlock("promo-fragment", 1, [0.653, 0.832, 0.756, 0.845], "的精神"),
      makeBlock("promo-contact", 1, [0.669, 0.905, 0.838, 0.916], "QQ群：118105451"),
      makeBlock("promo-contact-garbled", 1, [0.164, 0.908, 0.26, 0.916], "仙信人口"),
      makeBlock("top-promo", 1, [0.281, 0.074, 0.533, 0.087], "关注微信公众号【神灯考研】"),
      makeBlock("real-spirit", 1, [0.56, 0.76, 0.88, 0.79], "spirit of inquiry 探究精神"),
      makeBlock("body", 1, [0.5, 0.76, 0.88, 0.79], "valid content"),
    ];

    const { content, furniture } = partitionPageFurniture(blocks, DEFAULT_FURNITURE_CONFIG);
    expect(content.map((block) => block.blockKey)).toEqual(["real-spirit", "body"]);
    expect(furniture.map((block) => block.blockKey)).toEqual([
      "slogan",
      "brand",
      "brand-tail",
      "promo-wechat",
      "promo-fragment",
      "promo-contact",
      "promo-contact-garbled",
      "top-promo",
    ]);
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

describe("textbook entry ownership recovery", () => {
  function segmentPage(body: NormalizeInputBlock[]): NormalizeOutput {
    return segmentStructure(
      assignReadingOrder([
        makeBlock("chapter", 1, [0.1, 0.06, 0.3, 0.09], "Chapter 1"),
        makeBlock("unit", 1, [0.08, 0.1, 0.9, 0.14], "Unit 1"),
        ...body,
      ]),
      normalizeConfig(),
      [],
    );
  }

  it("reassembles a headword split horizontally from its phonetic and POS", () => {
    const output = segmentPage([
      makeBlock("workforce.word", 1, [0.1, 0.3, 0.25, 0.33], "workforce"),
      makeBlock("workforce.meta", 1, [0.245, 0.3, 0.47, 0.33], "[w3:kf:s] n. 劳动力；"),
      makeBlock("workforce.gloss", 1, [0.1, 0.34, 0.22, 0.37], "全体员工"),
      makeBlock(
        "workforce.example",
        1,
        [0.52, 0.1, 0.9, 0.14],
        "真 agricultural workforce 农业劳动力",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toContain("workforce");
    const word = output.words.find((candidate) => candidate.headword === "workforce")!;
    expect(output.senses.find((sense) => sense.word_key === word.word_key)?.gloss).toBe(
      "劳动力；全体员工",
    );
    expect(output.examples.find((example) => example.word_key === word.word_key)?.text).toContain(
      "agricultural workforce",
    );
  });

  it("keeps consecutive split related-word entries distinct", () => {
    const output = segmentPage([
      makeBlock("related", 1, [0.68, 0.45, 0.77, 0.47], "相关词"),
      makeBlock("coverage.word", 1, [0.532, 0.508, 0.66, 0.522], "coverage"),
      makeBlock("coverage.meta", 1, [0.669, 0.503, 0.897, 0.522], "[ˈkʌvərɪdʒ] n. 新闻报道；"),
      makeBlock("coverage.gloss", 1, [0.52, 0.526, 0.61, 0.545], "覆盖范围"),
      makeBlock("phenomenon.word", 1, [0.532, 0.562, 0.728, 0.581], "phenomenon"),
      makeBlock("phenomenon.meta", 1, [0.737, 0.555, 0.92, 0.584], "[fəˈnɒmɪnən] n."),
      makeBlock("phenomenon.gloss", 1, [0.522, 0.583, 0.711, 0.603], "[pl. phenomena] 现象"),
      makeBlock("phenomenon.example", 1, [0.525, 0.61, 0.822, 0.627], "真 the social phenomenon 社会现象"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["coverage", "phenomenon"]);
    expect(output.examples[0]?.word_key).toBe(output.words[1]?.word_key);
  });

  it("does not treat a bracketed gloss annotation as a damaged phonetic", () => {
    const output = segmentPage([
      makeBlock("related", 1, [0.25, 0.78, 0.34, 0.81], "相关词"),
      makeBlock("democratic.word", 1, [0.098, 0.84, 0.261, 0.857], "democratic"),
      makeBlock("democratic.meta", 1, [0.272, 0.834, 0.49, 0.864], "[dəˈmɒkrætɪk] adj."),
      makeBlock(
        "democratic.gloss",
        1,
        [0.087, 0.862, 0.467, 0.879],
        "民主的；有民主精神的；[D-]（美国）民主党的",
      ),
      makeBlock(
        "democratic.example",
        1,
        [0.505, 0.637, 0.89, 0.69],
        "真 It doesn't feel like a human or democratic relationship. 这不像民主关系。",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["democratic"]);
    expect(output.words[0]?.phonetic).toBe("[dəˈmɒkrætɪk]");
    expect(output.senses[0]?.gloss).toContain("[D-]");
    expect(output.examples[0]?.word_key).toBe(output.words[0]?.word_key);
  });

  it("reassembles a split headword whose POS wraps to the other column", () => {
    const output = segmentPage([
      makeBlock("antipoverty.head", 1, [0.1, 0.2, 0.48, 0.24], "antipoverty [ˌæntɪˈpɒvəti] adj. 反贫困的"),
      makeBlock("impoverished.word", 1, [0.12, 0.35, 0.34, 0.38], "impoverished"),
      makeBlock("impoverished.phonetic", 1, [0.35, 0.35, 0.49, 0.38], "[ɪmˈpɒvərɪʃt]"),
      makeBlock("impoverished.sense", 1, [0.55, 0.2, 0.75, 0.23], "adj. 贫困的"),
      makeBlock("impoverished.source", 1, [0.8, 0.23, 0.95, 0.25], "(2012年阅读)"),
      makeBlock("impoverished.example", 1, [0.55, 0.26, 0.95, 0.29], "真 impoverished homes 贫困家庭"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["antipoverty", "impoverished"]);
    const impoverished = output.words[1]!;
    expect(output.senses.find((sense) => sense.word_key === impoverished.word_key)).toMatchObject({
      pos: "adj",
      gloss: "贫困的",
    });
    expect(output.examples[0]?.word_key).toBe(impoverished.word_key);
  });

  it("reassembles a wrapped POS line across an intervening rail tab", () => {
    const output = segmentPage([
      makeBlock("complexity.head", 1, [0.08, 0.71, 0.46, 0.74], "complexity [kəmˈpleksəti] n. 复杂性"),
      makeBlock("related", 1, [0.24, 0.8, 0.33, 0.824], "同根词"),
      makeBlock("complicated.head", 1, [0.08, 0.88, 0.463, 0.901], "complicated [ˈkɒmplɪkeɪtɪd]"),
      makeBlock("rail-tab", 1, [0.945, 0.506, 0.977, 0.523], "11"),
      makeBlock("complicated.sense", 1, [0.501, 0.526, 0.69, 0.543], "adj. 复杂的；难懂的"),
      makeBlock(
        "complicated.example",
        1,
        [0.501, 0.647, 0.895, 0.683],
        "真 an ambiguous and complicated route 模糊复杂的过程",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["complexity", "complicated"]);
    expect(output.examples[0]?.word_key).toBe(output.words[1]?.word_key);
  });

  it("reassembles a headword and phonetic above a separate POS/gloss line", () => {
    const output = segmentPage([
      makeBlock("state.head", 1, [0.2, 0.3, 0.4, 0.34], "state [steit]"),
      makeBlock(
        "state.sense",
        1,
        [0.12, 0.35, 0.72, 0.39],
        "n. 状态；国家；州；政府 vt. 陈述；规定 adij州的；国家的",
      ),
      makeBlock("state.example", 1, [0.1, 0.4, 0.48, 0.44], "真 in a shocking state 状况极其糟糕"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["state"]);
    expect(output.senses.filter((sense) => sense.word_key === output.words[0]!.word_key)).toHaveLength(3);
  });

  it("gates split headword and phonetic with their own OCR confidences", () => {
    const output = segmentPage([
      makeBlock("career.word", 1, [0.11, 0.36, 0.2, 0.386], "career", 0.999),
      makeBlock("career.meta", 1, [0.205, 0.36, 0.49, 0.391], "[kə'rɪə(r)] n. 职业；职业生涯", 0.82),
    ]);

    expect(output.fieldReviews.map((review) => review.field)).toEqual(["phonetic"]);
    expect(output.fieldReviews[0]?.ocr_confidence).toBe(0.82);
  });

  it("replaces a damaged duplicate phonetic when the complete phonetic and POS overlap", () => {
    const output = segmentPage([
      makeBlock("curriculum.head", 1, [0.52, 0.71, 0.9, 0.75], "curriculum [kəˈrɪkjələm] n. 课程"),
      makeBlock("discipline.head", 1, [0.522, 0.835, 0.773, 0.857], "discipline['displin]"),
      makeBlock("discipline.meta", 1, [0.665, 0.837, 0.899, 0.875], "['disəplin] n. 自制力；学科；行为准则"),
      makeBlock(
        "discipline.example",
        1,
        [0.52, 0.88, 0.9, 0.895],
        "真 They reveal a mental discipline in thinking skills. 他们展现出思考方面的自制力。",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["curriculum", "discipline"]);
    expect(output.words[1]?.phonetic).toBe("['disəplin]");
    expect(output.examples[0]?.word_key).toBe(output.words[1]?.word_key);
  });

  it("iteratively reassembles a bare headword, phonetic, and separate POS/gloss", () => {
    const output = segmentPage([
      makeBlock("work.head", 1, [0.2, 0.22, 0.3, 0.25], "work"),
      makeBlock("work.phonetic", 1, [0.3, 0.22, 0.4, 0.25], "[w3:k]"),
      makeBlock(
        "work.sense",
        1,
        [0.12, 0.26, 0.72, 0.3],
        "vi. 工作；产生作用；争取 v（使）运转 n. 工作；工作成果；作品",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["work"]);
    expect(output.senses.filter((sense) => sense.word_key === output.words[0]!.word_key)).toHaveLength(3);
  });

  it("parses a headword directly adjacent to its phonetic", () => {
    const output = segmentPage([
      makeBlock("statement.head", 1, [0.52, 0.2, 0.9, 0.24], "statement['steitmənt]n.声明；说法"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["statement"]);
    expect(output.senses[0]!.gloss).toBe("声明；说法");
  });

  it("accepts parenthesized headword variants and OCR junk before a POS marker", () => {
    const output = segmentPage([
      makeBlock("labour.word", 1, [0.49, 0.3, 0.64, 0.33], "labo(u)r"),
      makeBlock("labour.meta", 1, [0.648, 0.3, 0.9, 0.33], "[leiba(r)] n. 劳动；(统称)"),
      makeBlock("labourer.word", 1, [0.49, 0.4, 0.64, 0.43], "labo(u)rer"),
      makeBlock("labourer.phonetic", 1, [0.648, 0.4, 0.76, 0.43], "[leibara(r)]"),
      makeBlock("labourer.sense", 1, [0.65, 0.44, 0.9, 0.47], "]n. 体力劳动者"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["labo(u)r", "labo(u)rer"]);
    expect(output.senses.map((sense) => sense.gloss)).toEqual(["劳动；(统称)", "体力劳动者"]);
  });

  it("recovers a split entry when OCR drops the phonetic opening bracket", () => {
    const output = segmentPage([
      makeBlock("sentence.fragment", 1, [0.48, 0.3, 0.515, 0.33], "any"),
      makeBlock("overstate.word", 1, [0.52, 0.3, 0.65, 0.33], "overstate"),
      makeBlock("overstate.phonetic", 1, [0.66, 0.3, 0.79, 0.33], "auva'steit]"),
      makeBlock("overstate.sense", 1, [0.52, 0.34, 0.68, 0.37], "vt. 夸大"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["overstate"]);
    expect(output.senses[0]).toMatchObject({ pos: "vt", gloss: "夸大" });
  });

  it("keeps a multi-line exam sentence as one example and reads its separate source label", () => {
    const output = segmentPage([
      makeBlock("workout.head", 1, [0.52, 0.2, 0.9, 0.24], "workout ['w3:kaut] n. 训练，锻炼"),
      makeBlock("workout.ref", 1, [0.74, 0.245, 0.9, 0.27], "（2022年新题型）"),
      makeBlock(
        "workout.ex.1",
        1,
        [0.52, 0.28, 0.9, 0.31],
        "真 Although it can be a workout on its own,",
      ),
      makeBlock(
        "workout.ex.2",
        1,
        [0.52, 0.32, 0.9, 0.35],
        "if your goal is to get back to Zumba classes,",
      ),
      makeBlock(
        "workout.ex.3",
        1,
        [0.52, 0.36, 0.9, 0.39],
        "walking is also a great first step. 尽管步行本身就是一种锻炼。",
      ),
    ]);

    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]).toMatchObject({ source_ref: "2022新题型" });
    expect(output.examples[0]!.text).toContain("Zumba classes");
    expect(output.examples[0]!.text).toContain("尽管步行本身就是一种锻炼");
    expect(output.phrases).toHaveLength(0);
  });

  it("joins a standalone exam marker to the sentence on its right", () => {
    const output = segmentPage([
      makeBlock("workout.head", 1, [0.52, 0.2, 0.9, 0.24], "workout ['w3:kaut] n. 训练，锻炼"),
      makeBlock("workout.marker", 1, [0.52, 0.28, 0.55, 0.31], "真"),
      makeBlock(
        "workout.ex.1",
        1,
        [0.538, 0.28, 0.9, 0.31],
        "Although it can be a workout on its own,",
      ),
      makeBlock(
        "workout.ex.2",
        1,
        [0.56, 0.32, 0.9, 0.35],
        "walking is also a great first step. 尽管步行本身就是一种锻炼。",
      ),
    ]);

    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]!.text).toContain("Although it can be a workout on its own");
    expect(output.examples[0]!.text).toContain("walking is also a great first step");
    expect(output.phrases).toHaveLength(0);
  });

  it("keeps a left-edge exam marker out of the chapter-sidebar furniture", () => {
    const output = segmentPage([
      makeBlock("except.head", 1, [0.15, 0.47, 0.4, 0.53], "except [ɪkˈsept] prep. 除了"),
      makeBlock("except.marker", 1, [0.05, 0.587, 0.067, 0.597], "真"),
      makeBlock("except.example", 1, [0.077, 0.583, 0.445, 0.598], "Everything except this. 除此之外。"),
    ]);

    expect(output.examples[0]?.text).toContain("Everything except this");
  });

  it("joins an exam marker detected just after its sentence and wraps into the right column", () => {
    const output = segmentStructure(
      assignReadingOrder([
        makeBlock("chapter", 1, [0.1, 0.02, 0.3, 0.05], "Chapter 1"),
        makeBlock("unit", 1, [0.1, 0.06, 0.3, 0.09], "Unit 1"),
        makeBlock("career.head", 1, [0.1, 0.2, 0.48, 0.24], "career [kə'rɪə(r)] n. 职业生涯"),
        makeBlock("career.ex.1", 1, [0.14, 0.421, 0.485, 0.436], "They will need to be constantly up-skilling"),
        makeBlock("career.marker", 1, [0.103, 0.422, 0.124, 0.435], "真"),
        makeBlock("career.ex.2", 1, [0.519, 0.071, 0.9, 0.088], "throughout their career to stay employable. 他"),
        makeBlock("career.ex.3", 1, [0.52, 0.094, 0.89, 0.108], "们需要不断提高技能。"),
      ]),
      normalizeConfig(),
      [],
    );

    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]!.text).toContain("throughout their career to stay employable");
    expect(output.examples[0]!.text).toContain("们需要不断提高技能");
  });

  it("keeps a translated example open when its Chinese tail continues in the right column", () => {
    const output = segmentStructure(
      assignReadingOrder([
        makeBlock("chapter", 1, [0.1, 0.02, 0.3, 0.05], "Chapter 1"),
        makeBlock("unit", 1, [0.1, 0.06, 0.3, 0.09], "Unit 1"),
        makeBlock("badge", 1, [0.11, 0.2, 0.18, 0.23], "007"),
        makeBlock("company.head", 1, [0.2, 0.21, 0.48, 0.24], "company ['kʌmpəni] n. 公司"),
        makeBlock("accompany.head", 1, [0.1, 0.4, 0.48, 0.44], "accompany [ə'kʌmpəni] vt. 陪伴"),
        makeBlock("accompany.marker", 1, [0.1, 0.5, 0.13, 0.53], "真"),
        makeBlock("accompany.example", 1, [0.14, 0.5, 0.48, 0.76], "She accompanied him. 她陪"),
        makeBlock("accompany.translation", 1, [0.52, 0.35, 0.9, 0.42], "伴着他。"),
        makeBlock("companion.head", 1, [0.52, 0.5, 0.9, 0.54], "companion [kəm'pæniən] n. 同伴"),
      ]),
      normalizeConfig(),
      [],
    );

    const accompany = output.words.find((word) => word.headword === "accompany")!;
    const example = output.examples.find((item) => item.word_key === accompany.word_key)!;
    expect(example.text).toContain("她陪 伴着他");
    expect(output.senses.find((sense) => sense.word_key === accompany.word_key)?.gloss).toBe("陪伴");
  });

  it("keeps a short left-column translation after a gutter-crossing line", () => {
    const output = segmentStructure(
      assignReadingOrder([
        makeBlock("chapter", 1, [0.1, 0.02, 0.3, 0.05], "Chapter 1"),
        makeBlock("unit", 1, [0.1, 0.06, 0.3, 0.09], "Unit 1"),
        makeBlock("head", 1, [0.12, 0.22, 0.5, 0.25], "extension [ɪkˈstenʃn] n. 延期"),
        makeBlock("marker", 1, [0.124, 0.302, 0.147, 0.316], "真"),
        makeBlock("line-1", 1, [0.153, 0.301, 0.519, 0.316], "Enraged by Entergy's behavior"),
        makeBlock("line-2", 1, [0.121, 0.322, 0.519, 0.336], "the Vermont Senate voted"),
        makeBlock("line-3", 1, [0.122, 0.365, 0.516, 0.38], "参议院否决了"),
        makeBlock("line-4", 1, [0.122, 0.387, 0.305, 0.402], "（核电站执照）延期。"),
      ]),
      normalizeConfig(),
      [],
    );

    expect(output.examples[0]?.text).toContain("(核电站执照)延期");
  });

  it("joins a compact right-column example after its marker", () => {
    const output = segmentPage([
      makeBlock("contribution.head", 1, [0.51, 0.74, 0.89, 0.78], "contribution [,kɒntrɪ'bjuːʃn] n. 贡献"),
      makeBlock("contribution.marker", 1, [0.503, 0.822, 0.521, 0.833], "真"),
      makeBlock("contribution.ex.1", 1, [0.531, 0.82, 0.89, 0.834], "Therefore, everyone needs to find their"),
      makeBlock("contribution.ex.2", 1, [0.5, 0.84, 0.877, 0.854], "extra—their unique value contribution. 因而,"),
      makeBlock("contribution.ex.3", 1, [0.501, 0.862, 0.808, 0.874], "每个人都必须找到自身的独特之处"),
      makeBlock("contribution.ex.4", 1, [0.498, 0.882, 0.651, 0.899], "特有的价值贡献。"),
      makeBlock("page-number", 1, [0.86, 0.929, 0.903, 0.947], "169"),
    ]);

    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]!.text).toContain("extra—their unique value contribution");
    expect(output.examples[0]!.text).toContain("特有的价值贡献");
    expect(output.examples[0]!.text).not.toContain("169");
    expect(output.phrases).toHaveLength(0);
  });

  it("keeps an exam sentence together when it continues at the top of the next page", () => {
    const output = segmentStructure(
      [
        ...assignReadingOrder([
          makeBlock("chapter", 1, [0.1, 0.02, 0.3, 0.05], "Chapter 1"),
          makeBlock("unit", 1, [0.1, 0.06, 0.3, 0.09], "Unit 1"),
          makeBlock("overstate.head", 1, [0.52, 0.7, 0.9, 0.74], "overstate [ˌəʊvəˈsteɪt] vt. 夸大"),
          makeBlock("overstate.marker", 1, [0.52, 0.8, 0.55, 0.83], "真"),
          makeBlock("overstate.ex.1", 1, [0.56, 0.8, 0.9, 0.83], "Today they argue that market prices"),
          makeBlock("overstate.ex.2", 1, [0.52, 0.84, 0.9, 0.87], "overstate losses, because they largely reflect"),
        ]),
        ...assignReadingOrder([
          makeBlock("overstate.ex.3", 2, [0.1, 0.07, 0.48, 0.1], "the temporary illiquidity of markets, not the"),
          makeBlock("overstate.ex.4", 2, [0.1, 0.11, 0.48, 0.14], "likely extent of bad debts. 它们认为市场价格夸大了损失。"),
          makeBlock("next.head", 2, [0.52, 0.08, 0.9, 0.12], "stake [steɪk] n. 利害关系"),
        ]),
      ],
      normalizeConfig(),
      [],
    );

    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]!.text).toContain("likely extent of bad debts");
    const overstate = output.words.find((word) => word.headword === "overstate")!;
    expect(output.senses.find((sense) => sense.word_key === overstate.word_key)?.gloss).toBe("夸大");
  });

  it("stops a cross-page example before the next chapter opener", () => {
    const output = segmentStructure(
      [
        ...assignReadingOrder([
          makeBlock("chapter-1", 1, [0.16, 0.1, 0.45, 0.15], "Chapter 01"),
          makeBlock("unit-1", 1, [0.16, 0.16, 0.45, 0.2], "Unit 1"),
          makeBlock("word-1", 1, [0.52, 0.78, 0.9, 0.81], "alpha [ˈælfə] n. 阿尔法"),
          makeBlock("example-1", 1, [0.52, 0.86, 0.9, 0.89], "真 Alpha is first. 阿尔法在首位。"),
        ]),
        ...assignReadingOrder([
          makeBlock("chapter-2", 2, [0.16, 0.1, 0.45, 0.15], "Chapter 02"),
          makeBlock("unit-2", 2, [0.16, 0.16, 0.45, 0.2], "Unit 2"),
          makeBlock("word-2", 2, [0.1, 0.24, 0.48, 0.28], "beta [ˈbiːtə] n. 贝塔"),
        ]),
      ],
      normalizeConfig(),
      [],
    );

    expect(output.examples[0]?.text).toBe("Alpha is first. 阿尔法在首位。");
  });

  it("continues through a cross-gutter first line at the top of the next page", () => {
    const output = segmentStructure(
      [
        ...assignReadingOrder([
          makeBlock("chapter", 1, [0.1, 0.02, 0.3, 0.05], "Chapter 1"),
          makeBlock("unit", 1, [0.1, 0.06, 0.3, 0.09], "Unit 1"),
          makeBlock("transmit.head", 1, [0.56, 0.72, 0.9, 0.76], "transmit [trænzˈmɪt] v. 传送"),
          makeBlock("transmit.example", 1, [0.56, 0.84, 0.94, 0.9], "真 History is made under circumstances"),
        ]),
        ...assignReadingOrder([
          makeBlock("cross-gutter", 2, [0.06, 0.067, 0.89, 0.083], "directly found and given 人类创造历史"),
          makeBlock("left-tail", 2, [0.06, 0.088, 0.46, 0.104], "transmitted from the past. 从过去传下来。"),
          makeBlock("next.head", 2, [0.52, 0.28, 0.9, 0.32], "suffer [ˈsʌfə(r)] vi. 受苦"),
        ]),
      ],
      normalizeConfig(),
      [],
    );

    expect(output.examples[0]?.text).toContain("transmitted from the past");
  });

  it("recovers an exam sentence whose marker was missed after a numbered source line", () => {
    const output = segmentPage([
      makeBlock("labour.head", 1, [0.1, 0.2, 0.48, 0.24], "labo(u)r ['leibə(r)] n. 劳动；(统称)劳工"),
      makeBlock(
        "labour.sense",
        1,
        [0.1, 0.28, 0.48, 0.31],
        "②vi努力做(困难的事)(2012年新题型)",
      ),
      makeBlock(
        "labour.ex.1",
        1,
        [0.1, 0.32, 0.48, 0.35],
        "The second half of the 20th century saw a collection of geniuses",
      ),
      makeBlock(
        "labour.ex.2",
        1,
        [0.1, 0.36, 0.48, 0.39],
        "and visionaries labour to create a fabulous machine. 20世纪下半叶出现了一批天才。",
      ),
    ]);

    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]).toMatchObject({ source_ref: "2012新题型" });
    expect(output.examples[0]!.text).toContain("visionaries labour to create");
    expect(output.senses.map((sense) => [sense.pos, sense.gloss])).toContainEqual([
      "vi",
      "努力做(困难的事)",
    ]);
  });

  it("recovers an exam sentence after a numbered sense and separate source-reference block", () => {
    const output = segmentPage([
      makeBlock("show.head", 1, [0.1, 0.2, 0.48, 0.24], "show [ʃəʊ] vt. 表明"),
      makeBlock("show.sense", 1, [0.1, 0.28, 0.25, 0.31], "①vt.表明"),
      makeBlock("show.source", 1, [0.34, 0.28, 0.48, 0.31], "(2022年阅读)"),
      makeBlock("show.example", 1, [0.1, 0.32, 0.48, 0.35], "Employers must show cause. 雇主要说明原因。"),
      makeBlock("show.next-sense", 1, [0.1, 0.4, 0.25, 0.43], "②vt.表现"),
    ]);

    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]).toMatchObject({ source_ref: "2022阅读" });
    expect(output.examples[0]!.text).toContain("Employers must show cause");
    expect(output.senses[0]!.gloss).toBe("表明");
  });

  it("recovers an exam marker misread as 具 after a source-reference block", () => {
    const output = segmentPage([
      makeBlock("fatigue.head", 1, [0.56, 0.69, 0.92, 0.72], "fatigue [fəˈtiːɡ] n. 疲劳；厌倦"),
      makeBlock("fatigue.source", 1, [0.82, 0.728, 0.968, 0.745], "(2020年完形)"),
      makeBlock("fatigue.example", 1, [0.566, 0.76, 0.931, 0.78], "具 However, even though it is common,"),
      makeBlock("fatigue.tail", 1, [0.562, 0.797, 0.937, 0.82], "fatigue can make you regret words. 疲劳会让人后悔。"),
    ]);

    expect(output.senses[0]?.gloss).toBe("疲劳；厌倦");
    expect(output.examples[0]).toMatchObject({ source_ref: "2020完形" });
    expect(output.examples[0]?.text).toContain("However, even though it is common");
    expect(output.examples[0]?.text).not.toContain("具");
  });

  it("recovers an inline exam marker misread as 具 without a separate source block", () => {
    const output = segmentPage([
      makeBlock("alleviate.head", 1, [0.56, 0.69, 0.92, 0.72], "alleviate [əˈliːvieɪt] vt. 减轻"),
      makeBlock(
        "alleviate.example",
        1,
        [0.56, 0.76, 0.93, 0.78],
        "具 Toyota alleviated some damage. 丰田减轻了一些损失。",
      ),
      makeBlock("alleviate.overlap-noise", 1, [0.6, 0.755, 0.61, 0.765], "T"),
    ]);

    expect(output.senses[0]?.gloss).toBe("减轻");
    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]?.text).toContain("Toyota alleviated some damage");
    expect(output.examples[0]?.text).not.toContain("some T damage");
    expect(output.examples[0]?.text).not.toContain("具");
  });

  it("splits a note tail accidentally joined to a right-column exam marker", () => {
    const output = segmentPage([
      makeBlock("negative.head", 1, [0.1, 0.2, 0.48, 0.24], "negative [ˈneɡətɪv] adj. 负面的"),
      makeBlock(
        "negative.cross-gutter",
        1,
        [0.46, 0.3, 0.93, 0.33],
        "词后真 A negative result 一个负面结果",
      ),
    ]);

    expect(output.senses[0]?.gloss).toBe("负面的");
    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]?.text).toBe("A negative result 一个负面结果");
  });

  it("recovers phrases after an inline exam marker misread as 具", () => {
    const output = segmentPage([
      makeBlock("cultural.head", 1, [0.56, 0.69, 0.92, 0.72], "cultural [ˈkʌltʃərəl] adj. 文化的"),
      makeBlock(
        "cultural.phrases",
        1,
        [0.56, 0.76, 0.93, 0.8],
        "具 cuitural traditions 文化传统//cultural events 文化事件",
      ),
    ]);

    expect(output.senses[0]?.gloss).toBe("文化的");
    expect(output.phrases.map((phrase) => phrase.text)).toEqual([
      "cultural traditions",
      "cultural events",
    ]);
  });

  it("stops a phrase section at a headword whose opening phonetic bracket was read as a brace", () => {
    const output = segmentPage([
      makeBlock("apart.head", 1, [0.56, 0.69, 0.92, 0.72], "apart [əˈpɑːt] adv. 分离"),
      makeBlock("apart.phrase-heading", 1, [0.68, 0.75, 0.82, 0.77], "真题词组小记"),
      makeBlock("apart.marker-noise", 1, [0.68, 0.75, 0.72, 0.77], "旺"),
      makeBlock("apart.phrase", 1, [0.56, 0.78, 0.72, 0.81], "apart from 除了"),
      makeBlock("apart.phrase.2", 1, [0.56, 0.81, 0.72, 0.83], "take apart 拆开"),
      makeBlock("isolate.head", 1, [0.56, 0.84, 0.94, 0.87], "isolate {'aɪsəleɪt] vt. 使隔离"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["apart", "isolate"]);
    expect(output.phrases.map((phrase) => phrase.text)).toEqual(["apart from", "take apart"]);
    expect(output.senses.find((sense) => sense.word_key === output.words[0]?.word_key)?.gloss).toBe(
      "分离",
    );
    expect(output.senses.find((sense) => sense.word_key === output.words[1]?.word_key)?.gloss).toBe(
      "使隔离",
    );
  });

  it("recovers a headword whose opening phonetic bracket was read as lowercase l", () => {
    const output = segmentPage([
      makeBlock("paradise.head", 1, [0.1, 0.2, 0.48, 0.24], "paradise [ˈpærədaɪs] n. 天堂"),
      makeBlock("paradox.head", 1, [0.55, 0.2, 0.92, 0.24], "paradox l'pærədɒks] n. 矛盾"),
      makeBlock("paradox.example", 1, [0.55, 0.27, 0.92, 0.3], "真 face the paradox 面临矛盾"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["paradise", "paradox"]);
    expect(output.examples[0]?.word_key).toBe(output.words[1]?.word_key);
  });

  it("recovers a same-line entry whose phonetic opening bracket disappeared", () => {
    const output = segmentPage([
      makeBlock("anecdote.head", 1, [0.1, 0.2, 0.48, 0.23], "anecdote [ˈænɪkdəʊt] n. 轶事"),
      makeBlock("anecdotal.head", 1, [0.1, 0.26, 0.5, 0.29], "anecdotal ænɪkˈdəʊtl] adj. 传闻的；趣闻的"),
      makeBlock("anecdotal.example", 1, [0.1, 0.31, 0.5, 0.34], "真 anecdotal evidence 传闻中的证据"),
    ]);

    const anecdotal = output.words.find((word) => word.headword === "anecdotal")!;
    expect(anecdotal).toMatchObject({ phonetic: "[ænɪkˈdəʊtl]", ocr_confidence: 0 });
    expect(output.examples[0]?.word_key).toBe(anecdotal.word_key);
  });

  it("recovers a bare headword beside a damaged phonetic tail with a POS", () => {
    const output = segmentPage([
      makeBlock("radical.word", 1, [0.56, 0.2, 0.68, 0.23], "radical"),
      makeBlock("radical.tail", 1, [0.69, 0.2, 0.94, 0.23], "I'rædɪkl adi, 彻底的；激进的"),
      makeBlock("radical.example", 1, [0.56, 0.27, 0.94, 0.3], "真 radical change 彻底的变革"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["radical"]);
    expect(output.words[0]?.phonetic).toBe("[?]");
    expect(output.senses[0]).toMatchObject({ pos: "adj", gloss: "彻底的；激进的" });
  });

  it("recovers a bare headword whose phonetic and POS continue directly below", () => {
    const output = segmentPage([
      makeBlock("construct.word", 1, [0.22, 0.2, 0.43, 0.23], "construct"),
      makeBlock("construct.tail", 1, [0.14, 0.238, 0.54, 0.265], "[kənˈstrʌkt] vt. 建造"),
      makeBlock("construct.source-noise", 1, [0.14, 0.28, 0.25, 0.3], "直风连道"),
      makeBlock("construct.source", 1, [0.35, 0.28, 0.53, 0.3], "(2018年阅读)"),
      makeBlock("construct.example", 1, [0.14, 0.31, 0.54, 0.34], "真 offices were constructed 办公楼被建造"),
      makeBlock("construct.alt", 1, [0.56, 0.24, 0.88, 0.27], "思[kɒnstrʌkt] n. 构想；建筑物"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["construct"]);
    expect(output.senses.map((sense) => [sense.pos, sense.gloss])).toEqual([
      ["vt", "建造"],
      ["n", "构想；建筑物"],
    ]);
    expect(output.examples[0]?.word_key).toBe(output.words[0]?.word_key);
  });

  it("recovers a split headword when OCR leaves a dangling opening bracket on the word", () => {
    const output = segmentPage([
      makeBlock("emigration.head", 1, [0.1, 0.2, 0.45, 0.23], "emigration [ˌemɪˈɡreɪʃn] n. 移民"),
      makeBlock("mixture.word", 1, [0.1, 0.3, 0.22, 0.33], "mixture["),
      makeBlock("mixture.tail", 1, [0.21, 0.3, 0.48, 0.33], "[ˈmɪkstʃə(r)] n. 混合；混合物"),
      makeBlock("mixture.phrase", 1, [0.14, 0.35, 0.48, 0.38], "a mixture of skepticism and optimism 怀疑"),
      makeBlock("mixture.phrase-tail", 1, [0.11, 0.382, 0.35, 0.405], "和乐观交织在一起"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["emigration", "mixture"]);
    const mixture = output.words[1]!;
    expect(output.senses.find((sense) => sense.word_key === mixture.word_key)?.gloss).toBe(
      "混合；混合物",
    );
    expect(output.phrases.find((phrase) => phrase.word_key === mixture.word_key)?.text).toBe(
      "a mixture of skepticism and optimism",
    );
    expect(output.phrases.find((phrase) => phrase.word_key === mixture.word_key)?.gloss).toBe(
      "怀疑和乐观交织在一起",
    );
  });

  it("prefers the real same-line phonetic over a closer POS continuation below", () => {
    const output = segmentPage([
      makeBlock("patchwork.word", 1, [0.52, 0.62, 0.68, 0.64], "patchwork"),
      makeBlock("patchwork.phonetic", 1, [0.7, 0.62, 0.9, 0.64], "[ˈpætˌwɜːk] adj. 拼凑"),
      makeBlock("patchwork.tail", 1, [0.52, 0.642, 0.66, 0.66], "的 n. 拼凑之物"),
    ]);

    expect(output.words[0]).toMatchObject({ headword: "patchwork", phonetic: "[ˈpætˌwɜːk]" });
    expect(output.senses.map((sense) => [sense.pos, sense.gloss])).toEqual([
      ["adj", "拼凑的"],
      ["n", "拼凑之物"],
    ]);
  });

  it("recovers a visually gated word when OCR drops its headword but its examples repeat it", () => {
    const output = segmentPage([
      makeBlock("astronomical.head", 1, [0.1, 0.02, 0.48, 0.05], "astronomical [ˌæstrəˈnɒmɪkl] adj. 天文的"),
      makeBlock("atmosphere.phonetic-fragment", 1, [0.3, 0.07, 0.53, 0.09], "[ætməsfɪə(r)-"),
      makeBlock("atmosphere.gloss", 1, [0.1, 0.094, 0.29, 0.113], "气层；气氛；空气"),
      makeBlock("atmosphere.sense.1", 1, [0.1, 0.12, 0.23, 0.14], "① n. 大气层"),
      makeBlock("atmosphere.example.1", 1, [0.1, 0.15, 0.45, 0.17], "真 dense atmosphere 浓厚的大气层"),
      makeBlock("atmosphere.sense.2", 1, [0.1, 0.18, 0.23, 0.2], "② n. 气氛"),
      makeBlock("atmosphere.example.2", 1, [0.1, 0.21, 0.9, 0.24], "真 an atmosphere of intellectual earnestness 热衷学术的氛围"),
      makeBlock("space.word", 1, [0.55, 0.27, 0.65, 0.29], "space"),
      makeBlock("space.tail", 1, [0.66, 0.27, 0.92, 0.29], "[speɪs] n. 空间"),
    ]);

    const atmosphere = output.words.find((word) => word.headword === "atmosphere")!;
    expect(atmosphere).toMatchObject({ phonetic: "[?]", ocr_confidence: 0 });
    expect(output.senses.find((sense) => sense.word_key === atmosphere.word_key)?.gloss).toBe(
      "大气层；气氛；空气",
    );
    expect(output.examples.filter((example) => example.word_key === atmosphere.word_key)).toHaveLength(2);
    expect(
      output.fieldReviews.filter((review) => review.word_key === atmosphere.word_key).map((review) => review.field),
    ).toEqual(["headword", "phonetic"]);
  });

  it("does not recover a fused sentence fragment as a missing headword", () => {
    const output = segmentPage([
      makeBlock("known.head", 1, [0.1, 0.02, 0.48, 0.05], "known [nəʊn] adj. 已知的"),
      makeBlock("damaged.phonetic", 1, [0.3, 0.07, 0.53, 0.09], "[dæmɪdʒd-"),
      makeBlock("damaged.gloss", 1, [0.1, 0.094, 0.29, 0.113], "错误恢复"),
      makeBlock("damaged.sense", 1, [0.1, 0.12, 0.4, 0.14], "① n. 错误恢复"),
      makeBlock("damaged.example.1", 1, [0.1, 0.15, 0.48, 0.17], "真 willneedtobeconstantlyupskilling workers"),
      makeBlock("damaged.example.2", 1, [0.1, 0.18, 0.48, 0.2], "真 willneedtobeconstantlyupskilling employees"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["known"]);
  });

  it("recovers a short headword when its ASCII phonetic and inflected example agree", () => {
    const output = segmentPage([
      makeBlock("vague.head", 1, [0.05, 0.12, 0.44, 0.15], "vague [veɪɡ] adj. 含糊的"),
      makeBlock("dim.missing-head", 1, [0.12, 0.224, 0.445, 0.242], "[dim] adj. 迟钝的；昏暗的；模糊的"),
      makeBlock("dim.sense", 1, [0.04, 0.275, 0.162, 0.293], "v.（使）减弱"),
      makeBlock(
        "dim.example",
        1,
        [0.04, 0.3, 0.445, 0.38],
        "真 Not all people see their life chances dimmed. 并非所有人都认为前景暗淡。",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["vague", "dim"]);
    expect(output.examples[0]?.word_key).toBe(output.words[1]?.word_key);
    expect(output.fieldReviews.some((review) => review.word_key === output.words[1]?.word_key)).toBe(true);
  });

  it("recovers an ASCII-phonetic headword when the exam marker is a separate OCR block", () => {
    const output = segmentPage([
      makeBlock("vague.head", 1, [0.05, 0.12, 0.44, 0.15], "vague [veɪɡ] adj. 含糊的"),
      makeBlock("dim.missing-head", 1, [0.12, 0.224, 0.445, 0.242], "[dim] adj. 迟钝的；昏暗的；模糊的"),
      makeBlock("dim.source", 1, [0.3, 0.275, 0.445, 0.292], "(2012年阅读)"),
      makeBlock("dim.marker", 1, [0.04, 0.3, 0.07, 0.314], "真"),
      makeBlock("dim.example", 1, [0.077, 0.3, 0.447, 0.335], "Not all people see"),
      makeBlock("dim.example.tail", 1, [0.04, 0.342, 0.447, 0.379], "their life chances dimmed. 前景暗淡。"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["vague", "dim"]);
    expect(output.examples[0]?.word_key).toBe(output.words[1]?.word_key);
    expect(output.examples[0]?.text).toContain("dimmed");
  });

  it("does not promote a same-line word inside an exam sentence to a duplicate headword", () => {
    const output = segmentPage([
      makeBlock("withdraw.head", 1, [0.12, 0.42, 0.49, 0.45], "withdraw [wɪðˈdrɔː] vt. 撤回"),
      makeBlock("withdraw.marker", 1, [0.116, 0.546, 0.14, 0.56], "真"),
      makeBlock("withdraw.ex.1", 1, [0.145, 0.546, 0.254, 0.56], "Entergy will"),
      makeBlock("withdraw.ex.2", 1, [0.254, 0.547, 0.346, 0.56], "withdraw"),
      makeBlock("withdraw.ex.3", 1, [0.345, 0.545, 0.522, 0.56], "its application. 安特吉公司将会撤回其申请。"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["withdraw"]);
    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]?.text).toContain("Entergy will withdraw its application");
  });

  it("restores the source-verified quit entry when OCR fuses it with its example", () => {
    const page = 335;
    const output = segmentStructure(
      assignReadingOrder([
        makeBlock("chapter", page, [0.1, 0.02, 0.3, 0.05], "Chapter 1"),
        makeBlock("unit", page, [0.1, 0.12, 0.3, 0.15], "Unit 1"),
        makeBlock("dismiss.head", page, [0.1, 0.2, 0.48, 0.24], "dismiss [dɪsˈmɪs] vt. 解雇"),
        makeBlock("quit.fused", page, [0.08, 0.27, 0.85, 0.31], "真 quit a quit a seniorposition从高级职位离职"),
      ]),
      normalizeConfig(),
      [],
    );

    expect(output.words.map((word) => word.headword)).toEqual(["dismiss", "quit"]);
    const quit = output.words[1]!;
    expect(output.senses.find((sense) => sense.word_key === quit.word_key)?.gloss).toContain("离开");
    expect(output.examples.find((example) => example.word_key === quit.word_key)?.text).toBe(
      "quit a senior position 从高级职位离职",
    );
  });

  it("restores the source-verified biological header from its fused phonetic", () => {
    const page = 307;
    const output = segmentStructure(
      assignReadingOrder([
        makeBlock("chapter", page, [0.1, 0.02, 0.3, 0.05], "Chapter 1"),
        makeBlock("unit", page, [0.1, 0.12, 0.3, 0.15], "Unit 1"),
        makeBlock("biological.bad-head", page, [0.149, 0.227, 0.535, 0.257], "biologicalbarlikl]"),
        makeBlock("biological.sense", page, [0.061, 0.267, 0.427, 0.286], "adj. 与生命过程有关的；生物学的"),
        makeBlock("biological.example", page, [0.047, 0.339, 0.449, 0.398], "真 social and biological factors 社会和生理因素"),
      ]),
      normalizeConfig(),
      [],
    );

    expect(output.words.map((word) => word.headword)).toEqual(["biological"]);
    expect(output.examples[0]?.word_key).toBe(output.words[0]?.word_key);
  });

  it("restores hint when the original page OCR clips its printed headword to int", () => {
    const page = 315;
    const output = segmentStructure(
      assignReadingOrder([
        makeBlock("chapter", page, [0.1, 0.02, 0.3, 0.05], "Chapter 1"),
        makeBlock("unit", page, [0.1, 0.12, 0.3, 0.15], "Unit 1"),
        makeBlock("hint.clipped", page, [0.49, 0.864866, 0.554857, 0.896922], "int"),
        makeBlock("hint.phonetic", page, [0.542857, 0.870866, 0.865546, 0.890922], "[hint] v.(~at)暗示；示意n.暗示;"),
        makeBlock("hint.gloss", page, [0.454902, 0.886348, 0.611204, 0.920479], "征兆；窍门"),
      ]),
      normalizeConfig(),
      [],
    );
    expect(output.words.some((word) => word.headword === "hint")).toBe(true);
    expect(output.words.some((word) => word.headword === "int")).toBe(false);
  });

  it("assigns a cross-column example to the recent word named in its text", () => {
    const output = segmentPage([
      makeBlock("geographical.head", 1, [0.1, 0.2, 0.45, 0.23], "geographical [ˌdʒiːəˈɡræfɪkl] adj. 地理的"),
      makeBlock("irritate.head", 1, [0.55, 0.25, 0.92, 0.28], "irritate [ˈɪrɪteɪt] vt. 激怒"),
      makeBlock("geographical.example", 1, [0.1, 0.3, 0.45, 0.33], "真 geographical features 地理特征"),
      makeBlock("tissue.head", 1, [0.55, 0.35, 0.92, 0.38], "tissue [ˈtɪʃuː] n. 组织"),
      makeBlock("irritate.example", 1, [0.55, 0.4, 0.92, 0.43], "真 irritate owners 激怒业主"),
    ]);

    const geographical = output.words.find((word) => word.headword === "geographical")!;
    const irritate = output.words.find((word) => word.headword === "irritate")!;
    expect(output.examples.map((example) => [example.word_key, example.text])).toEqual([
      [geographical.word_key, "geographical features 地理特征"],
      [irritate.word_key, "irritate owners 激怒业主"],
    ]);
  });

  it("reassigns an example to a matching word parsed later on the same page", () => {
    const output = segmentPage([
      makeBlock("expire.head", 1, [0.1, 0.2, 0.45, 0.23], "expire [ɪkˈspaɪə(r)] vi. 到期"),
      makeBlock("sip.example", 1, [0.1, 0.27, 0.45, 0.3], "真 sip bottled water 喝瓶装水"),
      makeBlock("sip.head", 1, [0.55, 0.2, 0.9, 0.23], "sip [sɪp] v. 小口喝"),
    ]);

    const sip = output.words.find((word) => word.headword === "sip")!;
    expect(output.examples).toHaveLength(1);
    expect(output.examples[0]).toMatchObject({
      word_key: sip.word_key,
      example_key: `ex.${sip.word_key}.1`,
      source_order: 1,
    });
  });

  it("repairs a one-letter OCR omission in an example from its assigned headword", () => {
    const output = segmentPage([
      makeBlock("flexibly.head", 1, [0.1, 0.2, 0.5, 0.23], "flexibly [ˈfleksəbli] adv. 灵活地"),
      makeBlock("flexibly.example", 1, [0.1, 0.27, 0.5, 0.3], "真 beimplementedfexibly 被灵活地执行"),
    ]);

    expect(output.examples[0]?.text).toBe("beimplementedflexibly 被灵活地执行");
    expect(findContentOwnershipFindings(output)).toEqual([]);
  });

  it("repairs a short OCR transposition or clipped ending in an assigned example", () => {
    const output = segmentPage([
      makeBlock("search.head", 1, [0.1, 0.2, 0.48, 0.23], "search [sɜːtʃ] n. 搜索"),
      makeBlock("search.example", 1, [0.1, 0.25, 0.48, 0.28], "真 a cursory soareh 粗略调查"),
      makeBlock("survive.head", 1, [0.55, 0.3, 0.92, 0.33], "survive [səˈvaɪv] v. 经受住"),
      makeBlock("survive.example", 1, [0.55, 0.35, 0.92, 0.38], "真 claims will survi challenges 主张将经受住挑战"),
    ]);

    expect(output.examples.map((example) => example.text)).toEqual([
      "a cursory search 粗略调查",
      "claims will survive challenges 主张将经受住挑战",
    ]);
    expect(findContentOwnershipFindings(output)).toEqual([]);
  });

  it("recovers an exam badge missed directly below its matching headword", () => {
    const output = segmentPage([
      makeBlock("earnestness.head", 1, [0.1, 0.2, 0.5, 0.23], "earnestness [ˈɜːnɪstnəs] n. 认真"),
      makeBlock("earnestness.example", 1, [0.1, 0.25, 0.5, 0.28], "an atmosphere of intellectual earnestness 认"),
      makeBlock("earnestness.example.tail", 1, [0.1, 0.282, 0.4, 0.31], "真的学术氛围号：神灯考研"),
    ]);

    expect(output.phrases).toHaveLength(0);
    expect(output.examples[0]?.text).toBe(
      "an atmosphere of intellectual earnestness 认真的学术氛围",
    );
    expect(findContentOwnershipFindings(output)).toEqual([]);
  });

  it("recovers a visually gated headword from a short exam example and damaged POS row", () => {
    const output = segmentPage([
      makeBlock("hurriedly.head", 1, [0.1, 0.2, 0.45, 0.23], "hurriedly [ˈhʌrɪdli] adv. 匆忙地"),
      makeBlock("intrinsically.damaged-pos", 1, [0.55, 0.25, 0.92, 0.28], "[ɪnˈtrɪnzɪkliadv本质地；内"),
      makeBlock("intrinsically.damaged-head", 1, [0.55, 0.28, 0.85, 0.31], "trTnsicany trtrrnzrk"),
      makeBlock("intrinsically.gloss-tail", 1, [0.55, 0.312, 0.85, 0.34], "在地；固有地"),
      makeBlock("intrinsically.marker", 1, [0.55, 0.36, 0.58, 0.39], "真"),
      makeBlock("intrinsically.example", 1, [0.59, 0.36, 0.9, 0.39], "intrinsically bad 本质上不好"),
    ]);

    const intrinsically = output.words.find((word) => word.headword === "intrinsically")!;
    expect(intrinsically).toMatchObject({ phonetic: "[?]", ocr_confidence: 0 });
    expect(output.senses.find((sense) => sense.word_key === intrinsically.word_key)).toMatchObject({
      pos: "adv",
      gloss: "本质地；内在地；固有地",
    });
    expect(output.examples[0]?.word_key).toBe(intrinsically.word_key);
    expect(
      output.fieldReviews.filter((review) => review.word_key === intrinsically.word_key).map((review) => review.field),
    ).toEqual(["headword", "phonetic"]);
  });

  it("recovers a damaged headword across an interleaved opposite-column entry", () => {
    const output = segmentStructure([
      makeBlock("chapter", 1, [0.1, 0.06, 0.3, 0.09], "Chapter 1"),
      makeBlock("unit", 1, [0.08, 0.1, 0.9, 0.14], "Unit 1"),
      makeBlock("unstoppable.head", 1, [0.1, 0.8, 0.48, 0.83], "unstoppable [ʌnˈstɒpəbl] adj. 无法遏止的"),
      makeBlock("dampen.damaged-pos", 1, [0.671412, 0.865987, 0.906036, 0.874428], "['demnanlvt 抑制：弄湿"),
      makeBlock("dampen.damaged-head", 1, [0.568907, 0.866338, 0.910023, 0.88287], "dampen[uunpon nn.pp，开"),
      makeBlock("federation.head", 1, [0.113895, 0.868449, 0.534169, 0.885332], "federation [ˌfedəˈreɪʃn] n. 联盟；联邦；联"),
      makeBlock("federation.tail", 1, [0.112, 0.885, 0.165, 0.908], "合会"),
      makeBlock("promo", 1, [0.16, 0.895, 0.36, 0.911], "微信公众"),
      makeBlock("dampen.example", 1, [0.570615, 0.886388, 0.922551, 0.900809], "真dampen our moods 抑制我们的情绪"),
    ], normalizeConfig(), []);

    const dampen = output.words.find((word) => word.headword === "dampen")!;
    expect(dampen).toMatchObject({ phonetic: "[?]", ocr_confidence: 0 });
    expect(output.senses.find((sense) => sense.word_key === dampen.word_key)).toMatchObject({
      pos: "vt",
      gloss: "抑制：弄湿",
    });
    expect(output.examples[0]).toMatchObject({ word_key: dampen.word_key });
    expect(output.examples[0]?.text).toBe("dampen our moods 抑制我们的情绪");
  });

  it("does not invent a headword from an example when nearby damaged OCR does not support it", () => {
    const output = segmentPage([
      makeBlock("known.head", 1, [0.1, 0.2, 0.45, 0.23], "known [nəʊn] adj. 已知的"),
      makeBlock("damaged.pos", 1, [0.55, 0.25, 0.92, 0.28], "n. 错误恢复"),
      makeBlock("damaged.marker", 1, [0.55, 0.31, 0.58, 0.34], "真"),
      makeBlock("damaged.example", 1, [0.59, 0.31, 0.9, 0.34], "enoughofthe workers 足够的工人"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["known"]);
  });

  it("does not turn a possessive exam-sentence fragment into a headword", () => {
    const output = segmentPage([
      makeBlock("fame.head", 1, [0.1, 0.2, 0.45, 0.23], "fame [feɪm] n. 名誉"),
      makeBlock("damaged.pos", 1, [0.1, 0.25, 0.45, 0.28], "fameofallen's n. 名声"),
      makeBlock("damaged.marker", 1, [0.1, 0.31, 0.13, 0.34], "真"),
      makeBlock("damaged.example", 1, [0.13, 0.31, 0.45, 0.34], "fameofallen's book 名声"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["fame"]);
  });

  it("keeps the -ize spelling under an existing -ise/-ize entry", () => {
    const output = segmentPage([
      makeBlock("visualise.head", 1, [0.55, 0.2, 0.92, 0.23], "visualise/-ize [ˈvɪʒuəlaɪz] vt. 设想"),
      makeBlock("visualise.damaged", 1, [0.55, 0.24, 0.92, 0.25], "visualize vt.设想"),
      makeBlock("visualise.marker", 1, [0.55, 0.26, 0.58, 0.29], "真"),
      makeBlock("visualise.example", 1, [0.59, 0.26, 0.92, 0.29], "Visualize your future. 设想未来。"),
    ]);
    expect(output.words.map((word) => word.headword)).toEqual(["visualise/-ize"]);
    expect(output.examples[0]?.word_key).toBe(output.words[0]?.word_key);
  });

  it("does not reassign a broad example to the unrelated word abroad", () => {
    const output = segmentPage([
      makeBlock("broad.head", 1, [0.1, 0.2, 0.45, 0.23], "broad [brɔːd] adj. 广泛的"),
      makeBlock("abroad.head", 1, [0.1, 0.24, 0.45, 0.27], "abroad [əˈbrɔːd] adv. 在国外"),
      makeBlock("broad.marker", 1, [0.1, 0.3, 0.13, 0.33], "真"),
      makeBlock("broad.example", 1, [0.13, 0.3, 0.45, 0.33], "A broad range of choices exists. 选择广泛。"),
    ]);
    expect(output.examples[0]?.word_key).toBe(output.words.find((w) => w.headword === "broad")?.word_key);
  });

  it("joins the visually verified favorable sentence across page 95 columns", () => {
    const output = segmentPage([
      makeBlock("favorable.head", 95, [0.09, 0.72, 0.47, 0.75], "favo(u)rable ['feɪvərəbl] adj. 赞同的"),
      makeBlock("favorable.marker", 95, [0.09, 0.809, 0.115, 0.823], "真"),
      makeBlock("favorable.example", 95, [0.12, 0.807, 0.473, 0.823], "Forthemost part,theresponse hasbee"),
      makeBlock("favorable.tail", 95, [0.505, 0.21, 0.892, 0.228], "favorable,to say the least.至少可以说，大部"),
      makeBlock("favorable.tail2", 95, [0.507, 0.232, 0.715, 0.248], "分人的反应都是赞同的。"),
    ]);
    const favorable = output.words.find((w) => w.headword === "favo(u)rable")!;
    expect(output.examples.filter((e) => e.word_key === favorable.word_key).map((e) => e.text)).toEqual([
      "For the most part, the response has been favorable, to say the least. 至少可以说，大部分人的反应都是赞同的。",
    ]);
    expect(output.phrases).toEqual([]);
  });

  it("uses the printed world works wording for Unit 1 work", () => {
    const output = segmentPage([
      makeBlock("work.head", 16, [0.1, 0.2, 0.45, 0.23], "work [wɜːk] v. 工作"),
      makeBlock("work.marker", 16, [0.1, 0.26, 0.13, 0.29], "真"),
      makeBlock("work.example", 16, [0.13, 0.26, 0.45, 0.29], "Gates chooses nonfiction titles because they explain how the worked works. 盖茨选择非虚构类图书。"),
    ]);
    expect(output.examples[0]?.text).toContain("how the world works.");
  });

  it("recovers the original-page insure entry and assigns its next-page example", () => {
    const output = segmentStructure(assignReadingOrder([
      makeBlock("chapter", 170, [0.1, 0.04, 0.3, 0.06], "Chapter 1"),
      makeBlock("unit", 170, [0.08, 0.06, 0.9, 0.1], "Unit 1"),
      makeBlock("sure.head", 170, [0.1, 0.56, 0.48, 0.6], "sure [ʃʊə(r)] adj. 确信的"),
      makeBlock("insure.word", 170, [0.533476, 0.840564, 0.918586, 0.867372], "insure 承保；确保"),
      makeBlock("insure.meta", 170, [0.65399, 0.847972, 0.914837, 0.864903], "[in'ʃuə(r)] vt.承保；确保"),
      makeBlock("insure.gloss", 170, [0.524371, 0.871252, 0.590787, 0.885362], "v.投保"),
      makeBlock("insure.sense", 171, [0.09, 0.08, 0.48, 0.11], "vt.确保"),
      makeBlock("insure.marker", 171, [0.09, 0.13, 0.12, 0.16], "真"),
      makeBlock("insure.example", 171, [0.12, 0.13, 0.48, 0.22], "Almost all of the interior detail is of cast iron or plaster; the use of wood was minimized to insure fire safety. 确保消防安全。"),
    ]), normalizeConfig(), []);
    const insure = output.words.find((w) => w.headword === "insure")!;
    expect(insure).toBeDefined();
    expect(output.examples.find((e) => e.text.includes("insure fire safety"))?.word_key).toBe(insure.word_key);
  });

  it("recovers the favorable sentence when OCR orders the right-column tail first", () => {
    const output = segmentPage([
      makeBlock("favorable.head", 95, [0.09, 0.72, 0.47, 0.75], "favo(u)rable ['feɪvərəbl] adj. 赞同的"),
      makeBlock("favorable.tail", 95, [0.505, 0.21, 0.892, 0.228], "favorable,to say the least.至少可以说，大部"),
      makeBlock("favorable.tail2", 95, [0.507, 0.232, 0.715, 0.248], "分人的反应都是赞同的。"),
      makeBlock("favorable.marker", 95, [0.09, 0.809, 0.115, 0.823], "真"),
      makeBlock("favorable.example", 95, [0.12, 0.807, 0.473, 0.823], "Forthemost part,theresponse hasbee"),
    ]);
    expect(output.examples.map((e) => e.text)).toEqual([
      "For the most part, the response has been favorable, to say the least. 至少可以说，大部分人的反应都是赞同的。",
    ]);
    expect(output.phrases).toEqual([]);
  });

  it("applies a source-verified repair to the deference example", () => {
    const output = segmentPage([
      makeBlock("deference.head", 1, [0.1, 0.8, 0.48, 0.83], "deference [ˈdefərəns] n. 尊敬"),
      makeBlock("deference.example", 1, [0.1, 0.86, 0.48, 0.89], "真 absence ofdern 113"),
    ]);

    expect(output.examples[0]?.text).toBe("absence of deference 缺乏尊重");
    expect(findContentOwnershipFindings(output)).toEqual([]);
  });

  it("applies source-verified repairs to damaged exam sentences and credibility", () => {
    const output = segmentPage([
      makeBlock("end.head", 1, [0.1, 0.2, 0.48, 0.23], "end [end] v. 结束"),
      makeBlock(
        "end.example",
        1,
        [0.1, 0.24, 0.48, 0.27],
        "真 anlyishoenn contentedness among those who may believe English is stable. 因此他的分析应该终结自满。",
      ),
      makeBlock("credibility.head", 1, [0.1, 0.3, 0.48, 0.33], "credtbitfty [,kredə'biləti] n. 可信性"),
      makeBlock(
        "credibility.example",
        1,
        [0.1, 0.34, 0.48, 0.37],
        "真 It may be the credibility of their team. 可能是团队的可信性。",
      ),
      makeBlock("concerned.head", 1, [0.1, 0.4, 0.48, 0.43], "concerned [kənˈsɜːnd] adj. 关注的"),
      makeBlock(
        "concerned.example",
        1,
        [0.1, 0.44, 0.48, 0.47],
        "真 He was not interested in daily politics, but 的精神家",
      ),
      makeBlock("grasp.head", 1, [0.1, 0.5, 0.48, 0.53], "grasp [ɡrɑːsp] vt. 抓住"),
      makeBlock(
        "grasp.example",
        1,
        [0.1, 0.54, 0.48, 0.57],
        "真 This is a shame—the community shouldbe giaspirgtle opportunrty to Taise Tts hiifuenee in the real world. 这是令人惋惜的。",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual([
      "end",
      "credibility",
      "concerned",
      "grasp",
    ]);
    expect(output.examples.map((example) => example.text)).toEqual([
      "His analysis should therefore end any self-contentedness among those who may believe English is stable. 因此他的分析应该终结自满。",
      "It may be the credibility of their team. 可能是团队的可信性。",
      "He was not interested in daily politics, but concerned with questions of moral behavior and the larger questions of right and wrong affecting the entire society. 他对日常政治不感兴趣，但关注道德行为问题以及影响全社会的更大的是非问题。",
      "This is a shame—the community should be grasping the opportunity to raise its influence in the real world. 这是令人惋惜的——这一群体（指社会科学家）应该抓住这次机会来提高自身在真实世界中的影响力。",
    ]);
    expect(findContentOwnershipFindings(output)).toEqual([]);
  });

  it("restores the source-verified place summary and cross-column example", () => {
    const output = segmentPage([
      makeBlock(
        "place.head",
        1,
        [0.12, 0.68, 0.49, 0.735],
        "place [plers] n.地方；表面的某处；尤指占用或",
      ),
      makeBlock(
        "place.example",
        1,
        [0.11, 0.81, 0.49, 0.87],
        '真 Quotas get action: they "open the way to equality and they break through the g lass ceiling,” according to Reding,a result see nin 人)处于某位置；以某种态度对待(或',
      ),
    ]);

    expect(output.senses.map((sense) => [sense.pos, sense.gloss])).toEqual([
      [
        "n",
        "地方；表面的某处；（尤指占用或空着的）座位；（速度比赛或竞赛获胜者的）名次",
      ],
      [
        "vt",
        "（小心或有意）放置；使（人）处于某位置；以某种态度对待（或看待）；下赌注；获名次",
      ],
    ]);
    expect(output.examples[0]?.text).toContain("provisions on placing women");
    expect(findContentOwnershipFindings(output)).toEqual([]);
  });

  it("does not turn a joined sentence continuation into a cross-column headword", () => {
    const output = segmentPage([
      makeBlock("inquire.head", 1, [0.11, 0.07, 0.49, 0.11], "inquire/enquire [ɪnˈkwaɪə(r)] vt. 询问；探究"),
      makeBlock("inquire.marker", 1, [0.11, 0.19, 0.135, 0.205], "真"),
      makeBlock("inquire.example.1", 1, [0.138, 0.192, 0.492, 0.207], "One of the astonishing revelations was how"),
      makeBlock("inquire.example.2", 1, [0.108, 0.212, 0.49, 0.226], "littleRebekahBrooksknewofwhatwentonin"),
      makeBlock("opposite.sense", 1, [0.525, 0.213, 0.617, 0.231], "①n.问题"),
      makeBlock("inquire.example.3", 1, [0.107, 0.234, 0.491, 0.248], "her newsroom, how little she thought to ask and"),
      makeBlock("inquire.example.4", 1, [0.108, 0.255, 0.491, 0.269], "the fact that she never inquired how the stories arrived. 她从不询问来源。"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["inquire/enquire"]);
    expect(output.examples[0]?.text).toContain("never inquired");
    expect(findContentOwnershipFindings(output)).toEqual([]);
  });

  it("does not turn a two-letter line-end fragment into a split headword", () => {
    const output = segmentPage([
      makeBlock("view.head", 1, [0.1, 0.2, 0.48, 0.23], "view [vjuː] n. 方法"),
      makeBlock("view.marker", 1, [0.1, 0.26, 0.13, 0.28], "真"),
      makeBlock("view.example.1", 1, [0.14, 0.26, 0.48, 0.28], "Before each revelation thinkers sustained more ancie"),
      makeBlock("view.example.fragment", 1, [0.46, 0.282, 0.48, 0.3], "nt"),
      makeBlock("opposite.meta", 1, [0.52, 0.282, 0.8, 0.3], "[ˈɪntəvjuːə(r)] n. 面试者"),
      makeBlock("view.example.2", 1, [0.1, 0.304, 0.48, 0.33], "ways of thinking including the view 思维方式包括观点"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["view"]);
    expect(output.examples[0]?.text).toContain("ways of thinking");
  });

  it("does not infer a headword from a numbered sense or Chinese continuation", () => {
    const output = segmentPage([
      makeBlock("work.head", 1, [0.1, 0.2, 0.48, 0.23], "work [wɜːk] vi. 工作"),
      makeBlock("work.sense", 1, [0.1, 0.26, 0.3, 0.29], "①vi. 产生…作用"),
      makeBlock("work.example", 1, [0.1, 0.31, 0.48, 0.34], "真 Travelona Londonbusand you'llquickly"),
      makeBlock("work.example.tail", 1, [0.1, 0.342, 0.48, 0.37], "see how this works with drivers 公交车上的作用"),
      makeBlock("labour.head", 1, [0.55, 0.4, 0.92, 0.43], "labo(u)r [ˈleɪbə(r)] n. 劳动"),
      makeBlock("labour.tail", 1, [0.55, 0.44, 0.92, 0.47], "劳工；英国工党 vi. 努力做"),
      makeBlock("labour.example", 1, [0.55, 0.49, 0.92, 0.52], "真 cmulauor里⊥/faoorⅢmarket另动刀巾场"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["work", "labo(u)r"]);
  });

  it("drops page labels and damaged phrase headings captured after an exam badge", () => {
    const output = segmentPage([
      makeBlock("work.head", 1, [0.1, 0.2, 0.48, 0.23], "work [wɜːk] n. 工作"),
      makeBlock("noise.unit", 1, [0.1, 0.26, 0.48, 0.29], "真 Unit"),
      makeBlock("noise.code", 1, [0.1, 0.31, 0.48, 0.34], "真 E01S0"),
      makeBlock("noise.heading", 1, [0.1, 0.36, 0.48, 0.39], "真 题词组小记家园"),
    ]);

    expect(output.examples).toEqual([]);
  });

  it("applies source-verified repairs to the Unit 1 work example and labor phrases", () => {
    const output = segmentPage([
      makeBlock("work.head", 1, [0.1, 0.2, 0.48, 0.23], "work [wɜːk] vi. 工作；产生…作用；争取 v. (使)"),
      makeBlock("work.tail", 1, [0.1, 0.235, 0.48, 0.255], "转n. 工作；工作成果；作品"),
      makeBlock("work.example", 1, [0.1, 0.28, 0.48, 0.31], "真 Travelona Londonbusand you'llquickly see how this works withdrivers.搭乘一辆伦敦的公交车出行，你很快就会看到这种原理如何在公交车司机们的身上起作用。"),
      makeBlock("labour.head", 1, [0.55, 0.4, 0.92, 0.43], "labo(u)r [ˈleɪbə(r)] n. 劳动；(统称)"),
      makeBlock("labour.tail", 1, [0.55, 0.44, 0.92, 0.47], "微劳工；[L-]英国工党 vi. 努力做(困难的事)"),
      makeBlock("labour.phrases", 1, [0.55, 0.49, 0.92, 0.52], "真 cmulauor里⊥/faoorⅢmarket另动刀巾场//laborshortage劳动力短缺"),
    ]);

    expect(output.examples[0]?.text).toBe(
      "Travel on a London bus and you'll quickly see how this works with drivers. 搭乘一辆伦敦的公交车出行，你很快就会看到这种原理如何在公交车司机们的身上起作用。",
    );
    expect(output.senses.find((sense) => sense.word_key === output.words[0]?.word_key && sense.pos === "v")?.gloss).toBe("(使)运转");
    expect(output.senses.find((sense) => sense.word_key === output.words[1]?.word_key && sense.pos === "n")?.gloss).toBe("劳动；(统称)劳工；[L-]英国工党");
    expect(output.phrases.map((phrase) => [phrase.text, phrase.gloss])).toEqual([
      ["child labor", "童工"],
      ["labor market", "劳动力市场"],
      ["labor shortage", "劳动力短缺"],
    ]);
  });

  it("recovers a numbered entry whose decorative phonetic was malformed", () => {
    const output = segmentPage([
      makeBlock("badge", 1, [0.11, 0.1, 0.18, 0.13], "019"),
      makeBlock("government.bad-head", 1, [0.2, 0.11, 0.6, 0.14], "governmentI'gavar Aeenments"),
      makeBlock("government.summary", 1, [0.12, 0.15, 0.4, 0.18], "n. 政府；治理"),
      makeBlock("government.marker", 1, [0.1, 0.22, 0.13, 0.25], "真"),
      makeBlock("government.example", 1, [0.14, 0.22, 0.48, 0.25], "the government changed 政府换届"),
      makeBlock("governmental.head", 1, [0.1, 0.3, 0.48, 0.34], "governmental [ˌgʌvnˈmentl] adj. 政府的"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["government", "governmental"]);
    expect(output.words[0]!.phonetic).toBe("[?]");
    expect(output.examples[0]).toMatchObject({ word_key: output.words[0]!.word_key });
    expect(output.fieldReviews.filter((review) => review.word_key === output.words[0]!.word_key)).toHaveLength(2);
  });

  it("keeps a real split phonetic on a numbered entry instead of replacing it with a placeholder", () => {
    const output = segmentPage([
      makeBlock("badge", 1, [0.12, 0.48, 0.18, 0.51], "002"),
      makeBlock("state.word", 1, [0.21, 0.495, 0.31, 0.515], "state", 0.998),
      makeBlock("state.phonetic", 1, [0.32, 0.496, 0.39, 0.515], "[steit]", 0.926),
      makeBlock("state.summary", 1, [0.12, 0.527, 0.49, 0.554], "n. 状态；国家；州；政府", 0.969),
      makeBlock("state.example", 1, [0.12, 0.61, 0.49, 0.64], "真 in a shocking state 状况极其糟糕"),
    ]);

    expect(output.words[0]).toMatchObject({ headword: "state", phonetic: "[steit]" });
    expect(output.fieldReviews.filter((review) => review.word_key === output.words[0]!.word_key)).toEqual([]);
  });

  it("does not invent an example token as a headword for a split sense of the preceding word", () => {
    const output = segmentPage([
      makeBlock("misuse.head", 1, [0.53, 0.35, 0.92, 0.384], "misuse [mis'ju:s] n. 误用；滥用"),
      makeBlock("misuse.verb", 1, [0.52, 0.376, 0.82, 0.407], "[mis'ju:z] vt. 误用；滥用"),
      makeBlock("misuse.sense", 1, [0.52, 0.411, 0.59, 0.43], "n. 误用"),
      makeBlock("marker", 1, [0.52, 0.435, 0.55, 0.454], "真"),
      makeBlock(
        "misuse.example",
        1,
        [0.557, 0.438, 0.91, 0.453],
        "Relying on ethical persuasion rather than",
      ),
      makeBlock("misuse.example.2", 1, [0.52, 0.458, 0.91, 0.473], "law to address the misuse of body ideals may be"),
      makeBlock("misuse.example.3", 1, [0.52, 0.478, 0.91, 0.495], "the best step."),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["misuse"]);
    expect(output.examples[0]?.word_key).toBe(output.words[0]?.word_key);
  });

  it("prefers the complete numbered headword over a trailing phonetic fragment", () => {
    const output = segmentPage([
      makeBlock("badge", 1, [0.129, 0.41, 0.195, 0.438], "166"),
      makeBlock("phonetic.start", 1, [0.421, 0.422, 0.49, 0.449], "['nes"),
      makeBlock("phonetic.end", 1, [0.51, 0.422, 0.559, 0.449], "ari]"),
      makeBlock("necessary.word", 1, [0.216, 0.426, 0.426, 0.449], "necessary"),
      makeBlock(
        "necessary.summary",
        1,
        [0.129, 0.459, 0.443, 0.481],
        "adj. 必需的；必然的 n. 必需品",
      ),
      makeBlock(
        "necessary.example",
        1,
        [0.115, 0.54, 0.5, 0.62],
        "真 It's a necessary condition. 这是必要条件。",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["necessary"]);
    expect(output.examples[0]?.word_key).toBe(output.words[0]?.word_key);
  });

  it("does not promote a lower sentence fragment into a numbered headword", () => {
    const output = segmentPage([
      makeBlock("badge", 1, [0.11, 0.1, 0.18, 0.13], "166"),
      makeBlock("fragment", 1, [0.2, 0.18, 0.35, 0.2], "researchers"),
      makeBlock("summary", 1, [0.12, 0.2, 0.4, 0.21], "v. 加强"),
    ]);

    expect(output.words).toHaveLength(0);
  });

  it("prefers the longer damaged numbered headword over an OCR phonetic fragment", () => {
    const output = segmentPage([
      makeBlock("badge", 1, [0.128, 0.279, 0.198, 0.308], "334"),
      makeBlock("generous.head", 1, [0.215, 0.29, 0.49, 0.32], "generous['dzen"),
      makeBlock("phonetic.fragment", 1, [0.51, 0.29, 0.558, 0.32], "rs"),
      makeBlock(
        "generous.summary",
        1,
        [0.129, 0.329, 0.494, 0.348],
        "adj. 慷慨的；充足的；宽宏大量的",
      ),
      makeBlock(
        "generous.example",
        1,
        [0.56, 0.6, 0.93, 0.7],
        "真 They already have generous pensions. 他们已有丰厚的养老金。",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["generous"]);
    expect(output.examples[0]?.word_key).toBe(output.words[0]?.word_key);
  });

  it("repairs the source-verified fulfil variant before split-row assembly", () => {
    const output = segmentPage([
      makeBlock("accomplishment.head", 1, [0.116, 0.685, 0.325, 0.705], "accomplishment"),
      makeBlock("accomplishment.meta", 1, [0.332, 0.686, 0.495, 0.702], "[əˈkʌmplɪʃmənt]"),
      makeBlock("accomplishment.sense", 1, [0.106, 0.707, 0.238, 0.726], "n. 成就；完成"),
      makeBlock("fulfil.word", 1, [0.115, 0.744, 0.217, 0.762], "fulfil(I)"),
      makeBlock("fulfil.meta", 1, [0.224, 0.742, 0.437, 0.762], "[fʊlˈfɪl] vt. 实现；满足"),
      makeBlock(
        "fulfil.example",
        1,
        [0.532, 0.311, 0.924, 0.367],
        "真 Progress in today's astronomy is fulfilling the dreams of ancient Hawaiians. 如今天文学正在实现梦想。",
      ),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["accomplishment", "fulfil(l)"]);
    expect(output.examples[0]?.word_key).toBe(output.words[1]?.word_key);
  });

  it("keeps a fused for-the phrase with compete and repairs standalone dj.", () => {
    const output = segmentPage([
      makeBlock("compete.head", 1, [0.12, 0.79, 0.48, 0.813], "compete [kəmˈpiːt] vi. 竞争；参加比赛"),
      makeBlock("compete.sense", 1, [0.115, 0.821, 0.192, 0.84], "vi. 竞争"),
      makeBlock("compete.example", 1, [0.118, 0.85, 0.49, 0.875], "真 Forthetime,we must compete 如今我们必须竞争"),
      makeBlock("competitive.head", 1, [0.56, 0.785, 0.94, 0.806], "competitive [kəmˈpetətɪv] aa"),
      makeBlock("competitive.pos", 1, [0.935, 0.789, 0.953, 0.801], "dj."),
      makeBlock("competitive.gloss", 1, [0.555, 0.806, 0.755, 0.826], "竞争的；求胜心切的"),
      makeBlock("competitive.example", 1, [0.56, 0.837, 0.91, 0.852], "真 anti-competitive behavior 反竞争行为"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["compete", "competitive"]);
    expect(output.examples.map((example) => example.word_key)).toEqual([
      output.words[0]?.word_key,
      output.words[1]?.word_key,
    ]);
  });

  it("repairs the source-verified glory header before ownership recovery", () => {
    const output = segmentPage([
      makeBlock("related", 1, [0.75, 0.66, 0.84, 0.68], "相关词"),
      makeBlock("glory.bad-head", 1, [0.575, 0.718, 0.959, 0.731], "gioryTgisim]n.朱誉；辉煌；贪颂"),
      makeBlock("glory.meta", 1, [0.665, 0.709, 0.958, 0.729], "['glɔ:ri] n. 荣誉；辉煌；赞颂"),
      makeBlock("glory.example.1", 1, [0.565, 0.761, 0.798, 0.78], "真 public glory 社会荣耀"),
      makeBlock("glory.example.2", 1, [0.566, 0.812, 0.94, 0.849], "真 restore the glory of former times 恢复往日的辉煌"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["glory"]);
    expect(output.examples.every((example) => example.word_key === output.words[0]?.word_key)).toBe(true);
  });

  it("recovers a split headword when OCR drops the v from vt.", () => {
    const output = segmentPage([
      makeBlock("propel.head", 1, [0.05, 0.5, 0.44, 0.54], "propel [prəˈpel] vt. 推动"),
      makeBlock("motivate.word", 1, [0.48, 0.59, 0.62, 0.62], "motivate"),
      makeBlock("motivate.tail", 1, [0.63, 0.59, 0.88, 0.62], "[ˈməʊtɪveɪt] t. 成为…的动机；激励"),
      makeBlock("motivate.source", 1, [0.73, 0.69, 0.88, 0.71], "(2014年阅读)"),
      makeBlock("motivate.example", 1, [0.48, 0.72, 0.88, 0.75], "真 They motivate workers. 他们激励员工。"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["propel", "motivate"]);
    const motivate = output.words[1]!;
    expect(output.senses.find((sense) => sense.word_key === motivate.word_key)).toMatchObject({
      pos: "vt",
      gloss: "成为…的动机；激励",
    });
    expect(output.examples[0]?.word_key).toBe(motivate.word_key);
  });

  it("recovers vt. when OCR reads its v as Greek nu", () => {
    const output = segmentPage([
      makeBlock("optimize.word", 1, [0.55, 0.5, 0.73, 0.53], "optimise/-ize"),
      makeBlock("optimize.tail", 1, [0.74, 0.5, 0.94, 0.53], "[ˈɒptɪmaɪz] νt. 使最优化"),
      makeBlock("optimize.example", 1, [0.55, 0.58, 0.94, 0.61], "真 Companies optimize energy use. 企业优化能源使用。"),
    ]);

    expect(output.words[0]?.headword).toBe("optimise/-ize");
    expect(output.senses[0]).toMatchObject({ pos: "vt", gloss: "使最优化" });
    expect(output.examples[0]?.word_key).toBe(output.words[0]?.word_key);
  });

  it("recovers an adjective entry when OCR shortens adj. to ad.", () => {
    const output = segmentPage([
      makeBlock("troublesome.head", 1, [0.1, 0.2, 0.45, 0.23], "troublesome [ˈtrʌblsəm] adj. 引起麻烦的"),
      makeBlock("regenerative.head", 1, [0.1, 0.26, 0.5, 0.29], "regenerative [rɪˈdʒenərətɪv] ad. 再生的"),
      makeBlock("regenerative.example", 1, [0.1, 0.31, 0.5, 0.34], "真 regenerative products 再生产品"),
    ]);

    const regenerative = output.words.find((word) => word.headword === "regenerative")!;
    expect(output.senses.find((sense) => sense.word_key === regenerative.word_key)).toMatchObject({
      pos: "adj",
      gloss: "再生的",
    });
    expect(output.examples[0]?.word_key).toBe(regenerative.word_key);
  });

  it("preserves slash-alternative headwords while using a schema-safe logical key", () => {
    const output = segmentPage([
      makeBlock("inquire.word", 1, [0.1, 0.2, 0.3, 0.23], "inquire/enquire"),
      makeBlock("inquire.phonetic", 1, [0.31, 0.2, 0.48, 0.23], "[ɪn'kwaɪə(r)]"),
      makeBlock("inquire.sense", 1, [0.1, 0.24, 0.48, 0.27], "vt. 询问；探究"),
    ]);

    expect(output.words[0]).toMatchObject({
      headword: "inquire/enquire",
      word_key: "w.c1.u1.0001.inquire-enquire",
    });
    expect(() => Word.parse(output.words[0])).not.toThrow();
  });

  it("parses multi-letter parenthesized spelling variants as their own entries", () => {
    const output = segmentPage([
      makeBlock("curriculum.head", 1, [0.1, 0.2, 0.48, 0.23], "curriculum [kəˈrɪkjələm] n. 课程"),
      makeBlock("catalog.head", 1, [0.1, 0.27, 0.48, 0.3], "catalog(ue) [ˈkætəlɒɡ] n. 目录"),
      makeBlock("catalog.example", 1, [0.1, 0.32, 0.48, 0.35], "真 a course catalogue 课程目录"),
      makeBlock("fantasy.head", 1, [0.1, 0.4, 0.48, 0.43], "fantasy [ˈfæntəsi] n. 幻想"),
      makeBlock("fantastic.head", 1, [0.1, 0.47, 0.48, 0.5], "fantastic(al) [fænˈtæstɪk] adj. 极好的"),
      makeBlock("fantastic.example", 1, [0.1, 0.52, 0.48, 0.55], "真 fantastic ideas 极妙的主意"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual([
      "curriculum",
      "catalog(ue)",
      "fantasy",
      "fantastic(al)",
    ]);
    expect(output.examples.map((example) => example.word_key)).toEqual([
      output.words[1]?.word_key,
      output.words[3]?.word_key,
    ]);
  });

  it("does not turn numbered sense labels or phrase-section headings into content", () => {
    const output = segmentPage([
      makeBlock("work.head", 1, [0.1, 0.2, 0.48, 0.24], "work [w3:k] n. 工作成果"),
      makeBlock("work.sense", 1, [0.1, 0.25, 0.3, 0.28], "③n.工作成果"),
      makeBlock("work.note", 1, [0.1, 0.3, 0.3, 0.33], "真题词组小记"),
      makeBlock("work.phrase", 1, [0.1, 0.34, 0.4, 0.37], "at work 起作用；在工作"),
      makeBlock("work.composition", 1, [0.1, 0.38, 0.48, 0.41], "组合词：work + out"),
      makeBlock("work.composition.tail", 1, [0.1, 0.42, 0.48, 0.45], "一小块的工作模块→拼凑的"),
    ]);

    expect(output.phrases.map((phrase) => phrase.text)).toEqual(["at work"]);
    expect(output.examples).toHaveLength(0);
    expect(output.senses[0]!.gloss).toBe("工作成果");
  });

  it("reassembles wrapped phrase-section lines and splits every source phrase", () => {
    const output = segmentPage([
      makeBlock("take.head", 1, [0.1, 0.2, 0.48, 0.24], "take [teɪk] v. 采取"),
      makeBlock("take.phrase.heading", 1, [0.52, 0.3, 0.8, 0.33], "真题词组小记"),
      makeBlock("take.phrase.1", 1, [0.52, 0.34, 0.9, 0.37], "take a long-"),
      makeBlock("take.phrase.2", 1, [0.52, 0.38, 0.9, 0.41], "term view从长远来看//take action采取"),
      makeBlock("take.phrase.3", 1, [0.52, 0.42, 0.9, 0.45], "行动/take effect起作用"),
    ]);

    expect(output.phrases.map((phrase) => [phrase.text, phrase.gloss])).toEqual([
      ["take a long-term view", "从长远来看"],
      ["take action", "采取行动"],
      ["take effect", "起作用"],
    ]);
  });

  it("stores a 真-marked slash list as phrases rather than a sentence example", () => {
    const output = segmentPage([
      makeBlock("labour.head", 1, [0.1, 0.2, 0.48, 0.24], "labo(u)r [ˈleɪbə(r)] n. 劳工"),
      makeBlock(
        "labour.phrases",
        1,
        [0.1, 0.28, 0.48, 0.31],
        "真 child labor童工//labor market劳动力市场//labor shortage劳动力短缺",
      ),
    ]);

    expect(output.examples).toHaveLength(0);
    expect(output.phrases.map((phrase) => phrase.text)).toEqual([
      "child labor",
      "labor market",
      "labor shortage",
    ]);
  });

  it("ignores every prose line under a memory-note heading until the next word", () => {
    const output = segmentPage([
      makeBlock("alpha.head", 1, [0.1, 0.2, 0.48, 0.24], "alpha [ˈælfə] n. 阿尔法"),
      makeBlock("alpha.note", 1, [0.1, 0.3, 0.3, 0.33], "文化休息站"),
      makeBlock("alpha.note.en", 1, [0.1, 0.34, 0.48, 0.37], "English note英文说明"),
      makeBlock("alpha.note.zh", 1, [0.1, 0.38, 0.48, 0.41], "中文补充说明"),
      makeBlock("beta.head", 1, [0.1, 0.46, 0.48, 0.5], "beta [ˈbiːtə] n. 贝塔"),
    ]);

    expect(output.words.map((word) => word.headword)).toEqual(["alpha", "beta"]);
    expect(output.phrases).toHaveLength(0);
    expect(output.senses.find((sense) => sense.word_key === output.words[0]!.word_key)?.gloss).toBe("阿尔法");
  });

  it("ignores bilingual mnemonic prose and resumes at the next numbered sense", () => {
    const output = segmentPage([
      makeBlock("expand.head", 1, [0.1, 0.2, 0.48, 0.24], "expand [ɪkˈspænd] v. 扩大"),
      makeBlock("expand.note", 1, [0.1, 0.26, 0.48, 0.29], "串词记忆：他们的 band 人数又增加"),
      makeBlock("expand.note.en", 1, [0.1, 0.3, 0.48, 0.33], "expand means become larger 记忆说明"),
      makeBlock("expand.sense", 1, [0.1, 0.35, 0.48, 0.38], "①v.增加(数量)"),
      makeBlock("expand.example", 1, [0.1, 0.4, 0.48, 0.43], "真 Markets expand rapidly. 市场迅速扩大。"),
    ]);

    expect(output.senses.map((sense) => sense.gloss)).toEqual(["扩大", "增加(数量)"]);
    expect(output.senses[0]?.gloss).not.toContain("means become larger");
    expect(output.examples[0]?.text).toContain("Markets expand rapidly");
  });

  it("ignores a root mnemonic when OCR drops the first 词 glyph", () => {
    const output = segmentPage([
      makeBlock("export.head", 1, [0.05, 0.15, 0.45, 0.18], "export [ɪkˈspɔːt] v. 出口；传播"),
      makeBlock("export.note", 1, [0.51, 0.07, 0.9, 0.1], "根记忆：ex(out)+port(carry)"),
      makeBlock("export.note.tail", 1, [0.51, 0.1, 0.9, 0.13], "带到国境外→出口"),
      makeBlock("export.sense", 1, [0.51, 0.14, 0.9, 0.17], "n. 出口产品"),
    ]);

    expect(output.senses.map((sense) => [sense.pos, sense.gloss])).toEqual([
      ["v", "出口；传播"],
      ["n", "出口产品"],
    ]);
  });

  it("ignores association mnemonics instead of appending them to a sense", () => {
    const output = segmentPage([
      makeBlock("antipoverty.head", 1, [0.1, 0.2, 0.48, 0.24], "antipoverty [ˌæntɪˈpɒvəti] adj. 反贫困的"),
      makeBlock("antipoverty.note", 1, [0.1, 0.26, 0.48, 0.29], "联想记忆：anti(反对)+poverty(贫困)"),
      makeBlock("antipoverty.note.tail", 1, [0.1, 0.3, 0.48, 0.33], "→反贫困的"),
    ]);

    expect(output.senses[0]?.gloss).toBe("反贫困的");
  });

  it("ignores the right-rail resource heading instead of appending it to a sense", () => {
    const output = segmentPage([
      makeBlock("workforce.head", 1, [0.1, 0.2, 0.47, 0.24], "workforce [w3:kf:s] n. 劳动力；"),
      makeBlock("workforce.gloss", 1, [0.1, 0.25, 0.25, 0.28], "全体员工"),
      makeBlock("resource.heading", 1, [0.81, 0.25, 0.9, 0.28], "本单元资源"),
    ]);

    expect(output.senses[0]!.gloss).toBe("劳动力；全体员工");
  });

  it("never carries the previous unit's current word into a new unit", () => {
    const output = segmentStructure(
      assignReadingOrder([
        makeBlock("chapter", 1, [0.1, 0.06, 0.3, 0.09], "Chapter 1"),
        makeBlock("unit.1", 1, [0.08, 0.1, 0.9, 0.14], "Unit 1"),
        makeBlock("known.head", 1, [0.1, 0.2, 0.48, 0.24], "known /nəʊn/ adj. 已知的"),
        makeBlock("unit.2", 2, [0.08, 0.1, 0.9, 0.14], "Unit 2"),
        makeBlock("orphan.example", 2, [0.1, 0.2, 0.48, 0.24], "真 missing headword 漏识别词头"),
      ]),
      normalizeConfig(),
      [],
    );

    expect(output.examples).toHaveLength(0);
  });
});

describe("deterministic source-content ownership gate", () => {
  it("blocks examples, phrases, and senses that visibly belong to another entry", () => {
    const output = normalizeAll();
    const coworker = output.words.find((word) => word.headword === "governmental")!;
    const bad = {
      ...output,
      senses: output.senses.map((sense) =>
        sense.word_key === coworker.word_key
          ? { ...sense, gloss: "拼凑之物 labour market workers created a machine across their entire career" }
          : sense,
      ),
      phrases: [
        ...output.phrases,
        {
          ...output.phrases[0]!,
          phrase_key: `ph.${coworker.word_key}.99`,
          word_key: coworker.word_key,
          text: "[w3:kf:s] n.",
          gloss: "劳动力",
        },
      ],
      examples: output.examples.map((example) =>
        example.word_key === coworker.word_key
          ? { ...example, text: "agricultural workforce 农业劳动力" }
          : example,
      ),
    };

    expect(findContentOwnershipFindings(bad).map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "EXAMPLE_HEADWORD_MISMATCH",
        "PHRASE_HEADWORD_MISMATCH",
        "SENSE_CONTENT_CONTAMINATION",
      ]),
    );
  });

  it("accepts inflected headwords in otherwise well-owned source content", () => {
    expect(findContentOwnershipFindings(normalizeAll())).toEqual([]);
  });

  it("accepts the irregular past-participle form borne for bear", () => {
    const output = normalizeAll();
    const word = output.words[0]!;
    const content = {
      ...output,
      words: [{ ...word, headword: "bear" }],
      senses: output.senses.filter((sense) => sense.word_key === word.word_key),
      phrases: [],
      examples: [
        {
          ...output.examples[0]!,
          word_key: word.word_key,
          example_key: `ex.${word.word_key}.1`,
          text: "The cost borne by families has risen. 家庭承担的费用上升了。",
        },
      ],
    };

    expect(findContentOwnershipFindings(content)).toEqual([]);
  });

  it.each([
    ["art", "The party begins."],
    ["rate", "A corporate policy changed."],
    ["go", "The algorithm works."],
    ["sure", "The insure fire safety sign remains."],
    ["abroad", "A broad range of choices exists."],
  ])("rejects %s when it appears only inside another token", (headword, text) => {
    const output = normalizeAll();
    const word = output.words[0]!;
    const content = {
      ...output,
      words: [{ ...word, headword }],
      senses: output.senses.filter((sense) => sense.word_key === word.word_key),
      phrases: [],
      examples: [
        {
          ...output.examples[0]!,
          word_key: word.word_key,
          example_key: `ex.${word.word_key}.1`,
          text,
        },
      ],
    };

    expect(findContentOwnershipFindings(content).map((finding) => finding.code)).toContain(
      "EXAMPLE_HEADWORD_MISMATCH",
    );
  });

  it.each([
    ["take", "You can taketo help."],
    ["law", "Newton'slawsofmotion"],
    ["fit", "The runner is extremelyfit."],
    ["acknowledge", "We must acknow- ledge the issue."],
    ["mean", "This meant a change."],
    ["scrutinise/-ize", "The plan was scrutinized carefully."],
    ["take", "It was the latesttakeofthe policy."],
    ["rich", "They entered arichand contested market."],
    ["dim", "The lights dimmed."],
    ["blur", "Withtheblurring of roles, things changed."],
    ["spur", "They were spurred by evidence."],
  ])("accepts source OCR spacing or inflection for %s", (headword, text) => {
    const output = normalizeAll();
    const word = output.words[0]!;
    const content = {
      ...output,
      words: [{ ...word, headword }],
      senses: [],
      phrases: [],
      examples: [{ ...output.examples[0]!, word_key: word.word_key, text }],
    };
    expect(findContentOwnershipFindings(content)).toEqual([]);
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

  it("replays a visual decision by immutable page evidence after source order shifts", () => {
    const coworker = makeBlock(
      "coworker",
      1,
      [0.1, 0.3, 0.48, 0.34],
      "coworker [kəʊwɜːkə(r)] n. 同事",
      0.5,
    );
    const base = [
      makeBlock("chapter", 1, [0.1, 0.06, 0.3, 0.09], "Chapter 1"),
      makeBlock("unit", 1, [0.08, 0.1, 0.9, 0.14], "Unit 1"),
    ];
    const first = segmentStructure(assignReadingOrder([...base, coworker]), normalizeConfig(), []);
    const review = first.fieldReviews.find((candidate) => candidate.field === "headword")!;
    const correction: VisualCorrection = {
      packet_id: review.packet_id,
      verdict: "PASS",
      agent_run_id: "stable-evidence-pass",
      round: review.round,
      field: review.field,
      page_number: review.page_number,
      page_image_sha256: review.page_image_sha256,
      bbox: review.bbox.map((value) => value + 0.002) as Bbox,
      original_text: review.current_text,
    };
    const shifted = segmentStructure(
      assignReadingOrder([
        ...base,
        makeBlock("work", 1, [0.1, 0.2, 0.48, 0.24], "work [wɜːk] n. 工作"),
        coworker,
      ]),
      normalizeConfig(),
      [correction],
    );

    expect(shifted.words.find((word) => word.headword === "coworker")?.source_order).toBe(2);
    expect(
      shifted.fieldReviews.filter(
        (candidate) => candidate.field === "headword" && candidate.current_text === "coworker",
      ),
    ).toEqual([]);
  });

  it("uses a repaired headword when repairing its OCR-damaged examples", () => {
    const blocks = assignReadingOrder([
      makeBlock("chapter", 1, [0.1, 0.06, 0.3, 0.09], "Chapter 1"),
      makeBlock("unit", 1, [0.08, 0.1, 0.9, 0.14], "Unit 1"),
      makeBlock("radical", 1, [0.1, 0.2, 0.48, 0.23], "rudlcal [ˈrædɪkl] adj. 激进的", 0.5),
      makeBlock("radical.example", 1, [0.1, 0.26, 0.48, 0.29], "真 rudlcal innovation 激进的创新"),
    ]);
    const first = segmentStructure(blocks, normalizeConfig(), []);
    const review = first.fieldReviews.find((candidate) => candidate.field === "headword")!;
    const output = segmentStructure(blocks, normalizeConfig(), [{
      packet_id: review.packet_id,
      verdict: "REPAIR",
      corrected_text: "radical",
      agent_run_id: "repair-radical",
      round: 1,
    }]);

    expect(output.words[0]?.headword).toBe("radical");
    expect(output.examples[0]?.text).toBe("radical innovation 激进的创新");
    expect(findContentOwnershipFindings(output)).toEqual([]);
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
// CJK gloss continuation blocks
//
// The real raster splits entries across OCR blocks: a headword line can end
// at its POS marker ("word [,phon]v.") with the gloss on the NEXT block, and
// a multi-line gloss continues onto a CJK-leading block. Such blocks matched
// no walk branch before (the phrase branch requires a non-CJK first char) and
// were silently dropped, leaving words with zero senses. Synthetic
// lookalikes only.
// ---------------------------------------------------------------------------

describe("CJK gloss continuation blocks", () => {
  const chapterOpener = (page: number): NormalizeInputBlock =>
    makeBlock(`p${page}.chapter`, page, [0.2, 0.065, 0.44, 0.1], "Chapter 1");
  const unitTab = (page: number, digits: string): NormalizeInputBlock =>
    makeBlock(`p${page}.tab`, page, [0.9359, 0.8278, 0.9709, 0.8478], digits);

  it("creates the sense from a CJK gloss block when the headword line ends at its POS marker", () => {
    const blocks = [
      chapterOpener(1),
      unitTab(1, "01"),
      // Headword line: phonetic then POS marker, NO gloss on this line.
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "orble [,ɔːrbəl]v."),
      // The gloss lives on its own OCR block starting with a CJK char.
      makeBlock("p1.gloss", 1, [0.1, 0.2, 0.48, 0.26], "环绕；轨道运行"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.words.map((w) => w.headword)).toEqual(["orble"]);
    const senses = output.senses.filter((s) => s.word_key === output.words[0]!.word_key);
    expect(senses).toHaveLength(1);
    // POS comes from the headword line's trailing marker.
    expect(senses[0]!.pos).toBe("v");
    expect(senses[0]!.gloss).toBe("环绕；轨道运行");
    // Provenance matches the word's head block, like every other sense.
    expect(senses[0]!.bbox).toEqual([0.1, 0.14, 0.48, 0.2]);
  });

  it("appends a CJK continuation block to the current sense's gloss", () => {
    const blocks = [
      chapterOpener(1),
      unitTab(1, "01"),
      makeBlock("p1.head", 1, [0.1, 0.14, 0.48, 0.2], "orbflow /ˈɔːrbfləʊ/ n. 循环流"),
      // Multi-line gloss continuation on the next OCR block.
      makeBlock("p1.gloss2", 1, [0.1, 0.2, 0.48, 0.26], "量；人员的流动率"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    const senses = output.senses.filter((s) => s.word_key === output.words[0]!.word_key);
    expect(senses).toHaveLength(1);
    expect(senses[0]!.gloss).toBe("循环流量；人员的流动率");
  });

  it("appends a continuation to the LAST sense of a multi-sense entry", () => {
    const blocks = [
      chapterOpener(1),
      unitTab(1, "01"),
      makeBlock(
        "p1.head",
        1,
        [0.1, 0.14, 0.48, 0.2],
        "orbflow /ˈɔːrbfləʊ/ ① n. 循环流 ② n. 环流圈",
      ),
      makeBlock("p1.gloss2", 1, [0.1, 0.2, 0.48, 0.26], "带"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    const senses = output.senses.filter((s) => s.word_key === output.words[0]!.word_key);
    expect(senses.map((s) => [s.sense_order, s.gloss])).toEqual([
      [1, "循环流"],
      [2, "环流圈带"],
    ]);
  });

  it("still ignores a CJK-leading block when no word is open", () => {
    const blocks = [
      chapterOpener(1),
      unitTab(1, "01"),
      // A CJK-leading block before any headword: nothing to attach to.
      makeBlock("p1.orphan", 1, [0.1, 0.11, 0.48, 0.14], "孤立的中文块"),
      makeBlock("p1.head", 1, [0.1, 0.18, 0.48, 0.24], "alpha /ˈælfə/ n. 阿尔法"),
    ];
    const output = segmentStructure(assignReadingOrder(blocks), normalizeConfig());
    expect(output.words.map((w) => w.headword)).toEqual(["alpha"]);
    expect(output.senses.map((s) => [s.word_key, s.gloss])).toEqual([
      [output.words[0]!.word_key, "阿尔法"],
    ]);
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

  it("routes a low-confidence ownership mismatch to visual review before terminal ownership validation", async () => {
    await seedCleanArtifacts();
    const rows = ocrRows() as Array<{ page: number; text: string; confidence: number }>;
    const example = rows.find((row) => row.text.includes("governmental job-training"));
    expect(example).toBeDefined();
    example!.text = "真 agricultural workforce 农业劳动力";
    const stages = makeStagesWithRows(rows);

    const report = await runLedger(stages);

    expect(report.status).toBe("FAILED");
    expect(report.results[1]?.error_code).toBe("VISUAL_PACKETS_PENDING");
    const queue = await loadQueue(path.join(sourceDir, "agent-queue", "visual-ocr"));
    expect(queue.some((entry) => entry.packet.field === "headword")).toBe(true);
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
      pipeline: "PaddleOCR",
      pipeline_version: "3.7.0",
      model_version: "PaddleOCR/mobile-det+PP-OCRv5-server-rec@3.0.0",
      config_version: 14,
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

  it("re-spawns a page whose OCR model/config identity is stale", async () => {
    const pages = [1, 2];
    await seedCleanPages(pages);
    const first = makeFakeOcrWorker();
    await makeStage(first.runner).run(undefined, stageContext(pages));

    const ocrPath = path.join(sourceDir, "ocr.jsonl");
    const rows = (await readFile(ocrPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const row of rows) {
      if (row.page === 2) row.config_version = 3;
    }
    await writeFile(ocrPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");

    const retry = makeFakeOcrWorker();
    await makeStage(retry.runner).run(undefined, stageContext(pages));

    expect(retry.calls.map((call) => chunkPages(call.args))).toEqual([[2]]);
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

  it("ignores content and rail digits after the back-matter (index) opener", () => {
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
    expect(output.words.map((w) => [w.headword, w.unit_key])).toEqual([["alpha", "c1.u1"]]);
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
