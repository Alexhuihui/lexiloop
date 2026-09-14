/**
 * Deterministic structure recovery: OCR blocks -> normalized records
 * (spec 5.4).
 *
 * Input is strict, provenance-bearing OCR blocks in reading order. Output is
 * book/Unit/word/sense/phrase/example records that validate against
 * `@lexiloop/content-schema`, plus the visual-review bookkeeping:
 *
 * - critical fields (headword/phonetic) below `critical_confidence_min`, or
 *   carrying OCR-confusion patterns, become `fieldReviews` (visual-agent
 *   packets). They are NEVER guessed or rewritten;
 * - a `REPAIR` correction applies only when the corrected text is itself
 *   clean; a still-invalid repair escalates to the next round, and a field
 *   that exhausts `MAX_PACKET_ROUND` (or is BLOCKed) lands in
 *   `blockedFields`, which fails the owning Unit closed;
 * - every entity keeps the full provenance of the block it came from.
 */
import {
  Book,
  Example,
  ExampleOrigin,
  PartOfSpeech,
  Phrase,
  Sense,
  Unit,
  Word,
} from "@lexiloop/content-schema";
import type { z } from "zod";
import { hashString } from "../stage";
import { flagOcrConfusions } from "./confusions";
import type { NormalizeBookConfig } from "./config";
export type { NormalizeBookConfig };
import { joinHyphenatedLines } from "./joins";
import { DEFAULT_FURNITURE_CONFIG, partitionPageFurniture } from "./furniture";
import { normalizeUnicodeText } from "./punctuation";
import type { Bbox } from "./reading-order";
import {
  MAX_PACKET_ROUND,
  type AppliedCorrection,
  type BlockedField,
  type CriticalField,
  type FieldReview,
  type VisualCorrection,
} from "./quality";

export type BookT = z.output<typeof Book>;
export type UnitT = z.output<typeof Unit>;
export type WordT = z.output<typeof Word>;
export type SenseT = z.output<typeof Sense>;
export type PhraseT = z.output<typeof Phrase>;
export type ExampleT = z.output<typeof Example>;
export type ExampleOriginT = z.output<typeof ExampleOrigin>;
type PartOfSpeechT = z.output<typeof PartOfSpeech>;

/** One strict OCR block prepared for normalization (camelCase mirror). */
export interface NormalizeInputBlock {
  blockKey: string;
  sourcePdfSha256: string;
  page: number;
  pageImageSha256: string;
  bbox: Bbox;
  text: string;
  confidence: number;
  layoutRole: string;
  sourceRawRefHash: string;
}

export interface UnitBoundary {
  unit_key: string;
  unit_order: number;
  title: string;
  first_page: number;
  last_page: number;
}

export interface NormalizeOutput {
  book: BookT;
  units: UnitT[];
  words: WordT[];
  senses: SenseT[];
  phrases: PhraseT[];
  examples: ExampleT[];
  unitBoundaries: UnitBoundary[];
  fieldReviews: FieldReview[];
  blockedFields: BlockedField[];
  appliedCorrections: AppliedCorrection[];
}

/** Evidence code for critical fields below the confidence threshold. */
export const LOW_CONFIDENCE_CRITICAL_FIELD = "LOW_CONFIDENCE_CRITICAL_FIELD";

const ZERO_HASH = "0".repeat(32);
const CJK_RANGE = /[\u3400-\u9fff\uf900-\ufaff]/u;
const HEAD_ENTRY_RE = /^([A-Za-z][A-Za-z'’-]*)\s+(\/[^/]+\/|\[[^\]]+\])\s*(.*)$/su;
const SOURCE_REF_RE = /[（(]([^（()）]*\d[^（()）]*)[）)]\s*$/u;
const SENSE_SPLIT_RE = /[①②③④⑤⑥⑦⑧⑨⑩]/u;

function sha8(value: string): string {
  return hashString(value).slice(0, 8);
}

/** Stable per-field packet id: `vo.<field>.p<page>.r<round>.<hash8>`.
 * The id depends only on the field's identity and round — never on the text
 * under review — so a re-run reproduces the exact ids agents answered. */
export function packetIdFor(
  field: CriticalField,
  wordKey: string,
  page: number,
  round: number,
): string {
  return `vo.${field}.p${page}.r${round}.${sha8(`${field}|${wordKey}|${page}|${round}`)}`;
}

interface SenseDraft {
  pos: PartOfSpeechT;
  gloss: string;
}

interface WordDraft {
  word: WordT;
  unitKey: string;
  /** The entry's headword block (always carries its normalizedText). */
  head: PreprocessedBlock;
  headword: string;
  phonetic: string | null;
  senseDrafts: SenseDraft[];
  /** POS from the headword line's trailing marker, for entries whose gloss
   * lives on a following OCR block (null when the line carries no marker). */
  posFromHead: PartOfSpeechT | null;
  exampleCount: number;
}

const PART_OF_SPEECH_VALUES = new Set<string>(PartOfSpeech.options);

/** Map a configured POS marker ("vt.", "phr.") to the schema enum value. */
function posValue(marker: string): PartOfSpeechT {
  const bare = marker.replace(/\.+$/u, "");
  const value = bare === "phr" ? "phrase" : bare;
  return (PART_OF_SPEECH_VALUES as Set<string>).has(value)
    ? (value as PartOfSpeechT)
    : "other";
}

/** Find the configured POS marker occurring earliest (longest match wins). */
function findPosMarker(text: string, markers: readonly string[]): { marker: string; index: number } | null {
  let best: { marker: string; index: number } | null = null;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index < 0) continue;
    if (
      best === null ||
      index < best.index ||
      (index === best.index && marker.length > best.marker.length)
    ) {
      best = { marker, index };
    }
  }
  return best;
}

/** Find the configured POS marker occurring last (longest match wins ties). */
function findLastPosMarker(
  text: string,
  markers: readonly string[],
): { marker: string; index: number } | null {
  let best: { marker: string; index: number } | null = null;
  for (const marker of markers) {
    const index = text.indexOf(marker);
    if (index < 0) continue;
    if (
      best === null ||
      index > best.index ||
      (index === best.index && marker.length > best.marker.length)
    ) {
      best = { marker, index };
    }
  }
  return best;
}

function parseSenses(text: string, config: NormalizeBookConfig): SenseDraft[] {
  const segments = text
    .split(SENSE_SPLIT_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const senses: SenseDraft[] = [];
  for (const segment of segments) {
    const found = findPosMarker(segment, config.pos_markers);
    if (!found) continue;
    const gloss = segment.slice(found.index + found.marker.length).trim();
    if (gloss.length === 0) continue;
    senses.push({ pos: posValue(found.marker), gloss });
  }
  return senses;
}

interface PreprocessedBlock extends NormalizeInputBlock {
  normalizedText: string;
}

function preprocess(blocks: readonly NormalizeInputBlock[]): PreprocessedBlock[] {
  return blocks.map((block) => ({
    ...block,
    normalizedText: joinHyphenatedLines(normalizeUnicodeText(block.text)).text,
  }));
}

function provenance(block: PreprocessedBlock) {
  return {
    source_pdf_sha256: block.sourcePdfSha256,
    page_number: block.page,
    page_image_sha256: block.pageImageSha256,
    bbox: block.bbox,
    source_raw_ref_hash: block.sourceRawRefHash,
    source_normalized_text: block.normalizedText,
    ocr_confidence: block.confidence,
    structure_confidence: 1,
  };
}

interface WalkState {
  config: NormalizeBookConfig;
  correctionsByPacket: Map<string, VisualCorrection>;
  units: UnitT[];
  unitBoundaries: UnitBoundary[];
  boundaryByUnit: Map<string, UnitBoundary>;
  words: WordT[];
  wordDrafts: WordDraft[];
  senses: SenseT[];
  phrases: PhraseT[];
  examples: ExampleT[];
  fieldReviews: FieldReview[];
  blockedFields: BlockedField[];
  appliedCorrections: AppliedCorrection[];
  currentUnit: UnitBoundary | null;
  /** Unit NUMBER of the open unit (the tab/banner value, not the ordinal). */
  currentUnitNumber: number;
  /** Chapter context the open unit was opened in. */
  currentUnitChapter: number;
  currentWord: WordDraft | null;
  pendingSourceRef: string | undefined;
  wordKeys: Set<string>;
  /** Words seen per unit key; feeds the textbook source_order counter. */
  unitWordCount: Map<string, number>;
}

function touchBoundary(state: WalkState, unitKey: string | null, page: number): void {
  if (!unitKey) return;
  const boundary = state.boundaryByUnit.get(unitKey);
  if (boundary && page > boundary.last_page) boundary.last_page = page;
}

/**
 * Open (or re-point to) the unit carried by a banner or tab with the captured
 * number `unitNumber` inside chapter context `chapter`. The captured number is
 * authoritative (Task 6 minor): the unit key derives from it, never from
 * discovery order, so unit identity is stable regardless of which pages a run
 * happens to cover.
 *
 * - `unit_key` is chapter-qualified (`c<chapter>.u<number>`): the same number
 *   under a DIFFERENT chapter is a different unit.
 * - `unit_order` is the global encounter ordinal (1,2,3,... across the whole
 *   book), so textbook-order consumers sort by true reading order even when a
 *   chapter legally restarts the numbering at 1.
 *
 * Side tabs repeat the unit's number on every page; a banner whose number
 * equals the currently open unit never re-opens it. Within one chapter, banner
 * numbers must strictly increase — a lower number is a misread (fail closed).
 * A NEW chapter legally restarts at any number (chapter 4 of the real book
 * opens at unit 1); the same (chapter, number) re-opening while another unit
 * is open stays illegal.
 */
function startUnit(
  state: WalkState,
  block: PreprocessedBlock,
  chapter: number,
  unitNumber: number,
  title: string,
  firstPage: number,
): void {
  const unitKey = `c${chapter}.u${unitNumber}`;
  const existing = state.boundaryByUnit.get(unitKey);
  if (existing) {
    if (state.currentUnit === existing) return; // repeated per-page tab
    throw new Error(
      `unit banner ${unitKey} re-appeared on page ${block.page} after unit ` +
        `${state.currentUnit?.unit_key ?? "?"} opened; banner numbers must be monotonic`,
    );
  }
  if (
    state.currentUnit !== null &&
    state.currentUnitChapter === chapter &&
    unitNumber < state.currentUnitNumber
  ) {
    // Within one chapter the tab numbers strictly increase (calibrated on the
    // real raster). A decreasing banner is therefore always a misread — e.g.
    // the run-0 tab misread that the single-run tolerance cannot collapse —
    // and must fail closed instead of silently opening a phantom unit that
    // keeps the real unit's opener pages' words. A new chapter restarting at
    // 1 is legal and guarded by the chapter comparison above.
    throw new Error(
      `unit banner ${unitKey} on page ${block.page} is lower than the open unit ` +
        `${state.currentUnit.unit_key}; unit numbers must strictly increase within a ` +
        "chapter — a new chapter may restart at 1, but a tab misread must not open a phantom unit",
    );
  }
  const unitOrder = state.units.length + 1;
  const unit: UnitT = {
    unit_key: unitKey,
    book_key: state.config.book_key,
    level: 1,
    unit_order: unitOrder,
    title,
    ...provenance(block),
  };
  const boundary: UnitBoundary = {
    unit_key: unitKey,
    unit_order: unitOrder,
    title,
    first_page: firstPage,
    last_page: firstPage,
  };
  state.units.push(unit);
  state.unitBoundaries.push(boundary);
  state.boundaryByUnit.set(unitKey, boundary);
  state.currentUnit = boundary;
  state.currentUnitNumber = unitNumber;
  state.currentUnitChapter = chapter;
}

function startWord(state: WalkState, block: PreprocessedBlock, match: RegExpMatchArray): void {
  const [headword, phoneticWithDelims, rest] = [match[1]!, match[2]!, match[3]!];
  // Content before the first unit title lands in a synthetic "u0" bucket so
  // segmentation stays total; the STRUCTURE_NORMALIZE stage fails closed
  // (DANGLING_UNIT_REFERENCE) if such a book is ever emitted, so real runs
  // can never silently publish word entries without their Unit record.
  const unitKey = state.currentUnit?.unit_key ?? "u0";

  const headwordText = headword.trim();
  // Textbook order: a per-unit counter, not a name-derived position.
  const sourceOrder = (state.unitWordCount.get(unitKey) ?? 0) + 1;
  state.unitWordCount.set(unitKey, sourceOrder);
  const wordKey = `w.${unitKey}.${String(sourceOrder).padStart(4, "0")}.${headwordText}`;
  state.wordKeys.add(wordKey);

  // A trailing "(2022 年阅读)" is the exam-paper reference of the entry's
  // first example, not part of the gloss.
  let pendingSourceRef: string | undefined;
  let senseText = rest;
  const refMatch = SOURCE_REF_RE.exec(senseText);
  if (refMatch) {
    pendingSourceRef = refMatch[1]!.replace(/年/u, "").replace(/\s+/gu, " ").trim();
    senseText = senseText.slice(0, refMatch.index).trim();
  }

  const senseDrafts = parseSenses(senseText, state.config);
  const phonetic = phoneticWithDelims.trim();
  const posFromHeadMatch = findLastPosMarker(senseText, state.config.pos_markers);
  const word: WordT = {
    word_key: wordKey,
    unit_key: unitKey,
    headword: headwordText,
    tier: state.config.default_tier,
    source_order: sourceOrder,
    ...provenance(block),
    ...(phonetic.length > 0 ? { phonetic } : {}),
  };
  const draft: WordDraft = {
    word,
    unitKey,
    head: block,
    headword: headwordText,
    phonetic: phonetic.length > 0 ? phonetic : null,
    senseDrafts,
    posFromHead: posFromHeadMatch ? posValue(posFromHeadMatch.marker) : null,
    exampleCount: 0,
  };
  state.words.push(word);
  state.wordDrafts.push(draft);
  state.currentWord = draft;
  state.pendingSourceRef = pendingSourceRef;

  senseDrafts.forEach((draft2, index) => {
    const sense: SenseT = {
      sense_key: `s.${wordKey}.${index + 1}`,
      word_key: wordKey,
      pos: draft2.pos,
      gloss: draft2.gloss,
      sense_order: index + 1,
      ...provenance(block),
    };
    state.senses.push(sense);
  });
  touchBoundary(state, unitKey, block.page);
}

function addExample(state: WalkState, block: PreprocessedBlock, marker: string): void {
  const draft = state.currentWord;
  if (!draft) return; // Examples attach to the entry being read.
  const text = block.normalizedText.startsWith(marker)
    ? block.normalizedText.slice(marker.length).trim()
    : block.normalizedText;
  if (text.length === 0) {
    return; // A bare exam marker printed on its own line carries no content.
  }
  const cjkIndex = text.search(CJK_RANGE);
  const english = cjkIndex >= 0 ? text.slice(0, cjkIndex).trimEnd() : text;
  const spanEnd = english.length > 0 ? english.length : text.length;
  const origin: ExampleOriginT = "exam";
  draft.exampleCount += 1;
  const example: ExampleT = {
    example_key: `ex.${draft.word.word_key}.${draft.exampleCount}`,
    word_key: draft.word.word_key,
    origin,
    ...(state.pendingSourceRef !== undefined ? { source_ref: state.pendingSourceRef } : {}),
    text,
    target_span: [0, spanEnd],
    source_order: draft.exampleCount,
    ...provenance(block),
  };
  state.examples.push(example);
  state.pendingSourceRef = undefined;
  touchBoundary(state, draft.unitKey, block.page);
}

function addPhrase(state: WalkState, block: PreprocessedBlock): void {
  const draft = state.currentWord;
  if (!draft) return;
  const text = block.normalizedText;
  const cjkIndex = text.search(CJK_RANGE);
  if (cjkIndex <= 0) return; // No "english gloss CJK" split point.
  const english = text.slice(0, cjkIndex).trim();
  const gloss = text.slice(cjkIndex).trim();
  if (english.length === 0 || gloss.length === 0 || !/[A-Za-z]/u.test(english)) return;
  const phraseCount = state.phrases.filter((p) => p.word_key === draft.word.word_key).length;
  const phrase: PhraseT = {
    phrase_key: `ph.${draft.word.word_key}.${phraseCount + 1}`,
    word_key: draft.word.word_key,
    text: english,
    gloss,
    source_order: phraseCount + 1,
    ...provenance(block),
  };
  state.phrases.push(phrase);
  touchBoundary(state, draft.unitKey, block.page);
}

/**
 * Attach a CJK-leading block that matched no earlier branch to the entry
 * being read. The real raster splits entries across OCR blocks in two ways:
 * a headword line can end at its POS marker (no gloss on that line) with the
 * gloss on the next block, and a parsed gloss can continue onto further
 * CJK-leading lines. Direct concatenation reconstructs the printed gloss
 * (e.g. "货物周转" + "率；..." -> "货物周转率；...").
 */
function attachCjkGloss(state: WalkState, block: PreprocessedBlock): void {
  const draft = state.currentWord;
  if (!draft) return; // Guarded by the caller; kept total.
  const gloss = block.normalizedText;
  if (gloss.length === 0) return;
  if (draft.senseDrafts.length > 0) {
    // Continuation of the entry's last sense, draft + pushed record alike.
    const last = draft.senseDrafts[draft.senseDrafts.length - 1]!;
    last.gloss += gloss;
    const senseKey = `s.${draft.word.word_key}.${draft.senseDrafts.length}`;
    const sense = state.senses.find((s) => s.sense_key === senseKey);
    if (sense) sense.gloss = last.gloss;
  } else {
    // The headword line ended at its POS marker: this block IS the sense
    // gloss. POS from that line's trailing marker — a started word always had
    // one, so the "other" fallback is unreachable in practice (kept total).
    const pos = draft.posFromHead ?? "other";
    draft.senseDrafts.push({ pos, gloss });
    state.senses.push({
      sense_key: `s.${draft.word.word_key}.${draft.senseDrafts.length}`,
      word_key: draft.word.word_key,
      pos,
      gloss,
      sense_order: draft.senseDrafts.length,
      ...provenance(draft.head),
    });
  }
  touchBoundary(state, draft.unitKey, block.page);
}

/** Digit confusions are unambiguous; `rn`↔`m` is too common to gate on. */
function gatingEvidence(text: string, field: CriticalField): string[] {
  return flagOcrConfusions(text, field).filter((code) => code.startsWith("OCR_CONFUSION_DIGIT"));
}

function evidenceFor(text: string, confidence: number, field: CriticalField, config: NormalizeBookConfig): string[] {
  const codes = gatingEvidence(text, field);
  if (confidence < config.critical_confidence_min) codes.push(LOW_CONFIDENCE_CRITICAL_FIELD);
  return codes;
}

/**
 * Resolve one critical field across repair rounds. Packet ids are stable per
 * (field, word, page, round), so the whole correction history can be
 * replayed statelessly: rounds with corrections are applied (PASS affirms, a
 * clean REPAIR is applied, a still-invalid REPAIR escalates), and the first
 * round WITHOUT a correction emits the review packet. A field whose repair
 * at MAX_PACKET_ROUND is still invalid (or that is explicitly BLOCKed) ends
 * in `blockedFields`. Returns the accepted text (null when blocked).
 */
function resolveField(
  state: WalkState,
  draft: WordDraft,
  field: CriticalField,
  ocrText: string,
): string | null {
  const { config } = state;
  const block = draft.head;
  const packetIdAt = (round: number): string =>
    packetIdFor(field, draft.word.word_key, block.page, round);

  // Highest round an agent decision answers for this field (0 = none).
  let correctedRound = 0;
  for (let round = 1; round <= MAX_PACKET_ROUND; round += 1) {
    if (state.correctionsByPacket.has(packetIdAt(round))) correctedRound = round;
  }

  let currentText = ocrText;
  for (let round = 1; round <= correctedRound; round += 1) {
    const packetId = packetIdAt(round);
    const correction = state.correctionsByPacket.get(packetId);
    if (!correction) continue; // Historical round without a stored decision.
    if (correction.verdict === "PASS") {
      return currentText; // Agent affirmed the OCR text.
    }
    if (correction.verdict === "BLOCK") {
      state.blockedFields.push({
        packet_id: packetId,
        field,
        unit_key: draft.unitKey,
        word_key: draft.word.word_key,
        current_text: currentText,
        round: correction.round,
      });
      return null;
    }
    // REPAIR: a clean correction is applied; an invalid one stays rejected.
    const corrected = correction.corrected_text ?? "";
    if (corrected.length > 0 && gatingEvidence(corrected, field).length === 0) {
      state.appliedCorrections.push({
        packet_id: packetId,
        field,
        word_key: draft.word.word_key,
        corrected_text: corrected,
        agent_run_id: correction.agent_run_id,
        round: correction.round,
      });
      return corrected;
    }
    currentText = corrected.length > 0 ? corrected : currentText;
  }

  const packetId = packetIdAt(correctedRound + 1);
  const evidence = evidenceFor(currentText, block.confidence, field, config);
  if (evidence.length === 0) {
    return currentText; // Deterministically accepted: no review needed.
  }
  if (correctedRound >= MAX_PACKET_ROUND) {
    // The repair budget is exhausted with the field still invalid.
    state.blockedFields.push({
      packet_id: packetIdAt(MAX_PACKET_ROUND),
      field,
      unit_key: draft.unitKey,
      word_key: draft.word.word_key,
      current_text: currentText,
      round: MAX_PACKET_ROUND,
    });
    return null;
  }
  // Unanswered packet: emit (or keep) the review for this round.
  state.fieldReviews.push({
    packet_id: packetId,
    field,
    unit_key: draft.unitKey,
    word_key: draft.word.word_key,
    page_number: block.page,
    page_image_sha256: block.pageImageSha256,
    bbox: block.bbox,
    current_text: currentText,
    ocr_confidence: block.confidence,
    evidence_codes: evidence,
    round: correctedRound + 1,
  });
  return currentText;
}

function resolveReviews(state: WalkState, corrections: readonly VisualCorrection[]): void {
  state.correctionsByPacket = new Map(
    corrections.map((correction) => [correction.packet_id, correction]),
  );
  for (const draft of state.wordDrafts) {
    const headword = resolveField(state, draft, "headword", draft.headword);
    if (headword !== null && headword !== draft.word.headword) draft.word.headword = headword;
    if (draft.phonetic !== null) {
      const phonetic = resolveField(state, draft, "phonetic", draft.phonetic);
      if (phonetic !== null && phonetic !== draft.word.phonetic) draft.word.phonetic = phonetic;
    }
  }
}

/** Which detector produced a page's unit signal. */
type SignalKind = "banner" | "tab";

/**
 * Unit signal found on one page: the captured number plus the block that
 * named it (provenance anchor for the Unit record). An opener banner wins
 * over the page's side tab; both carry the same number on a real opener.
 */
interface PageSignal {
  kind: SignalKind;
  number: number;
  anchor: PreprocessedBlock;
  title: string;
}

/**
 * Chapter context per page (spec 5.4, calibration v3). Chapter openers
 * ("Chapter N" near the page top, exactly one candidate per page) are
 * authoritative and must be contiguous from chapter 1; everything before the
 * first opener is front matter (chapter null — no unit may open and no
 * signal is heard), everything from the back-matter marker on is signal-inert.
 */
interface ChapterTimeline {
  chapterByPage: Array<number | null>;
  /** Page index back matter starts at, or null when the book has none. */
  backMatterFromIndex: number | null;
  /** Chapter opener blocks by the page index they open. */
  openers: Map<number, { chapter: number; anchor: PreprocessedBlock }>;
}

function chapterTimeline(
  pages: readonly PreprocessedBlock[][],
  config: NormalizeBookConfig,
): ChapterTimeline {
  const openerRe = new RegExp(config.chapter_opener_pattern, "u");
  const backMatterRes = config.back_matter_patterns.map((pattern) => new RegExp(pattern, "u"));
  const chapterByPage: Array<number | null> = [];
  const openers = new Map<number, { chapter: number; anchor: PreprocessedBlock }>();
  let current: number | null = null;
  let backMatterFromIndex: number | null = null;
  pages.forEach((blocksOfPage, index) => {
    if (backMatterFromIndex === null) {
      for (const block of blocksOfPage) {
        if (
          block.bbox[1] <= config.back_matter_y_max &&
          backMatterRes.some((re) => re.test(block.normalizedText))
        ) {
          backMatterFromIndex = index;
          break;
        }
      }
    }
    if (backMatterFromIndex === null) {
      const candidates = blocksOfPage.filter(
        (block) =>
          block.bbox[1] <= config.chapter_opener_y_max && openerRe.test(block.normalizedText),
      );
      if (candidates.length === 1) {
        const match = openerRe.exec(candidates[0]!.normalizedText);
        const captured = Number.parseInt(match?.[1] ?? "", 10);
        if (Number.isInteger(captured) && captured > 0) {
          if (current === null && captured !== 1) {
            throw new Error(
              `first chapter opener on page ${candidates[0]!.page} is chapter ${captured}; ` +
                "expected chapter 1 — a misread opener must not re-root the book",
            );
          }
          if (current !== null && captured !== current + 1) {
            throw new Error(
              `chapter opener ${captured} on page ${candidates[0]!.page} follows chapter ` +
                `${current}; chapter openers must be contiguous`,
            );
          }
          current = captured;
          openers.set(index, { chapter: captured, anchor: candidates[0]! });
        }
      }
    }
    chapterByPage.push(backMatterFromIndex === null ? current : current);
  });
  return { chapterByPage, backMatterFromIndex, openers };
}

/** The page's unit signal: an opener banner match, else its right-rail tab. */
function pageSignal(
  blocksOfPage: readonly PreprocessedBlock[],
  unitTitleRes: readonly RegExp[],
  config: NormalizeBookConfig,
): PageSignal | null {
  for (const block of blocksOfPage) {
    for (const re of unitTitleRes) {
      const match = re.exec(block.normalizedText);
      if (match) {
        const captured = Number.parseInt(match[1] ?? "", 10);
        if (Number.isInteger(captured) && captured > 0) {
          return { kind: "banner", number: captured, anchor: block, title: block.normalizedText };
        }
      }
    }
  }
  let tabBlock: PreprocessedBlock | null = null;
  for (const block of blocksOfPage) {
    if (matchUnitTabNumber(block, config) !== null) tabBlock = block; // last wins: bottom rail
  }
  if (tabBlock) {
    const number = matchUnitTabNumber(tabBlock, config)!;
    return { kind: "tab", number, anchor: tabBlock, title: `Unit ${number}` };
  }
  return null;
}

/**
 * Digit readings a 1-2 digit tab could represent: the literal value, its
 * digit reversal ("10" for "01"), and its 180° rotation ("90" for "06",
 * "60" for "09"). Calibrated on the real raster, where the stylized thumb-tab
 * digits misread in exactly these ways while the true value stays recoverable.
 */
function tabCandidates(number: number): number[] {
  const digits = String(number);
  const reversed = [...digits].reverse().join("");
  const rotated = [...reversed]
    .map((digit) => (digit === "6" ? "9" : digit === "9" ? "6" : digit))
    .join("");
  return [...new Set([number, Number.parseInt(reversed, 10), Number.parseInt(rotated, 10)])]
    .filter((value) => Number.isInteger(value) && value > 0 && value < 100);
}

/** Runs of consecutive signaled pages carrying the same captured number. */
function signalRuns(signals: readonly (PageSignal | null)[]): Array<{
  start: number;
  end: number;
  value: number;
}> {
  const indexes = signals.flatMap((signal, index) => (signal ? [index] : []));
  const runs: Array<{ start: number; end: number; value: number }> = [];
  indexes.forEach((index) => {
    const value = signals[index]!.number;
    const last = runs[runs.length - 1];
    if (last && last.value === value) last.end = index;
    else runs.push({ start: index, end: index, value });
  });
  return runs;
}

/**
 * Unit attribution for signal-less pages (unit openers whose stylized banner
 * defeats OCR, chapter dividers, trailing even-printed pages): nearest
 * signaled page wins, ties keep the earlier unit. A page before any signal
 * belongs to the first signal's unit (an opener page precedes its unit's
 * first tab page); a page after every signal stays with the open unit.
 * Pages WITHOUT chapter context (front matter, and books that never open a
 * chapter) are never attributed: their content lands in the pre-unit bucket
 * and the stage fails closed.
 *
 * Signal conditioning before attribution, all deterministic:
 * - a SINGLE-page tab run that disagrees with identical neighbor runs is an
 *   OCR misread of the repeated tab and is corrected to the neighbors (units
 *   never interleave, so a one-page unit between two pages of one and the
 *   same other unit is impossible);
 * - a single-page tab run whose digit-candidate set intersects only the
 *   previous (or only the next) run adopts that neighbor's value — the
 *   opener-spread tab misread that reads as the NEW unit's digits ("60" for
 *   "09") joins the unit it opens;
 * - a chapter whose page range carries NO unit signal at all (the real
 *   chapter 4's stylized tabs defeat OCR entirely) gets one synthetic
 *   chapter-level signal at its opener page, numbered 1 — the chapter-aware
 *   guard makes that restart legal, and the chapter's pages do not drain
 *   into the previous chapter's last unit.
 */
function attributePages(
  pages: readonly PreprocessedBlock[][],
  unitTitleRes: readonly RegExp[],
  config: NormalizeBookConfig,
): {
  attributions: Array<{
    unitNumber: number;
    chapter: number;
    kind: SignalKind;
    anchor: PreprocessedBlock;
    title: string;
  }>;
  /** True when the book carries at least one chapter opener. */
  hasChapters: boolean;
} {
  const timeline = chapterTimeline(pages, config);
  const signals: Array<PageSignal | null> = pages.map((blocksOfPage, index) => {
    if (timeline.chapterByPage[index] === null) return null; // front matter
    if (timeline.backMatterFromIndex !== null && index >= timeline.backMatterFromIndex) {
      return null; // back matter: rail digits there are noise
    }
    return pageSignal(blocksOfPage, unitTitleRes, config);
  });

  // Collapse isolated single-page misreads of the repeating tab. Runs are
  // taken over the SIGNALED pages only (signal-less gaps between tab pages
  // are the normal even/odd rail rhythm, not run separators). Rewrites adopt
  // the neighbors' VALUE (never their signal objects), so each run is judged
  // against the original runs and collapses cannot cascade.
  const runs = signalRuns(signals);
  for (let index = 1; index < runs.length - 1; index += 1) {
    const run = runs[index]!;
    const previous = runs[index - 1]!;
    const next = runs[index + 1]!;
    if (run.start === run.end && run.value !== previous.value && previous.value === next.value) {
      for (let page = run.start; page <= run.end; page += 1) {
        const anchor = signals[page]!.anchor;
        signals[page] = {
          kind: "tab",
          number: previous.value,
          anchor,
          title: `Unit ${previous.value}`,
        };
      }
    }
  }

  // Candidate-set merge: a lone tab between two different-unit runs joins the
  // neighbor whose digit readings overlap its own (previous wins: staying
  // with the open unit is the conservative reading).
  const mergedRuns = signalRuns(signals);
  for (let index = 1; index < mergedRuns.length - 1; index += 1) {
    const run = mergedRuns[index]!;
    if (run.start !== run.end) continue;
    const signal = signals[run.start]!;
    if (signal.kind !== "tab") continue;
    const previous = signals[mergedRuns[index - 1]!.start]!;
    const next = signals[mergedRuns[index + 1]!.end]!;
    if (previous.kind !== "tab" || next.kind !== "tab") continue;
    const candidates = tabCandidates(signal.number);
    const rewrite = (value: number): void => {
      signals[run.start] = { kind: "tab", number: value, anchor: signal.anchor, title: `Unit ${value}` };
    };
    if (tabCandidates(previous.number).some((value) => candidates.includes(value))) {
      rewrite(previous.number);
    } else if (tabCandidates(next.number).some((value) => candidates.includes(value))) {
      rewrite(next.number);
    }
  }

  // Chapter-level fallback for chapters whose tabs never surfaced in OCR.
  let start = 0;
  while (start < pages.length) {
    const chapter = timeline.chapterByPage[start]!;
    let end = start;
    while (end + 1 < pages.length && timeline.chapterByPage[end + 1] === chapter) end += 1;
    const opener = chapter !== null ? timeline.openers.get(start) : undefined;
    if (
      chapter !== null &&
      opener &&
      !signals.slice(start, end + 1).some((signal) => signal !== null)
    ) {
      signals[start] = {
        kind: "banner",
        number: 1,
        anchor: opener.anchor,
        title: opener.anchor.normalizedText,
      };
    }
    start = end + 1;
  }

  const signalIndexes = signals.flatMap((signal, index) => (signal ? [index] : []));
  const attributions = signals.map((signal, index) => {
    const chapterOf = (pageIndex: number): number => timeline.chapterByPage[pageIndex] ?? 0;
    if (signal) {
      return {
        unitNumber: signal.number,
        chapter: chapterOf(index),
        kind: signal.kind,
        anchor: signal.anchor,
        title: signal.title,
      };
    }
    if (chapterOf(index) === 0) {
      // No chapter context anywhere for this page: pre-unit bucket (fails
      // closed downstream if it ever holds word entries).
      return { unitNumber: 0, chapter: 0, kind: "tab" as const, anchor: pages[index]![0]!, title: "" };
    }
    const previous = [...signalIndexes].reverse().find((candidate) => candidate < index);
    const next = signalIndexes.find((candidate) => candidate > index);
    if (previous === undefined && next === undefined) {
      // A signal-less page in a chaptered book with no signals at all: leave
      // it unattributed (pre-unit bucket, fails closed downstream).
      return { unitNumber: 0, chapter: 0, kind: "tab" as const, anchor: pages[index]![0]!, title: "" };
    }
    const source =
      previous === undefined
        ? next!
        : next === undefined || index - previous <= next - index
          ? previous
          : next!;
    const chosen = signals[source]!;
    return {
      unitNumber: chosen.number,
      chapter: chapterOf(source),
      kind: chosen.kind,
      anchor: chosen.anchor,
      title: chosen.title,
    };
  });
  return { attributions, hasChapters: timeline.openers.size > 0 };
}
/** Group reading-ordered blocks by page, preserving in-page order. */
function groupByPage<T extends { page: number }>(blocks: readonly T[]): Map<number, T[]> {
  const byPage = new Map<number, T[]>();
  for (const block of blocks) {
    const list = byPage.get(block.page);
    if (list) list.push(block);
    else byPage.set(block.page, [block]);
  }
  return byPage;
}

/**
 * Unit number carried by a side-tab block, or null. The real raster repeats
 * the unit's number as a bare 1-2 digit thumb-tab in the RIGHT rail (the tab
 * slides down the rail as the unit advances). Position (x0 >= `unit_tab_x_min`
 * inside the `unit_tab_y_min`..`unit_tab_y_max` band) is what distinguishes a
 * tab from the bare entry numbers printed inside the text column and from the
 * page numbers at the outer bottom corners.
 */
function matchUnitTabNumber(block: PreprocessedBlock, config: NormalizeBookConfig): number | null {
  if (block.bbox[0] < config.unit_tab_x_min) return null;
  if (block.bbox[1] < config.unit_tab_y_min || block.bbox[1] > config.unit_tab_y_max) return null;
  const match = new RegExp(config.unit_tab_number_pattern, "u").exec(block.normalizedText);
  if (!match) return null;
  const number = Number.parseInt(match[1] ?? match[0], 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Recover book/Unit/word/sense/phrase/example records from OCR blocks.
 * `blocks` must already be in reading order (see `assignReadingOrder`);
 * page furniture is partitioned off internally before segmentation.
 */
export function segmentStructure(
  blocks: readonly NormalizeInputBlock[],
  config: NormalizeBookConfig,
  corrections: readonly VisualCorrection[] = [],
): NormalizeOutput {
  const content = partitionPageFurniture(preprocess(blocks), DEFAULT_FURNITURE_CONFIG).content;

  const unitTitleRes = config.unit_title_patterns.map((pattern) => new RegExp(pattern, "u"));
  const state: WalkState = {
    config,
    correctionsByPacket: new Map(),
    units: [],
    unitBoundaries: [],
    boundaryByUnit: new Map(),
    words: [],
    wordDrafts: [],
    senses: [],
    phrases: [],
    examples: [],
    fieldReviews: [],
    blockedFields: [],
    appliedCorrections: [],
    currentUnit: null,
    currentUnitNumber: 0,
    currentUnitChapter: 0,
    currentWord: null,
    pendingSourceRef: undefined,
    wordKeys: new Set(),
    unitWordCount: new Map(),
  };

  const groupedPages = [...groupByPage(content).values()];
  const { attributions, hasChapters } = attributePages(groupedPages, unitTitleRes, config);

  groupedPages.forEach((blocksOfPage, pageIndex) => {
    // Page-level unit attribution: the right-rail tab names the unit that
    // owns the WHOLE page (it physically sits near the rail — after the page
    // content in reading order), and signal-less pages (openers whose
    // stylized banner defeats OCR, chapter dividers, trailing pages) follow
    // the nearest tab signal. Front-matter pages (no chapter context) are
    // never attributed. Open the page's unit before reading it.
    const { unitNumber, chapter, kind, anchor, title } = attributions[pageIndex]!;
    if (chapter === 0 && hasChapters) {
      // Calibrated front matter (before the first chapter opener): book
      // apparatus — preface prose and word-family samplers — never unit
      // vocabulary. A book with NO chapter context at all keeps the old
      // behavior (content lands in the pre-unit bucket and fails closed).
      return;
    }
    if (unitNumber > 0) {
      // Tab digit-candidate resolution (banners are always literal):
      // - a tab whose readings include the OPEN unit's number is that unit's
      //   repeating tab (the real "10"/"01" alternation inside unit 1);
      // - otherwise a chapter's FIRST tab resolves to the smallest reading —
      //   the real chapter 1 opens on tabs misread "10" for "01", and the
      //   reversed candidate is the only plausible first unit;
      // - later tabs keep their literal value.
      let resolved = unitNumber;
      if (kind === "tab") {
        const candidates = tabCandidates(unitNumber);
        if (
          state.currentUnit !== null &&
          state.currentUnitChapter === chapter &&
          candidates.includes(state.currentUnitNumber)
        ) {
          resolved = state.currentUnitNumber;
        } else if (state.currentUnitChapter !== chapter) {
          resolved = Math.min(...candidates);
        }
      }
      const resolvedTitle = resolved !== unitNumber ? `Unit ${resolved}` : title;
      const unitKey = `c${chapter}.u${resolved}`;
      if (unitKey !== state.currentUnit?.unit_key) {
        startUnit(state, anchor, chapter, resolved, resolvedTitle, blocksOfPage[0]!.page);
      }
    }

    for (const block of blocksOfPage) {
      const text = block.normalizedText;
      let unitMatch: RegExpExecArray | null = null;
      for (const re of unitTitleRes) {
        const match = re.exec(text);
        if (match) {
          unitMatch = match;
          break;
        }
      }
      if (unitMatch) {
        // Opener banner: the captured group is the unit's real number. Only
        // chapter context makes a banner meaningful — a contents page's unit
        // lines live before the first opener and must never open a unit.
        if (chapter > 0) {
          const captured = Number.parseInt(unitMatch[1] ?? "", 10);
          const bannerNumber =
            Number.isInteger(captured) && captured > 0 ? captured : state.units.length + 1;
          const bannerKey = `c${chapter}.u${bannerNumber}`;
          if (bannerKey !== state.currentUnit?.unit_key) {
            startUnit(state, block, chapter, bannerNumber, text, block.page);
          }
        }
        continue;
      }
      if (matchUnitTabNumber(block, config) !== null) {
        // Per-page side tab: attribution already handled it; never content.
        continue;
      }
      if (config.note_patterns.some((pattern) => new RegExp(pattern, "u").test(text))) {
        continue; // Word-root/synonym notes carry no learnable entity.
      }
      const headMatch = HEAD_ENTRY_RE.exec(text);
      if (headMatch && findPosMarker(headMatch[3] ?? "", config.pos_markers) !== null) {
        startWord(state, block, headMatch);
        continue;
      }
      if (text.startsWith(config.exam_marker)) {
        addExample(state, block, config.exam_marker);
        continue;
      }
      if (state.currentWord && CJK_RANGE.test(text.slice(0, 1))) {
        // A CJK-leading tail of the open entry: a multi-line gloss
        // continuation, or the gloss block of a headword line that ended at
        // its POS marker. Without this branch such blocks matched nothing and
        // were silently dropped (words could end up with zero senses).
        attachCjkGloss(state, block);
        continue;
      }
      if (
        block.confidence >= config.non_critical_confidence_min &&
        state.currentWord &&
        !CJK_RANGE.test(text.slice(0, 1))
      ) {
        addPhrase(state, block);
      }
    }
  });

  resolveReviews(state, corrections);

  const first = content[0];
  const book: BookT = {
    book_key: config.book_key,
    title: config.book_title,
    edition: config.book_edition,
    source_pdf_sha256: first?.sourcePdfSha256 ?? ZERO_HASH,
    page_number: first?.page ?? 1,
    page_image_sha256: first?.pageImageSha256 ?? ZERO_HASH,
    bbox: [0, 0, 1, 1],
    source_raw_ref_hash: first?.sourceRawRefHash ?? ZERO_HASH,
    source_normalized_text: config.book_title,
    ocr_confidence: 1,
    structure_confidence: 1,
  };

  return {
    book,
    units: state.units,
    words: state.words,
    senses: state.senses,
    phrases: state.phrases,
    examples: state.examples,
    unitBoundaries: state.unitBoundaries,
    fieldReviews: state.fieldReviews,
    blockedFields: state.blockedFields,
    appliedCorrections: state.appliedCorrections,
  };
}
