/** Source-checked trims of OCR tails that leaked into a word sense. */
import { join } from "node:path";
import { z } from "zod";
import { fileExists, readJsonl } from "./media";

export const ACCEPTED_SENSE_FILE = "ocr-review-v1/accepted-sense-trims.jsonl";
const HEX64 = /^[0-9a-f]{64}$/u;

export const AcceptedSenseTrimSchema = z.object({
  sense_key: z.string().min(1),
  page: z.number().int().positive(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  source_raw_ref_hash: z.string().regex(HEX64),
  original_image_sha256: z.string().regex(HEX64),
  old_gloss: z.string().min(1),
  corrected_gloss: z.string().min(1),
  verdict: z.literal("ACCEPTED_SOURCE_TRIM"),
}).strict();
export type AcceptedSenseTrim = z.output<typeof AcceptedSenseTrimSchema>;

interface SourceSense {
  sense_key: string;
  page_number: number;
  bbox: readonly number[];
  source_raw_ref_hash: string;
  gloss: string;
}

/** Fail closed if source identity changes or the correction rewrites text. */
export function applyAcceptedSenseCorrections<T extends SourceSense>(
  senses: readonly T[],
  corrections: readonly AcceptedSenseTrim[],
  originalImageHashes: ReadonlyMap<number, string>,
): T[] {
  const byKey = new Map<string, AcceptedSenseTrim>();
  for (const raw of corrections) {
    const correction = AcceptedSenseTrimSchema.parse(raw);
    if (byKey.has(correction.sense_key)) throw new Error(`duplicate sense trim: ${correction.sense_key}`);
    if (originalImageHashes.get(correction.page) !== correction.original_image_sha256) {
      throw new Error(`sense trim ${correction.sense_key}: original image hash mismatch`);
    }
    if (!correction.old_gloss.startsWith(correction.corrected_gloss) ||
        correction.old_gloss === correction.corrected_gloss) {
      throw new Error(`sense trim ${correction.sense_key}: not a strict prefix trim`);
    }
    byKey.set(correction.sense_key, correction);
  }
  const matched = new Set<string>();
  const result = senses.map((sense) => {
    const correction = byKey.get(sense.sense_key);
    if (!correction) return sense;
    if (matched.has(sense.sense_key) ||
        sense.page_number !== correction.page ||
        JSON.stringify(sense.bbox) !== JSON.stringify(correction.bbox) ||
        sense.source_raw_ref_hash !== correction.source_raw_ref_hash ||
        sense.gloss !== correction.old_gloss) {
      throw new Error(`sense trim ${sense.sense_key}: identity mismatch`);
    }
    matched.add(sense.sense_key);
    return { ...sense, gloss: correction.corrected_gloss };
  });
  if (matched.size !== byKey.size) throw new Error(`sense trims missing ${byKey.size - matched.size} sense(s)`);
  return result;
}

export async function loadAcceptedSenseCorrections(workDir: string): Promise<AcceptedSenseTrim[]> {
  const path = join(workDir, ACCEPTED_SENSE_FILE);
  return (await fileExists(path)) ? readJsonl(path, AcceptedSenseTrimSchema) : [];
}
