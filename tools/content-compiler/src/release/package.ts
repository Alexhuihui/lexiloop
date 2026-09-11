/**
 * RELEASE_PACKAGE: immutable release bundling (spec 5.9).
 *
 * The final pipeline stage. It replaces the fail-closed placeholder and turns
 * a fully-compiled work directory into the spec'd immutable bundle:
 *
 *   manifest.json                  SHA-256 + byte size of every other file
 *   d1/001-content.sql             release-scoped content rows (deterministic)
 *   d1/002-cards.sql               card definitions (deterministic)
 *   d1/003-search.sql              FTS integrity pass (see 0002 migration)
 *   r2/audio-manifest.jsonl        the validated audio artifact, verbatim
 *   qa/unit-status.json            sanitized per-unit status (no source text)
 *   qa/validation-summary.json     sanitized finding statistics
 *   rollback.json                  rollback metadata + compatibility demands
 *
 * Fail-closed guarantees (spec 5.9/5.6/17): every one of the 13 stages must
 * have a PASSED ledger entry with recorded output hashes; the run's upstream
 * provenance must name AUDIO_VALIDATE with the matching hash (stale runs are
 * refused); every target Unit's deterministic validation report must be
 * PASSED (BLOCKED units can never enter a release); 100% of the audio
 * manifest's assets must exist on disk with matching hashes and gate results.
 * Provenance written into the bundle keeps only private hash references —
 * the full OCR/source text never leaves the private work directory.
 *
 * Real bundles live under the git-ignored `.lexiloop-private/releases/`.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  Book,
  CardDefinition,
  Example,
  Phrase,
  ReleaseManifest,
  Sense,
  Unit,
  UnitValidationReport,
  Word,
  type SourceProvenance,
} from "@lexiloop/content-schema";
import { AudioInspectionRowSchema, loadAudioManifest } from "../tts/cache";
import {
  buildTtsPlan,
  collectTtsItems,
  DEFAULT_TTS_CONFIG_PATH,
  readTtsConfig,
} from "../tts/plan";
import {
  loadUnitWorkloads,
  SEMANTIC_PROMPT_VERSION,
  SEMANTIC_QUEUE_DIR,
  WorkPacketError,
} from "../agents/work-packets";
import { COMPILER_ROOT, DEFAULT_RULE_PATH, fileExists, MediaOutputInvalidError, readJsonl, sha256File } from "../media";
import { DEFAULT_OCR_CONFIG_PATH } from "../ocr-adapter";
import { hashJson, StageError, type AnyStage } from "../stage";
import type { LedgerEntry } from "../ledger";

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The RELEASE_PACKAGE stage name and its 12 predecessors in exact compile
 * order. Declared HERE (not in stage-registry.ts) so the registry can compose
 * `PRODUCTION_STAGE_NAMES` from them without an import cycle.
 */
export const RELEASE_PACKAGE_STAGE = "RELEASE_PACKAGE";

export const RELEASE_PACKAGE_PREDECESSORS = [
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
] as const;

/** Relative directory (under the private root) holding release bundles. */
export const RELEASES_DIR = "releases";

/** Default versioned card-rules config (mirrors config/cards/v1.json). */
export const DEFAULT_RELEASE_CARDS_CONFIG_PATH = path.join(COMPILER_ROOT, "config", "cards", "v1.json");

/** Deployment-provided parts of the manifest that are not derivable from disk. */
export const ReleaseMetadataConfigSchema = z.strictObject({
  schema_version: z.string().min(1),
  prompt_version: z.string().min(1),
  model_config: z.strictObject({
    generation_model_id: z.string().min(1),
    review_model_id: z.string().min(1),
    repair_model_id: z.string().min(1),
  }),
});
export type ReleaseMetadataConfig = z.output<typeof ReleaseMetadataConfigSchema>;

/** Defaults; operators may override per release via `release package`. */
export const DEFAULT_RELEASE_METADATA: ReleaseMetadataConfig = {
  schema_version: "schema-v1",
  prompt_version: SEMANTIC_PROMPT_VERSION,
  model_config: {
    generation_model_id: "agent-generation-v1",
    review_model_id: "agent-review-v1",
    repair_model_id: "agent-repair-v1",
  },
};

export const ReleasePackageOutputSchema = z.object({
  source_sha256: z.string().regex(HEX64),
  release_id: z.string().min(1),
  /** Bundle directory relative to the private root: `releases/<release_id>`. */
  release_dir: z.string().min(1),
  manifest_sha256: z.string().regex(HEX64),
  file_count: z.number().int().positive(),
  units: z.number().int().positive(),
  audio_assets: z.number().int().nonnegative(),
});
export type ReleasePackageOutput = z.output<typeof ReleasePackageOutputSchema>;

/** Options for the RELEASE_PACKAGE stage. */
export interface ReleasePackageStageOptions {
  /** Private root holding `work/<source-hash>` and `releases/<release-id>`. */
  privateRoot: string;
  /** Deployment metadata for the manifest (defaults to the repo constants). */
  metadata?: ReleaseMetadataConfig;
  /** Previous compatible release recorded in rollback.json, when one exists. */
  previousReleaseId?: string;
  cardsConfigPath?: string;
  ttsConfigPath?: string;
  watermarkRulePath?: string;
  ocrConfigPath?: string;
}

// ---------------------------------------------------------------------------
// Small typed readers (fail closed with machine-readable codes)
// ---------------------------------------------------------------------------

type ProvenanceT = z.output<typeof SourceProvenance>;

async function readJsonConfig(filePath: string, code: string, what: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StageError(code, `${what} unreadable at ${filePath}: ${message}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new StageError(code, `${what} at ${filePath} is not valid JSON`);
  }
}

function requireStringField(config: Record<string, unknown>, field: string, code: string, what: string): string {
  const value = config[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new StageError(code, `${what} is missing a string field "${field}"`);
  }
  return value;
}

/**
 * Redact source provenance for the bundle: the full OCR/source text is
 * dropped and only its private hash reference survives (spec 5.5).
 */
export function redactProvenance(provenance: ProvenanceT): Record<string, unknown> {
  return {
    source_pdf_sha256: provenance.source_pdf_sha256,
    page_number: provenance.page_number,
    page_image_sha256: provenance.page_image_sha256,
    bbox: provenance.bbox,
    source_raw_ref_hash: provenance.source_raw_ref_hash,
    ocr_confidence: provenance.ocr_confidence,
    structure_confidence: provenance.structure_confidence,
  };
}

// ---------------------------------------------------------------------------
// Deterministic SQL builders
// ---------------------------------------------------------------------------

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlOptText(value: string | null | undefined): string {
  return value === null || value === undefined ? "NULL" : sqlText(value);
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type WithProvenance<T> = T & ProvenanceT;

/** Structured row inputs for the content import file (provenance flattened). */
export interface ContentRows {
  books: Array<WithProvenance<{ book_key: string; title: string; edition: string }>>;
  units: Array<WithProvenance<{ unit_key: string; book_key: string; level: number; unit_order: number; title: string }>>;
  words: Array<WithProvenance<{ word_key: string; unit_key: string; headword: string; phonetic?: string; tier: string; source_order: number }>>;
  senses: Array<WithProvenance<{ sense_key: string; word_key: string; pos: string; gloss: string; sense_order: number }>>;
  phrases: Array<WithProvenance<{ phrase_key: string; word_key: string; sense_key?: string; text: string; gloss: string; source_order: number }>>;
  examples: Array<WithProvenance<{ example_key: string; word_key: string; sense_key?: string; phrase_key?: string; origin: string; source_ref?: string; text: string; target_span: [number, number]; source_order: number }>>;
  explanations: Array<{ explanation_key: string; word_key: string; unit_key: string; generated: unknown }>;
  audioAssets: Array<{ asset_key: string; content_sha256: string; text_hash: string; provider: string; model_id: string; voice: string; synthesis_config_version: string; sample_rate_hz: number; channels: number; encoding: string; duration_ms: number }>;
  audioLinks: Array<{ entity_type: "word" | "example"; entity_key: string; asset_key: string }>;
}

/**
 * d1/001-content.sql: one INSERT per line, in fixed order (books, units,
 * words, senses, phrases, examples, explanations, audio). Determinism is a
 * bundle guarantee: identical compiles must produce identical bytes.
 */
export function buildContentSql(releaseId: string, rows: ContentRows): string {
  const lines: string[] = [
    `-- LexiLoop release ${releaseId}: content import (spec 5.9).`,
    "-- Generated by RELEASE_PACKAGE; immutable once verified into a bundle.",
    "-- Provenance JSON keeps only private hash references (spec 5.5): full",
    "-- OCR/source text never leaves the private work directory.",
  ];
  for (const book of [...rows.books].sort((a, b) => byString(a.book_key, b.book_key))) {
    lines.push(
      `INSERT INTO book (release_id, book_key, title, edition, provenance_json) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(book.book_key)}, ${sqlText(book.title)}, ` +
        `${sqlText(book.edition)}, ${sqlText(JSON.stringify(redactProvenance(book)))});`,
    );
  }
  for (const unit of [...rows.units].sort((a, b) => a.unit_order - b.unit_order || byString(a.unit_key, b.unit_key))) {
    lines.push(
      `INSERT INTO unit (release_id, unit_key, book_key, level, unit_order, title, provenance_json) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(unit.unit_key)}, ${sqlText(unit.book_key)}, ${unit.level}, ` +
        `${unit.unit_order}, ${sqlText(unit.title)}, ${sqlText(JSON.stringify(redactProvenance(unit)))});`,
    );
  }
  for (const word of [...rows.words].sort((a, b) => byString(a.unit_key, b.unit_key) || a.source_order - b.source_order || byString(a.word_key, b.word_key))) {
    lines.push(
      `INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(word.word_key)}, ${sqlText(word.unit_key)}, ${sqlText(word.headword)}, ` +
        `${sqlOptText(word.phonetic)}, ${sqlText(word.tier)}, ${word.source_order}, ` +
        `${sqlText(JSON.stringify(redactProvenance(word)))});`,
    );
  }
  for (const sense of [...rows.senses].sort((a, b) => byString(a.word_key, b.word_key) || a.sense_order - b.sense_order || byString(a.sense_key, b.sense_key))) {
    lines.push(
      `INSERT INTO sense (release_id, sense_key, word_key, pos, gloss, sense_order, provenance_json) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(sense.sense_key)}, ${sqlText(sense.word_key)}, ${sqlText(sense.pos)}, ` +
        `${sqlText(sense.gloss)}, ${sense.sense_order}, ${sqlText(JSON.stringify(redactProvenance(sense)))});`,
    );
  }
  for (const phrase of [...rows.phrases].sort((a, b) => byString(a.word_key, b.word_key) || a.source_order - b.source_order || byString(a.phrase_key, b.phrase_key))) {
    lines.push(
      `INSERT INTO phrase (release_id, phrase_key, word_key, sense_key, text, gloss, source_order, provenance_json) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(phrase.phrase_key)}, ${sqlText(phrase.word_key)}, ${sqlOptText(phrase.sense_key)}, ` +
        `${sqlText(phrase.text)}, ${sqlText(phrase.gloss)}, ${phrase.source_order}, ` +
        `${sqlText(JSON.stringify(redactProvenance(phrase)))});`,
    );
  }
  for (const example of [...rows.examples].sort((a, b) => byString(a.word_key, b.word_key) || a.source_order - b.source_order || byString(a.example_key, b.example_key))) {
    lines.push(
      `INSERT INTO example (release_id, example_key, word_key, sense_key, phrase_key, origin, source_ref, text, target_start, target_end, source_order, provenance_json) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(example.example_key)}, ${sqlText(example.word_key)}, ${sqlOptText(example.sense_key)}, ` +
        `${sqlOptText(example.phrase_key)}, ${sqlText(example.origin)}, ${sqlOptText(example.source_ref)}, ${sqlText(example.text)}, ` +
        `${example.target_span[0]}, ${example.target_span[1]}, ${example.source_order}, ` +
        `${sqlText(JSON.stringify(redactProvenance(example)))});`,
    );
  }
  for (const explanation of [...rows.explanations].sort((a, b) => byString(a.explanation_key, b.explanation_key))) {
    lines.push(
      `INSERT INTO explanation (release_id, explanation_key, word_key, unit_key, generated_json) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(explanation.explanation_key)}, ${sqlText(explanation.word_key)}, ` +
        `${sqlText(explanation.unit_key)}, ${sqlText(JSON.stringify(explanation.generated))});`,
    );
  }
  for (const asset of [...rows.audioAssets].sort((a, b) => byString(a.asset_key, b.asset_key))) {
    lines.push(
      `INSERT INTO audio_asset (release_id, asset_key, content_sha256, text_hash, provider, model_id, voice, synthesis_config_version, format_container, sample_rate_hz, channels, encoding, duration_ms, validation) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(asset.asset_key)}, ${sqlText(asset.content_sha256)}, ${sqlText(asset.text_hash)}, ` +
        `${sqlText(asset.provider)}, ${sqlText(asset.model_id)}, ${sqlText(asset.voice)}, ${sqlText(asset.synthesis_config_version)}, ` +
        `'wav', ${asset.sample_rate_hz}, ${asset.channels}, ${sqlText(asset.encoding)}, ${asset.duration_ms}, 'PASSED');`,
    );
  }
  for (const link of [...rows.audioLinks].sort((a, b) => byString(a.entity_type, b.entity_type) || byString(a.entity_key, b.entity_key) || byString(a.asset_key, b.asset_key))) {
    lines.push(
      `INSERT INTO content_audio_link (release_id, entity_type, entity_key, asset_key) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(link.entity_type)}, ${sqlText(link.entity_key)}, ${sqlText(link.asset_key)});`,
    );
  }
  return lines.join("\n") + "\n";
}

/** d1/002-cards.sql: card definitions in the compiler's fixed order. */
export function buildCardsSql(releaseId: string, cards: Array<z.output<typeof CardDefinition>>): string {
  const lines: string[] = [
    `-- LexiLoop release ${releaseId}: card definitions (spec 5.7).`,
    "-- Rows appear in the deterministic generation order of cards.jsonl.",
  ];
  for (const card of cards) {
    lines.push(
      `INSERT INTO card_definition (release_id, content_card_key, card_type, target_entity_key, word_key, unit_key, template_version, status) VALUES (` +
        `${sqlText(releaseId)}, ${sqlText(card.content_card_key)}, ${sqlText(card.card_type)}, ` +
        `${sqlText(card.target_entity_key)}, ${sqlText(card.word_key)}, ${sqlText(card.unit_key)}, ` +
        `${sqlText(card.template_version)}, ${sqlText(card.status)});`,
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * d1/003-search.sql: the search index integrity pass. content_search_fts is
 * populated by the sync triggers while 001-content.sql executes; FTS is not a
 * backup source (spec 6.3), so the bundle ships the documented rebuild
 * command instead of redundant index rows.
 */
export function buildSearchSql(releaseId: string): string {
  return [
    `-- LexiLoop release ${releaseId}: search index integrity pass (spec 6.2/6.3).`,
    "-- content_search_fts is filled by the sync triggers during 001-content.sql.",
    "-- FTS is not a backup source: this ships the documented recovery command,",
    "-- and `release smoke` verifies index/content parity before activation.",
    "INSERT INTO content_search_fts(content_search_fts) VALUES('rebuild');",
  ].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

function workDirectoryFor(privateRoot: string, sourceHash: string): string {
  if (!HEX64.test(sourceHash)) {
    throw new StageError("RELEASE_INPUT_INVALID", `sourceHash must be a sha-256 hex string`);
  }
  return path.join(path.resolve(privateRoot), "work", sourceHash);
}

interface ParsedContent {
  book: z.output<typeof Book>;
  units: z.output<typeof Unit>[];
  words: z.output<typeof Word>[];
  senses: z.output<typeof Sense>[];
  phrases: z.output<typeof Phrase>[];
  examples: z.output<typeof Example>[];
}

async function parseNormalizedRows(workDir: string): Promise<ParsedContent> {
  const filePath = path.join(workDir, "normalized.jsonl");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StageError("RELEASE_INPUT_MISSING", `normalized.jsonl unreadable: ${message}`);
  }
  const content: ParsedContent = { book: undefined as never, units: [], words: [], senses: [], phrases: [], examples: [] };
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new StageError("RELEASE_INPUT_INVALID", `normalized.jsonl line ${index + 1} is not valid JSON`);
    }
    const entityType = row["entity_type"];
    // The row wrapper key is structural; the strict entity contracts parse the rest.
    const { entity_type: _ignored, ...entityFields } = row;
    void _ignored;
    try {
      if (entityType === "book") content.book = Book.parse(entityFields);
      else if (entityType === "unit") content.units.push(Unit.parse(entityFields));
      else if (entityType === "word") content.words.push(Word.parse(entityFields));
      else if (entityType === "sense") content.senses.push(Sense.parse(entityFields));
      else if (entityType === "phrase") content.phrases.push(Phrase.parse(entityFields));
      else if (entityType === "example") content.examples.push(Example.parse(entityFields));
      else {
        throw new StageError("RELEASE_INPUT_INVALID", `normalized.jsonl line ${index + 1} has unknown entity_type`);
      }
    } catch (err) {
      if (err instanceof StageError) throw err;
      throw new StageError(
        "RELEASE_INPUT_INVALID",
        `normalized.jsonl line ${index + 1} violates the ${String(entityType)} contract: ` +
          `${err instanceof z.ZodError ? err.issues[0]?.message : String(err)}`,
      );
    }
  }
  if (!content.book) {
    throw new StageError("RELEASE_INPUT_MISSING", "normalized.jsonl has no book record");
  }
  return content;
}

async function parseCards(workDir: string): Promise<z.output<typeof CardDefinition>[]> {
  const filePath = path.join(workDir, "cards.jsonl");
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StageError("RELEASE_INPUT_MISSING", `cards.jsonl unreadable: ${message}`);
  }
  const cards: z.output<typeof CardDefinition>[] = [];
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    try {
      cards.push(CardDefinition.parse(JSON.parse(line)));
    } catch (err) {
      throw new StageError(
        "RELEASE_INPUT_INVALID",
        `cards.jsonl line ${index + 1} violates the card contract: ` +
          `${err instanceof z.ZodError ? err.issues[0]?.message : String(err)}`,
      );
    }
  }
  return cards;
}

/** Generation results from the semantic queue; a missing queue yields none. */
async function collectExplanations(
  workDir: string,
): Promise<Array<{ explanation_key: string; word_key: string; unit_key: string; generated: unknown }>> {
  const resultsPath = path.join(workDir, SEMANTIC_QUEUE_DIR, "results.jsonl");
  let rows: Array<{ role: string; output: { explanations?: Array<Record<string, unknown>> } }>;
  try {
    rows = await readJsonl(
      resultsPath,
      z.object({ role: z.string(), output: z.object({ explanations: z.array(z.record(z.string(), z.unknown())).optional() }).passthrough() }),
    );
  } catch (err) {
    if (err instanceof MediaOutputInvalidError || err instanceof WorkPacketError) {
      return [];
    }
    throw err;
  }
  const explanations: Array<{ explanation_key: string; word_key: string; unit_key: string; generated: unknown }> = [];
  for (const row of rows) {
    if (row.role !== "generation") continue;
    for (const explanation of row.output.explanations ?? []) {
      const key = explanation["explanation_key"];
      const wordKey = explanation["word_key"];
      const unitKey = explanation["unit_key"];
      if (typeof key !== "string" || typeof wordKey !== "string" || typeof unitKey !== "string") {
        throw new StageError("RELEASE_INPUT_INVALID", "generation result explanation missing key fields");
      }
      explanations.push({ explanation_key: key, word_key: wordKey, unit_key: unitKey, generated: explanation });
    }
  }
  return explanations;
}

/**
 * RELEASE_PACKAGE. See the module doc for the bundle contract and the
 * fail-closed preconditions.
 */
export function createReleasePackageStage(options: ReleasePackageStageOptions): AnyStage {
  const configVersion = "1";
  const cardsConfigPath = options.cardsConfigPath ?? DEFAULT_RELEASE_CARDS_CONFIG_PATH;
  const ttsConfigPath = options.ttsConfigPath ?? DEFAULT_TTS_CONFIG_PATH;
  const watermarkRulePath = options.watermarkRulePath ?? DEFAULT_RULE_PATH;
  const ocrConfigPath = options.ocrConfigPath ?? DEFAULT_OCR_CONFIG_PATH;
  const privateRoot = path.resolve(options.privateRoot);

  return {
    name: RELEASE_PACKAGE_STAGE,
    configVersion,
    inputSchema: z.unknown(),
    outputSchema: ReleasePackageOutputSchema,
    computeInputHash: (ctx) =>
      hashJson({
        stage: RELEASE_PACKAGE_STAGE,
        configVersion,
        sourceHash: ctx.sourceHash,
        metadata: options.metadata ?? null,
        previous_release_id: options.previousReleaseId ?? null,
        upstream: ctx.upstream?.outputHash ?? null,
      }),
    run: async (_input, ctx) => {
      // -- 1. Every one of the 13 stages must have a PASSED ledger entry.
      // (The 12 predecessors: this stage's own entry is written afterwards.)
      const unmet: string[] = [];
      const entries = new Map<string, LedgerEntry>();
      for (const name of RELEASE_PACKAGE_PREDECESSORS) {
        const entry = await ctx.ledger.load(name);
        if (!entry || entry.status !== "PASSED" || entry.output_hash === null) {
          unmet.push(`${name}(${entry?.status ?? "no entry"})`);
          continue;
        }
        entries.set(name, entry);
      }
      if (unmet.length > 0) {
        throw new StageError(
          "RELEASE_GATE_UNMET",
          `refusing to package: every pipeline stage must be PASSED, but ${unmet.join(", ")} is not`,
          { blocked: true },
        );
      }

      // -- 2. Upstream provenance: a stale run context is refused. ----------
      const audioEntry = entries.get("AUDIO_VALIDATE")!;
      if (!ctx.upstream || ctx.upstream.stage !== "AUDIO_VALIDATE") {
        throw new StageError(
          "RELEASE_PROVENANCE_INVALID",
          "run context carries no AUDIO_VALIDATE upstream provenance; invoke packaging through the pipeline",
        );
      }
      if (ctx.upstream.outputHash !== audioEntry.output_hash) {
        throw new StageError(
          "RELEASE_PROVENANCE_INVALID",
          `upstream hash ${(ctx.upstream.outputHash ?? "(null)").slice(0, 12)} does not match the ` +
            `AUDIO_VALIDATE ledger output ${(audioEntry.output_hash ?? "").slice(0, 12)}: the run is stale`,
        );
      }

      const workDir = workDirectoryFor(privateRoot, ctx.sourceHash);

      // -- 3. Deterministic validation reports: BLOCKED can never ship. -----
      const content = await parseNormalizedRows(workDir);
      const cards = await parseCards(workDir);
      const unitKeys = content.units.map((unit) => unit.unit_key);
      const unitStatuses: Array<z.output<typeof UnitValidationReport>> = [];
      for (const unitKey of unitKeys) {
        const reportPath = path.join(workDir, "validation", `${unitKey}.json`);
        let parsed: z.output<typeof UnitValidationReport>;
        try {
          parsed = UnitValidationReport.parse(JSON.parse(await readFile(reportPath, "utf8")));
        } catch {
          throw new StageError(
            "RELEASE_UNIT_REPORT_MISSING",
            `unit ${unitKey} has no readable PASSED validation report at ${reportPath}`,
          );
        }
        if (parsed.status !== "PASSED") {
          throw new StageError(
            "RELEASE_UNIT_BLOCKED",
            `unit ${unitKey} is ${parsed.status}: a BLOCKED unit can never enter a release`,
            { blocked: true },
          );
        }
        unitStatuses.push(parsed);
      }

      // -- 4. Audio: 100% manifest coverage with intact assets + gate. ------
      const audioRows = await loadAudioManifest(workDir);
      if (audioRows.length === 0) {
        throw new StageError("RELEASE_AUDIO_MISSING", "no audio manifest; TTS/audio validation never ran");
      }
      const inspection = await readJsonl(path.join(workDir, "audio", "inspection.jsonl"), AudioInspectionRowSchema);
      const inspectionByKey = new Map(inspection.map((row) => [row.cache_key, row]));
      const durations = new Map<string, number>();
      for (const row of audioRows) {
        const assetPath = path.join(workDir, row.object_key);
        if (!(await fileExists(assetPath))) {
          throw new StageError("RELEASE_AUDIO_MISSING", `audio asset ${row.cache_key.slice(0, 12)} missing: ${row.object_key}`);
        }
        const actualSha = await sha256File(assetPath);
        if (actualSha !== row.sha256) {
          throw new StageError(
            "RELEASE_AUDIO_HASH_MISMATCH",
            `audio asset ${row.cache_key.slice(0, 12)} bytes changed (${actualSha.slice(0, 12)} != ${row.sha256.slice(0, 12)})`,
          );
        }
        const gate = inspectionByKey.get(row.cache_key);
        if (!gate || !gate.ok) {
          throw new StageError(
            "RELEASE_AUDIO_GATE_FAILED",
            `asset ${row.cache_key.slice(0, 12)} has no passing deterministic gate result`,
          );
        }
        if (gate.duration_seconds === undefined || gate.duration_seconds <= 0) {
          throw new StageError(
            "RELEASE_AUDIO_GATE_FAILED",
            `asset ${row.cache_key.slice(0, 12)} has no usable measured duration`,
          );
        }
        durations.set(row.cache_key, Math.round(gate.duration_seconds * 1000));
      }

      // -- 5. Audio links: derived with the same planner as the TTS gate. ---
      const ttsConfig = await readTtsConfig(ttsConfigPath);
      const workloads = await loadUnitWorkloads(workDir);
      const plan = buildTtsPlan({ items: collectTtsItems(workloads), config: ttsConfig, existing: audioRows });
      const audioLinks: ContentRows["audioLinks"] = [];
      for (const entry of plan.entries) {
        const row = audioRows.find((candidate) => candidate.cache_key === entry.cacheKey);
        if (!row) {
          throw new StageError(
            "RELEASE_AUDIO_COVERAGE_INCOMPLETE",
            `required text ${entry.cacheKey.slice(0, 12)} ("${entry.text}") is absent from the audio manifest`,
          );
        }
        for (const item of entry.items) {
          audioLinks.push({ entity_type: item.kind, entity_key: item.entityKey, asset_key: entry.objectKey });
        }
      }

      // -- 6. Release id: content-derived, deterministic, immutable. --------
      const normalizedSha = await sha256File(path.join(workDir, "normalized.jsonl"));
      const cardsSha = await sha256File(path.join(workDir, "cards.jsonl"));
      const audioManifestSha = await sha256File(path.join(workDir, "audio", "manifest.jsonl"));
      const releaseId =
        "rel-" +
        hashJson({
          source_hash: ctx.sourceHash,
          book_key: content.book.book_key,
          units: [...unitKeys].sort(),
          normalized_sha256: normalizedSha,
          cards_sha256: cardsSha,
          audio_manifest_sha256: audioManifestSha,
        }).slice(0, 16);

      // -- 7. Per-unit counts + sanitized QA reports. -----------------------
      const countBy = (rowsList: Array<{ unit_key: string }>): Map<string, number> => {
        const counts = new Map<string, number>();
        for (const row of rowsList) counts.set(row.unit_key, (counts.get(row.unit_key) ?? 0) + 1);
        return counts;
      };
      const unitByWord = new Map(content.words.map((word) => [word.word_key, word.unit_key]));
      const unitOf = (wordKey: string): string => unitByWord.get(wordKey) ?? "(dangling)";
      const wordCounts = countBy(content.words);
      const senseCounts = countBy(content.senses.map((sense) => ({ unit_key: unitOf(sense.word_key) })));
      const phraseCounts = countBy(content.phrases.map((phrase) => ({ unit_key: unitOf(phrase.word_key) })));
      const exampleCounts = countBy(content.examples.map((example) => ({ unit_key: unitOf(example.word_key) })));
      const cardCounts = countBy(cards);
      const explanations = await collectExplanations(workDir);
      const explanationCounts = countBy(explanations);

      const unitEntries = [...content.units]
        .sort((a, b) => a.unit_order - b.unit_order || (a.unit_key < b.unit_key ? -1 : 1))
        .map((unit) => ({
          unit_key: unit.unit_key,
          counts: {
            words: wordCounts.get(unit.unit_key) ?? 0,
            senses: senseCounts.get(unit.unit_key) ?? 0,
            phrases: phraseCounts.get(unit.unit_key) ?? 0,
            examples: exampleCounts.get(unit.unit_key) ?? 0,
            explanations: explanationCounts.get(unit.unit_key) ?? 0,
            cards: cardCounts.get(unit.unit_key) ?? 0,
          },
        }));
      const reportByUnit = new Map(unitStatuses.map((report) => [report.unit_key, report]));

      const unitStatusJson = unitEntries.map((unit) => {
        const report = reportByUnit.get(unit.unit_key)!;
        return {
          unit_key: unit.unit_key,
          status: report.status,
          counts: unit.counts,
          repair_rounds: report.repair_rounds,
          finding_codes: [...new Set(report.findings.map((finding) => finding.check))].sort(),
        };
      });
      const allFindings = unitStatuses.flatMap((report) => report.findings);
      const validationSummary = {
        units: unitEntries.length,
        passed: unitStatuses.filter((report) => report.status === "PASSED").length,
        blocked: unitStatuses.filter((report) => report.status === "BLOCKED").length,
        findings: {
          by_severity: {
            ERROR: allFindings.filter((finding) => finding.severity === "ERROR").length,
            WARNING: allFindings.filter((finding) => finding.severity === "WARNING").length,
          },
          by_code: allFindings.reduce<Record<string, number>>((acc, finding) => {
            acc[finding.check] = (acc[finding.check] ?? 0) + 1;
            return acc;
          }, {}),
        },
        max_repair_rounds: unitStatuses.reduce((acc, report) => Math.max(acc, report.repair_rounds), 0),
      };

      // -- 8. Versioned configuration for the manifest. ---------------------
      const metadata = options.metadata ?? DEFAULT_RELEASE_METADATA;
      const watermarkConfig = await readJsonConfig(watermarkRulePath, "RELEASE_CONFIG_INVALID", "watermark rule");
      const ocrVersionConfig = await readJsonConfig(ocrConfigPath, "RELEASE_CONFIG_INVALID", "OCR config");
      const cardsVersionConfig = await readJsonConfig(cardsConfigPath, "RELEASE_CONFIG_INVALID", "card rules config");
      const watermarkVersion = watermarkConfig["rule_version"];
      const ocrVersion = ocrVersionConfig["config_version"];
      if (typeof watermarkVersion !== "number" || typeof ocrVersion !== "number") {
        throw new StageError("RELEASE_CONFIG_INVALID", "watermark rule_version and OCR config_version must be numbers");
      }

      // -- 9. Bundle contents (deterministic). ------------------------------
      const createdAt = audioEntry.finished_at ?? audioEntry.started_at;
      if (!createdAt) {
        throw new StageError("RELEASE_INPUT_INVALID", "AUDIO_VALIDATE ledger entry has no timestamps");
      }
      const contentRows: ContentRows = {
        books: [content.book],
        units: content.units.map((unit) => ({ ...unit })),
        words: content.words.map((word) => ({ ...word })),
        senses: content.senses.map((sense) => ({ ...sense })),
        phrases: content.phrases.map((phrase) => ({ ...phrase })),
        examples: content.examples.map((example) => ({ ...example })),
        explanations,
        audioAssets: audioRows.map((row) => ({
          asset_key: row.object_key,
          content_sha256: row.sha256,
          text_hash: row.text_sha256,
          provider: row.provider,
          model_id: row.model,
          voice: row.voice,
          synthesis_config_version: row.synthesis_config_version,
          sample_rate_hz: ttsConfig.audio_gate.sample_rate_hz,
          channels: ttsConfig.audio_gate.channels,
          encoding: ttsConfig.audio_gate.codec,
          duration_ms: durations.get(row.cache_key)!,
        })),
        audioLinks,
      };

      const rollback = {
        version: 1,
        release_id: releaseId,
        source_pdf_sha256: ctx.sourceHash,
        previous_release_id: options.previousReleaseId ?? null,
        created_at: createdAt,
        policy: {
          activation: "pointer switch only; word_progress, card_state, and review_log are never rewritten",
          rollback_target: "the previous ACTIVE release, retained and demoted to RETIRED",
          aliases: "imported alias edges are immutable; rollback re-presents older keys and resolves the same canonical roots",
        },
        requires: { min_app_meta_config_version: 1 },
      };

      const contentSql = buildContentSql(releaseId, contentRows);
      const cardsSql = buildCardsSql(releaseId, cards);
      const searchSql = buildSearchSql(releaseId);
      const audioManifestBytes = await readFile(path.join(workDir, "audio", "manifest.jsonl"));
      const unitStatusBytes = Buffer.from(`${JSON.stringify(unitStatusJson, null, 2)}\n`, "utf8");
      const validationSummaryBytes = Buffer.from(`${JSON.stringify(validationSummary, null, 2)}\n`, "utf8");
      const rollbackBytes = Buffer.from(`${JSON.stringify(rollback, null, 2)}\n`, "utf8");

      const fileBodies = new Map<string, Buffer>([
        ["d1/001-content.sql", Buffer.from(contentSql, "utf8")],
        ["d1/002-cards.sql", Buffer.from(cardsSql, "utf8")],
        ["d1/003-search.sql", Buffer.from(searchSql, "utf8")],
        ["qa/unit-status.json", unitStatusBytes],
        ["qa/validation-summary.json", validationSummaryBytes],
        ["r2/audio-manifest.jsonl", audioManifestBytes],
        ["rollback.json", rollbackBytes],
      ]);
      const files = [...fileBodies.entries()]
        .map(([filePath, body]) => ({
          path: filePath,
          sha256: createHash("sha256").update(body).digest("hex"),
          bytes: body.length,
        }))
        .sort((a, b) => byString(a.path, b.path));

      const manifest = ReleaseManifest.parse({
        release_id: releaseId,
        status: "DRAFT",
        created_at: createdAt,
        book: { book_key: content.book.book_key, edition: content.book.edition },
        source_pdf_sha256: ctx.sourceHash,
        ...(options.previousReleaseId !== undefined ? { previous_release_id: options.previousReleaseId } : {}),
        config_versions: {
          schema_version: metadata.schema_version,
          watermark_rules_version: String(watermarkVersion),
          ocr_config_version: String(ocrVersion),
          prompt_version: metadata.prompt_version,
          card_rules_version: requireStringField(cardsVersionConfig, "card_rules_version", "RELEASE_CONFIG_INVALID", "card rules config"),
          synthesis_config_version: ttsConfig.synthesis_config_version,
        },
        model_config: {
          generation_model_id: metadata.model_config.generation_model_id,
          review_model_id: metadata.model_config.review_model_id,
          repair_model_id: metadata.model_config.repair_model_id,
          tts_model_id: ttsConfig.model,
          tts_voice: ttsConfig.voice,
        },
        units: unitEntries.map((unit) => ({
          unit_key: unit.unit_key,
          status: reportByUnit.get(unit.unit_key)!.status,
          counts: unit.counts,
        })),
        totals: {
          units: unitEntries.length,
          units_passed: unitStatuses.filter((report) => report.status === "PASSED").length,
          units_blocked: unitStatuses.filter((report) => report.status === "BLOCKED").length,
          words: unitEntries.reduce((acc, unit) => acc + unit.counts.words, 0),
          cards: unitEntries.reduce((acc, unit) => acc + unit.counts.cards, 0),
          audio_assets: audioRows.length,
        },
        files,
        gates: [
          { name: "units_all_passed", passed: true },
          { name: "audio_complete", passed: true },
          { name: "artifact_hashes_verified", passed: true },
          { name: "source_text_excluded", passed: true },
        ],
      });
      const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");

      // -- 10. Write the immutable bundle (manifest last). -------------------
      const bundleDir = path.join(privateRoot, RELEASES_DIR, releaseId);
      await mkdir(path.join(bundleDir, "d1"), { recursive: true });
      await mkdir(path.join(bundleDir, "qa"), { recursive: true });
      await mkdir(path.join(bundleDir, "r2"), { recursive: true });
      for (const [filePath, body] of fileBodies) {
        await writeFile(path.join(bundleDir, filePath), body);
      }
      await writeFile(path.join(bundleDir, "manifest.json"), manifestBytes);
      ctx.logger.info("release_packaged", {
        stage: RELEASE_PACKAGE_STAGE,
        compile_run_id: ctx.runId,
        release_id: releaseId,
        output_hash: manifestSha256,
      });

      return {
        source_sha256: ctx.sourceHash,
        release_id: releaseId,
        release_dir: `${RELEASES_DIR}/${releaseId}`,
        manifest_sha256: manifestSha256,
        file_count: files.length + 1,
        units: unitEntries.length,
        audio_assets: audioRows.length,
      } satisfies z.output<typeof ReleasePackageOutputSchema>;
    },
  };
}
