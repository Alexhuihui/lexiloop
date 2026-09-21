import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyAcceptedSpacingCorrections } from "../src/ocr-spacing";
import type { OcrBlockRecord } from "../src/ocr-adapter";

const oldText = "Theauthorholds thatthis";
const rawHash = createHash("sha256").update(oldText).digest("hex");
const originalImageHash = "ab".repeat(32);
const row: OcrBlockRecord = {
  schema_version: 1,
  pipeline: "PaddleOCR",
  pipeline_version: "3.7.0",
  model_version: "test",
  config_version: 14,
  source_sha256: "cd".repeat(32),
  page: 33,
  page_image_sha256: "ef".repeat(32),
  bbox: [0.1, 0.2, 0.4, 0.23],
  layout_label: "text",
  text: oldText,
  confidence: 0.9,
  source_raw_ref_hash: rawHash,
};
const correction = {
  page: 33,
  bbox: row.bbox,
  source_raw_ref_hash: rawHash,
  original_image_sha256: originalImageHash,
  old_text: oldText,
  candidate_text: "The author holds that this",
  verdict: "ACCEPTED_WHITESPACE_ONLY" as const,
};

describe("accepted OCR spacing corrections", () => {
  it("adds only spaces while keeping immutable raw provenance", () => {
    const corrected = applyAcceptedSpacingCorrections([row], [correction], new Map([[33, originalImageHash]]));
    expect(corrected[0]?.text).toBe("The author holds that this");
    expect(corrected[0]?.source_raw_ref_hash).toBe(rawHash);
    expect(row.text).toBe(oldText);
  });

  it("rejects a correction that changes source characters", () => {
    expect(() => applyAcceptedSpacingCorrections(
      [row], [{ ...correction, candidate_text: "The author hold that this" }],
      new Map([[33, originalImageHash]]),
    )).toThrow(/not additive whitespace/);
  });
});
