/**
 * Adapter for the Python layout-OCR worker (design doc 5.4).
 *
 * `lexiloop_media ocr` emits one strict `OcrBlockRecord` per OCR text line in
 * `ocr.jsonl` plus private per-page raw text under `ocr-raw/`. This module
 * mirrors the record schema in Zod and validates EVERY line — plus its hash
 * chaining to the cleaned page images and the raw-text evidence — before
 * normalization may consume it.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  COMPILER_ROOT,
  fileExists,
  MediaOutputInvalidError,
  readJsonl,
  sha256File,
  type CleanRecord,
} from "./media";
import type { NormalizeInputBlock } from "./normalize/segmentation";
import { assignReadingOrder } from "./normalize/reading-order";

/** Default versioned PP-StructureV3 pipeline config. */
export const DEFAULT_OCR_CONFIG_PATH = join(
  COMPILER_ROOT,
  "config",
  "ocr",
  "pp-structure-v3.json",
);

const HEX64 = /^[0-9a-f]{64}$/;
const unit = z.number().min(0).max(1);

/** Mirror of the Python `OcrBlockRecord` (extra keys rejected upstream). */
export const OcrBlockRecordSchema = z.object({
  schema_version: z.number().int().min(1),
  pipeline: z.string().min(1),
  pipeline_version: z.string().min(1),
  model_version: z.string().min(1),
  config_version: z.number().int().min(1),
  source_sha256: z.string().regex(HEX64),
  page: z.number().int().positive(),
  page_image_sha256: z.string().regex(HEX64),
  bbox: z.tuple([unit, unit, unit, unit]),
  layout_label: z.string().min(1),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1),
  source_raw_ref_hash: z.string().regex(HEX64),
});
export type OcrBlockRecord = z.output<typeof OcrBlockRecordSchema>;

/** Name of the OCR JSONL artifact, relative to the work directory. */
export const OCR_JSONL = "ocr.jsonl";

/** Private per-page raw OCR text (evidence; never leaves the work dir). */
export function rawTextRelativePath(page: number): string {
  return `ocr-raw/page-${String(page).padStart(4, "0")}.txt`;
}

/** Argument array for `lexiloop_media ocr` on a per-source work directory. */
export function ocrSpawnArgs(ocrConfigPath: string, workDir: string): string[] {
  return [
    "ocr",
    "--clean-jsonl",
    join(workDir, "clean.jsonl"),
    "--config",
    resolve(ocrConfigPath),
    "--out-dir",
    workDir,
  ];
}

/**
 * Validate `ocr.jsonl` against the schema, the cleaned pages, and the raw
 * evidence files: source hash, page-image hash chain, and one raw text file
 * per cleaned page whose content contains every block text. The per-block
 * `source_raw_ref_hash` binding to raw text is produced and contract-tested
 * by the Python worker; this side treats it as an opaque provenance
 * reference. Throws `MediaOutputInvalidError`.
 */
export async function validateOcrArtifacts(
  workDir: string,
  sourceHash: string,
  cleanRecords: readonly CleanRecord[],
): Promise<OcrBlockRecord[]> {
  const ocrJsonlPath = join(workDir, OCR_JSONL);
  const records = await readJsonl(ocrJsonlPath, OcrBlockRecordSchema);
  if (records.length === 0) {
    throw new MediaOutputInvalidError(ocrJsonlPath, "no OCR blocks were emitted");
  }

  const cleanByPage = new Map(cleanRecords.map((record) => [record.page, record]));
  const textByPage = new Map<number, string[]>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const where = `${ocrJsonlPath} line ${index + 1}`;
    if (record.source_sha256 !== sourceHash) {
      throw new MediaOutputInvalidError(where, "source hash mismatch");
    }
    const clean = cleanByPage.get(record.page);
    if (!clean) {
      throw new MediaOutputInvalidError(where, `page ${record.page} was not cleaned`);
    }
    if (record.page_image_sha256 !== clean.cleaned_image_sha256) {
      throw new MediaOutputInvalidError(
        where,
        `page ${record.page}: page image hash mismatch against clean.jsonl`,
      );
    }
    const texts = textByPage.get(record.page) ?? [];
    texts.push(record.text);
    textByPage.set(record.page, texts);
  }

  for (const clean of cleanRecords) {
    const texts = textByPage.get(clean.page);
    if (!texts || texts.length === 0) {
      throw new MediaOutputInvalidError(
        ocrJsonlPath,
        `page ${clean.page}: no OCR blocks for a cleaned page`,
      );
    }
    const rawPath = join(workDir, rawTextRelativePath(clean.page));
    if (!(await fileExists(rawPath))) {
      throw new MediaOutputInvalidError(
        ocrJsonlPath,
        `page ${clean.page}: raw OCR evidence missing: ${rawTextRelativePath(clean.page)}`,
      );
    }
    const rawText = await readFile(rawPath, "utf8");
    for (const text of texts) {
      if (!rawText.includes(text)) {
        throw new MediaOutputInvalidError(
          ocrJsonlPath,
          `page ${clean.page}: block text absent from raw OCR evidence`,
        );
      }
    }
  }
  return records;
}

/**
 * Convert validated OCR rows into normalization input blocks in deterministic
 * reading order (the worker's order is preserved; `assignReadingOrder` is a
 * stable, idempotent re-sort that guarantees the invariant regardless).
 */
export function toNormalizeInputBlocks(records: readonly OcrBlockRecord[]): NormalizeInputBlock[] {
  const perPage = new Map<number, number>();
  const blocks = records.map((record) => {
    const indexInPage = perPage.get(record.page) ?? 0;
    perPage.set(record.page, indexInPage + 1);
    const block: NormalizeInputBlock = {
      blockKey: `p${record.page}.b${String(indexInPage).padStart(3, "0")}`,
      sourcePdfSha256: record.source_sha256,
      page: record.page,
      pageImageSha256: record.page_image_sha256,
      bbox: record.bbox,
      text: record.text,
      confidence: record.confidence,
      layoutRole:
        record.layout_label === "header" || record.layout_label === "footer"
          ? "page_furniture"
          : "other",
      sourceRawRefHash: record.source_raw_ref_hash,
    };
    return block;
  });
  return assignReadingOrder(blocks);
}

/** SHA-256 of the OCR JSONL artifact (stage output binding). */
export function ocrJsonlHash(workDir: string): Promise<string> {
  return sha256File(join(workDir, OCR_JSONL));
}
