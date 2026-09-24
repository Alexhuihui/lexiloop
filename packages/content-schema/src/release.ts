import { z } from "zod";
import { IssueCode } from "./agents";
import { LogicalKey, Sha256Hex } from "./source";

/**
 * Release-side contracts: deterministic validation reports, TTS audio assets,
 * and the immutable release manifest (spec 5.1/5.8/5.9/6.2/11.3).
 */

export const CompileRunId = z.string().min(1);

/** Severity of a deterministic validator finding. */
export const ValidationSeverity = z.enum(["ERROR", "WARNING"]);

export const ValidationFinding = z.strictObject({
  check: IssueCode,
  severity: ValidationSeverity,
  field_path: z.string().min(1).optional(),
  message: z.string().min(1),
});

export const UnitValidationStatus = z.enum(["PASSED", "BLOCKED"]);

/**
 * Deterministic validator findings for one unit (spec 5.6 role 3). A unit that
 * still fails after three repair rounds is BLOCKED and must not enter a
 * release (spec 5.6/11.1).
 */
export const UnitValidationReport = z.strictObject({
  unit_key: LogicalKey,
  compile_run_id: CompileRunId,
  status: UnitValidationStatus,
  /** Completed repair rounds, capped at three. */
  repair_rounds: z.number().int().min(0).max(3),
  findings: z.array(ValidationFinding),
});

/**
 * Content-addressed TTS audio reference (spec 5.8/6.2 `audio_asset`). The R2
 * object key is content-addressed so releases can share identical objects.
 * Mapping assets back to words/examples is `content_audio_link`'s job (D1
 * schema), not the asset's.
 */
export const AudioAsset = z.strictObject({
  /** R2 object key, e.g. audio/<hash-prefix>/<hash>.wav. */
  asset_key: z.string().min(1).startsWith("audio/"),
  /** SHA-256 of the audio bytes; the object key derives from it. */
  content_sha256: Sha256Hex,
  /** Hash of the normalized voiced text; must match the content record. */
  text_hash: Sha256Hex,
  provider: z.string().min(1),
  model_id: z.string().min(1),
  voice: z.string().min(1),
  synthesis_config_version: z.string().min(1),
  format: z.strictObject({
    container: z.enum(["wav"]),
    sample_rate_hz: z.number().int().positive(),
    channels: z.number().int().min(1).max(2),
    encoding: z.string().min(1),
  }),
  duration_ms: z.number().int().positive(),
  /** Outcome of the deterministic audio gate. */
  validation: z.enum(["PENDING", "PASSED", "FAILED"]),
});

export const ReleaseStatus = z.enum([
  "DRAFT",
  "IMPORTING",
  "VALIDATING",
  "READY",
  "ACTIVE",
  "RETIRED",
  "FAILED",
]);

export const UnitCounts = z.strictObject({
  words: z.number().int().min(0),
  senses: z.number().int().min(0),
  phrases: z.number().int().min(0),
  examples: z.number().int().min(0),
  explanations: z.number().int().min(0),
  cards: z.number().int().min(0),
});

/** Per-unit release scope: only fully PASSED units may be declared (spec 5.6). */
export const ReleaseUnitStatus = z.strictObject({
  unit_key: LogicalKey,
  status: UnitValidationStatus,
  counts: UnitCounts,
  qa_summary: z.string().min(1).optional(),
});

export const ManifestFile = z.strictObject({
  /** Bundle-relative path, e.g. d1/001-content.sql. */
  path: z.string().min(1),
  sha256: Sha256Hex,
  bytes: z.number().int().min(0),
});

export const GateResult = z.strictObject({
  name: z.string().min(1),
  passed: z.boolean(),
});

/**
 * manifest.json of one immutable release bundle (spec 5.1/5.9): release id,
 * source PDF hash, configuration versions, model/voice config, per-file
 * hashes, statistics, gate results, and rollback metadata.
 */
export const ReleaseManifest = z.strictObject({
  release_id: z.string().min(1),
  status: ReleaseStatus,
  created_at: z.iso.datetime({ offset: true }),
  book: z.strictObject({ book_key: LogicalKey, edition: z.string().min(1) }),
  source_pdf_sha256: Sha256Hex,
  /**
   * Declared target unit scope (spec 5.6): exactly the units this release
   * ships. A release MAY cover a subset of fully-passed units, but the
   * manifest must state that scope and every declared unit must be PASSED.
   */
  target_units: z.array(LogicalKey).min(1),
  /** Previous compatible release kept for rollback, when one exists. */
  previous_release_id: z.string().min(1).optional(),
  config_versions: z.strictObject({
    schema_version: z.string().min(1),
    watermark_rules_version: z.string().min(1),
    ocr_config_version: z.string().min(1),
    prompt_version: z.string().min(1),
    card_rules_version: z.string().min(1),
    synthesis_config_version: z.string().min(1),
  }),
  model_config: z.strictObject({
    generation_model_id: z.string().min(1),
    review_model_id: z.string().min(1),
    repair_model_id: z.string().min(1),
    tts_model_id: z.string().min(1),
    tts_voice: z.string().min(1),
  }),
  units: z.array(ReleaseUnitStatus).min(1),
  totals: z.strictObject({
    units: z.number().int().min(1),
    units_passed: z.number().int().min(0),
    units_blocked: z.number().int().min(0),
    words: z.number().int().min(0),
    cards: z.number().int().min(0),
    audio_assets: z.number().int().min(0),
  }),
  files: z.array(ManifestFile).min(1),
  gates: z.array(GateResult).min(1),
}).superRefine((manifest, ctx) => {
  // Totals must agree with the declared units so a manifest can never claim
  // scope that contradicts its own unit list (spec 5.6/17: no partial units).
  const passed = manifest.units.filter((unit) => unit.status === "PASSED").length;
  const blocked = manifest.units.filter((unit) => unit.status === "BLOCKED").length;
  const sumOf = (key: "words" | "cards"): number =>
    manifest.units.reduce((acc, unit) => acc + unit.counts[key], 0);
  const expectTotal = (key: "units" | "units_passed" | "units_blocked" | "words" | "cards", expected: number): void => {
    if (manifest.totals[key] !== expected) {
      ctx.addIssue({
        code: "custom",
        message: `totals.${key} (${manifest.totals[key]}) must equal ${expected} derived from the units array`,
        path: ["totals", key],
      });
    }
  };
  expectTotal("units", manifest.units.length);
  expectTotal("units_passed", passed);
  expectTotal("units_blocked", blocked);
  expectTotal("words", sumOf("words"));
  expectTotal("cards", sumOf("cards"));
  // The declared target scope is binding (spec 5.6): a duplicate-free list
  // covering exactly the declared units — never a phantom or partial scope.
  if (new Set(manifest.target_units).size !== manifest.target_units.length) {
    ctx.addIssue({
      code: "custom",
      message: "target_units must not contain duplicates",
      path: ["target_units"],
    });
  }
  const declaredKeys = manifest.units.map((unit) => unit.unit_key).sort();
  const declaredScope = [...manifest.target_units].sort();
  if (
    declaredKeys.length !== declaredScope.length ||
    declaredKeys.some((unitKey, index) => unitKey !== declaredScope[index])
  ) {
    ctx.addIssue({
      code: "custom",
      message: "target_units must cover exactly the declared units (spec 5.6: no partial units)",
      path: ["target_units"],
    });
  }
});
