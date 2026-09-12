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
  head: NormalizeInputBlock;
  headword: string;
  phonetic: string | null;
  senseDrafts: SenseDraft[];
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
 * Open (or re-point to) the unit carried by a banner with the captured number
 * `unitNumber`. The captured number is authoritative (Task 6 minor): the
 * unit key and order derive from it, never from discovery order, so unit
 * identity is stable regardless of which pages a run happens to cover.
 *
 * Side tabs repeat the unit's number on every page; a banner whose number
 * equals the currently open unit never re-opens it. A banner re-opening an
 * already-closed unit (banner numbers must be monotonic in page order) is a
 * determinism violation and fails loudly instead of mis-attributing words.
 */
function startUnit(
  state: WalkState,
  block: PreprocessedBlock,
  unitNumber: number,
  title: string,
  firstPage: number,
): void {
  const unitKey = `u${unitNumber}`;
  const existing = state.boundaryByUnit.get(unitKey);
  if (existing) {
    if (state.currentUnit === existing) return; // repeated per-page tab
    throw new Error(
      `unit banner ${unitKey} re-appeared on page ${block.page} after unit ` +
        `${state.currentUnit?.unit_key ?? "?"} opened; banner numbers must be monotonic`,
    );
  }
  const unit: UnitT = {
    unit_key: unitKey,
    book_key: state.config.book_key,
    level: 1,
    unit_order: unitNumber,
    title,
    ...provenance(block),
  };
  const boundary: UnitBoundary = {
    unit_key: unitKey,
    unit_order: unitNumber,
    title,
    first_page: firstPage,
    last_page: firstPage,
  };
  state.units.push(unit);
  state.unitBoundaries.push(boundary);
  state.boundaryByUnit.set(unitKey, boundary);
  state.currentUnit = boundary;
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

/**
 * Unit signal found on one page: the captured number plus the block that
 * named it (provenance anchor for the Unit record).
 */
interface PageSignal {
  number: number;
  anchor: PreprocessedBlock;
  title: string;
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
          return { number: captured, anchor: block, title: block.normalizedText };
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
    return { number, anchor: tabBlock, title: `Unit ${number}` };
  }
  return null;
}

/**
 * Unit attribution for signal-less pages (unit openers whose stylized banner
 * defeats OCR, chapter dividers, trailing even-printed pages): nearest
 * signaled page wins, ties keep the earlier unit. A page before any signal
 * belongs to the first signal's unit (an opener page precedes its unit's
 * first tab page); a page after every signal stays with the open unit.
 *
 * Before attribution, a SINGLE-page signal run that disagrees with identical
 * neighbor runs is an OCR misread of the repeated tab and is corrected to the
 * neighbors (units never interleave, so a one-page unit between two pages of
 * one and the same other unit is impossible). Multi-page disagreement still
 * stands as a real signal, and genuine monotonicity violations throw below.
 */
function attributePages(
  pages: readonly PreprocessedBlock[][],
  unitTitleRes: readonly RegExp[],
  config: NormalizeBookConfig,
): Array<{ unitNumber: number; anchor: PreprocessedBlock; title: string }> {
  const signals = pages.map((blocksOfPage) => pageSignal(blocksOfPage, unitTitleRes, config));

  // Collapse isolated single-page misreads of the repeating tab. Runs are
  // taken over the SIGNALED pages only (signal-less gaps between tab pages
  // are the normal even/odd rail rhythm, not run separators).
  const signalIndexes = signals.flatMap((signal, index) => (signal ? [index] : []));
  const runs: Array<{ start: number; end: number; value: number }> = [];
  signalIndexes.forEach((index) => {
    const value = signals[index]!.number;
    const last = runs[runs.length - 1];
    if (last && last.value === value) last.end = index;
    else runs.push({ start: index, end: index, value });
  });
  for (let index = 1; index < runs.length - 1; index += 1) {
    const run = runs[index]!;
    const previous = runs[index - 1]!;
    const next = runs[index + 1]!;
    if (run.start === run.end && run.value !== previous.value && previous.value === next.value) {
      for (let page = run.start; page <= run.end; page += 1) {
        signals[page] = signals[previous.start]!;
      }
    }
  }

  return signals.map((signal, index) => {
    if (signal) return { unitNumber: signal.number, anchor: signal.anchor, title: signal.title };
    const previous = [...signalIndexes].reverse().find((candidate) => candidate < index);
    const next = signalIndexes.find((candidate) => candidate > index);
    if (previous === undefined && next === undefined) {
      // A page with no signal at all anywhere: leave it unattributed (its
      // content lands in the pre-unit bucket and the stage fails closed).
      return { unitNumber: 0, anchor: pages[index]![0]!, title: "" };
    }
    if (previous === undefined) {
      const chosen = signals[next!]!;
      return { unitNumber: chosen.number, anchor: chosen.anchor, title: chosen.title };
    }
    if (next === undefined) {
      const chosen = signals[previous]!;
      return { unitNumber: chosen.number, anchor: chosen.anchor, title: chosen.title };
    }
    const previousDistance = index - previous;
    const nextDistance = next - index;
    const chosen = previousDistance <= nextDistance ? signals[previous]! : signals[next]!;
    return { unitNumber: chosen.number, anchor: chosen.anchor, title: chosen.title };
  });
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
 * the unit's number as a bare 1-2 digit block in the right rail of every
 * page; position (x0 >= `unit_tab_x_min`) is what distinguishes a tab from
 * the bare entry numbers printed inside the text column.
 */
function matchUnitTabNumber(block: PreprocessedBlock, config: NormalizeBookConfig): number | null {
  if (block.bbox[0] < config.unit_tab_x_min) return null;
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
    currentWord: null,
    pendingSourceRef: undefined,
    wordKeys: new Set(),
    unitWordCount: new Map(),
  };

  const groupedPages = [...groupByPage(content).values()];
  const attribution = attributePages(groupedPages, unitTitleRes, config);

  groupedPages.forEach((blocksOfPage, pageIndex) => {
    // Page-level unit attribution: the right-rail tab names the unit that
    // owns the WHOLE page (it physically sits near the rail's bottom — after
    // the page content in reading order), and signal-less pages (openers
    // whose stylized banner defeats OCR, chapter dividers, trailing pages)
    // follow the nearest tab signal. Open the page's unit before reading it.
    const { unitNumber, anchor, title } = attribution[pageIndex]!;
    if (unitNumber > 0 && unitNumber !== state.currentUnit?.unit_order) {
      startUnit(state, anchor, unitNumber, title, blocksOfPage[0]!.page);
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
        // Opener banner: the captured group is the unit's real number.
        const captured = Number.parseInt(unitMatch[1] ?? "", 10);
        const bannerNumber =
          Number.isInteger(captured) && captured > 0 ? captured : state.units.length + 1;
        if (bannerNumber !== state.currentUnit?.unit_order) {
          startUnit(state, block, bannerNumber, text, block.page);
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
