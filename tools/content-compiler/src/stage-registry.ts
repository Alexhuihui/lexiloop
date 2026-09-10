/**
 * Production stage registry (spec 5.2).
 *
 * Declares the 13 production stage names in exact compile order plus their
 * dependency edges. Every stage starts as an unimplemented, fail-closed
 * handler: invoking it records FAILED with a stable error code and stops the
 * run. Tasks 5-10 replace the handlers with tested implementations; the names,
 * order, and dependencies declared here are final.
 */
import { z } from "zod";
import { StageError, hashString, type AnyStage } from "./stage";

export const PRODUCTION_STAGE_NAMES = [
  "SOURCE_FINGERPRINT",
  "IMAGE_EXTRACT",
  "WATERMARK_CLEAN",
  "LAYOUT_OCR",
  "STRUCTURE_NORMALIZE",
  "AGENT_ENRICH",
  "AGENT_REVIEW",
  "DETERMINISTIC_VALIDATE",
  "REPAIR_LOOP",
  "CARD_GENERATE",
  "TTS_SYNTHESIZE",
  "AUDIO_VALIDATE",
  "RELEASE_PACKAGE",
] as const;

export type ProductionStageName = (typeof PRODUCTION_STAGE_NAMES)[number];

/** Dependency edges: each stage depends on its immediate predecessor. */
export const PRODUCTION_STAGE_DEPENDENCIES: Readonly<
  Record<ProductionStageName, readonly ProductionStageName[]>
> = {
  SOURCE_FINGERPRINT: [],
  IMAGE_EXTRACT: ["SOURCE_FINGERPRINT"],
  WATERMARK_CLEAN: ["IMAGE_EXTRACT"],
  LAYOUT_OCR: ["WATERMARK_CLEAN"],
  STRUCTURE_NORMALIZE: ["LAYOUT_OCR"],
  AGENT_ENRICH: ["STRUCTURE_NORMALIZE"],
  AGENT_REVIEW: ["AGENT_ENRICH"],
  DETERMINISTIC_VALIDATE: ["AGENT_REVIEW"],
  REPAIR_LOOP: ["DETERMINISTIC_VALIDATE"],
  CARD_GENERATE: ["REPAIR_LOOP"],
  TTS_SYNTHESIZE: ["CARD_GENERATE"],
  AUDIO_VALIDATE: ["TTS_SYNTHESIZE"],
  RELEASE_PACKAGE: ["AUDIO_VALIDATE"],
};

/** The final stage, guarded so it only runs when all predecessors PASSED. */
export const RELEASE_STAGE: ProductionStageName = "RELEASE_PACKAGE";

/**
 * Placeholder handler used until the real stage lands. Fails closed with a
 * non-retryable error so an accidental run can never produce content.
 */
function unimplementedStage(name: ProductionStageName): AnyStage {
  const configVersion = "0-unimplemented";
  return {
    name,
    configVersion,
    inputSchema: z.unknown(),
    outputSchema: z.never(),
    computeInputHash: () => hashString(`${name}:${configVersion}`),
    run: async () => {
      throw new StageError(
        "STAGE_NOT_IMPLEMENTED",
        `Stage ${name} has no handler yet (planned for Phase 2 tasks 5-10)`,
      );
    },
  };
}

/** The 13 production stages in compile order, all currently fail-closed. */
export function getProductionStages(): AnyStage[] {
  return PRODUCTION_STAGE_NAMES.map((name) => unimplementedStage(name));
}
