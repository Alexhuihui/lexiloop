/** Rebuild the private, whole-book source QA snapshot from saved OCR evidence. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadQueue } from "../src/agents/visual-ocr";
import { findContentOwnershipFindings } from "../src/normalize/content-quality";
import { LLCY_2024_NORMALIZE_CONFIG } from "../src/normalize/config";
import { assignReadingOrder } from "../src/normalize/reading-order";
import { segmentStructure } from "../src/normalize/segmentation";
import { toNormalizeInputBlocks, type OcrBlockRecord } from "../src/ocr-adapter";
import { applyAcceptedSpacingCorrections, loadAcceptedSpacingCorrections } from "../src/ocr-spacing";
import { applyAcceptedSenseCorrections, loadAcceptedSenseCorrections } from "../src/sense-corrections";

interface CleanRow {
  page: number;
  original_image_sha256: string;
}

async function jsonl<T>(file: string): Promise<T[]> {
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--work-dir");
  if (flag < 0 || !process.argv[flag + 1]) {
    throw new Error("usage: tsx audit-source-content.ts --work-dir PRIVATE_SOURCE_WORK_DIR");
  }
  const workDir = path.resolve(process.argv[flag + 1]!);
  const reviewDir = path.join(workDir, "ocr-review-v1");
  const [ocrRows, cleanRows, queue] = await Promise.all([
    jsonl<OcrBlockRecord>(path.join(workDir, "ocr.jsonl")),
    jsonl<CleanRow>(path.join(workDir, "clean.jsonl")),
    loadQueue(path.join(workDir, "agent-queue", "visual-ocr")),
  ]);
  const imageHashes = new Map(cleanRows.map((row) => [row.page, row.original_image_sha256]));
  const spacing = await loadAcceptedSpacingCorrections(workDir);
  const blocks = assignReadingOrder(toNormalizeInputBlocks(
    applyAcceptedSpacingCorrections(ocrRows, spacing, imageHashes),
  ));
  const decisions = queue.filter((entry) => entry.status === "resolved" && entry.result)
    .map((entry) => ({
      packet_id: entry.result!.packet_id,
      verdict: entry.result!.verdict,
      ...(entry.result!.corrected_text !== undefined
        ? { corrected_text: entry.result!.corrected_text } : {}),
      agent_run_id: entry.result!.agent_run_id,
      round: entry.packet.round,
      field: entry.packet.field,
      page_number: entry.packet.page_number,
      page_image_sha256: entry.packet.page_image_sha256,
      bbox: entry.packet.bbox,
      original_text: entry.packet.current_text,
    }));
  const content = segmentStructure(blocks, LLCY_2024_NORMALIZE_CONFIG, decisions);
  const senseTrims = await loadAcceptedSenseCorrections(workDir);
  content.senses = applyAcceptedSenseCorrections(content.senses, senseTrims, imageHashes);

  const words = new Map(content.words.map((word) => [word.word_key, word]));
  const ownership = findContentOwnershipFindings(content);
  const qualityFlags = {
    sense: content.senses.filter((sense) =>
      /[A-Za-z0-9]/u.test(sense.gloss) || sense.gloss.includes("[") || sense.gloss.includes("]"))
      .map((sense) => ({ key: sense.sense_key, gloss: sense.gloss,
        page: sense.page_number, bbox: sense.bbox,
        source_raw_ref_hash: sense.source_raw_ref_hash })),
    phrase: content.phrases.filter((phrase) =>
      /[\u3400-\u9fff]/u.test(phrase.text) || phrase.text.includes("[") || phrase.text.includes("]"))
      .map((phrase) => ({ key: phrase.phrase_key, text: phrase.text, page: phrase.page_number })),
    example: content.examples.filter((example) =>
      /([a-z]{13,}|\s[0-9]{2,3}\s*$|\s[直真]\s)/u.test(example.text))
      .map((example) => ({ key: example.example_key, text: example.text,
        page: example.page_number })),
  };
  const snapshot = {
    source_sha256: ocrRows[0]?.source_sha256 ?? null,
    counts: {
      units: content.units.length, words: content.words.length,
      senses: content.senses.length, phrases: content.phrases.length,
      examples: content.examples.length, visualPending: content.fieldReviews.length,
      blocked: content.blockedFields.length,
    },
    spacingApplied: spacing.length,
    senseTrimsApplied: senseTrims.length,
    ownershipFindings: ownership,
    visualReviews: content.fieldReviews.map((review) => ({
      ...review, headword: words.get(review.word_key)?.headword ?? null,
    })),
    qualityFlags,
  };
  await mkdir(reviewDir, { recursive: true });
  const auditPath = path.join(reviewDir, "normalization-audit.json");
  const audit = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(auditPath, audit);
  await writeFile(path.join(reviewDir, "quality-flags.json"),
    `${JSON.stringify(qualityFlags, null, 2)}\n`);
  const summary = {
    source_sha256: snapshot.source_sha256,
    audit_sha256: createHash("sha256").update(audit).digest("hex"),
    counts: snapshot.counts,
    spacingApplied: spacing.length,
    senseTrimsApplied: senseTrims.length,
    ownershipFindings: ownership.length,
    qualityFlagCounts: Object.fromEntries(
      Object.entries(qualityFlags).map(([kind, rows]) => [kind, rows.length]),
    ),
  };
  await writeFile(path.join(reviewDir, "normalization-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

void main();
