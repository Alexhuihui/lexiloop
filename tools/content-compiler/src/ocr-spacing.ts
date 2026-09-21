/** Separately proven spacing-only corrections; raw OCR evidence stays intact. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { fileExists, readJsonl } from "./media";
import type { OcrBlockRecord } from "./ocr-adapter";

export const ACCEPTED_SPACING_FILE = "ocr-review-v1/accepted-spacing.jsonl";
const HEX64 = /^[0-9a-f]{64}$/;

export const AcceptedSpacingSchema = z.object({
  page: z.number().int().positive(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  source_raw_ref_hash: z.string().regex(HEX64),
  original_image_sha256: z.string().regex(HEX64),
  old_text: z.string().min(1),
  candidate_text: z.string().min(1),
  verdict: z.literal("ACCEPTED_WHITESPACE_ONLY"),
}).strict();
export type AcceptedSpacingCorrection = z.output<typeof AcceptedSpacingSchema>;

function rowKey(page: number, bbox: readonly number[], rawHash: string): string {
  return JSON.stringify([page, bbox, rawHash]);
}

function isAdditiveAsciiSpace(original: string, candidate: string): boolean {
  let before = 0;
  let after = 0;
  let inserted = false;
  while (before < original.length && after < candidate.length) {
    if (original[before] === candidate[after]) {
      before += 1;
      after += 1;
      continue;
    }
    if (
      candidate[after] === " " &&
      before > 0 &&
      /[A-Za-z]/u.test(original[before - 1]!) &&
      /[A-Za-z]/u.test(original[before]!)
    ) {
      inserted = true;
      after += 1;
      continue;
    }
    return false;
  }
  return inserted && before === original.length && after === candidate.length;
}

/** Fail closed on stale, duplicate, forged, or non-spacing corrections. */
export function applyAcceptedSpacingCorrections(
  records: readonly OcrBlockRecord[],
  corrections: readonly AcceptedSpacingCorrection[],
  originalImageHashes: ReadonlyMap<number, string>,
): OcrBlockRecord[] {
  const byKey = new Map<string, AcceptedSpacingCorrection>();
  for (const raw of corrections) {
    const correction = AcceptedSpacingSchema.parse(raw);
    const key = rowKey(correction.page, correction.bbox, correction.source_raw_ref_hash);
    if (byKey.has(key)) throw new Error(`duplicate accepted spacing correction: ${key}`);
    if (originalImageHashes.get(correction.page) !== correction.original_image_sha256) {
      throw new Error(`spacing correction page ${correction.page}: original image hash mismatch`);
    }
    if (createHash("sha256").update(correction.old_text).digest("hex") !== correction.source_raw_ref_hash) {
      throw new Error(`spacing correction page ${correction.page}: raw text hash mismatch`);
    }
    if (!isAdditiveAsciiSpace(correction.old_text, correction.candidate_text)) {
      throw new Error(`spacing correction page ${correction.page}: not additive whitespace`);
    }
    byKey.set(key, correction);
  }
  const matched = new Set<string>();
  const corrected = records.map((record) => {
    const key = rowKey(record.page, record.bbox, record.source_raw_ref_hash);
    const correction = byKey.get(key);
    if (!correction) return record;
    if (matched.has(key) || record.text !== correction.old_text) {
      throw new Error(`spacing correction page ${record.page}: OCR row identity mismatch`);
    }
    matched.add(key);
    return { ...record, text: correction.candidate_text };
  });
  if (matched.size !== byKey.size) {
    throw new Error(`spacing corrections missing ${byKey.size - matched.size} OCR row(s)`);
  }
  return corrected;
}

export async function loadAcceptedSpacingCorrections(workDir: string): Promise<AcceptedSpacingCorrection[]> {
  const path = join(workDir, ACCEPTED_SPACING_FILE);
  return (await fileExists(path)) ? readJsonl(path, AcceptedSpacingSchema) : [];
}
