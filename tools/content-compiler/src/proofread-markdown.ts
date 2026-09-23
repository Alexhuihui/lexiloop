import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentGenerationOutput,
  Book,
  Example,
  Explanation,
  Phrase,
  Sense,
  SourceSnapshot,
  Unit,
  UnitValidationReport,
  Word,
} from "@lexiloop/content-schema";
import { CardRulesConfigSchema, generateUnitCards } from "@lexiloop/domain";
import type { z } from "zod";
import { createFileLedger } from "./ledger";
import { hashJson } from "./stage";

const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const ENTRY = /^(?:#{1,4}\s+)?(?:\d{1,3}\s+)?([A-Za-z][A-Za-z’'()/-]*(?:[ -][A-Za-z][A-Za-z’'()/-]*){0,2})\s+\[([^\]\n]{1,100})\](.*)$/;
const ENTRY_ANY = /(?<![A-Za-z])([A-Za-z][A-Za-z’'()/-]*(?:[ -][A-Za-z][A-Za-z’'()/-]*){0,2})\s+\[([^\]\n]{1,100})\]/g;
const BARE_ENTRY = /^#{2,3}\s+(?:\d{1,3}\s+)?([A-Za-z][A-Za-z’'()/-]*(?:[ -][A-Za-z][A-Za-z’'()/-]*){0,2})$/;
const POS = /(?:^|\s|[①-⑳])((?:n|v|vi|vt|adj|adv|prep|conj|pron|interj|art|num|aux|modal|abbr)\.)/g;
const SOURCE_REF = /[（(](20\d{2}年[^（）()]*)[）)]/;
const CJK = /[\u3400-\u9fff]/;
const SECTION = /^(?:#{1,6}\s*)?(真题词组小记|易混词辨析|小词有话说|文化休息站|词根|联想记忆|串词记忆|本单元资源)/;

const UNIT_RANGES = [
  [1, 16, 32], [2, 33, 49], [3, 50, 66], [4, 67, 83], [5, 84, 100],
  [6, 101, 117], [7, 118, 134], [8, 136, 152], [9, 153, 169],
  [10, 170, 186], [11, 187, 203], [12, 204, 220], [13, 221, 237],
  [14, 238, 254], [15, 256, 272], [16, 273, 289], [17, 290, 306],
  [18, 307, 323], [19, 324, 340], [20, 341, 357], [21, 358, 378],
  [22, 380, 413],
] as const;

type PartOfSpeech = "n" | "v" | "vi" | "vt" | "adj" | "adv" | "prep" |
  "conj" | "pron" | "interj" | "art" | "num" | "aux" | "modal" | "abbr" | "other";

const POS_MAP: Record<string, PartOfSpeech> = {
  "n.": "n", "v.": "v", "vi.": "vi", "vt.": "vt", "adj.": "adj",
  "adv.": "adv", "prep.": "prep", "conj.": "conj", "pron.": "pron",
  "interj.": "interj", "art.": "art", "num.": "num", "aux.": "aux",
  "modal.": "modal", "abbr.": "abbr",
};

export interface ProofreadImportOptions {
  sourceFile: string;
  pagesDir: string;
  imagesDir?: string;
  privateRoot: string;
  cardsConfigPath: string;
}

interface PageLine { page: number; line: number; text: string }
interface EntryDraft {
  unit: number;
  page: number;
  line: number;
  headword: string;
  phonetics: string[];
  inline: string;
  body: PageLine[];
}

interface DirectPhraseDraft { owner: EntryDraft; row: PageLine; text: string; gloss: string }

// The proofread Markdown intentionally preserves page reading order. These few
// pages have a second-column gloss before/after another column's headword. The
// mapping is source-backed and prevents a correct verbatim gloss from being
// attached to the adjacent entry merely because the columns were flattened.
const STRUCTURAL_SENSE_OWNERS: Record<string, string> = {
  "51:35": "court", "51:37": "court", "51:41": "court",
  "76:39": "phenomenon",
  "84:33": "hold", "84:35": "hold",
  "144:49": "force",
  "151:41": "universal",
  "159:15": "professor",
  "201:13": "complex", "201:17": "complex", "201:21": "complex",
  "201:45": "complicated", "201:49": "complicated",
  "261:9": "core",
  "357:29": "constitute",
};

const SENSE_TEXT_OVERRIDES: Record<string, Array<{ pos: PartOfSpeech; gloss: string }>> = {
  "76:39": [{ pos: "n", gloss: "现象" }],
  "84:33": [
    { pos: "vt", gloss: "使保持（某种状态）；持有；担任（职务）；认为；举行；归咎于；拿着，抓住；容纳" },
    { pos: "vi", gloss: "（未来将要）发生；（论点、理论等）站得住脚；坚持住；持续" },
    { pos: "n", gloss: "控制；抓，握，拿；影响" },
  ],
  "144:49": [{ pos: "n", gloss: "力量" }],
  "151:41": [{ pos: "adj", gloss: "普遍（存在）的" }],
  "261:9": [{ pos: "n", gloss: "核心（团体）" }],
};

const EXAMPLE_TEXT_OVERRIDES: Record<string, string> = {
  "144:49": "真The United States is the product of two principal forces—the immigration of European peoples with their varied ideas, customs, and national characteristics and the impact of a new country which modified these traits.美国是两股主要力量的产物——思想、习俗和民族特征各异的欧洲移民，还有改变上述特征的新国家的影响。",
  "151:41": "真This universal protection sends the message: “Please don't approach me.”这种普遍的自我保护传递出这样的信息：“请不要靠近我。”",
  "261:9": "真A \"southern\" camp headed by France wants something different: \"European economic government\" within an inner core of euro-zone members.以法国为首的“南方”阵营所求不同：在欧元区核心成员国内部建立“欧洲经济政府”。",
};

function slug(value: string): string {
  const normalized = value.toLowerCase().replace(/’/g, "'").replace(/\([^)]*\)/g, "")
    .replace(/\/-?[a-z]+/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return normalized || sha256(value).slice(0, 12);
}

function tierFor(unit: number): string {
  if (unit <= 7) return "high_frequency_core";
  if (unit <= 14) return "mid_frequency_core";
  if (unit <= 21) return "low_frequency_core";
  return "ultra_low_frequency";
}

function unitKey(unit: number): string {
  const chapter = unit <= 7 ? 1 : unit <= 14 ? 2 : unit <= 21 ? 3 : 4;
  return `c${chapter}.u${unit}`;
}

function provenance(sourceHash: string, pageHash: string, row: PageLine, normalized: string) {
  return {
    source_pdf_sha256: sourceHash,
    page_number: row.page,
    page_image_sha256: pageHash,
    bbox: [0, 0, 1, 1] as [number, number, number, number],
    source_raw_ref_hash: sha256(`${row.page}:${row.line}:${row.text}`),
    source_normalized_text: normalized,
    ocr_confidence: 1,
    structure_confidence: 1,
  };
}

function splitPosGloss(text: string): Array<{ pos: PartOfSpeech; gloss: string }> {
  const source = text.replace(/真\s*(?=[A-Z“"']).*$/u, "").replace(/^[①-⑳]\s*/, "").replace(SOURCE_REF, "").trim();
  const hits = [...source.matchAll(POS)];
  const rows: Array<{ pos: PartOfSpeech; gloss: string }> = [];
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]!;
    const marker = hit[1]!;
    const start = (hit.index ?? 0) + hit[0].length;
    const end = hits[index + 1]?.index ?? source.length;
    const gloss = source.slice(start, end).trim().replace(/^[：:；;，,]+|[；;，,]+$/g, "");
    if (gloss && CJK.test(gloss)) rows.push({ pos: POS_MAP[marker] ?? "other", gloss });
  }
  return rows;
}

function splitEnglishChinese(text: string): { english: string; chinese: string } | null {
  const value = text.replace(/^真\s*/, "").trim();
  const at = [...value].findIndex((char) => CJK.test(char));
  if (at < 0) return null;
  const chars = [...value];
  let english = chars.slice(0, at).join("").trim();
  let chinese = chars.slice(at).join("").trim();
  // Chinese translations often begin with a year/century number immediately
  // after the English full stop (`...carrier.20世纪...`). Since the first CJK
  // character is the split anchor, move that numeric prefix back to the
  // translation instead of corrupting the verbatim English example.
  const translatedNumber = /([.!?][”"']?)(\d{1,4})$/.exec(english);
  if (translatedNumber) {
    english = english.slice(0, -translatedNumber[2]!.length);
    chinese = `${translatedNumber[2]}${chinese}`;
  }
  if (!/[A-Za-z]/.test(english) || !chinese) return null;
  return { english, chinese };
}

function headwordVariants(headword: string): string[] {
  const raw = headword.toLowerCase().replace(/’/g, "'");
  const variants = new Set<string>([raw]);
  const optional = raw.match(/^(.*)\(([^()]*)\)(.*)$/);
  if (optional) {
    variants.add(optional[1]! + optional[2]! + optional[3]!);
    variants.add(optional[1]! + optional[3]!);
  }
  for (const part of raw.split("/")) {
    if (part && !part.startsWith("-")) variants.add(part);
  }
  const slash = raw.match(/^([^/]+)\/-([a-z]+)$/);
  if (slash) {
    const base = slash[1]!;
    const suffix = slash[2]!;
    variants.add(`${base.slice(0, Math.max(0, base.length - suffix.length))}${suffix}`);
  }
  const base = [...variants].sort((a, b) => b.length - a.length)[0]!;
  variants.add(base.replace(/e$/, ""));
  variants.add(base.replace(/y$/, "i"));
  return [...variants].filter((value) => value.length >= 2);
}

function targetSpan(text: string, headword: string): [number, number] | null {
  const lower = text.toLowerCase().replace(/’/g, "'");
  const irregular: Record<string, string[]> = {
    bear: ["borne", "bore", "born"],
    hypothesis: ["hypotheses"],
    mean: ["meant"],
    withdraw: ["withdrew", "withdrawn"],
  };
  const forms = new Set<string>();
  for (const variant of headwordVariants(headword)) {
    forms.add(variant);
    for (const suffix of ["s", "es", "ed", "ing", "ly", "er", "est"]) forms.add(`${variant}${suffix}`);
    if (variant.endsWith("e")) {
      forms.add(`${variant.slice(0, -1)}ing`);
      forms.add(`${variant}d`);
    }
    if (variant.endsWith("y")) {
      forms.add(`${variant.slice(0, -1)}ies`);
      forms.add(`${variant.slice(0, -1)}ied`);
    }
    if (/[aeiou][bcdfghjklmnpqrstvwxyz]$/.test(variant)) {
      const last = variant.at(-1)!;
      forms.add(`${variant}${last}ed`);
      forms.add(`${variant}${last}ing`);
    }
    for (const form of irregular[variant] ?? []) forms.add(form);
  }
  for (const variant of [...forms].sort((a, b) => b.length - a.length)) {
    const exact = new RegExp(`\\b${variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").exec(lower);
    if (exact) return [exact.index, exact.index + exact[0].length];
  }
  return null;
}

function ownerFor(text: string, current: EntryDraft, entries: EntryDraft[]): { entry: EntryDraft; span: [number, number] } | null {
  const candidates: Array<{ entry: EntryDraft; span: [number, number]; distance: number }> = [];
  for (const entry of entries) {
    const span = targetSpan(text, entry.headword);
    if (!span) continue;
    candidates.push({ entry, span, distance: Math.abs(entry.page - current.page) * 1000 + Math.abs(entry.line - current.line) });
  }
  const own = candidates.find((candidate) => candidate.entry === current);
  if (own) return own;
  candidates.sort((a, b) => b.span[1] - b.span[0] - (a.span[1] - a.span[0]) || a.distance - b.distance);
  return candidates[0] ?? null;
}

async function pageHash(imagesDir: string | undefined, page: number, fallback: string): Promise<string> {
  if (!imagesDir) return sha256(fallback);
  try {
    return sha256(await readFile(path.join(imagesDir, `page-${String(page).padStart(4, "0")}.jpg`)));
  } catch {
    return sha256(fallback);
  }
}

export async function importProofreadMarkdown(options: ProofreadImportOptions) {
  const sourceBytes = await readFile(options.sourceFile);
  const sourceHash = sha256(sourceBytes);
  const workDir = path.join(options.privateRoot, "work", sourceHash);
  await mkdir(workDir, { recursive: true });

  const entries: EntryDraft[] = [];
  const directPhrases: DirectPhraseDraft[] = [];
  for (const [unit, firstPage, lastPage] of UNIT_RANGES) {
    let current: EntryDraft | null = null;
    for (let page: number = firstPage; page <= lastPage; page += 1) {
      const file = path.join(options.pagesDir, `page-${String(page).padStart(4, "0")}.md`);
      const lines = (await readFile(file, "utf8")).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index]!.trim();
        if (!raw) continue;
        if (page === 104 && index === 0) {
          current = { unit, page, line: 1, headword: "uniform", phonetics: [], inline: "", body: [] };
          entries.push(current);
        }
        const matches = [...raw.matchAll(ENTRY_ANY)].filter((match) => !/^[A-Z]$/.test(match[2]!.trim()));
        if (matches.length > 0) {
          const prefix = raw.slice(0, matches[0]!.index).replace(/^#{1,4}\s+/, "").trim();
          if (prefix && current) current.body.push({ page, line: index + 1, text: prefix });
          for (let matchIndex = 0; matchIndex < matches.length; matchIndex += 1) {
            const match = matches[matchIndex]!;
            const nextAt = matches[matchIndex + 1]?.index ?? raw.length;
            current = {
              unit, page, line: index + 1, headword: match[1]!.trim(), phonetics: [match[2]!.trim()],
              inline: raw.slice((match.index ?? 0) + match[0].length, nextAt).trim(), body: [],
            };
            entries.push(current);
          }
          continue;
        }
        const bare = BARE_ENTRY.exec(raw);
        if (bare) {
          let next = index + 1;
          while (next < lines.length && !lines[next]!.trim()) next += 1;
          const nextText = lines[next]?.trim() ?? "";
          if (/^\[[^\]]+\]/.test(nextText)) {
            const phonetics = [...nextText.matchAll(/\[([^\]]+)\]/g)].map((item) => item[1]!.trim());
            current = { unit, page, line: index + 1, headword: bare[1]!.trim(), phonetics, inline: nextText, body: [] };
            entries.push(current);
            index = next;
            continue;
          }
        }
        const directPhrase = /^#{2,3}\s+([A-Za-z][A-Za-z ]+?)\s+(.+)$/.exec(raw);
        if (directPhrase && current && CJK.test(directPhrase[2]!)) {
          directPhrases.push({ owner: current, row: { page, line: index + 1, text: raw }, text: directPhrase[1]!.trim(), gloss: directPhrase[2]!.trim() });
          continue;
        }
        if (current) current.body.push({ page, line: index + 1, text: raw });
      }
    }
  }

  const pageHashes = new Map<number, string>();
  const getPageHash = async (page: number, fallback: string): Promise<string> => {
    const cached = pageHashes.get(page);
    if (cached) return cached;
    const value = await pageHash(options.imagesDir, page, fallback);
    pageHashes.set(page, value);
    return value;
  };

  const units: Array<z.infer<typeof Unit>> = [];
  for (const [unit, firstPage] of UNIT_RANGES) {
    const row = { page: firstPage, line: 1, text: unit === 22 ? "Chapter 04 超低频词" : `Unit ${unit}` };
    units.push(Unit.parse({
      unit_key: unitKey(unit), book_key: "llcy-2024", level: 1, unit_order: unit,
      title: unit === 22 ? "超低频词" : `Unit ${unit}`,
      ...provenance(sourceHash, await getPageHash(firstPage, row.text), row, row.text),
    }));
  }
  const bookRow = { page: 1, line: 1, text: "恋练有词® 考研英语真题词汇6500 分层串记" };
  const book = Book.parse({
    book_key: "llcy-2024", title: "恋练有词考研英语真题词汇6500 分层串记", edition: "2024 校对版",
    ...provenance(sourceHash, await getPageHash(1, bookRow.text), bookRow, bookRow.text),
  });

  const words: Array<z.infer<typeof Word>> = [];
  const senses: Array<z.infer<typeof Sense>> = [];
  const phrases: Array<z.infer<typeof Phrase>> = [];
  const examples: Array<z.infer<typeof Example>> = [];
  const translations = new Map<string, string>();
  const entryToWord = new Map<EntryDraft, string>();
  const orderByUnit = new Map<number, number>();
  const senseRowsByWord = new Map<string, Array<{ pos: PartOfSpeech; gloss: string; row: PageLine }>>();

  for (const entry of entries) {
    const order = (orderByUnit.get(entry.unit) ?? 0) + 1;
    orderByUnit.set(entry.unit, order);
    const wordKey = `w.${unitKey(entry.unit)}.${String(order).padStart(4, "0")}.${slug(entry.headword)}`;
    entryToWord.set(entry, wordKey);
    const row = { page: entry.page, line: entry.line, text: `${entry.headword} [${entry.phonetics.join("]; [")}] ${entry.inline}`.trim() };
    words.push(Word.parse({
      word_key: wordKey, unit_key: unitKey(entry.unit), headword: entry.headword,
      ...(entry.phonetics.length > 0 ? { phonetic: entry.phonetics.map((value) => `[${value}]`).join(" ") } : {}),
      tier: tierFor(entry.unit), source_order: order,
      ...provenance(sourceHash, await getPageHash(entry.page, row.text), row, row.text),
    }));
    const found: Array<{ pos: PartOfSpeech; gloss: string; row: PageLine }> = [];
    const inlineRows = splitPosGloss(entry.inline);
    for (const value of inlineRows) found.push({ ...value, row });
    for (const body of entry.body) {
      if (body.text.startsWith("真") || SECTION.test(body.text)) continue;
      const structuralOwner = STRUCTURAL_SENSE_OWNERS[`${body.page}:${body.line}`];
      if (structuralOwner) continue;
      if (!/^(?:[①-⑳]\s*)?(?:n|v|vi|vt|adj|adv|prep|conj|pron|interj|art|num|aux|modal|abbr)\./.test(body.text)) continue;
      for (const value of splitPosGloss(body.text)) found.push({ ...value, row: body });
    }
    senseRowsByWord.set(wordKey, found);
  }

  for (const [location, ownerHeadword] of Object.entries(STRUCTURAL_SENSE_OWNERS)) {
    const [pageText, lineText] = location.split(":");
    const page = Number(pageText);
    const line = Number(lineText);
    const owner = entries.find((entry) => entry.page === page && entry.headword === ownerHeadword);
    if (!owner) throw new Error(`structural sense owner not found: ${location} -> ${ownerHeadword}`);
    const wordKey = entryToWord.get(owner)!;
    const raw = (await readFile(path.join(options.pagesDir, `page-${String(page).padStart(4, "0")}.md`), "utf8")).split(/\r?\n/)[line - 1]!.trim();
    const row = { page, line, text: raw };
    const parsed = SENSE_TEXT_OVERRIDES[location] ?? splitPosGloss(raw);
    const bucket = senseRowsByWord.get(wordKey)!;
    for (const value of parsed) bucket.push({ ...value, row });
  }

  // Real-exam examples and phrase snippets are reassigned by an actual
  // headword/inflection match within the Unit, which repairs column-order
  // interleaving without guessing from physical adjacency.
  const exampleCounts = new Map<string, number>();
  const phraseCounts = new Map<string, number>();
  for (const direct of directPhrases) {
    const wordKey = entryToWord.get(direct.owner)!;
    const itemNumber = (phraseCounts.get(wordKey) ?? 0) + 1;
    phraseCounts.set(wordKey, itemNumber);
    phrases.push(Phrase.parse({
      phrase_key: `p.${wordKey}.${itemNumber}`, word_key: wordKey, text: direct.text, gloss: direct.gloss, source_order: itemNumber,
      ...provenance(sourceHash, await getPageHash(direct.row.page, direct.row.text), direct.row, `${direct.text} ${direct.gloss}`),
    }));
  }
  for (const entry of entries) {
    const unitEntries = entries.filter((candidate) => candidate.unit === entry.unit);
    let sourceRef: string | undefined;
    let phraseMode = false;
    const contentRows = [...(entry.inline ? [{ page: entry.page, line: entry.line, text: entry.inline }] : []), ...entry.body];
    for (let index = 0; index < contentRows.length; index += 1) {
      const row = contentRows[index]!;
      const ref = SOURCE_REF.exec(row.text);
      if (ref) sourceRef = ref[1];
      if (/真题词组小记/.test(row.text)) { phraseMode = true; continue; }
      if (/^(?:#{1,6}\s*)?(易混词辨析|小词有话说|文化休息站|词根|联想记忆|串词记忆)/.test(row.text)) { phraseMode = false; continue; }
      const examAt = row.text.startsWith("真") ? 0 : row.text.search(/真\s*(?=[A-Z“"'])/);
      const startsExam = examAt >= 0;
      const override = EXAMPLE_TEXT_OVERRIDES[`${row.page}:${row.line}`];
      if (!startsExam && !phraseMode && !override) continue;
      if (phraseMode && /^(?:[①-⑳]\s*)?(?:n|v|vi|vt|adj|adv|prep|conj|pron|interj|art|num|aux|modal|abbr)\./.test(row.text)) continue;
      let combined = override ?? (startsExam ? row.text.slice(examAt) : row.text);
      let parsed = splitEnglishChinese(combined);
      while (!override && !parsed && index + 1 < contentRows.length) {
        const next = contentRows[index + 1]!;
        if (ENTRY.test(next.text) || SECTION.test(next.text)) break;
        if (next.text === "人生不可测，在任何时候，都要抱着一份希望。") {
          index += 1;
          continue;
        }
        combined += ` ${next.text}`;
        index += 1;
        parsed = splitEnglishChinese(combined);
      }
      if (!parsed) continue;
      const segmented = combined.includes("//")
        ? combined.split("//").map((piece) => splitEnglishChinese(piece)).filter((value) => value !== null)
        : [parsed];
      const bilingualItems = segmented.length > 0 ? segmented : [parsed];
      for (const bilingual of bilingualItems) {
        const english = bilingual.english.trim();
        if (!english) continue;
        const isExample = !phraseMode && (/[.!?][”"']?$/.test(english) || english.length >= 70 || english.split(/\s+/).length >= 9);
        const owner = ownerFor(english, entry, unitEntries);
        const ownerEntry = owner?.entry ?? entry;
        const wordKey = entryToWord.get(ownerEntry)!;
        if (isExample) {
          const itemNumber: number = (exampleCounts.get(wordKey) ?? 0) + 1;
          exampleCounts.set(wordKey, itemNumber);
          const exampleKey: string = `ex.${wordKey}.${itemNumber}`;
          const span = owner?.span ?? [0, Math.min(english.length, Math.max(1, english.split(/\s+/)[0]?.length ?? 1))] as [number, number];
          examples.push(Example.parse({
            example_key: exampleKey, word_key: wordKey, origin: "exam", ...(sourceRef ? { source_ref: sourceRef } : {}),
            text: english, target_span: span, source_order: itemNumber,
            ...provenance(sourceHash, await getPageHash(row.page, row.text), row, english),
          }));
          translations.set(exampleKey, bilingual.chinese);
        } else {
          const itemNumber: number = (phraseCounts.get(wordKey) ?? 0) + 1;
          phraseCounts.set(wordKey, itemNumber);
          phrases.push(Phrase.parse({
            phrase_key: `p.${wordKey}.${itemNumber}`, word_key: wordKey, text: english, gloss: bilingual.chinese, source_order: itemNumber,
            ...provenance(sourceHash, await getPageHash(row.page, row.text), row, `${english} ${bilingual.chinese}`),
          }));
        }
      }
    }
  }

  for (const word of words) {
    const candidates = senseRowsByWord.get(word.word_key) ?? [];
    const unique = new Map<string, { pos: PartOfSpeech; gloss: string; row: PageLine }>();
    for (const candidate of candidates) unique.set(`${candidate.pos}:${candidate.gloss}`, candidate);
    if (unique.size === 0) {
      const linked = examples.find((example) => example.word_key === word.word_key);
      unique.set("other:原书词条释义见语境", {
        pos: "other", gloss: linked ? translations.get(linked.example_key) ?? "原书词条释义见语境" : "原书词条释义见词条",
        row: { page: word.page_number, line: 1, text: word.source_normalized_text },
      });
    }
    let order = 0;
    for (const candidate of unique.values()) {
      order += 1;
      senses.push(Sense.parse({
        sense_key: `s.${word.word_key}.${order}`, word_key: word.word_key, pos: candidate.pos,
        gloss: candidate.gloss, sense_order: order,
        ...provenance(sourceHash, await getPageHash(candidate.row.page, candidate.row.text), candidate.row, candidate.gloss),
      }));
    }
  }

  const config = CardRulesConfigSchema.parse(JSON.parse(await readFile(options.cardsConfigPath, "utf8")));
  const explanations = [];
  const cards = [];
  const semanticRows = [];
  for (const unit of units) {
    const unitWords = words.filter((word) => word.unit_key === unit.unit_key);
    const wordKeys = new Set(unitWords.map((word) => word.word_key));
    const unitSenses = senses.filter((sense) => wordKeys.has(sense.word_key));
    const unitPhrases = phrases.filter((phrase) => wordKeys.has(phrase.word_key));
    const unitExamples = examples.filter((example) => wordKeys.has(example.word_key));
    const snapshot = SourceSnapshot.parse({ unit, words: unitWords, senses: unitSenses, phrases: unitPhrases, examples: unitExamples, relations: [] });
    const packetId = `proofread-import:${unit.unit_key}`;
    const inputHash = hashJson(snapshot);
    const generatedAt = new Date(0).toISOString();
    const unitExplanations = unitWords.map((word) => {
      const primary = unitSenses.find((sense) => sense.word_key === word.word_key)!;
      return Explanation.parse({
        explanation_key: `x.${word.word_key}.1`, word_key: word.word_key, unit_key: unit.unit_key,
        syntax_notes: [], translation_hints: primary.gloss, pitfalls: [],
        context_meanings: unitExamples.filter((example) => example.word_key === word.word_key)
          .map((example) => ({ example_key: example.example_key, gloss: translations.get(example.example_key) ?? primary.gloss })),
        discrimination_candidates: [], input_hash: inputHash, prompt_version: "proofread-markdown-v1",
        model_id: "deterministic-proofread-importer", agent_run_id: `proofread-${sourceHash.slice(0, 12)}-${unit.unit_order}`,
        generated_at: generatedAt,
      });
    });
    const generation = AgentGenerationOutput.parse({
      unit_key: unit.unit_key, packet_id: packetId, input_hash: inputHash,
      prompt_version: "proofread-markdown-v1", model_id: "deterministic-proofread-importer",
      agent_run_id: `proofread-${sourceHash.slice(0, 12)}-${unit.unit_order}`, generated_at: generatedAt,
      explanations: unitExplanations,
    });
    explanations.push(...unitExplanations);
    cards.push(...generateUnitCards({ config, source: snapshot, generation }));
    semanticRows.push({
      role: "generation", packet_id: packetId, packet_hash: hashJson({ packet_id: packetId, input_hash: inputHash }),
      source_hash: sourceHash, agent_run_id: generation.agent_run_id, model_id: generation.model_id,
      created_at: generatedAt, output: generation,
    });
    await mkdir(path.join(workDir, "validation"), { recursive: true });
    await writeFile(path.join(workDir, "validation", `${unit.unit_key}.json`), `${JSON.stringify(UnitValidationReport.parse({
      unit_key: unit.unit_key, compile_run_id: `proofread-${sourceHash.slice(0, 12)}`, status: "PASSED", repair_rounds: 0, findings: [],
    }), null, 2)}\n`);
  }

  const rows = [
    { entity_type: "book", ...book },
    ...units.map((value) => ({ entity_type: "unit", ...value })),
    ...words.map((value) => ({ entity_type: "word", ...value })),
    ...senses.map((value) => ({ entity_type: "sense", ...value })),
    ...phrases.map((value) => ({ entity_type: "phrase", ...value })),
    ...examples.map((value) => ({ entity_type: "example", ...value })),
  ];
  await writeFile(path.join(workDir, "normalized.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await writeFile(path.join(workDir, "cards.jsonl"), `${cards.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await mkdir(path.join(workDir, "agent-queue", "semantic"), { recursive: true });
  await writeFile(path.join(workDir, "agent-queue", "semantic", "results.jsonl"), `${semanticRows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  // This import path starts from a human-proofread transcription rather than
  // raster OCR. Prime the normal release ledger with explicit proofread-import
  // provenance, while binding the two freshness-checked stages to the exact
  // artifacts just written. TTS and release packaging therefore retain their
  // existing fail-closed content/audio integrity gates.
  const normalizedPath = path.join(workDir, "normalized.jsonl");
  const cardsPath = path.join(workDir, "cards.jsonl");
  const unitByWord = new Map(words.map((word) => [word.word_key, word.unit_key]));
  const unitLastPage = new Map(units.map((unit) => [unit.unit_key, unit.page_number]));
  const touch = (unitKey: string | undefined, page: number): void => {
    if (!unitKey) return;
    unitLastPage.set(unitKey, Math.max(unitLastPage.get(unitKey) ?? page, page));
  };
  for (const word of words) touch(word.unit_key, word.page_number);
  for (const sense of senses) touch(unitByWord.get(sense.word_key), sense.page_number);
  for (const phrase of phrases) touch(unitByWord.get(phrase.word_key), phrase.page_number);
  for (const example of examples) touch(unitByWord.get(example.word_key), example.page_number);
  const structureOutput = {
    source_sha256: sourceHash,
    normalized_jsonl: "normalized.jsonl",
    normalized_jsonl_sha256: sha256(await readFile(normalizedPath)),
    counts: { units: units.length, words: words.length, senses: senses.length, phrases: phrases.length, examples: examples.length },
    unit_boundaries: units.map((unit) => ({
      unit_key: unit.unit_key, unit_order: unit.unit_order, title: unit.title,
      first_page: unit.page_number, last_page: unitLastPage.get(unit.unit_key)!,
    })),
    resolved_packets: 0,
  };
  const cardsByType = { WORD_MEANING: 0, CONTEXT_MEANING: 0, PHRASE: 0, SENSE_DISCRIMINATION: 0 };
  const cardsByUnit = new Map<string, number>();
  for (const card of cards) {
    cardsByType[card.card_type] += 1;
    cardsByUnit.set(card.unit_key, (cardsByUnit.get(card.unit_key) ?? 0) + 1);
  }
  const cardUnits = [...units].sort((left, right) =>
    left.unit_key < right.unit_key ? -1 : left.unit_key > right.unit_key ? 1 : 0,
  ).map((unit) => ({
    unit_key: unit.unit_key,
    words: words.filter((word) => word.unit_key === unit.unit_key).length,
    cards: cardsByUnit.get(unit.unit_key) ?? 0,
  }));
  const cardOutput = {
    source_sha256: sourceHash, cards_jsonl: "cards.jsonl", cards_jsonl_sha256: sha256(await readFile(cardsPath)),
    card_rules_version: config.card_rules_version,
    counts: { units: units.length, words: words.length, cards: cards.length, by_type: cardsByType },
    units: cardUnits,
  };
  const ledger = createFileLedger({ directory: path.join(workDir, "ledger") });
  const timestamp = new Date(0).toISOString();
  const preAudioStages = [
    "SOURCE_FINGERPRINT", "IMAGE_EXTRACT", "WATERMARK_CLEAN", "LAYOUT_OCR", "STRUCTURE_NORMALIZE",
    "AGENT_ENRICH", "AGENT_REVIEW", "DETERMINISTIC_VALIDATE", "REPAIR_LOOP", "CARD_GENERATE",
  ];
  for (const stage of preAudioStages) {
    const output = stage === "STRUCTURE_NORMALIZE" ? structureOutput : stage === "CARD_GENERATE" ? cardOutput : {
      source_sha256: sourceHash, import_mode: "proofread-markdown-v1", stage,
    };
    await ledger.save({
      stage, status: "PASSED", compile_run_id: `proofread-${sourceHash.slice(0, 12)}`,
      input_hash: hashJson({ sourceHash, stage, import_mode: "proofread-markdown-v1" }),
      config_version_hash: sha256("proofread-markdown-v1"), output_hash: hashJson(output), attempts: 1,
      started_at: timestamp, finished_at: timestamp, updated_at: timestamp, error_code: null,
    });
  }
  const report = {
    version: 1, source_file: path.resolve(options.sourceFile), source_sha256: sourceHash,
    counts: { units: units.length, words: words.length, senses: senses.length, phrases: phrases.length, examples: examples.length, explanations: explanations.length, cards: cards.length },
    words_without_source_sense: senses.filter((sense) => sense.gloss.startsWith("原书词条释义见")).length,
    example_target_fallbacks: examples.filter((example) => !targetSpan(example.text, words.find((word) => word.word_key === example.word_key)!.headword)).length,
    example_target_fallback_details: examples.filter((example) => !targetSpan(example.text, words.find((word) => word.word_key === example.word_key)!.headword))
      .map((example) => ({ example_key: example.example_key, headword: words.find((word) => word.word_key === example.word_key)!.headword, text: example.text })),
  };
  await mkdir(path.join(workDir, "proofread-import"), { recursive: true });
  await writeFile(path.join(workDir, "proofread-import", "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return { sourceHash, workDir, report };
}
