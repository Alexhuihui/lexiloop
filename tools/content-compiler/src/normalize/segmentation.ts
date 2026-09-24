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
import { textContainsHeadword } from "./content-quality";
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
const SIMPLE_HEADWORD_TOKEN = String.raw`[A-Za-z](?:[A-Za-z'’\-]|\([A-Za-z]+\))*`;
const HEADWORD_TOKEN = String.raw`${SIMPLE_HEADWORD_TOKEN}(?:/(?:${SIMPLE_HEADWORD_TOKEN}|-[A-Za-z]+))*`;
const HEAD_ENTRY_RE = new RegExp(
  String.raw`^(${HEADWORD_TOKEN})\s*(\/[^/]+\/|\[[^\]]+\])\s*(.*)$`,
  "su",
);
const BARE_HEADWORD_RE = new RegExp(String.raw`^${HEADWORD_TOKEN}$`, "u");
const PHONETIC_TAIL_RE = /^(\/[^/]+\/|\[[^\]]+\])\s*(.*)$/su;
const MALFORMED_BRACKET_PHONETIC_RE = new RegExp(
  String.raw`^[^\s\[\]][^\s\[\]]{1,40}\]\s*(.*)$`,
  "su",
);
const ENTRY_BADGE_RE = /^\d{3}$/u;
const SOURCE_REF_RE = /[（(]([^（()）]*\d[^（()）]*)[）)]\s*$/u;
const SOURCE_REF_ONLY_RE = /^[（(]([^（()）]*\d[^（()）]*)[）)]$/u;
const SENSE_SPLIT_RE = /[①②③④⑤⑥⑦⑧⑨⑩]/gu;

function sha8(value: string): string {
  return hashString(value).slice(0, 8);
}

function logicalHeadwordSlug(headword: string): string {
  return headword
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
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
  const normalized = text.replace(SENSE_SPLIT_RE, " ");
  const occurrences: Array<{ marker: string; index: number }> = [];
  for (const marker of [...config.pos_markers].sort((a, b) => b.length - a.length)) {
    let from = 0;
    while (from < normalized.length) {
      const index = normalized.indexOf(marker, from);
      if (index < 0) break;
      const previous = index > 0 ? normalized[index - 1]! : "";
      if (!/[A-Za-z]/u.test(previous)) occurrences.push({ marker, index });
      from = index + marker.length;
    }
  }
  occurrences.sort((a, b) => a.index - b.index || b.marker.length - a.marker.length);
  const unique = occurrences.filter(
    (entry, index) => index === 0 || entry.index !== occurrences[index - 1]!.index,
  );
  const senses: SenseDraft[] = [];
  for (const [index, found] of unique.entries()) {
    const end = unique[index + 1]?.index ?? normalized.length;
    const gloss = normalized
      .slice(found.index + found.marker.length, end)
      .replace(/^[,，:：;；]\s*/u, "")
      .trim();
    if (gloss.length === 0) continue;
    senses.push({ pos: posValue(found.marker), gloss });
  }
  return senses;
}

interface PreprocessedBlock extends NormalizeInputBlock {
  normalizedText: string;
  /** Confidence of the physical OCR row that supplied each critical field. */
  headwordConfidence?: number;
  phoneticConfidence?: number;
}

function preprocess(blocks: readonly NormalizeInputBlock[]): PreprocessedBlock[] {
  return blocks.flatMap((block) => {
    const normalizedText = joinHyphenatedLines(normalizeUnicodeText(block.text)).text
      .replace(/(^|[^A-Za-z])adi[j.]?(?=[,，:：;；\u3400-\u9fff])/gu, "$1adj.")
      .replace(
        /(^|[^A-Za-z])(interj|modal|abbr|prep|conj|pron|adj|adv|aux|phr|art|num|vi|vt|n|v)(?=[(\u3400-\u9fff])/gu,
        "$1$2.",
      )
      .replace(/(?<=[\u3400-\u9fff])(?:号[:：])?神灯考研.*$/u, "");
    // The decorative 真 marker has a dense right-hand stroke and PaddleOCR
    // occasionally reads it as 具. It is safe to repair only at line start
    // when an English example/phrase follows immediately.
    const repairedMarker = normalizedText
      .replace(/^具\s*(?=[A-Za-z])/u, "真 ")
      .replace(/^[\u3400-\u9fff]{1,8}真\s+(?=[A-Za-z])/u, "真 ")
      .replace(/^dj\.$/u, "adj.");
    const damagedAdj = new RegExp(
      String.raw`^((?:${HEADWORD_TOKEN}\s*)?(?:\/[^/]+\/|\[[^\]]+\])\s*)ad\.(?=\s*[\u3400-\u9fff])`,
      "u",
    );
    const repairedPos = repairedMarker.replace(damagedAdj, "$1adj.");
    const missingSameLineBracket = new RegExp(
      String.raw`^(${HEADWORD_TOKEN})\s+([^\s\[\]]{2,40}\]\s*(?:interj|modal|abbr|prep|conj|pron|adj|adv|aux|phr|art|num|vi|vt|n|v)\.)`,
      "u",
    );
    const repairedSameLinePhonetic = repairedPos.replace(missingSameLineBracket, "$1 [$2");
    const repairedLeadingPhonetic = repairedSameLinePhonetic
      .replace(/^思(?=\[[^\]]+\]\s*)/u, "")
      // Verified on source page 174: lowercase l in the optional British
      // spelling was OCR'd as uppercase I, which otherwise prevents the bare
      // headword from joining its phonetic/POS block.
      .replace(/^fulfil\(I\)$/u, "fulfil(l)")
      // Verified on source page 358. The decorative glory header collapsed
      // into its phonetic and corrupted gloss; the overlapping clean meta row
      // below retains the pronunciation and definition.
      .replace(/^gioryTgisim\]n\..*$/u, "glory");
    // Likewise, the opening square bracket of a phonetic is occasionally read
    // as `{`. Restrict the repair to a complete headword row ending in `]` and
    // lower its confidence so both critical fields still require visual review.
    const malformedHeadPhonetic = new RegExp(
      String.raw`^(${HEADWORD_TOKEN})\s*(?:\{|[lI](?=['’]))(?=[^}\n]{1,40}\]\s*)`,
      "u",
    );
    let repairedHead = repairedLeadingPhonetic.replace(malformedHeadPhonetic, "$1 [");

    // A few source rows are both visually unambiguous and structurally
    // important: leaving them damaged creates duplicate words or assigns an
    // example to its neighbor. These repairs are page-scoped transcriptions
    // from the rendered book, never dictionary guesses.
    if (block.page === 151 && /^the univercol bitoy世界中$/u.test(repairedHead)) {
      repairedHead = "the universal history 世界史";
    }
    if (block.page === 170 && repairedHead === "insure 承保；确保") {
      // The original page shows a separate insure headword and phonetic row;
      // the cleaned-page OCR fused its gloss into the bare headword block.
      repairedHead = "insure";
    }
    if (block.page === 280 && /^fix \[fiks\]$/u.test(repairedHead)) {
      repairedHead = "fix [fiks] vt. 使固定；修理；修复；安装；确定 n. 解决方法；困境";
    }
    if (block.page === 295 && /^\[dim\]\s*adj\./u.test(repairedHead)) {
      repairedHead = `dim ${repairedHead}`;
    }
    if (block.page === 307 && /^biologicalbarlikl\]$/u.test(repairedHead)) {
      repairedHead = "biological [,baɪəˈlɒdʒɪkl]";
    }
    if (block.page === 335 && repairedHead === "it") {
      repairedHead = "quit";
    }
    if (block.page === 315 && repairedHead === "int" &&
        block.bbox[1] > 0.86 && block.bbox[1] < 0.88) {
      // Source page 301 visibly prints "hint"; OCR clipped its first letter.
      repairedHead = "hint";
    }

    const redundantSourceFragment =
      (block.page === 151 && /^真\s*tle unnvelsar mhstory/u.test(repairedHead)) ||
      (block.page === 280 && (/^定n\.解决方法；困境$/u.test(repairedHead) || /^vt\.使固定；修理；修复；安装；$/u.test(repairedHead))) ||
      (block.page === 322 && (/^adults are addicted to alconol or drugs\./u.test(repairedHead) || /^问题是许多无家可归的成年人酗酒或吸毒/u.test(repairedHead) || /^成瘾。$/u.test(repairedHead))) ||
      (block.page === 353 && /^v\.加强$/u.test(repairedHead));
    if (redundantSourceFragment) return [];

    return [{
      ...block,
      normalizedText: repairedHead,
      ...(repairedHead !== repairedMarker ? { confidence: 0 } : {}),
    }];
  });
}

function mergeBlocks(left: PreprocessedBlock, right: PreprocessedBlock, separator = " "): PreprocessedBlock {
  return {
    ...left,
    blockKey: `${left.blockKey}+${right.blockKey}`,
    bbox: [
      Math.min(left.bbox[0], right.bbox[0]),
      Math.min(left.bbox[1], right.bbox[1]),
      Math.max(left.bbox[2], right.bbox[2]),
      Math.max(left.bbox[3], right.bbox[3]),
    ],
    text: `${left.text}${separator}${right.text}`,
    normalizedText: `${left.normalizedText}${separator}${right.normalizedText}`.trim(),
    confidence: Math.min(left.confidence, right.confidence),
    ...(left.headwordConfidence !== undefined || right.headwordConfidence !== undefined
      ? { headwordConfidence: left.headwordConfidence ?? right.headwordConfidence }
      : {}),
    ...(left.phoneticConfidence !== undefined || right.phoneticConfidence !== undefined
      ? { phoneticConfidence: left.phoneticConfidence ?? right.phoneticConfidence }
      : {}),
    sourceRawRefHash: hashString(`${left.sourceRawRefHash}|${right.sourceRawRefHash}`),
  };
}

function verticalOverlap(left: Bbox, right: Bbox): number {
  const overlap = Math.max(0, Math.min(left[3], right[3]) - Math.max(left[1], right[1]));
  const smaller = Math.min(left[3] - left[1], right[3] - right[1]);
  return smaller > 0 ? overlap / smaller : 0;
}

function horizontalOverlap(left: Bbox, right: Bbox): number {
  return Math.max(0, Math.min(left[2], right[2]) - Math.max(left[0], right[0]));
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function phoneticTailBlock(block: PreprocessedBlock): PreprocessedBlock | null {
  // Bracketed grammar notes (for example "[pl. phenomena]") can sit directly
  // below a split headword. They are sense metadata, not pronunciation, and
  // must not win over the actual phonetic block on the same printed line.
  if (/^\[(?:pl|sing|count|uncount)\./iu.test(block.normalizedText)) return null;
  if (PHONETIC_TAIL_RE.test(block.normalizedText)) {
    // In the source font the leading "v" of "vt." is occasionally lost
    // while the phonetic and the remaining "t." stay clear. Recover this
    // tightly scoped POS marker so the split row can open its own entry.
    const damagedVt = /^((?:\/[^/]+\/|\[[^\]]+\])\s*)(?:t|νt)\./su;
    if (damagedVt.test(block.normalizedText)) {
      return {
        ...block,
        text: block.text.replace(damagedVt, "$1vt."),
        normalizedText: block.normalizedText.replace(damagedVt, "$1vt."),
      };
    }
    return block;
  }
  if (!MALFORMED_BRACKET_PHONETIC_RE.test(block.normalizedText)) return null;
  return {
    ...block,
    text: `[${block.text}`,
    normalizedText: `[${block.normalizedText}`,
  };
}

/** Rejoin OCR fragments that visually form one textbook headword line. */
function assembleSplitHeadwords(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  let current = [...blocks];
  for (let pass = 0; pass < blocks.length; pass += 1) {
    let mergedOnPass = false;
    const consumed = new Set<number>();
    const replacement = new Map<number, PreprocessedBlock>();
    for (const [headIndex, head] of current.entries()) {
      if (consumed.has(headIndex)) continue;
      const parsedHead = HEAD_ENTRY_RE.exec(head.normalizedText);
      const danglingBracket = new RegExp(String.raw`^(${HEADWORD_TOKEN})\s*\[$`, "u").exec(
        head.normalizedText,
      );
      const bareText = danglingBracket?.[1] ?? head.normalizedText;
      const bareLetters = bareText.replace(/[^a-z]/gu, "");
      const isPlausibleBareHeadword =
        bareText === bareText.toLowerCase() && bareLetters.length >= 3 && bareLetters.length <= 30;
      const isBare =
        (BARE_HEADWORD_RE.test(head.normalizedText) || danglingBracket !== null) &&
        isPlausibleBareHeadword;
      const markedPrefix = current
        .slice(Math.max(0, headIndex - 3), headIndex)
        .reverse()
        .find(
          (candidate) =>
            candidate.page === head.page &&
            candidate.normalizedText.startsWith(config.exam_marker) &&
            verticalOverlap(candidate.bbox, head.bbox) >= 0.45 &&
            head.bbox[0] - candidate.bbox[2] >= -0.02 &&
            head.bbox[0] - candidate.bbox[2] <= 0.04,
        );
      const immediatePrefix = current[headIndex - 1];
      const separateMarker = current
        .slice(Math.max(0, headIndex - 3), headIndex - 1)
        .some(
          (candidate) =>
            candidate.page === head.page &&
            candidate.normalizedText === config.exam_marker &&
            immediatePrefix !== undefined &&
            verticalOverlap(candidate.bbox, immediatePrefix.bbox) >= 0.45,
        );
      const followsMarkedPrefix =
        separateMarker &&
        immediatePrefix !== undefined &&
        verticalOverlap(immediatePrefix.bbox, head.bbox) >= 0.45 &&
        head.bbox[0] - immediatePrefix.bbox[2] >= -0.02 &&
        head.bbox[0] - immediatePrefix.bbox[2] <= 0.04;
      const continuesMarkedExample = isBare && (markedPrefix !== undefined || followsMarkedPrefix);
      // OCR often boxes an emphasized target word separately from the rest of
      // the exam sentence. It is sentence text, not another copy of the entry
      // header (for example "Entergy will" + "withdraw" + "its application").
      if (continuesMarkedExample) continue;
      const headForMerge = danglingBracket
        ? {
            ...head,
            text: danglingBracket[1]!,
            normalizedText: danglingBracket[1]!,
          }
        : head;
      const isHeadWithoutPos =
        parsedHead !== null && findPosMarker(parsedHead[3] ?? "", config.pos_markers) === null;
      if (!isBare && !isHeadWithoutPos) continue;

      let best: {
        index: number;
        distance: number;
        tail: PreprocessedBlock;
        syntheticPhonetic: boolean;
        replaceHeadPhonetic: boolean;
      } | null = null;
      for (const [tailIndex, tail] of current.entries()) {
        if (tailIndex === headIndex || consumed.has(tailIndex) || tail.page !== head.page) continue;
        let matches: boolean;
        let distance: number;
        let tailForMerge = tail;
        let syntheticPhonetic = false;
        let replaceHeadPhonetic = false;
        if (isBare) {
          let phoneticTail = phoneticTailBlock(tail);
          if (phoneticTail === null && HEAD_ENTRY_RE.exec(tail.normalizedText) === null) {
            const damagedPos = findPosMarker(tail.normalizedText, config.pos_markers);
            if (damagedPos !== null && damagedPos.index > 0 && damagedPos.index <= 24) {
              const recovered = `[?] ${tail.normalizedText.slice(damagedPos.index)}`;
              phoneticTail = {
                ...tail,
                text: recovered,
                normalizedText: recovered,
                confidence: 0,
              };
              syntheticPhonetic = true;
            }
          }
          const sameLine =
            verticalOverlap(head.bbox, tail.bbox) >= 0.45 &&
            (Math.abs(tail.bbox[0] - head.bbox[2]) <= 0.05 ||
              (tail.bbox[0] > head.bbox[0] && horizontalOverlap(head.bbox, tail.bbox) > 0));
          const gap = tail.bbox[1] - head.bbox[3];
          const directlyBelow =
            gap >= 0 && gap <= 0.025 && horizontalOverlap(head.bbox, tail.bbox) > 0;
          matches = (sameLine || directlyBelow) && phoneticTail !== null;
          if (phoneticTail !== null) tailForMerge = phoneticTail;
          distance = sameLine ? Math.abs(tail.bbox[0] - head.bbox[2]) : gap;
        } else {
          const tailPos = findPosMarker(tail.normalizedText, config.pos_markers);
          const completePhoneticTail = phoneticTailBlock(tail);
          const completePhoneticMatch = completePhoneticTail
            ? PHONETIC_TAIL_RE.exec(completePhoneticTail.normalizedText)
            : null;
          const completePhoneticHasPos =
            completePhoneticMatch !== null &&
            findPosMarker(completePhoneticMatch[2] ?? "", config.pos_markers) !== null;
          const gap = tail.bbox[1] - head.bbox[3];
          const sameLine =
            verticalOverlap(head.bbox, tail.bbox) >= 0.45 &&
            Math.abs(tail.bbox[0] - head.bbox[2]) <= 0.05;
          const directlyBelow =
            gap >= 0 && gap <= 0.045 && horizontalOverlap(head.bbox, tail.bbox) > 0;
          const overlappingDuplicatePhonetic =
            completePhoneticHasPos &&
            verticalOverlap(head.bbox, tail.bbox) >= 0.45 &&
            tail.bbox[0] > head.bbox[0] &&
            horizontalOverlap(head.bbox, tail.bbox) > 0;
          const wrapsToOtherColumn =
            tailIndex > headIndex &&
            current
              .slice(headIndex + 1, tailIndex)
              .every((between) => matchUnitTabNumber(between, config) !== null) &&
            head.bbox[0] < 0.5 &&
            tail.bbox[0] >= 0.5 &&
            tail.bbox[1] < head.bbox[1];
          if (
            completePhoneticTail &&
            completePhoneticHasPos &&
            (sameLine || directlyBelow || overlappingDuplicatePhonetic)
          ) {
            matches = true;
            tailForMerge = completePhoneticTail;
            replaceHeadPhonetic = true;
          } else {
            matches =
              tailPos !== null &&
              tailPos.index <= 2 &&
              (sameLine || directlyBelow || wrapsToOtherColumn);
          }
          distance = sameLine
            ? Math.abs(tail.bbox[0] - head.bbox[2])
            : wrapsToOtherColumn
              ? tailIndex - headIndex
              : gap;
        }
        if (
          matches &&
          (best === null ||
            (best.syntheticPhonetic && !syntheticPhonetic) ||
            (best.syntheticPhonetic === syntheticPhonetic && distance < best.distance))
        ) {
          best = {
            index: tailIndex,
            distance,
            tail: tailForMerge,
            syntheticPhonetic,
            replaceHeadPhonetic,
          };
        }
      }
      if (!best) continue;
      const firstIndex = Math.min(headIndex, best.index);
      const mergeHead =
        best.replaceHeadPhonetic && parsedHead
          ? {
              ...head,
              text: parsedHead[1]!,
              normalizedText: parsedHead[1]!,
            }
          : headForMerge;
      replacement.set(firstIndex, {
        ...mergeBlocks(mergeHead, best.tail),
        headwordConfidence: head.confidence,
        phoneticConfidence: best.tail.confidence,
      });
      consumed.add(headIndex);
      consumed.add(best.index);
      mergedOnPass = true;
    }
    if (!mergedOnPass) return current;
    current = current.flatMap((block, index) => {
      const merged = replacement.get(index);
      if (merged) return [merged];
      return consumed.has(index) ? [] : [block];
    });
  }
  return current;
}

/**
 * Recover the large numbered entry header when OCR kept its English word and
 * the following POS summary but damaged the decorative phonetic. A `[?]`
 * placeholder deliberately carries zero confidence, so the normalizer emits
 * visual-review packets for both critical fields before release.
 */
function assembleNumberedEntryHeaders(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  const consumed = new Set<number>();
  const replacements = new Map<number, PreprocessedBlock>();
  for (const [badgeIndex, badge] of blocks.entries()) {
    if (!ENTRY_BADGE_RE.test(badge.normalizedText.replace(/\s+/gu, ""))) continue;
    let candidateIndex = -1;
    let candidateScore = -1;
    let summaryIndex = -1;
    for (let index = badgeIndex + 1; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      if (block.page !== badge.page || block.bbox[1] > badge.bbox[3] + 0.08) break;
      if (
        /^[A-Za-z]/u.test(block.normalizedText) &&
        verticalOverlap(badge.bbox, block.bbox) >= 0.2
      ) {
        // A split phonetic suffix such as "ari]" can precede the real word in
        // two-column reading order. Prefer a complete bare token, while still
        // retaining the damaged-header fallback used for rows like
        // "governmentI'gavar...".
        const rawCandidate = new RegExp(`^(${HEADWORD_TOKEN})`, "u").exec(
          block.normalizedText,
        )?.[1];
        if (!rawCandidate) continue;
        const artifactIndex = rawCandidate.search(/(?<=[a-z])[A-Z]/u);
        const candidateHeadword =
          artifactIndex > 0 ? rawCandidate.slice(0, artifactIndex) : rawCandidate;
        // OCR often emits the end of a broken phonetic as a second bare Latin
        // block ("rs", "ppar", "ari]"). The printed headword is normally the
        // longer Latin prefix on that same banner row. A small exact-token
        // bonus resolves ties without letting a short fragment beat it.
        const score = candidateHeadword.replace(/[^A-Za-z]/gu, "").length * 2 +
          (BARE_HEADWORD_RE.test(block.normalizedText) ? 1 : 0);
        if (score > candidateScore) {
          candidateIndex = index;
          candidateScore = score;
        }
      }
      const pos = findPosMarker(block.normalizedText, config.pos_markers);
      if (pos !== null && pos.index <= 2) {
        summaryIndex = index;
        break;
      }
    }
    if (candidateIndex < 0 || summaryIndex < 0 || candidateIndex === summaryIndex) continue;
    const candidate = blocks[candidateIndex]!;
    const existing = HEAD_ENTRY_RE.exec(candidate.normalizedText);
    if (existing && findPosMarker(existing[3] ?? "", config.pos_markers) !== null) continue;
    const rawHeadword = new RegExp(`^(${HEADWORD_TOKEN})`, "u").exec(candidate.normalizedText)?.[1];
    if (!rawHeadword) continue;
    const artifactIndex = rawHeadword.search(/(?<=[a-z])[A-Z]/u);
    const headword = artifactIndex > 0 ? rawHeadword.slice(0, artifactIndex) : rawHeadword;
    const summary = blocks[summaryIndex]!;
    const phoneticIndex = blocks.findIndex((block, index) =>
      index > badgeIndex &&
      index < blocks.length &&
      index !== candidateIndex &&
      index !== summaryIndex &&
      block.page === candidate.page &&
      verticalOverlap(candidate.bbox, block.bbox) >= 0.4 &&
      /^(?:\/[^/]+\/|\[[^\]]+\])$/u.test(block.normalizedText.trim()),
    );
    const header = phoneticIndex >= 0
      ? {
          ...mergeBlocks(
            { ...candidate, text: headword, normalizedText: headword },
            blocks[phoneticIndex]!,
          ),
          headwordConfidence: candidate.confidence,
          phoneticConfidence: blocks[phoneticIndex]!.confidence,
        }
      : { ...candidate, text: `${headword} [?]`, normalizedText: `${headword} [?]`, confidence: 0 };
    const replacement = mergeBlocks(header, summary);
    replacements.set(candidateIndex, replacement);
    consumed.add(candidateIndex);
    consumed.add(summaryIndex);
    if (phoneticIndex >= 0) consumed.add(phoneticIndex);
  }
  return blocks.flatMap((block, index) => {
    const replacement = replacements.get(index);
    if (replacement) return [replacement];
    return consumed.has(index) ? [] : [block];
  });
}

/**
 * Recover a missing short headword when the printed phonetic is itself an
 * ASCII spelling and a nearby exam example contains that word or an inflected
 * form. The evidence is deliberately conjunctive and confidence is zero so a
 * visual review still confirms the inferred critical field.
 */
function recoverAsciiHeadwordsFromPhonetics(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  return blocks.map((block, index) => {
    const match = /^\[([a-z]{3,20})\]\s*(.*)$/iu.exec(block.normalizedText);
    if (!match || HEAD_ENTRY_RE.test(block.normalizedText)) return block;
    const candidate = match[1]!.toLowerCase();
    if (findPosMarker(match[2] ?? "", config.pos_markers) === null) return block;
    const forms = headwordForms(candidate);
    let supported = false;
    let insideExample = false;
    for (let cursor = index + 1; cursor < blocks.length && cursor <= index + 12; cursor += 1) {
      const evidence = blocks[cursor]!;
      if (evidence.page !== block.page) break;
      const head = HEAD_ENTRY_RE.exec(evidence.normalizedText);
      if (head && findPosMarker(head[3] ?? "", config.pos_markers) !== null) break;
      if (evidence.normalizedText.startsWith(config.exam_marker)) insideExample = true;
      if (!insideExample) continue;
      const compact = evidence.normalizedText.toLowerCase().replace(/[^a-z]/gu, "");
      if (forms.some((form) => compact.includes(form))) {
        supported = true;
        break;
      }
    }
    if (!supported) return block;
    const recovered = `${candidate} ${block.normalizedText}`;
    return {
      ...block,
      text: recovered,
      normalizedText: recovered,
      confidence: 0,
    };
  });
}

/** Reject clause fragments produced when OCR removes every inter-word gap. */
function plausibleRecoveredHeadword(value: string): boolean {
  const compact = value.toLowerCase().replace(/[^a-z]/gu, "");
  if (compact.length < 2 || compact.length > 24) return false;
  return !/^(?:the(?:author|researchers?|court|company|government)|this(?:is|was|has)|there(?:is|are|was|were|has)|it(?:is|was|has)|we(?:can|could|will|would|know)|but(?:after|before|for)|for(?:instance|the)|while(?:all|traditional)|when(?:education|the)|unlessa|although(?:only|the)|ratherthan|willneed|couldtake|manyof)/u.test(compact);
}

/**
 * Recover an entry whose large headword vanished but a damaged phonetic,
 * summary gloss, and at least two source lines still survive. The repeated
 * English token supplies only a provisional headword; confidence is forced to
 * zero and the phonetic becomes `[?]`, so both critical fields must be
 * confirmed against the page image before a release can proceed.
 */
function recoverMissingHeadwordsFromExamples(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  const consumed = new Set<number>();
  const replacements = new Map<number, PreprocessedBlock>();
  const ignored = new Set([
    "about", "after", "before", "chapter", "could", "these", "their", "there", "which",
    "world", "would",
  ]);

  for (const [index, phonetic] of blocks.entries()) {
    if (consumed.has(index)) continue;
    const text = phonetic.normalizedText.trim();
    if (!/^\[[^\]]{3,50}$/u.test(text) || HEAD_ENTRY_RE.test(text)) continue;

    let glossIndex = -1;
    let glossDistance = Number.POSITIVE_INFINITY;
    for (const offset of [-3, -2, -1, 1, 2, 3]) {
      const candidateIndex = index + offset;
      if (candidateIndex < 0 || candidateIndex >= blocks.length) continue;
      const candidate = blocks[candidateIndex]!;
      if (candidate.page !== phonetic.page) continue;
      if (CJK_RANGE.test(candidate.normalizedText.slice(0, 1))) {
        const distance = Math.abs(candidate.bbox[1] - phonetic.bbox[1]);
        if (distance < glossDistance) {
          glossIndex = candidateIndex;
          glossDistance = distance;
        }
      }
    }
    if (glossIndex < 0) continue;

    const evidence: PreprocessedBlock[] = [];
    let posMarker: string | null = null;
    for (let cursor = Math.max(index, glossIndex) + 1; cursor < blocks.length; cursor += 1) {
      const candidate = blocks[cursor]!;
      if (candidate.page !== phonetic.page) break;
      const head = HEAD_ENTRY_RE.exec(candidate.normalizedText);
      if (
        (head && findPosMarker(head[3] ?? "", config.pos_markers) !== null) ||
        (/^[a-z][a-z'’-]{2,}$/u.test(candidate.normalizedText) &&
          !/^chapter$/iu.test(candidate.normalizedText))
      ) {
        break;
      }
      evidence.push(candidate);
      if (posMarker === null && /^[①②③④⑤⑥⑦⑧⑨⑩]/u.test(candidate.normalizedText)) {
        posMarker = findPosMarker(candidate.normalizedText, config.pos_markers)?.marker ?? null;
      }
    }
    if (posMarker === null) continue;

    const lowerEvidence = evidence.map((block) => block.normalizedText.toLowerCase());
    const compactEvidence = lowerEvidence.map((line) => line.replace(/[^a-z]/gu, ""));
    const tokens = new Set(
      lowerEvidence.flatMap((line) => line.match(/[a-z]{5,}/gu) ?? []),
    );
    let inferred: { token: string; count: number } | null = null;
    for (const token of tokens) {
      if (ignored.has(token) || !plausibleRecoveredHeadword(token)) continue;
      const count = compactEvidence.filter((line) => line.includes(token)).length;
      if (
        count >= 2 &&
        (inferred === null || count > inferred.count || (count === inferred.count && token.length > inferred.token.length))
      ) {
        inferred = { token, count };
      }
    }
    if (inferred === null) continue;

    const gloss = blocks[glossIndex]!;
    const syntheticText = `${inferred.token} [?] ${posMarker} ${gloss.normalizedText}`;
    const merged = mergeBlocks(phonetic, gloss);
    replacements.set(Math.min(index, glossIndex), {
      ...merged,
      text: syntheticText,
      normalizedText: syntheticText,
      confidence: 0,
    });
    consumed.add(index);
    consumed.add(glossIndex);
  }

  return blocks.flatMap((block, index) => {
    const replacement = replacements.get(index);
    if (replacement) return [replacement];
    return consumed.has(index) ? [] : [block];
  });
}

/** Join an isolated textbook exam marker to the sentence printed beside it. */
function assembleExamMarkers(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  const consumed = new Set<number>();
  const replacements = new Map<number, PreprocessedBlock>();
  for (const [index, block] of blocks.entries()) {
    if (consumed.has(index)) continue;
    if (block.normalizedText !== config.exam_marker) continue;
    let best: { index: number; distance: number } | null = null;
    for (const [candidateIndex, candidate] of blocks.entries()) {
      if (candidateIndex === index || candidate.page !== block.page || consumed.has(candidateIndex)) continue;
      if (isExampleBoundary(candidate.normalizedText, config)) continue;
      const distance = candidate.bbox[0] - block.bbox[2];
      if (
        verticalOverlap(block.bbox, candidate.bbox) >= 0.45 &&
        // OCR boxes for the circular 真 badge can overlap the first letters
        // of the sentence by about 1.5% of page width.
        distance >= -0.02 &&
        distance <= 0.08 &&
        (best === null || distance < best.distance)
      ) {
        best = { index: candidateIndex, distance };
      }
    }
    if (best === null) continue;
    replacements.set(Math.min(index, best.index), mergeBlocks(block, blocks[best.index]!));
    consumed.add(index);
    consumed.add(best.index);
  }
  return blocks.flatMap((block, index) => {
    const replacement = replacements.get(index);
    if (replacement) return [replacement];
    return consumed.has(index) ? [] : [block];
  });
}

/**
 * Recover a headword row whose decorative word/phonetic OCR is unusable but
 * whose POS, gloss, and immediately following short exam example survive.
 *
 * This is deliberately narrow: a real parsed entry must precede the damaged
 * row, the intervening row must end in a recognizable POS directly before a
 * Chinese gloss, and the exam example may contain at most five English words.
 * The inferred headword receives a `[?]` phonetic and zero confidence so both
 * critical fields still require visual confirmation before release.
 */
function recoverCorruptedHeadwordsBeforeExamples(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  const consumed = new Set<number>();
  const replacements = new Map<number, PreprocessedBlock>();
  const ignoredTokens = new Set([
    "about", "after", "before", "could", "from", "have", "into", "their", "there", "these",
    "this", "those", "which", "with", "would",
  ]);
  const relaxedPos =
    /(interj|modal|abbr|prep|conj|pron|adj|adv|aux|phr|art|num|vi|vt|n|v)[.。]?\s*(?=[\u3400-\u9fff])/u;

  for (const [exampleIndex, example] of blocks.entries()) {
    if (!example.normalizedText.startsWith(config.exam_marker)) continue;
    const body = example.normalizedText.slice(config.exam_marker.length).trim();
    const cjkIndex = body.search(CJK_RANGE);
    const english = (cjkIndex >= 0 ? body.slice(0, cjkIndex) : body).trim();
    const tokens = english.toLowerCase().match(/[a-z][a-z'’-]*/gu) ?? [];
    const candidates = tokens.filter(
      (token) =>
        token.replace(/[^a-z]/gu, "").length >= 5 &&
        plausibleRecoveredHeadword(token) &&
        // A possessive inside an exam sentence ("fame of Allen's") is prose,
        // not evidence for a missing dictionary headword.
        !/[’']/u.test(token) &&
        !token.startsWith("forthe") &&
        !ignoredTokens.has(token),
    );
    if (candidates.length === 0 || tokens.length > 5) continue;

    let previousHeadIndex = -1;
    for (let index = exampleIndex - 1; index >= 0 && exampleIndex - index <= 10; index -= 1) {
      const block = blocks[index]!;
      if (block.page !== example.page) break;
      const head = HEAD_ENTRY_RE.exec(block.normalizedText);
      if (head && findPosMarker(head[3] ?? "", config.pos_markers) !== null) {
        previousHeadIndex = index;
        break;
      }
    }
    if (previousHeadIndex < 0) continue;
    const previousHead = HEAD_ENTRY_RE.exec(blocks[previousHeadIndex]!.normalizedText)?.[1] ?? "";
    let ownershipEvidence = english;
    for (let index = exampleIndex + 1; index < blocks.length && index <= exampleIndex + 10; index += 1) {
      const continuation = blocks[index]!;
      if (
        continuation.page !== example.page ||
        exampleColumn(continuation.bbox) !== exampleColumn(example.bbox) ||
        continuation.bbox[1] - example.bbox[3] > 0.18 ||
        isExampleBoundary(continuation.normalizedText, config)
      ) {
        break;
      }
      ownershipEvidence += ` ${continuation.normalizedText}`;
    }
    const compactExample = ownershipEvidence.toLowerCase().replace(/[^a-z]/gu, "");
    if (
      headwordForms(previousHead).some(
        (form) => form.length >= 4 && compactExample.includes(form),
      )
    ) {
      continue;
    }

    let damagedPosIndex = -1;
    let posMatch: RegExpExecArray | null = null;
    let damagedPosDistance = Number.POSITIVE_INFINITY;
    // Reading-order row clustering can interleave the opposite column between
    // a damaged entry and its example. Search a small same-column visual band
    // instead of assuming the damaged row is after the last parsed headword.
    for (let index = Math.max(0, exampleIndex - 12); index < exampleIndex; index += 1) {
      const block = blocks[index]!;
      if (block.page !== example.page) continue;
      if (/^[①②③④⑤⑥⑦⑧⑨⑩]/u.test(block.normalizedText) || CJK_RANGE.test(block.normalizedText[0] ?? "")) {
        continue;
      }
      const parsed = HEAD_ENTRY_RE.exec(block.normalizedText);
      if (parsed && findPosMarker(parsed[3] ?? "", config.pos_markers) !== null) continue;
      if (
        exampleColumn(block.bbox) !== exampleColumn(example.bbox) ||
        example.bbox[1] - block.bbox[1] < -0.01 ||
        example.bbox[1] - block.bbox[1] > 0.12
      ) {
        continue;
      }
      const match = relaxedPos.exec(block.normalizedText);
      if (!match) continue;
      const distance =
        Math.abs(example.bbox[1] - block.bbox[1]) +
        Math.abs(example.bbox[0] - block.bbox[0]) * 0.25;
      if (distance < damagedPosDistance) {
        damagedPosIndex = index;
        damagedPosDistance = distance;
        posMatch = match;
      }
    }
    if (damagedPosIndex < 0 || posMatch === null) continue;

    const evidence = blocks
      .slice(Math.max(0, Math.min(previousHeadIndex, damagedPosIndex) - 2), exampleIndex)
      .flatMap((block) => block.normalizedText.toLowerCase().match(/[a-z]{4,}/gu) ?? []);
    // The example tells us which word is used, but it cannot by itself prove
    // that a new entry exists. Require the damaged header/POS neighborhood to
    // carry the same token (or a close OCR rendering); otherwise ordinary
    // example prose such as `enoughofthe ...` becomes a fabricated headword.
    const supportedCandidates = [...new Set(candidates)].filter((token) =>
      evidence.some((piece) => {
        if (piece.includes(token) || token.includes(piece)) return true;
        const shorter = Math.min(piece.length, token.length);
        const sharesFour = Array.from({ length: Math.max(0, token.length - 3) }, (_, index) =>
          token.slice(index, index + 4),
        ).some((fragment) => piece.includes(fragment));
        return (
          shorter >= 5 &&
          sharesFour &&
          editDistance(token, piece) <= Math.max(2, Math.floor(shorter * 0.5))
        );
      }),
    );
    if (supportedCandidates.length === 0) continue;
    const candidate = supportedCandidates.sort((left, right) => {
      const score = (token: string): number => {
        const exact = evidence.some((piece) => piece.includes(token) || token.includes(piece)) ? 100 : 0;
        const nearest = evidence.reduce(
          (best, piece) => Math.min(best, editDistance(token, piece)),
          Number.POSITIVE_INFINITY,
        );
        const firstToken = token === candidates[0] ? 10 : 0;
        return exact + firstToken - (Number.isFinite(nearest) ? nearest : 20);
      };
      return score(right) - score(left) || right.length - left.length;
    })[0]!;

    const posBlock = blocks[damagedPosIndex]!;
    const glossStart = posMatch.index + posMatch[0].length;
    let gloss = posBlock.normalizedText.slice(glossStart).trim();
    const tailIndices: number[] = [];
    for (let index = damagedPosIndex + 1; index < exampleIndex; index += 1) {
      const tail = blocks[index]!;
      if (
        CJK_RANGE.test(tail.normalizedText.slice(0, 1)) &&
        Math.abs(tail.bbox[0] - posBlock.bbox[0]) <= 0.12
      ) {
        gloss += tail.normalizedText.trim();
        tailIndices.push(index);
      }
    }
    if (gloss.length === 0) continue;

    const markerBare = posMatch[1]!;
    const canonicalPos =
      config.pos_markers.find((marker) => marker.replace(/\.+$/u, "") === markerBare) ??
      `${markerBare}.`;
    let provenanceBlock = posBlock;
    for (const index of tailIndices) provenanceBlock = mergeBlocks(provenanceBlock, blocks[index]!, "");
    const syntheticText = `${candidate} [?] ${canonicalPos} ${gloss}`;
    replacements.set(damagedPosIndex, {
      ...provenanceBlock,
      text: syntheticText,
      normalizedText: syntheticText,
      confidence: 0,
    });
    consumed.add(damagedPosIndex);
    for (const index of tailIndices) consumed.add(index);
  }

  return blocks.flatMap((block, index) => {
    const replacement = replacements.get(index);
    if (replacement) return [replacement];
    return consumed.has(index) ? [] : [block];
  });
}

function isExampleBoundary(text: string, config: NormalizeBookConfig): boolean {
  if (
    text === config.exam_marker ||
    new RegExp(`^${config.exam_marker}\\s*(?=[A-Za-z])`, "u").test(text)
  ) {
    return true;
  }
  if (new RegExp(config.chapter_opener_pattern, "u").test(text)) return true;
  if (config.unit_title_patterns.some((pattern) => new RegExp(pattern, "u").test(text))) return true;
  const head = HEAD_ENTRY_RE.exec(text);
  if (head && findPosMarker(head[3] ?? "", config.pos_markers) !== null) return true;
  const phoneticOnly = PHONETIC_TAIL_RE.exec(text);
  if (phoneticOnly && findPosMarker(phoneticOnly[2] ?? "", config.pos_markers) !== null) return true;
  if (/^[①②③④⑤⑥⑦⑧⑨⑩]/u.test(text)) return true;
  if (SOURCE_REF_ONLY_RE.test(text)) return true;
  if (/^真题词组/u.test(text)) return true;
  return config.note_patterns.some((pattern) => new RegExp(pattern, "u").test(text));
}

function exampleColumn(bbox: Bbox): "left" | "right" | "full" {
  if (bbox[0] <= 0.4 && bbox[2] >= 0.6) return "full";
  if (bbox[0] >= 0.49 && bbox[2] - bbox[0] <= 0.08) return "right";
  // A left-page OCR box may bleed a few pixels across the gutter. Its x0 is
  // still a reliable column signal and keeps the final short translation line
  // attached to the sentence above it.
  if (bbox[2] <= 0.55) return "left";
  if (bbox[0] >= 0.45 && bbox[2] > 0.55) return "right";
  if (bbox[0] < 0.49) return "left";
  if (bbox[0] >= 0.49) return "right";
  return "full";
}

/** Collapse a 真题词组小记 section so physical line wraps cannot create fake phrases. */
function assemblePhraseSections(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  const assembled: PreprocessedBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const heading = blocks[index]!;
    assembled.push(heading);
    if (!/^真题词组小记$/u.test(heading.normalizedText)) continue;
    const section: PreprocessedBlock[] = [];
    while (index + 1 < blocks.length) {
      const next = blocks[index + 1]!;
      const head = HEAD_ENTRY_RE.exec(next.normalizedText);
      const isHeadword = head && findPosMarker(head[3] ?? "", config.pos_markers) !== null;
      if (
        next.page !== heading.page ||
        isHeadword ||
        /^\d{3}$/u.test(next.normalizedText.replace(/\s+/gu, "")) ||
        config.note_patterns.some(
          (pattern) => !/^\^真题词组/u.test(pattern) && new RegExp(pattern, "u").test(next.normalizedText),
        )
      ) {
        break;
      }
      // A tiny decorative badge beside this heading is sometimes recognized
      // as the standalone glyph “旺”. It is neither phrase text nor a marker.
      if (!/^旺$/u.test(next.normalizedText)) section.push(next);
      index += 1;
    }
    if (section.length === 0) continue;
    assembled.push(
      section.slice(1).reduce((merged, block) => {
        // Each physical line beginning with English after a Chinese gloss is
        // a new phrase. Preserve that boundary as the same `//` delimiter the
        // book uses inline; ordinary wraps and hyphenated words still join.
        const separator =
          CJK_RANGE.test(merged.normalizedText.slice(-1)) && /^[A-Za-z]/u.test(block.normalizedText)
            ? "//"
            : "";
        return mergeBlocks(merged, block, separator);
      }, section[0]!),
    );
  }
  return assembled;
}

/** Join the Chinese continuation of an unheaded phrase printed below it. */
function assembleMultilinePhrases(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  const assembled: PreprocessedBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    let current = blocks[index]!;
    const cjkIndex = current.normalizedText.search(CJK_RANGE);
    const head = HEAD_ENTRY_RE.exec(current.normalizedText);
    const isHeadword = head && findPosMarker(head[3] ?? "", config.pos_markers) !== null;
    const isPhrase =
      !current.normalizedText.startsWith(config.exam_marker) &&
      /^[A-Za-z]/u.test(current.normalizedText) &&
      cjkIndex > 0 &&
      !isHeadword;
    if (!isPhrase) {
      assembled.push(current);
      continue;
    }

    let previous = current;
    while (index + 1 < blocks.length) {
      const next = blocks[index + 1]!;
      const gap = next.bbox[1] - previous.bbox[3];
      const sameColumn = exampleColumn(current.bbox) === exampleColumn(next.bbox);
      if (
        next.page !== current.page ||
        !CJK_RANGE.test(next.normalizedText.slice(0, 1)) ||
        isExampleBoundary(next.normalizedText, config) ||
        !sameColumn ||
        gap < -0.005 ||
        gap > 0.03
      ) {
        break;
      }
      current = mergeBlocks(current, next, "");
      previous = next;
      index += 1;
    }
    assembled.push(current);
  }
  return assembled;
}

/** Mark an English sentence after a numbered source line when OCR missed 真. */
function markImplicitExamples(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  return blocks.map((block, index) => {
    if (index === 0 || block.normalizedText.startsWith(config.exam_marker)) return block;
    const previous = blocks[index - 1]!;
    const numberedSourceBefore =
      /^[①②③④⑤⑥⑦⑧⑨⑩]/u.test(previous.normalizedText) && SOURCE_REF_RE.test(previous.normalizedText);
    const sourceBefore = SOURCE_REF_ONLY_RE.test(previous.normalizedText);
    const markerGlyphMisread = /^具\s*(?=[A-Za-z])/u.test(block.normalizedText);
    const previousHead = HEAD_ENTRY_RE.exec(previous.normalizedText);
    const previousHeadword = previousHead?.[1]
      ?.toLowerCase()
      .split("/")[0]!
      .replace(/\([a-z]+\)/gu, "")
      .replace(/[^a-z]/gu, "");
    const currentCjkIndex = block.normalizedText.search(CJK_RANGE);
    const currentEnglishTokens = (
      currentCjkIndex >= 0 ? block.normalizedText.slice(0, currentCjkIndex) : block.normalizedText
    ).toLowerCase().match(/[a-z]+/gu) ?? [];
    const directHeadwordExample =
      previousHead !== null &&
      findPosMarker(previousHead[3] ?? "", config.pos_markers) !== null &&
      /^[A-Za-z]/u.test(block.normalizedText) &&
      CJK_RANGE.test(block.normalizedText) &&
      (previousHeadword?.length ?? 0) >= 4 &&
      currentEnglishTokens.at(-1) === previousHeadword;
    if (
      (numberedSourceBefore || sourceBefore || directHeadwordExample) &&
      (/^[A-Za-z]/u.test(block.normalizedText) || markerGlyphMisread)
    ) {
      const text = markerGlyphMisread ? block.text.replace(/^具\s*/u, "") : block.text;
      const normalizedText = markerGlyphMisread
        ? block.normalizedText.replace(/^具\s*/u, "")
        : block.normalizedText;
      return {
        ...block,
        text: `${config.exam_marker} ${text}`,
        normalizedText: `${config.exam_marker} ${normalizedText}`,
      };
    }
    return block;
  });
}

/** Join the physical lines of one exam sentence before assigning ownership. */
function assembleMultilineExamples(
  blocks: readonly PreprocessedBlock[],
  config: NormalizeBookConfig,
): PreprocessedBlock[] {
  const assembled: PreprocessedBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    let current = blocks[index]!;
    if (
      !current.normalizedText.startsWith(config.exam_marker) ||
      /^真题词组小记/u.test(current.normalizedText)
    ) {
      assembled.push(current);
      continue;
    }
    let previous = current;
    while (index + 1 < blocks.length) {
      const next = blocks[index + 1]!;
      // Printed page numbers sit close enough to the last example line to
      // look like a continuation. They are footer furniture, never content.
      if (next.bbox[1] >= 0.9 && /^\d{1,3}$/u.test(next.normalizedText.trim())) break;
      if (isExampleBoundary(next.normalizedText, config)) break;
      if (next.normalizedText.startsWith(config.exam_marker)) break;
      const samePage = next.page === previous.page;
      const continuesOnNextPage =
        next.page === previous.page + 1 && next.bbox[1] <= 0.2;
      if (!samePage && !continuesOnNextPage) break;
      const currentColumn = exampleColumn(previous.bbox);
      const nextColumn = exampleColumn(next.bbox);
      const sameColumn = currentColumn === nextColumn;
      const closeBelow =
        samePage &&
        (sameColumn || currentColumn === "full") &&
        next.bbox[1] - previous.bbox[3] <= 0.045;
      const wrapsToRightColumn =
        samePage &&
        currentColumn === "left" &&
        nextColumn === "right" &&
        next.bbox[1] < previous.bbox[1];
      if (!closeBelow && !wrapsToRightColumn && !continuesOnNextPage) break;
      current = mergeBlocks(current, next, " ");
      previous = next;
      index += 1;
    }
    assembled.push(current);
  }
  return assembled;
}

/** Page-scoped spaces confirmed by the saved original-page OCR review. */
const SOURCE_VERIFIED_SPACING: Readonly<Record<number, readonly (readonly [string, string])[]>> = {
  24: [["meanwell", "mean well"]],
  37: [["thebarexam", "the bar exam"]],
  56: [["setout", "set out"]],
  73: [
    ["controversy,with", "controversy, with"],
    ["UnitedStatestrade", "United States trade"],
    ["whetherthetax", "whether the tax"],
    ["discriminatesagainstAmerican", "discriminates against American"],
    ["companies,which inturn couldlead totrade", "companies, which in turn could lead to trade"],
    ["sanctionsagainstFrance", "sanctions against France"],
  ],
  82: [["riseabove", "rise above"]],
  83: [["turnback", "turn back"], ["scaleback", "scale back"]],
  84: [["family- ownedfirm", "family-owned firm"]],
  85: [["takehold", "take hold"], ["atighthold", "a tight hold"]],
  108: [["inmind", "in mind"], ["sb.'smind", "sb.'s mind"], ["firstmove", "first move"]],
  109: [["makeamove", "make a move"]],
  110: [["atrisk", "at risk"]],
  111: [["short-termmemory", "short-term memory"], ["intheshort/medium/longterm", "in the short/medium/long term"]],
  170: [["makesure", "make sure"]],
  194: [["beginning,this", "beginning, this"], ["hasbeen", "has been"], ["PreCheck'sfatalflaw", "PreCheck's fatal flaw"]],
  253: [["wakeup", "wake up"]],
  280: [
    ["havelostfaiththattheeuro", "have lost faith that the euro"],
    ["stronger,willoneday", "stronger, will one day"],
    ["quickfixofdevaluation", "quick fix of devaluation"],
  ],
  293: [["avastdatacentre", "a vast data centre"]],
  303: [
    ["lawsofmotionandDarwinian", "laws of motion and Darwinian"],
    ["evolutioneachbind", "evolution each bind"],
    ["hostofdifferentphenomena", "host of different phenomena"],
  ],
  324: [["calmdown", "calm down"]],
  326: [["obeytrafficlaws", "obey traffic laws"]],
  327: [["sth.tobear(onsb./sth.", "sth. to bear (on sb./sth."]],
  361: [
    ["SouthCarolina", "South Carolina"],
    ["programcalledRage", "program called Rage"],
    ["Against theHaze", "Against the Haze"],
  ],
};

export function sourceVerifiedSpacing(page: number, value: string): string {
  return (SOURCE_VERIFIED_SPACING[page] ?? []).reduce(
    (text, [before, after]) => text.replaceAll(before, after),
    value,
  );
}

/** Letter repairs checked against the printed Unit 1 exam sentences. */
export function sourceVerifiedExamCharacterRepairs(page: number, value: string): string {
  if (page === 17) {
    return value
      .replaceAll("Gverstate losses", "overstate losses")
      .replaceAll("temnorary illiquidity", "temporary illiquidity")
      .replaceAll("wo mpol iqun vl iho l o the temporary", "the temporary")
      .replaceAll("markets not the likelyextentofbaddebts.", "markets, not the likely extent of bad debts.");
  }
  if (page === 18) {
    return value
      .replaceAll("Manyvoung icans", "Many young Americans")
      .replaceAll("cast douhts", "cast doubts")
      .replaceAll("abilitytohandleinformation.", "ability to handle information.");
  }
  if (page === 19) {
    return value.replaceAll("abilitytohandleinformation.", "ability to handle information.");
  }
  return value;
}

/** Exact repairs transcribed from the rendered source page after OCR failed. */
function applySourceVerifiedTextRepairs(blocks: readonly PreprocessedBlock[]): PreprocessedBlock[] {
  return blocks
    .filter(
      (block) =>
        !(
          block.page === 54 &&
          (/^着的[）)]座位/u.test(block.normalizedText) ||
            /^人[）)]处于某位置/u.test(block.normalizedText))
        ),
    )
    .map((block) => {
    if (/^真\s*absence ofdern(?:\s*113)?$/u.test(block.normalizedText)) {
      const corrected = "真 absence of deference 缺乏尊重";
      return { ...block, text: corrected, normalizedText: corrected };
    }
    if (/^真\s*Travelona Londonbusand you'llquickly/u.test(block.normalizedText)) {
      const corrected = block.normalizedText
        .replace(/^真\s*Travelona Londonbusand you'llquickly/u, "真 Travel on a London bus and you'll quickly")
        .replace(/withdrivers\./u, "with drivers. ");
      return { ...block, text: corrected, normalizedText: corrected };
    }
    if (/^真\s*cmulauor/u.test(block.normalizedText) && /laborshortage/u.test(block.normalizedText)) {
      const corrected = "真 child labor 童工//labor market 劳动力市场//labor shortage 劳动力短缺";
      return { ...block, text: corrected, normalizedText: corrected };
    }
    if (/^真\s*anlyishoenn contentedness/u.test(block.normalizedText)) {
      const corrected = block.normalizedText.replace(
        /^真\s*anlyishoenn contentedness/u,
        "真 His analysis should therefore end any self-contentedness",
      );
      return { ...block, text: corrected, normalizedText: corrected };
    }
    if (/^真\s*Quotas get action:/u.test(block.normalizedText)) {
      const corrected =
        '真 Quotas get action: they "open the way to equality and they break through the glass ceiling," according to Reding, a result seen in France and other countries with legally binding provisions on placing women in top business positions. 定额能带来切实的行动：它们可以“开启平等之路，打破（阻碍女性晋升的）玻璃天花板，”雷丁说，在法国及其他一些国家已经看到了这一效果，这些国家以法律约束条款使女性身居公司高层职位。';
      return { ...block, text: corrected, normalizedText: corrected };
    }
    if (/^真\s*He was not interested in daily politics, but/u.test(block.normalizedText)) {
      const corrected =
        "真 He was not interested in daily politics, but concerned with questions of moral behavior and the larger questions of right and wrong affecting the entire society. 他对日常政治不感兴趣，但关注道德行为问题以及影响全社会的更大的是非问题。";
      return { ...block, text: corrected, normalizedText: corrected };
    }
    if (/^真\s*This is a shame—the community shouldbe giaspirgtle/u.test(block.normalizedText)) {
      const corrected =
        "真 This is a shame—the community should be grasping the opportunity to raise its influence in the real world. 这是令人惋惜的——这一群体（指社会科学家）应该抓住这次机会来提高自身在真实世界中的影响力。";
      return { ...block, text: corrected, normalizedText: corrected };
    }
    if (/^真\s*It is true that CEO pay has gone up—top/u.test(block.normalizedText)) {
      const corrected =
        "真 It is true that CEO pay has gone up—top ones may make 300 times the pay of typical workers on average, and since the mid-1970s, CEO pay for large publicly traded American corporations has, by varying estimates, gone up by about 500%. 没错，首席执行官的薪酬上涨了——顶尖首席执行官的薪酬可能是普通员工平均薪酬的300倍，而且，据多方估计，自20世纪70年代中期以来，美国大型上市公司首席执行官的薪酬业已上涨了约500%。";
      return { ...block, text: corrected, normalizedText: corrected };
    }
    if (/^真\s*向不知名的杂志投递一些短篇随笔$/u.test(block.normalizedText)) {
      const corrected = "真 submit short sketches to obscure magazines 向不知名的杂志投递一些短篇随笔";
      return { ...block, text: corrected, normalizedText: corrected };
    }
    if (/^真\s*Partofthe problem is that many homeless$/u.test(block.normalizedText)) {
      const corrected =
        "真 Part of the problem is that many homeless adults are addicted to alcohol or drugs. 部分问题是许多无家可归的成年人酗酒或吸毒成瘾。";
      return { ...block, text: corrected, normalizedText: corrected };
    }

    let corrected = sourceVerifiedExamCharacterRepairs(
      block.page,
      sourceVerifiedSpacing(block.page, block.normalizedText),
    );
    if (/^credtbitfty(?=\s)/u.test(corrected)) {
      corrected = corrected.replace(/^credtbitfty/u, "credibility");
    }
    if (/^place\s+[^\s]+\s+n\.地方/u.test(corrected)) {
      corrected =
        "place [pleɪs] n. 地方；表面的某处；（尤指占用或空着的）座位；（速度比赛或竞赛获胜者的）名次 vt. （小心或有意）放置；使（人）处于某位置；以某种态度对待（或看待）；下赌注；获名次";
    }
    if (/^转n\.\s*工作；工作成果；作品$/u.test(corrected)) {
      corrected = corrected.replace(/^转/u, "运转");
    }
    if (/^微劳工；\[L-\]英国工党\s*vi\.\s*努力做/u.test(corrected)) {
      corrected = corrected.replace(/^微劳工/u, "劳工");
    }
    if (/^真\s*agriculturalworkforce农业劳动力$/u.test(corrected)) {
      corrected = "真 agricultural workforce 农业劳动力";
    }
    if (/^真\s*Although it can be a workout on its own,/u.test(corrected)) {
      corrected = corrected
        .replace(/getback/u, "get back")
        .replace(/Zumbaclasses/u, "Zumba classes")
        .replace(/tennis,cycling,orany otheractivity/u, "tennis, cycling, or any other activity")
        .replace(/alsoa greatfirst step\./u, "also a great first step. ");
    }
    if (/^真\s*Gates choosesnonfictiontitles becausethey/u.test(corrected)) {
      corrected = corrected
        .replace(/choosesnonfictiontitles becausethey/u, "chooses nonfiction titles because they")
        .replace(/works\./u, "works. ");
    }
    if (/^真\s*Scientists are increasingly seeking out visual/u.test(corrected)) {
      corrected = corrected
        .replace(/helpthemto communicatetheir work/u, "help them to communicate their work")
        .replace(/newaudiences\./u, "new audiences. ");
    }
    return corrected === block.normalizedText
      ? block
      : { ...block, text: corrected, normalizedText: corrected };
    });
}

/** Expand a source row when OCR fused a clipped related-word entry with its example. */
function expandSourceVerifiedEntries(blocks: readonly PreprocessedBlock[]): PreprocessedBlock[] {
  return blocks.flatMap((block) => {
    if (block.page !== 335 || !/^真\s*quit a quit a seniorposition/u.test(block.normalizedText)) {
      return [block];
    }
    const headText = "quit [kwɪt] v. 离开（工作职位、学校等）；停止";
    const exampleText = "真 quit a senior position 从高级职位离职";
    return [
      {
        ...block,
        blockKey: `${block.blockKey}.quit-head`,
        text: headText,
        normalizedText: headText,
        confidence: 0,
      },
      {
        ...block,
        blockKey: `${block.blockKey}.quit-example`,
        text: exampleText,
        normalizedText: exampleText,
      },
    ];
  });
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
  correctionsByEvidence: Map<string, VisualCorrection>;
  correctionsByLocation: VisualCorrection[];
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
  /** Ignore wrapped explanatory-note lines until the next real headword. */
  ignoreNoteTail: boolean;
  /** Standalone reference sections ignore English and Chinese prose alike. */
  ignoreAllNoteTail: boolean;
  wordKeys: Set<string>;
  /** Words seen per unit key; feeds the textbook source_order counter. */
  unitWordCount: Map<string, number>;
}

function correctionEvidenceKey(
  field: CriticalField,
  page: number,
  pageImageSha256: string,
  bbox: Bbox,
  originalText: string,
  round: number,
): string {
  return [
    field,
    page,
    pageImageSha256,
    bbox.map((value) => value.toFixed(6)).join(","),
    originalText,
    round,
  ].join("|");
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
  resetCurrentWord = true,
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
  // A newly opened Unit is a hard ownership boundary. If its first headword
  // was missed, orphan lines must be dropped rather than attached to the last
  // word of the previous Unit.
  if (resetCurrentWord) {
    state.currentWord = null;
    state.pendingSourceRef = undefined;
    state.ignoreNoteTail = false;
    state.ignoreAllNoteTail = false;
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
  const wordKey = `w.${unitKey}.${String(sourceOrder).padStart(4, "0")}.${logicalHeadwordSlug(headwordText)}`;
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
  state.ignoreNoteTail = false;
  state.ignoreAllNoteTail = false;

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

function expandedHeadwordAlternatives(headword: string): string[] {
  const expanded: string[] = [];
  let previous = "";
  for (const alternative of headword.toLowerCase().split("/")) {
    if (alternative.startsWith("-") && previous.length > alternative.length - 1) {
      const suffix = alternative.slice(1);
      expanded.push(`${previous.slice(0, -suffix.length)}${suffix}`);
    } else {
      expanded.push(alternative);
      previous = alternative;
    }
  }
  return expanded;
}

function headwordForms(headword: string): string[] {
  const forms = new Set<string>();
  for (const alternative of expandedHeadwordAlternatives(headword)) {
    const bases = [
      alternative.replace(/\([a-z]+\)/gu, ""),
      alternative.replace(/[()]/gu, ""),
    ];
    for (const rawBase of bases) {
      const base = rawBase.replace(/[^a-z]/gu, "");
      if (base.length === 0) continue;
      forms.add(base);
      forms.add(`${base}s`);
      forms.add(`${base}es`);
      forms.add(`${base}ed`);
      forms.add(`${base}ing`);
      if (base.endsWith("e")) {
        forms.add(`${base}d`);
        forms.add(`${base.slice(0, -1)}ing`);
      }
      if (base.endsWith("y") && base.length > 1) {
        forms.add(`${base.slice(0, -1)}ies`);
        forms.add(`${base.slice(0, -1)}ied`);
      }
      if (/[^aeiou][aeiou][^aeiouwxy]$/u.test(base)) {
        const last = base.slice(-1);
        forms.add(`${base}${last}ed`);
        forms.add(`${base}${last}ing`);
      }
    }
  }
  return [...forms];
}

/** Conservative forms used when rewriting source text, not just matching it. */
function canonicalHeadwordForms(headword: string): string[] {
  const forms = new Set<string>();
  for (const alternative of expandedHeadwordAlternatives(headword)) {
    for (const rawBase of [
      alternative.replace(/\([a-z]+\)/gu, ""),
      alternative.replace(/[()]/gu, ""),
    ]) {
      const base = rawBase.replace(/[^a-z]/gu, "");
      if (base.length === 0) continue;
      forms.add(base);
      forms.add(`${base}s`);
      forms.add(`${base}es`);
      if (base.endsWith("e")) {
        forms.add(`${base}d`);
        forms.add(`${base.slice(0, -1)}ing`);
      } else if (/(?:mit|fer)$/u.test(base)) {
        const last = base.slice(-1);
        forms.add(`${base}${last}ed`);
        forms.add(`${base}${last}ing`);
      } else {
        forms.add(`${base}ed`);
        forms.add(`${base}ing`);
      }
      if (base.endsWith("y") && base.length > 1) {
        forms.add(`${base.slice(0, -1)}ies`);
        forms.add(`${base.slice(0, -1)}ied`);
      }
    }
  }
  return [...forms];
}

function addExample(state: WalkState, block: PreprocessedBlock, marker: string): void {
  const currentDraft = state.currentWord;
  if (!currentDraft) return; // Examples attach to the entry being read.
  const text = block.normalizedText.startsWith(marker)
    ? block.normalizedText.slice(marker.length).trim()
    : block.normalizedText;
  if (text.length === 0) {
    return; // A bare exam marker printed on its own line carries no content.
  }
  if (
    /^Unit$/iu.test(text) ||
    /题词组小记/u.test(text) ||
    /^(?=[A-Z0-9]*\d)[A-Z0-9]+[\u3400-\u9fff]?$/u.test(text)
  ) {
    return; // Page labels / damaged section furniture are not source examples.
  }
  const compactText = text.toLowerCase().replace(/[^a-z]/gu, "");
  const draft =
    [...state.wordDrafts]
      .reverse()
      .find(
        (candidate) =>
          candidate.unitKey === currentDraft.unitKey &&
          candidate.head.page >= block.page - 1 &&
          candidate.head.page <= block.page &&
          headwordForms(candidate.headword).some(
            (form) => form.length >= 4 && compactText.includes(form),
          ),
      ) ?? currentDraft;
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

/**
 * Dense two-column pages can put an example ahead of the headword it belongs
 * to in the detector's reading order. `addExample` can only consider words
 * parsed so far, so make one page-local pass after every word is known.
 *
 * Long forms may span OCR whitespace, while three-letter forms must match a
 * complete English token (`sip`, `sue`) to avoid substring false positives.
 */
function reassignExamplesByHeadword(state: WalkState): void {
  const draftByWordKey = new Map(
    state.wordDrafts.map((draft) => [draft.word.word_key, draft] as const),
  );

  for (const example of state.examples) {
    example.text = sourceVerifiedSpacing(example.page_number, example.text);
    const current = draftByWordKey.get(example.word_key);
    if (!current) continue;

    const compactText = example.text.toLowerCase().replace(/[^a-z]/gu, "");
    const tokens = new Set(example.text.toLowerCase().match(/[a-z]+/gu) ?? []);
    let best: { draft: WordDraft; score: number; distance: number } | null = null;

    for (const candidate of state.wordDrafts) {
      if (candidate.unitKey !== current.unitKey || candidate.head.page !== example.page_number) {
        continue;
      }
      const matchedLength = headwordForms(candidate.headword).reduce((longest, form) => {
        const matches = form.length >= 4
          ? compactText.includes(form)
          : form.length === 3 && tokens.has(form);
        return matches ? Math.max(longest, form.length) : longest;
      }, 0);
      if (matchedLength === 0 || !textContainsHeadword(example.text, candidate.headword)) continue;

      const distance = Math.abs(candidate.word.source_order - current.word.source_order);
      if (
        best === null ||
        matchedLength > best.score ||
        (matchedLength === best.score && distance < best.distance)
      ) {
        best = { draft: candidate, score: matchedLength, distance };
      }
    }

    if (best) example.word_key = best.draft.word.word_key;

    const owner = draftByWordKey.get(example.word_key);
    if (owner) {
      const exactOwnerForms = new Set(headwordForms(owner.headword));
      const forms = canonicalHeadwordForms(owner.headword)
        .filter((form) => form.length >= 4)
        .sort((left, right) => right.length - left.length);
      const matches = [...example.text.matchAll(/[A-Za-z]+/gu)];
      let repair: { index: number; length: number; replacement: string } | null = null;
      for (const tokenMatch of matches) {
        if (tokenMatch.index === undefined) continue;
        const token = tokenMatch[0].toLowerCase();
        if (exactOwnerForms.has(token)) continue;
        if (forms.some((form) => token.includes(form))) continue;
        let form = forms
          .map((candidate) => ({ candidate, distance: editDistance(candidate, token) }))
          .filter(({ candidate, distance }) => {
            const allowedDistance = candidate.length >= 6 ? 2 : 1;
            return (
              Math.abs(candidate.length - token.length) <= allowedDistance &&
              candidate[0] === token[0] &&
              distance > 0 &&
              distance <= allowedDistance
            );
          })
          .sort(
            (left, right) =>
              left.distance - right.distance ||
              Math.abs(left.candidate.length - token.length) -
                Math.abs(right.candidate.length - token.length),
          )[0]?.candidate;
        let tokenOffset = 0;
        let matchedLength = token.length;
        if (!form) {
          outer: for (const candidate of forms.filter((value) => value.length >= 6)) {
            for (const length of [candidate.length - 1, candidate.length, candidate.length + 1]) {
              for (let start = 0; start + length <= token.length; start += 1) {
                const window = token.slice(start, start + length);
                if (
                  candidate[0] === window[0] &&
                  candidate.at(-1) === window.at(-1) &&
                  editDistance(candidate, window) === 1
                ) {
                  form = candidate;
                  tokenOffset = start;
                  matchedLength = length;
                  break outer;
                }
              }
            }
          }
        }
        if (!form) continue;
        const replacement = /^[A-Z]/u.test(tokenMatch[0])
          ? `${form[0]!.toUpperCase()}${form.slice(1)}`
          : form;
        repair = {
          index: tokenMatch.index + tokenOffset,
          length: matchedLength,
          replacement,
        };
        break;
      }
      if (repair) {
        example.text = `${example.text.slice(0, repair.index)}${repair.replacement}${example.text.slice(repair.index + repair.length)}`;
        const cjkIndex = example.text.search(CJK_RANGE);
        const english = cjkIndex >= 0 ? example.text.slice(0, cjkIndex).trimEnd() : example.text;
        example.target_span = [0, english.length > 0 ? english.length : example.text.length];
      }
      // The printed sentence starts at the bottom of page 95's left column
      // and finishes at the top of its right column. The OCR lost the last
      // letters of "been" and spaces, but the complete line is legible on
      // the source page; preserve the joined sentence as one example.
      if (
        example.page_number === 95 &&
        owner.headword === "favo(u)rable" &&
        /^Forthemost part,theresponse hasbee favorable,to say the least\.至少可以说，大部分人的反应都是赞同的。$/u.test(example.text)
      ) {
        example.text = "For the most part, the response has been favorable, to say the least. 至少可以说，大部分人的反应都是赞同的。";
        example.target_span = [0, example.text.indexOf(" 至少可以说")];
      }
      if (
        example.page_number === 16 &&
        owner.headword === "work" &&
        example.text.includes("how the worked works.")
      ) {
        example.text = example.text.replace("how the worked works.", "how the world works.");
        const cjkIndex = example.text.search(CJK_RANGE);
        example.target_span = [0, cjkIndex >= 0 ? example.text.slice(0, cjkIndex).trimEnd().length : example.text.length];
      }
    }
  }

  // Page 308 prints this under the derived form "summarise/-ize", not as a
  // standalone exam example of the headword "sum". The OCR's full-page box
  // incorrectly promoted it into the example stream.
  state.examples = state.examples.filter((example) => {
    const owner = draftByWordKey.get(example.word_key);
    return !(
      example.page_number === 308 &&
      owner?.headword === "sum" &&
      /^summarize\s+the\s*main\s*idea/u.test(example.text)
    );
  });

  const favorable = state.wordDrafts.find(
    (draft) => draft.head.page === 95 && draft.headword === "favo(u)rable",
  );
  if (favorable) {
    const incomplete = state.examples.find(
      (example) => example.word_key === favorable.word.word_key && example.text === "Forthemost part,theresponse hasbee",
    );
    const tailIndex = state.phrases.findIndex(
      (phrase) => phrase.word_key === favorable.word.word_key &&
        /^favorable,to say the least\./u.test(phrase.text),
    );
    if (incomplete && tailIndex >= 0) {
      incomplete.text = "For the most part, the response has been favorable, to say the least. 至少可以说，大部分人的反应都是赞同的。";
      incomplete.target_span = [0, incomplete.text.indexOf(" 至少可以说")];
      state.phrases.splice(tailIndex, 1);
    }
  }

  const counts = new Map<string, number>();
  for (const draft of state.wordDrafts) draft.exampleCount = 0;
  for (const example of state.examples) {
    const sourceOrder = (counts.get(example.word_key) ?? 0) + 1;
    counts.set(example.word_key, sourceOrder);
    example.source_order = sourceOrder;
    example.example_key = `ex.${example.word_key}.${sourceOrder}`;
    const draft = draftByWordKey.get(example.word_key);
    if (draft) draft.exampleCount = sourceOrder;
  }
}

function addPhrase(state: WalkState, block: PreprocessedBlock): void {
  const draft = state.currentWord;
  if (!draft) return;
  const normalized = block.normalizedText.replace(/(?<=[\u3400-\u9fff])\/(?=[A-Za-z])/gu, "//");
  const canonicalHeadword = draft.headword
    .toLowerCase()
    .split("/")[0]!
    .replace(/\(([a-z]+)\)/gu, "$1")
    .replace(/[^a-z]/gu, "");
  const compactBlock = normalized.toLowerCase().replace(/[^a-z]/gu, "");
  const hasExactSibling =
    canonicalHeadword.length >= 5 && compactBlock.includes(canonicalHeadword);
  for (const text of normalized.split(/\/\//u)) {
    const cjkIndex = text.search(CJK_RANGE);
    if (cjkIndex <= 0) continue; // No "english gloss CJK" split point.
    let english = text.slice(0, cjkIndex).trim();
    const gloss = text.slice(cjkIndex).trim();
    if (english.length === 0 || gloss.length === 0 || !/[A-Za-z]/u.test(english)) continue;
    if (block.page === 308 && draft.headword === "sum" && /^summarise\/-ize\b/u.test(english)) {
      continue;
    }
    const leadingPos = findPosMarker(english, state.config.pos_markers);
    if (leadingPos !== null && leadingPos.index <= 2) continue;
    let compactPhrase = english.toLowerCase().replace(/[^a-z]/gu, "");
    const compactHeadword = draft.headword.toLowerCase().replace(/\([a-z]+\)/gu, "").replace(/[^a-z]/gu, "");
    if (compactHeadword.length > 0 && !compactPhrase.includes(compactHeadword)) {
      // When another phrase in the same printed list contains the exact
      // headword, use it as local evidence to repair a single OCR-damaged
      // occurrence (for example cuitural -> cultural). Never use this on an
      // isolated phrase, where the headword itself could be the bad OCR.
      const tokens = [...english.matchAll(/[A-Za-z]+/gu)];
      const close = tokens.find((match) => {
        const token = match[0].toLowerCase();
        const limit = canonicalHeadword.length >= 7 ? 2 : 1;
        return token[0] === canonicalHeadword[0] && editDistance(token, canonicalHeadword) <= limit;
      });
      if (!hasExactSibling || !close || close.index === undefined) continue;
      english = `${english.slice(0, close.index)}${canonicalHeadword}${english.slice(close.index + close[0].length)}`;
      compactPhrase = english.toLowerCase().replace(/[^a-z]/gu, "");
      if (!compactPhrase.includes(canonicalHeadword)) continue;
    }
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
  const embeddedPos = findPosMarker(gloss, state.config.pos_markers);
  if (draft.senseDrafts.length > 0 && embeddedPos !== null) {
    const prefix = gloss.slice(0, embeddedPos.index).trim();
    const last = draft.senseDrafts[draft.senseDrafts.length - 1]!;
    if (prefix.length > 0) {
      last.gloss += prefix;
      const lastSense = state.senses.find(
        (sense) => sense.sense_key === `s.${draft.word.word_key}.${draft.senseDrafts.length}`,
      );
      if (lastSense) lastSense.gloss = last.gloss;
    }
    for (const parsed of parseSenses(gloss.slice(embeddedPos.index), state.config)) {
      draft.senseDrafts.push(parsed);
      state.senses.push({
        sense_key: `s.${draft.word.word_key}.${draft.senseDrafts.length}`,
        word_key: draft.word.word_key,
        ...parsed,
        sense_order: draft.senseDrafts.length,
        ...provenance(block),
      });
    }
  } else if (draft.senseDrafts.length > 0) {
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

/**
 * A numbered sense directly below the entry can restore one clipped CJK
 * glyph in the compact summary above it (`气层` -> `大气层`). Restrict the
 * repair to a one-character prefix/suffix omission inside the same POS.
 */
function repairClippedSummaryGloss(
  state: WalkState,
  draft: WordDraft,
  parsed: SenseDraft,
): void {
  for (const [index, existing] of draft.senseDrafts.entries()) {
    if (existing.pos !== parsed.pos) continue;
    const parts = existing.gloss.split(/([；;])/u);
    let changed = false;
    for (let partIndex = 0; partIndex < parts.length; partIndex += 2) {
      const part = parts[partIndex]!.trim();
      const candidate = parsed.gloss.trim();
      if (
        candidate.length === part.length + 1 &&
        editDistance(candidate, part) === 1 &&
        (candidate.endsWith(part) || candidate.startsWith(part))
      ) {
        parts[partIndex] = parts[partIndex]!.replace(part, candidate);
        changed = true;
        break;
      }
    }
    if (!changed) continue;
    existing.gloss = parts.join("");
    const sense = state.senses.find(
      (candidate) => candidate.sense_key === `s.${draft.word.word_key}.${index + 1}`,
    );
    if (sense) sense.gloss = existing.gloss;
    return;
  }
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
  const correctionAt = (round: number, text: string): VisualCorrection | undefined => {
    const exact =
      state.correctionsByPacket.get(packetIdAt(round)) ??
      state.correctionsByEvidence.get(
      correctionEvidenceKey(
        field,
        block.page,
        block.pageImageSha256,
        block.bbox,
        text,
        round,
      ),
    );
    if (exact) return exact;
    const compatible = state.correctionsByLocation
      .flatMap((correction) => {
        if (
          correction.field !== field ||
          correction.page_number !== block.page ||
          correction.page_image_sha256 !== block.pageImageSha256 ||
          correction.round !== round ||
          correction.bbox === undefined ||
          correction.original_text === undefined
        ) {
          return [];
        }
        const bboxDistance = Math.max(
          ...block.bbox.map((value, index) => Math.abs(value - correction.bbox![index]!)),
        );
        if (bboxDistance > 0.015) return [];
        const textDistance = editDistance(text, correction.original_text);
        const textMatches =
          text === correction.original_text ||
          (correction.verdict === "REPAIR" &&
            Math.abs(text.length - correction.original_text.length) <= 2 &&
            textDistance <= 2);
        return textMatches ? [{ correction, score: bboxDistance + textDistance }] : [];
      })
      .sort((left, right) => left.score - right.score);
    return compatible[0]?.correction;
  };

  // Highest round an agent decision answers for this field (0 = none).
  let correctedRound = 0;
  for (let round = 1; round <= MAX_PACKET_ROUND; round += 1) {
    if (correctionAt(round, ocrText) !== undefined) correctedRound = round;
  }

  let currentText = ocrText;
  for (let round = 1; round <= correctedRound; round += 1) {
    const packetId = packetIdAt(round);
    const correction = correctionAt(round, currentText);
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
  const fieldConfidence =
    field === "headword"
      ? (block.headwordConfidence ?? block.confidence)
      : (block.phoneticConfidence ?? block.confidence);
  const evidence = evidenceFor(currentText, fieldConfidence, field, config);
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
    ocr_confidence: fieldConfidence,
    evidence_codes: evidence,
    round: correctedRound + 1,
  });
  return currentText;
}

function resolveReviews(state: WalkState, corrections: readonly VisualCorrection[]): void {
  state.correctionsByPacket = new Map(
    corrections.map((correction) => [correction.packet_id, correction]),
  );
  state.correctionsByEvidence = new Map(
    corrections.flatMap((correction) => {
      if (
        correction.field === undefined ||
        correction.page_number === undefined ||
        correction.page_image_sha256 === undefined ||
        correction.bbox === undefined ||
        correction.original_text === undefined
      ) {
        return [];
      }
      return [[
        correctionEvidenceKey(
          correction.field,
          correction.page_number,
          correction.page_image_sha256,
          correction.bbox,
          correction.original_text,
          correction.round,
        ),
        correction,
      ] as const];
    }),
  );
  state.correctionsByLocation = corrections.filter(
    (correction) =>
      correction.field !== undefined &&
      correction.page_number !== undefined &&
      correction.page_image_sha256 !== undefined &&
      correction.bbox !== undefined &&
      correction.original_text !== undefined,
  );
  for (const draft of state.wordDrafts) {
    const headword = resolveField(state, draft, "headword", draft.headword);
    if (headword !== null && headword !== draft.word.headword) {
      draft.word.headword = headword;
      draft.headword = headword;
    }
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
    // Back matter may contain alphabetic index rows that look exactly like
    // vocabulary entries. Mark it outside chapter context so the main walk
    // skips those rows instead of appending the whole index to the last word.
    chapterByPage.push(backMatterFromIndex === null ? current : null);
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
  const partitioned = partitionPageFurniture(preprocess(blocks), DEFAULT_FURNITURE_CONFIG).content;
  const content = expandSourceVerifiedEntries(applySourceVerifiedTextRepairs(
    assembleMultilineExamples(
      markImplicitExamples(
        assembleMultilinePhrases(
          assemblePhraseSections(
            recoverCorruptedHeadwordsBeforeExamples(
              assembleExamMarkers(
                assembleSplitHeadwords(
                  assembleNumberedEntryHeaders(
                    recoverMissingHeadwordsFromExamples(
                      recoverAsciiHeadwordsFromPhonetics(partitioned, config),
                      config,
                    ),
                    config,
                  ),
                  config,
                ),
                config,
              ),
              config,
            ),
            config,
          ),
          config,
        ),
        config,
      ),
      config,
    ),
  ));
  const unitTitleRes = config.unit_title_patterns.map((pattern) => new RegExp(pattern, "u"));
  const state: WalkState = {
    config,
    correctionsByPacket: new Map(),
    correctionsByEvidence: new Map(),
    correctionsByLocation: [],
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
    ignoreNoteTail: false,
    ignoreAllNoteTail: false,
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
    const unitBeforeAttribution = state.currentUnit?.unit_key ?? null;
    let deferBannerReset = false;
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
        deferBannerReset = kind === "banner" && unitBeforeAttribution !== null;
        startUnit(
          state,
          anchor,
          chapter,
          resolved,
          resolvedTitle,
          blocksOfPage[0]!.page,
          kind !== "banner",
        );
      }
    }

    for (const block of blocksOfPage) {
      const text = block.normalizedText;
      if (
        deferBannerReset &&
        block !== anchor &&
        block.bbox[1] >= anchor.bbox[3]
      ) {
        state.currentWord = null;
        state.pendingSourceRef = undefined;
        deferBannerReset = false;
      }
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
            startUnit(state, block, chapter, bannerNumber, text, block.page, false);
          }
        }
        continue;
      }
      if (matchUnitTabNumber(block, config) !== null) {
        // Per-page side tab: attribution already handled it; never content.
        continue;
      }
      const headMatch = HEAD_ENTRY_RE.exec(text);
      const isHeadword = headMatch && findPosMarker(headMatch[3] ?? "", config.pos_markers) !== null;
      if (isHeadword) {
        state.ignoreNoteTail = false;
        state.ignoreAllNoteTail = false;
      }
      if (config.note_patterns.some((pattern) => new RegExp(pattern, "u").test(text))) {
        if (!/^真题词组小记/u.test(text)) {
          state.ignoreNoteTail = true;
          state.ignoreAllNoteTail = /^(?:文化休息站|易混词辨析|相关词|近义词|反义词|同根词|注释)$/u.test(text);
        }
        continue; // Word-root/synonym notes carry no learnable entity.
      }
      if (/^直风连道$/u.test(text)) continue; // damaged duplicate of the adjacent source label
      if (state.ignoreNoteTail && !isHeadword) {
        if (state.ignoreAllNoteTail) continue;
        const pos = findPosMarker(text, config.pos_markers);
        const resumesEntryContent =
          text.startsWith(config.exam_marker) ||
          /^[①②③④⑤⑥⑦⑧⑨⑩]/u.test(text) ||
          SOURCE_REF_ONLY_RE.test(text) ||
          (pos !== null && pos.index <= 2);
        if (!resumesEntryContent) continue;
        state.ignoreNoteTail = false;
        state.ignoreAllNoteTail = false;
      }
      const sourceRef = SOURCE_REF_ONLY_RE.exec(text);
      if (sourceRef && state.currentWord) {
        state.pendingSourceRef = sourceRef[1]!.replace(/年/u, "").replace(/\s+/gu, " ").trim();
        continue;
      }
      const inlineSourceRef = SOURCE_REF_RE.exec(text);
      if (
        inlineSourceRef &&
        state.currentWord &&
        /^[①②③④⑤⑥⑦⑧⑨⑩]/u.test(text)
      ) {
        state.pendingSourceRef = inlineSourceRef[1]!
          .replace(/年/u, "")
          .replace(/\s+/gu, " ")
          .trim();
        const withoutRef = text.slice(0, inlineSourceRef.index).replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/u, "");
        for (const parsed of parseSenses(withoutRef, config)) {
          repairClippedSummaryGloss(state, state.currentWord, parsed);
          const duplicate = state.currentWord.senseDrafts.some(
            (sense) => sense.pos === parsed.pos || sense.gloss.includes(parsed.gloss),
          );
          if (duplicate) continue;
          state.currentWord.senseDrafts.push(parsed);
          state.senses.push({
            sense_key: `s.${state.currentWord.word.word_key}.${state.currentWord.senseDrafts.length}`,
            word_key: state.currentWord.word.word_key,
            ...parsed,
            sense_order: state.currentWord.senseDrafts.length,
            ...provenance(block),
          });
        }
        continue;
      }
      if (isHeadword) {
        startWord(state, block, headMatch);
        continue;
      }
      if (text.startsWith(config.exam_marker)) {
        const body = text.slice(config.exam_marker.length).trim();
        if (body.includes("//")) {
          addPhrase(state, { ...block, text: body, normalizedText: body });
        } else {
          addExample(state, block, config.exam_marker);
        }
        continue;
      }
      const phoneticOnly = PHONETIC_TAIL_RE.exec(text);
      if (state.currentWord && phoneticOnly) {
        const tail = phoneticOnly[2] ?? "";
        const tailPos = findPosMarker(tail, config.pos_markers);
        if (tailPos !== null) {
          for (const parsed of parseSenses(tail, config)) {
            const duplicate = state.currentWord.senseDrafts.some(
              (sense) => sense.pos === parsed.pos && sense.gloss === parsed.gloss,
            );
            if (duplicate) continue;
            state.currentWord.senseDrafts.push(parsed);
            state.senses.push({
              sense_key: `s.${state.currentWord.word.word_key}.${state.currentWord.senseDrafts.length}`,
              word_key: state.currentWord.word.word_key,
              ...parsed,
              sense_order: state.currentWord.senseDrafts.length,
              ...provenance(block),
            });
          }
          continue;
        }
      }
      const standalonePos = findPosMarker(text, config.pos_markers);
      if (
        state.currentWord &&
        standalonePos !== null &&
        standalonePos.index <= 2 &&
        !CJK_RANGE.test(text.slice(0, 1))
      ) {
        for (const parsed of parseSenses(text, config)) {
          repairClippedSummaryGloss(state, state.currentWord, parsed);
          const duplicate = state.currentWord.senseDrafts.some(
            (sense) =>
              sense.pos === parsed.pos &&
              (sense.gloss === parsed.gloss ||
                sense.gloss.includes(parsed.gloss) ||
                parsed.gloss.includes(sense.gloss)),
          );
          if (duplicate) continue;
          state.currentWord.senseDrafts.push(parsed);
          state.senses.push({
            sense_key: `s.${state.currentWord.word.word_key}.${state.currentWord.senseDrafts.length}`,
            word_key: state.currentWord.word.word_key,
            ...parsed,
            sense_order: state.currentWord.senseDrafts.length,
            ...provenance(block),
          });
        }
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
  reassignExamplesByHeadword(state);

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
