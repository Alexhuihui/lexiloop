import { describe, expect, it } from "vitest";
import { applyAcceptedSenseCorrections } from "../src/sense-corrections";

const oldGloss = "展览微VN号";
const sourceRawRefHash = "ab".repeat(32);
const originalImageHash = "cd".repeat(32);
const sense = {
  sense_key: "s.w.c1.u2.0015.exhibition.1",
  word_key: "w.c1.u2.0015.exhibition",
  pos: "n" as const,
  gloss: oldGloss,
  sense_order: 1,
  source_pdf_sha256: "ef".repeat(32),
  page_number: 37,
  page_image_sha256: "01".repeat(32),
  bbox: [0.5, 0.7, 0.8, 0.72] as [number, number, number, number],
  ocr_confidence: 0.8,
  source_raw_ref_hash: sourceRawRefHash,
};
const correction = {
  sense_key: sense.sense_key,
  page: 37,
  bbox: sense.bbox,
  source_raw_ref_hash: sourceRawRefHash,
  original_image_sha256: originalImageHash,
  old_gloss: oldGloss,
  corrected_gloss: "展览",
  verdict: "ACCEPTED_SOURCE_TRIM" as const,
};

describe("accepted sense corrections", () => {
  it("trims a source-identified contaminated tail without mutating raw evidence", () => {
    const result = applyAcceptedSenseCorrections([sense], [correction], new Map([[37, originalImageHash]]));
    expect(result[0]?.gloss).toBe("展览");
    expect(result[0]?.source_raw_ref_hash).toBe(sourceRawRefHash);
    expect(sense.gloss).toBe(oldGloss);
  });

  it("fails closed on a stale or non-prefix correction", () => {
    const hashes = new Map([[37, originalImageHash]]);
    expect(() => applyAcceptedSenseCorrections([sense], [{ ...correction, old_gloss: "展览微V" }], hashes))
      .toThrow(/identity mismatch/);
    expect(() => applyAcceptedSenseCorrections([sense], [{ ...correction, corrected_gloss: "展出" }], hashes))
      .toThrow(/prefix trim/);
  });
});
