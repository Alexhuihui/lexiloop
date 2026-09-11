/**
 * Immutable release bundling and the fail-closed publish lifecycle
 * (spec 5.9/6.4/11.3/17).
 *
 * Covered under test:
 * - RELEASE_PACKAGE produces EXACTLY the bundle layout of spec 5.9, records a
 *   SHA-256 + byte size for every file, and is byte-deterministic;
 * - bundles exclude full private OCR/source text (provenance keeps only the
 *   private raw-text hash reference, spec 5.5) and reject missing audio,
 *   BLOCKED target Units, and any ledger that is missing, failed, blocked or
 *   stale (provenance mismatch);
 * - the whole-pipeline fixture: exact 13-stage order, predecessor dependency
 *   hashes, resume behavior, and the release gate's refusal to package;
 * - publishing stages an INACTIVE D1 release (IMPORTING, app_meta untouched),
 *   uploads content-addressed audio idempotently by hash, validates before
 *   activation (rows/FK/FTS/audio), and only `activate` switches the pointer —
 *   atomically, never rewriting word_progress/card_state/review_log;
 * - typed alias edges: end existence, one canonical root, state-collapse
 *   rejection, and bidirectional version-aware canonical resolution;
 * - CLI wiring of every `release` subcommand with injected D1/R2 deps.
 *
 * Bundle tests use synthetic fixtures; real bundles live under the
 * git-ignored `.lexiloop-private/releases/` and are never committed.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  CardDefinition,
  Example,
  Phrase,
  ReleaseManifest,
  Sense,
  Unit,
  UnitValidationReport,
  Word,
} from "@lexiloop/content-schema";
import {
  AliasRepository,
  ContentRepository,
  ReleaseRepository,
  createSqliteDatabase,
  type LexiloopDatabase,
} from "@lexiloop/db";
import { buildCli, type CliDeps } from "../../src/cli";
import { createFileLedger, type LedgerStore } from "../../src/ledger";
import { silentLogger } from "../../src/logging";
import { runPipeline } from "../../src/pipeline";
import { loadAudioManifest, ttsCacheKey } from "../../src/tts/cache";
import {
  PRODUCTION_STAGE_DEPENDENCIES,
  PRODUCTION_STAGE_NAMES,
  createReleasePackageStage,
  getProductionStages,
} from "../../src/stage-registry";
import {
  ReleasePackageOutputSchema,
  buildContentSql,
  redactProvenance,
} from "../../src/release/package";
import { verifyBundle } from "../../src/release/validate";
import {
  R2AudioStore,
  activateRelease,
  rollbackRelease,
  smokeRelease,
  stageBundle,
  uploadAudioAssets,
} from "../../src/release/publish";
import { hashJson, hashString, StageError, type AnyStage, type StageRunContext } from "../../src/stage";

// ---------------------------------------------------------------------------
// Fixture: one fully-compiled source work directory (synthetic artifacts that
// satisfy every upstream stage output contract RELEASE_PACKAGE verifies).
// ---------------------------------------------------------------------------

const SOURCE_HASH = "b4".repeat(32);
const PDF_HASH = createHash("sha256").update("source.pdf").digest("hex");
const LEDGER_ISO = "2026-09-10T00:00:00.000Z";
const NOW_MS = 1_700_000_000_000;
const sha = (label: string): string => createHash("sha256").update(label).digest("hex");

const sha256File = async (filePath: string): Promise<string> =>
  createHash("sha256").update(await readFile(filePath)).digest("hex");

function provenance(page: number, text: string) {
  return {
    source_pdf_sha256: PDF_HASH,
    page_number: page,
    bbox: [0.1, 0.2, 0.5, 0.6] as [number, number, number, number],
    page_image_sha256: sha(`page-${page}`),
    source_raw_ref_hash: sha(`raw-${page}-${text}`),
    // Full private OCR/source line: must NEVER appear in any bundle file.
    source_normalized_text: text,
    ocr_confidence: 0.98,
    structure_confidence: 0.97,
  };
}

const UNIT = Unit.parse({
  unit_key: "u01",
  book_key: "bk-llcy",
  level: 1,
  unit_order: 1,
  title: "Unit 1",
  ...provenance(12, "Unit 1 第一单元 ||RAW-OCR-UNIT||"),
});

const WORDS = [
  Word.parse({
    word_key: "u01-abandon",
    unit_key: "u01",
    headword: "abandon",
    phonetic: "/\u0259\u02c8b\u00e6nd\u0259n/",
    tier: "core",
    source_order: 1,
    ...provenance(12, "abandon vt. 放弃；抛弃 ||RAW-OCR-ABANDON||"),
  }),
  Word.parse({
    word_key: "u01-ability",
    unit_key: "u01",
    headword: "ability",
    tier: "core",
    source_order: 2,
    ...provenance(12, "ability n. 能力 ||RAW-OCR-ABILITY||"),
  }),
];

const SENSES = [
  Sense.parse({
    sense_key: "u01-abandon-s1",
    word_key: "u01-abandon",
    pos: "vt",
    gloss: "放弃；抛弃",
    sense_order: 1,
    ...provenance(12, "放弃；抛弃 ||RAW-OCR-SENSE||"),
  }),
];

const PHRASES = [
  Phrase.parse({
    phrase_key: "u01-abandon-p1",
    word_key: "u01-abandon",
    text: "abandon oneself to",
    gloss: "沉溺于",
    source_order: 1,
    ...provenance(13, "abandon oneself to 沉溺于 ||RAW-OCR-PHRASE||"),
  }),
];

const EXAMPLES = [
  Example.parse({
    example_key: "u01-abandon-ex1",
    word_key: "u01-abandon",
    origin: "exam",
    source_ref: "2019 阅读 Text 2",
    text: "He abandoned the plan without a second thought.",
    target_span: [4, 13],
    source_order: 1,
    ...provenance(13, "He abandoned the plan ... ||RAW-OCR-EXAMPLE||"),
  }),
];

const CARDS = [
  CardDefinition.parse({
    content_card_key: "card.u01-abandon.wm",
    card_type: "WORD_MEANING",
    target_entity_key: "u01-abandon-s1",
    word_key: "u01-abandon",
    unit_key: "u01",
    template_version: "v1",
    status: "ACTIVE",
  }),
  CardDefinition.parse({
    content_card_key: "card.u01-abandon-ex1.cm",
    card_type: "CONTEXT_MEANING",
    target_entity_key: "u01-abandon-ex1",
    word_key: "u01-abandon",
    unit_key: "u01",
    template_version: "v1",
    status: "ACTIVE",
  }),
];

// Every headword and every example sentence needs audio (spec 5.8).
const AUDIO_TEXTS = ["abandon", "ability", "He abandoned the plan without a second thought."];

/** Deterministic pseudo-WAV bytes (packaging only hashes, never decodes). */
function wavBytes(seed: string): Buffer {
  const data = Buffer.from(`fake-pcm-data-${seed}`, "utf8");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.write("WAVE", 8, "latin1");
  header.writeUInt32LE(data.length + 36, 4);
  return Buffer.concat([header, data]);
}

interface AudioFixtureRow {
  cache_key: string;
  object_key: string;
  wav_path: string;
  text: string;
  text_sha256: string;
  sha256: string;
  bytes: number;
}

async function writeAudioFixture(workDir: string): Promise<AudioFixtureRow[]> {
  const rows: AudioFixtureRow[] = [];
  for (const text of AUDIO_TEXTS) {
    // Cache keys must match the TTS planner exactly: sha256(provider, model,
    // voice, normalized text, synthesis config version) with the repo config.
    const cacheKey = ttsCacheKey({
      provider: "mimo",
      model: "mimo-v2.5-tts",
      voice: "Mia",
      text,
      synthesisConfigVersion: "mimo-v2.5-tts-1",
    });
    const objectKey = `audio/${cacheKey.slice(0, 2)}/${cacheKey}.wav`;
    const wav = wavBytes(text);
    await mkdir(path.join(workDir, path.dirname(objectKey)), { recursive: true });
    await writeFile(path.join(workDir, objectKey), wav);
    rows.push({
      cache_key: cacheKey,
      object_key: objectKey,
      wav_path: `${cacheKey.slice(0, 2)}/${cacheKey}.wav`,
      text,
      text_sha256: sha(text),
      sha256: createHash("sha256").update(wav).digest("hex"),
      bytes: wav.length,
    });
  }
  rows.sort((a, b) => (a.cache_key < b.cache_key ? -1 : 1));
  const manifestRows = rows.map((row) => ({
    cache_key: row.cache_key,
    object_key: row.object_key,
    wav_path: row.wav_path,
    text_sha256: row.text_sha256,
    text_chars: row.text.length,
    min_seconds: 0.3,
    max_seconds: 2,
    sha256: row.sha256,
    bytes: row.bytes,
    provider: "mimo",
    model: "mimo-v2.5-tts",
    voice: "Mia",
    synthesis_config_version: "mimo-v2.5-tts-1",
  }));
  await mkdir(path.join(workDir, "audio"), { recursive: true });
  await writeFile(
    path.join(workDir, "audio", "manifest.jsonl"),
    manifestRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(workDir, "audio", "inspection.jsonl"),
    manifestRows
      .map((row) =>
        JSON.stringify({
          cache_key: row.cache_key,
          wav_path: row.wav_path,
          ok: true,
          text_sha256: row.text_sha256,
          duration_seconds: 0.9,
        }),
      )
      .join("\n") + "\n",
    "utf8",
  );
  return rows;
}

async function writeValidationReport(
  workDir: string,
  report: { status: "PASSED" | "BLOCKED"; findings?: Array<{ check: string; severity: "ERROR" | "WARNING"; message: string }> },
): Promise<void> {
  const parsed = UnitValidationReport.parse({
    unit_key: UNIT.unit_key,
    compile_run_id: "prime",
    status: report.status,
    repair_rounds: 0,
    findings: report.findings ?? [],
  });
  await mkdir(path.join(workDir, "validation"), { recursive: true });
  await writeFile(
    path.join(workDir, "validation", `${UNIT.unit_key}.json`),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
}

/** Synthetic but self-consistent output object for one upstream stage. */
async function stageOutputFor(name: string, workDir: string): Promise<Record<string, unknown>> {
  switch (name) {
    case "SOURCE_FINGERPRINT":
      return { source_sha256: SOURCE_HASH, algorithm: "sha256" };
    case "IMAGE_EXTRACT":
      return {
        source_sha256: SOURCE_HASH,
        pages_jsonl: "pages.jsonl",
        pages: [{ page: 12, method: "rendered", width_px: 1000, height_px: 1400, image_sha256: sha("p12") }],
      };
    case "WATERMARK_CLEAN":
      return { source_sha256: SOURCE_HASH, rule_version: 3, clean_jsonl: "clean.jsonl", pages: [], body_overlap_pages: [] };
    case "LAYOUT_OCR":
      return { source_sha256: SOURCE_HASH, ocr_jsonl: "ocr.jsonl", ocr_jsonl_sha256: sha("ocr"), block_count: 4, pages: [{ page: 12, block_count: 4 }] };
    case "STRUCTURE_NORMALIZE":
      return {
        source_sha256: SOURCE_HASH,
        normalized_jsonl: "normalized.jsonl",
        normalized_jsonl_sha256: await sha256File(path.join(workDir, "normalized.jsonl")),
        counts: { units: 1, words: 2, senses: 1, phrases: 1, examples: 1 },
        unit_boundaries: [{ unit_key: "u01", unit_order: 1, title: "Unit 1", first_page: 12, last_page: 13 }],
        resolved_packets: 0,
      };
    case "AGENT_ENRICH":
    case "AGENT_REVIEW":
    case "DETERMINISTIC_VALIDATE":
    case "REPAIR_LOOP":
      return { source_sha256: SOURCE_HASH, units: [{ unit_key: "u01", phase: "passed" }] };
    case "CARD_GENERATE":
      return {
        source_sha256: SOURCE_HASH,
        cards_jsonl: "cards.jsonl",
        cards_jsonl_sha256: await sha256File(path.join(workDir, "cards.jsonl")),
        card_rules_version: "cards-v1",
        counts: {
          units: 1,
          words: 2,
          cards: 2,
          by_type: { WORD_MEANING: 1, CONTEXT_MEANING: 1, PHRASE: 0, SENSE_DISCRIMINATION: 0 },
        },
        units: [{ unit_key: "u01", words: 2, cards: 2 }],
      };
    case "TTS_SYNTHESIZE":
      return {
        source_sha256: SOURCE_HASH,
        audio_manifest: "audio/manifest.jsonl",
        audio_manifest_sha256: await sha256File(path.join(workDir, "audio", "manifest.jsonl")),
        synthesis_config_version: "mimo-v2.5-tts-1",
        counts: { items: 2, unique_texts: 2, cache_hits: 0, synthesized: 2 },
        characters: AUDIO_TEXTS.reduce((acc, text) => acc + text.length, 0),
        assets: [],
      };
    case "AUDIO_VALIDATE":
      return {
        source_sha256: SOURCE_HASH,
        audio_inspection: "audio/inspection.jsonl",
        audio_inspection_sha256: await sha256File(path.join(workDir, "audio", "inspection.jsonl")),
        synthesis_config_version: "mimo-v2.5-tts-1",
        counts: { checked: AUDIO_TEXTS.length, failed: 0 },
      };
    default:
      throw new Error(`no synthetic output for stage ${name}`);
  }
}

const PRIMED_ATTEMPTS: Record<string, unknown> = {
  stage: "",
  status: "PASSED",
  compile_run_id: "prime",
  input_hash: "",
  config_version_hash: "",
  output_hash: "",
  attempts: 1,
  started_at: LEDGER_ISO,
  finished_at: LEDGER_ISO,
  updated_at: LEDGER_ISO,
  error_code: null,
};

async function primeLedger(ledger: LedgerStore, workDir: string): Promise<void> {
  for (const name of PRODUCTION_STAGE_NAMES.slice(0, 12)) {
    const output = await stageOutputFor(name, workDir);
    await ledger.save({
      ...PRIMED_ATTEMPTS,
      stage: name,
      input_hash: hashString(`${name}:input`),
      config_version_hash: hashString(`${name}:config`),
      output_hash: hashJson(output),
    } as Parameters<LedgerStore["save"]>[0]);
  }
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ReleaseFixture {
  privateRoot: string;
  workDir: string;
  ledgerDir: string;
  ledger: LedgerStore;
  audioRows: AudioFixtureRow[];
  audioValidateOutput: Record<string, unknown>;
  stage: AnyStage;
  ctx: StageRunContext;
}

/** Fully-compiled work directory + primed 12-stage ledger + the real stage. */
async function makeReleaseFixture(): Promise<ReleaseFixture> {
  const privateRoot = await makeTempDir("release-private-");
  const workDir = path.join(privateRoot, "work", SOURCE_HASH);
  await mkdir(workDir, { recursive: true });
  const normalizedRows = [
    { entity_type: "book" as const, book_key: UNIT.book_key, title: "低压高频词汇 2024", edition: "2024 第一版", ...provenance(1, "book cover ||RAW-OCR-BOOK||") },
    { entity_type: "unit" as const, ...UNIT },
    ...WORDS.map((word) => ({ entity_type: "word" as const, ...word })),
    ...SENSES.map((sense) => ({ entity_type: "sense" as const, ...sense })),
    ...PHRASES.map((phrase) => ({ entity_type: "phrase" as const, ...phrase })),
    ...EXAMPLES.map((example) => ({ entity_type: "example" as const, ...example })),
  ];
  await writeFile(
    path.join(workDir, "normalized.jsonl"),
    normalizedRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(workDir, "cards.jsonl"),
    CARDS.map((card) => JSON.stringify(card)).join("\n") + "\n",
    "utf8",
  );
  const audioRows = await writeAudioFixture(workDir);
  await writeValidationReport(workDir, { status: "PASSED" });

  const ledgerDir = await makeTempDir("release-ledger-");
  const ledger = createFileLedger({ directory: ledgerDir });
  await primeLedger(ledger, workDir);
  const audioValidateOutput = await stageOutputFor("AUDIO_VALIDATE", workDir);
  const stage = createReleasePackageStage({ privateRoot });
  const ctx: StageRunContext = {
    runId: "release-test",
    sourceHash: SOURCE_HASH,
    config: {},
    ledger,
    logger: silentLogger,
    upstream: { stage: "AUDIO_VALIDATE", outputHash: hashJson(audioValidateOutput) },
  };
  return { privateRoot, workDir, ledgerDir, ledger, audioRows, audioValidateOutput, stage, ctx };
}

async function packageBundle(fixture: ReleaseFixture): Promise<{ releaseId: string; bundleDir: string; manifestSha256: string }> {
  const output = ReleasePackageOutputSchema.parse(await fixture.stage.run(undefined, fixture.ctx));
  return {
    releaseId: output.release_id,
    bundleDir: path.join(fixture.privateRoot, "releases", output.release_id),
    manifestSha256: output.manifest_sha256,
  };
}

const BUNDLE_FILES = [
  "d1/001-content.sql",
  "d1/002-cards.sql",
  "d1/003-search.sql",
  "manifest.json",
  "qa/unit-status.json",
  "qa/validation-summary.json",
  "r2/audio-manifest.jsonl",
  "rollback.json",
];

async function listBundleFiles(bundleDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    const entries = await readdir(path.join(bundleDir, rel));
    for (const entry of entries.sort()) {
      const relPath = rel ? `${rel}/${entry}` : entry;
      const info = await stat(path.join(bundleDir, relPath));
      if (info.isDirectory()) await walk(relPath);
      else out.push(relPath);
    }
  }
  await walk("");
  return out.sort();
}

// ---------------------------------------------------------------------------
// Release bundling (RELEASE_PACKAGE)
// ---------------------------------------------------------------------------

describe("RELEASE_PACKAGE bundle (spec 5.9)", () => {
  it("produces exactly the spec bundle layout with a self-verifying manifest", async () => {
    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);

    expect(await listBundleFiles(bundleDir)).toEqual([...BUNDLE_FILES].sort());

    const manifest = ReleaseManifest.parse(JSON.parse(await readFile(path.join(bundleDir, "manifest.json"), "utf8")));
    // Every non-manifest file is hashed; manifest.json itself is the trust root.
    expect(manifest.files.map((file) => file.path).sort()).toEqual(BUNDLE_FILES.filter((f) => f !== "manifest.json").sort());
    for (const file of manifest.files) {
      const bytes = await readFile(path.join(bundleDir, file.path));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
      expect(bytes.length).toBe(file.bytes);
    }
    expect(manifest.status).toBe("DRAFT");
    expect(manifest.source_pdf_sha256).toBe(SOURCE_HASH);
    expect(manifest.units).toEqual([
      {
        unit_key: "u01",
        status: "PASSED",
        counts: { words: 2, senses: 1, phrases: 1, examples: 1, explanations: 0, cards: 2 },
      },
    ]);
    expect(manifest.totals).toMatchObject({ units: 1, units_passed: 1, units_blocked: 0, words: 2, cards: 2, audio_assets: 3 });
    expect(manifest.totals.audio_assets).toBe(fixture.audioRows.length);
    // The verified manifest hash is the stage output's manifest hash.
    const verified = await verifyBundle(bundleDir);
    expect(verified.ok).toBe(true);
    expect(verified.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is byte-deterministic across runs (deterministic SQL ordering)", async () => {
    const first = await makeReleaseFixture();
    const firstBundle = await packageBundle(first);
    const bytesOf = async (dir: string, file: string): Promise<string> => readFile(path.join(dir, file), "utf8");

    // A second, independently-primed compile of the same content.
    const second = await makeReleaseFixture();
    const secondBundle = await packageBundle(second);

    expect(secondBundle.releaseId).toBe(firstBundle.releaseId);
    for (const file of BUNDLE_FILES) {
      expect(await bytesOf(secondBundle.bundleDir, file)).toBe(await bytesOf(firstBundle.bundleDir, file));
    }
    // SQL rows are ordered deterministically (no source-order jitter).
    const contentSql = await bytesOf(firstBundle.bundleDir, "d1/001-content.sql");
    const wordAt = (key: string): number => contentSql.indexOf(`'${firstBundle.releaseId}', '${key}'`);
    expect(wordAt("u01-abandon")).toBeGreaterThan(-1);
    expect(wordAt("u01-abandon")).toBeLessThan(wordAt("u01-ability"));
  });

  it("excludes full private OCR/source text but keeps hash references", async () => {
    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);

    for (const file of BUNDLE_FILES) {
      const text = await readFile(path.join(bundleDir, file), "utf8");
      // The raw OCR lines and the provenance key itself never appear...
      expect(text).not.toContain("source_normalized_text");
      expect(text).not.toContain("||RAW-OCR-ABANDON||");
      expect(text).not.toContain("||RAW-OCR-UNIT||");
      expect(text).not.toContain("||RAW-OCR-BOOK||");
      // ...while the private hash reference survives in the SQL provenance.
      if (file === "d1/001-content.sql") {
        expect(text).toContain(sha(`raw-12-${WORDS[0]!.headword} vt. 放弃；抛弃 ||RAW-OCR-ABANDON||`));
      }
    }
    // QA reports are sanitized: statuses/counts/codes only.
    const unitStatus = await readFile(path.join(bundleDir, "qa", "unit-status.json"), "utf8");
    expect(unitStatus).toContain("u01");
    expect(unitStatus).not.toContain("abandon");
  });

  it("rejects missing audio assets with RELEASE_AUDIO_MISSING", async () => {
    const fixture = await makeReleaseFixture();
    await rm(path.join(fixture.workDir, fixture.audioRows[0]!.object_key));
    await expect(fixture.stage.run(undefined, fixture.ctx)).rejects.toMatchObject({
      code: "RELEASE_AUDIO_MISSING",
    });
  });

  it("rejects a BLOCKED target unit terminally with RELEASE_UNIT_BLOCKED", async () => {
    const fixture = await makeReleaseFixture();
    await writeValidationReport(fixture.workDir, {
      status: "BLOCKED",
      findings: [{ check: "FORBIDDEN_TERM", severity: "ERROR", message: "blocked" }],
    });
    const err = await fixture.stage.run(undefined, fixture.ctx).catch((err: unknown) => err);
    expect(err).toBeInstanceOf(StageError);
    expect((err as StageError).code).toBe("RELEASE_UNIT_BLOCKED");
    expect((err as StageError).blocked).toBe(true);
  });

  it.each([
    ["missing", "delete"],
    ["failed", "fail"],
    ["blocked", "block"],
  ])("refuses to package when a predecessor is %s (RELEASE_GATE_UNMET)", async (_label, mode) => {
    const fixture = await makeReleaseFixture();
    if (mode === "delete") {
      await rm(path.join(fixture.ledgerDir, "WATERMARK_CLEAN.json"));
    } else {
      const entry = await fixture.ledger.load("WATERMARK_CLEAN");
      await fixture.ledger.save({
        ...entry!,
        status: mode === "fail" ? "FAILED" : "BLOCKED",
        error_code: mode === "fail" ? "MEDIA_TIMEOUT" : "UNIT_BLOCKED",
      });
    }
    await expect(fixture.stage.run(undefined, fixture.ctx)).rejects.toMatchObject({
      code: "RELEASE_GATE_UNMET",
    });
    // Nothing was written outside the work directory.
    const releasesDir = path.join(fixture.privateRoot, "releases");
    await expect(readdir(releasesDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a work directory edited after the pipeline passed (RELEASE_INPUT_STALE)", async () => {
    // Normalized content edit (bytes no longer hash to the recorded output).
    const tampered = await makeReleaseFixture();
    const normalizedFile = path.join(tampered.workDir, "normalized.jsonl");
    await writeFile(
      normalizedFile,
      (await readFile(normalizedFile, "utf8")).replace('"ocr_confidence":0.98', '"ocr_confidence":0.97'),
      "utf8",
    );
    await expect(tampered.stage.run(undefined, tampered.ctx)).rejects.toMatchObject({
      code: "RELEASE_INPUT_STALE",
    });
    await expect(readdir(path.join(tampered.privateRoot, "releases"))).rejects.toMatchObject({ code: "ENOENT" });

    // Cards edit (still schema-valid, but no longer what CARD_GENERATE hashed).
    const tamperedCards = await makeReleaseFixture();
    const cardsFile = path.join(tamperedCards.workDir, "cards.jsonl");
    await writeFile(
      cardsFile,
      (await readFile(cardsFile, "utf8")).replace('"template_version":"v1"', '"template_version":"v9"'),
      "utf8",
    );
    await expect(tamperedCards.stage.run(undefined, tamperedCards.ctx)).rejects.toMatchObject({
      code: "RELEASE_INPUT_STALE",
    });
    await expect(readdir(path.join(tamperedCards.privateRoot, "releases"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses stale packaging provenance with RELEASE_PROVENANCE_INVALID", async () => {
    const fixture = await makeReleaseFixture();
    // The upstream hash no longer matches the AUDIO_VALIDATE ledger output.
    const staleCtx: StageRunContext = {
      ...fixture.ctx,
      upstream: { stage: "AUDIO_VALIDATE", outputHash: sha("stale-upstream") },
    };
    await expect(fixture.stage.run(undefined, staleCtx)).rejects.toMatchObject({
      code: "RELEASE_PROVENANCE_INVALID",
    });
  });
});

// ---------------------------------------------------------------------------
// Whole-pipeline fixture: 13-stage order, predecessor hashes, resume, gate
// ---------------------------------------------------------------------------

function audioValidateSpy(output: unknown): AnyStage {
  const passthrough = { parse: (value: unknown) => value };
  return {
    name: "AUDIO_VALIDATE",
    configVersion: "1",
    inputSchema: passthrough,
    outputSchema: passthrough,
    computeInputHash: () => "AUDIO_VALIDATE-input",
    run: async () => output,
  } as unknown as AnyStage;
}

describe("whole-pipeline release fixture (spec 5.2)", () => {
  it("registers exactly the 13 production stages chained to their predecessors", () => {
    expect(PRODUCTION_STAGE_NAMES).toEqual([
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
    ]);
    const stages = getProductionStages({ privateRoot: mkdtempSync(path.join(tmpdir(), "registry-")) });
    expect(stages.map((stage) => stage.name)).toEqual([...PRODUCTION_STAGE_NAMES]);
    stages.forEach((stage, index) => {
      if (index === 0) {
        expect(PRODUCTION_STAGE_DEPENDENCIES[stage.name as keyof typeof PRODUCTION_STAGE_DEPENDENCIES]).toEqual([]);
        return;
      }
      expect(PRODUCTION_STAGE_DEPENDENCIES[stage.name as keyof typeof PRODUCTION_STAGE_DEPENDENCIES]).toEqual([
        stages[index - 1]!.name,
      ]);
    });
  });

  it("packages through the pipeline, resumes clean, and blocks on an unmet gate", async () => {
    const fixture = await makeReleaseFixture();
    const gate = {
      stage: "RELEASE_PACKAGE",
      requires: PRODUCTION_STAGE_DEPENDENCIES["RELEASE_PACKAGE"],
    };
    const stages: AnyStage[] = [audioValidateSpy(fixture.audioValidateOutput), fixture.stage];

    const first = await runPipeline(stages, fixture.ledger, {
      sourceHash: SOURCE_HASH,
      runId: "pipe-1",
      releaseGate: gate,
    });
    expect(first.status).toBe("COMPLETED");
    expect(first.results.map((result) => `${result.name}:${result.status}`)).toEqual([
      "AUDIO_VALIDATE:PASSED",
      "RELEASE_PACKAGE:PASSED",
    ]);
    const releaseEntry = await fixture.ledger.load("RELEASE_PACKAGE");
    expect(releaseEntry).toMatchObject({ status: "PASSED" });
    expect(releaseEntry?.output_hash).toMatch(/^[0-9a-f]{64}$/);

    // Resume: both stages skip with unchanged inputs (predecessor hash stable).
    const second = await runPipeline(stages, fixture.ledger, {
      sourceHash: SOURCE_HASH,
      runId: "pipe-2",
      releaseGate: gate,
    });
    expect(second.status).toBe("COMPLETED");
    expect(second.results.map((result) => `${result.name}:${result.status}`)).toEqual([
      "AUDIO_VALIDATE:SKIPPED",
      "RELEASE_PACKAGE:SKIPPED",
    ]);

    // Gate refusal: a predecessor without a PASSED entry blocks packaging.
    const broken = await makeReleaseFixture();
    const brokenEntry = await broken.ledger.load("CARD_GENERATE");
    await broken.ledger.save({ ...brokenEntry!, status: "FAILED", error_code: "SEMANTIC_STATE_INVALID" });
    const report = await runPipeline([audioValidateSpy(broken.audioValidateOutput), broken.stage], broken.ledger, {
      sourceHash: SOURCE_HASH,
      runId: "pipe-3",
      releaseGate: gate,
    });
    expect(report.status).toBe("BLOCKED");
    expect(report.stoppedAt).toBe("RELEASE_PACKAGE");
    expect(report.results.find((result) => result.name === "RELEASE_PACKAGE")).toMatchObject({
      status: "BLOCKED",
      error_code: "RELEASE_GATE_UNMET",
    });
    const releasesDir = path.join(broken.privateRoot, "releases");
    await expect(readdir(releasesDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ---------------------------------------------------------------------------
// Deterministic SQL builders: ordering + private-text redaction
// ---------------------------------------------------------------------------

describe("deterministic import SQL builders", () => {
  it("redacts provenance to private hash references", () => {
    const redacted = redactProvenance(provenance(12, "abandon vt. 放弃；抛弃 ||RAW-OCR-ABANDON||"));
    expect(redacted).not.toHaveProperty("source_normalized_text");
    expect(redacted).toMatchObject({
      source_pdf_sha256: PDF_HASH,
      page_number: 12,
      source_raw_ref_hash: sha(`raw-12-abandon vt. 放弃；抛弃 ||RAW-OCR-ABANDON||`),
    });
  });

  it("emits ordered, redacted INSERT statements", () => {
    const sql = buildContentSql("rel-x", {
      books: [{ ...UNIT, book_key: UNIT.book_key, title: "Book 'quoted'", edition: "2024", ...provenance(1, "raw") }],
      units: [{ ...UNIT }],
      words: WORDS.map((word) => ({ ...word })),
      senses: SENSES.map((sense) => ({ ...sense })),
      phrases: PHRASES.map((phrase) => ({ ...phrase })),
      examples: EXAMPLES.map((example) => ({ ...example })),
      explanations: [
        {
          explanation_key: "exp.u01-abandon",
          word_key: "u01-abandon",
          unit_key: "u01",
          generated: { syntax_notes: ["S + V + O"], translation_hints: "提示", pitfalls: [], context_meanings: [], discrimination_candidates: [] },
        },
      ],
      audioAssets: [],
      audioLinks: [],
    });
    expect(sql).toContain("INSERT INTO book");
    expect(sql).toContain("'Book ''quoted'''");
    // Statements are one-per-line and ordered: book, unit, word, sense, phrase, example, explanation.
    const lines = sql.split("\n").filter((line) => line.startsWith("INSERT INTO"));
    expect(lines.map((line) => line.split(" ")[2])).toEqual([
      "book", "unit", "word", "word", "sense", "phrase", "example", "explanation",
    ]);
    expect(sql).not.toContain("source_normalized_text");
    expect(sql).not.toContain("||RAW-OCR||");
  });
});

// ---------------------------------------------------------------------------
// D1/R2 test doubles (real migrated schema + in-memory R2)
// ---------------------------------------------------------------------------

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../infra/migrations",
);

interface TestDb {
  sqlite: Database.Database;
  db: LexiloopDatabase;
  cleanup(): void;
}

function createDb(): TestDb {
  const dir = mkdtempSync(path.join(tmpdir(), "release-db-"));
  tempDirs.push(dir);
  const sqlite = new Database(path.join(dir, "d1.sqlite"));
  sqlite.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  return {
    sqlite,
    db: createSqliteDatabase(sqlite),
    cleanup: () => {
      sqlite.close();
    },
  };
}

class FakeR2 implements R2AudioStore {
  readonly objects = new Map<string, Buffer>();
  readonly putKeys: string[] = [];
  heads = 0;

  async head(objectKey: string): Promise<{ size: number } | null> {
    this.heads += 1;
    const object = this.objects.get(objectKey);
    return object ? { size: object.length } : null;
  }

  async put(objectKey: string, body: Uint8Array): Promise<void> {
    this.putKeys.push(objectKey);
    this.objects.set(objectKey, Buffer.from(body));
  }
}

async function snapshotUserState(db: TestDb): Promise<string> {
  return JSON.stringify({
    progress: db.sqlite.prepare("SELECT * FROM word_progress ORDER BY user_id, word_key").all(),
    cards: db.sqlite.prepare("SELECT * FROM card_state ORDER BY user_id, content_card_key").all(),
    logs: db.sqlite.prepare("SELECT * FROM review_log ORDER BY event_id").all(),
  });
}

/** Seeds release `releaseId` (READY) with a unit + word + card, like an import. */
async function seedReadyRelease(db: TestDb, releaseId: string, wordKey: string): Promise<void> {
  const releases = new ReleaseRepository(db.db);
  await releases.create({
    releaseId,
    sourcePdfSha256: sha(`pdf-${releaseId}`),
    schemaVersion: "schema-v1",
    promptVersion: "prompt-v1",
    modelConfigJson: "{}",
    status: "READY",
    createdAt: NOW_MS,
    manifestSha256: sha(`manifest-${releaseId}`),
  });
  await releases.insertUnitReport(releaseId, { unitKey: "u1", status: "PASSED", words: 1, cards: 1 });
  db.sqlite
    .prepare("INSERT INTO book (release_id, book_key, title, edition, provenance_json) VALUES (?, 'bk', 't', 'e', '{}')")
    .run(releaseId);
  db.sqlite
    .prepare("INSERT INTO unit (release_id, unit_key, book_key, level, unit_order, title, provenance_json) VALUES (?, 'u1', 'bk', 1, 1, 'Unit 1', '{}')")
    .run(releaseId);
  db.sqlite
    .prepare("INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) VALUES (?, ?, 'u1', ?, NULL, 'core', 1, '{}')")
    .run(releaseId, wordKey, "legacy");
  db.sqlite
    .prepare("INSERT INTO card_definition (release_id, content_card_key, card_type, target_entity_key, word_key, unit_key, template_version, status) VALUES (?, ?, 'WORD_MEANING', ?, ?, 'u1', 'v1', 'ACTIVE')")
    .run(releaseId, `card.${wordKey}`, wordKey, wordKey);
}

// ---------------------------------------------------------------------------
// Publish lifecycle: verify -> stage -> smoke -> activate / rollback
// ---------------------------------------------------------------------------

describe("release publish lifecycle (D1/R2)", () => {
  it("stages an inactive IMPORTING release without touching app_meta", async () => {
    const env = createDb();
    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);
    const r2 = new FakeR2();

    const result = await stageBundle({ db: env.db, r2, bundleDir, audioRoot: fixture.workDir, now: NOW_MS });
    expect(result.uploaded).toBe(fixture.audioRows.length);
    expect(result.reused).toBe(0);
    expect(result.releaseId).toMatch(/^rel-/);

    const releases = new ReleaseRepository(env.db);
    const row = await releases.getById(result.releaseId);
    expect(row).toMatchObject({ status: "IMPORTING", activatedAt: null });
    expect(row?.manifestSha256).toBe((await verifyBundle(bundleDir)).manifestSha256);
    // app_meta untouched: activation is the ONLY pointer writer.
    expect((await releases.getMeta())?.activeReleaseId ?? null).toBeNull();

    // Content rows imported in the release scope.
    const content = new ContentRepository(env.db);
    expect((await content.getUnit(result.releaseId, "u01"))?.title).toBe("Unit 1");
    expect((await content.getWord(result.releaseId, "u01-abandon"))?.headword).toBe("abandon");
    expect((await content.getCard(result.releaseId, "card.u01-abandon.wm"))?.cardType).toBe("WORD_MEANING");
    expect((await content.listAudio(result.releaseId, "word", "u01-abandon")).length).toBe(1);

    // Content-addressed R2 objects keyed exactly by the manifest object keys.
    for (const audio of fixture.audioRows) {
      expect(r2.objects.get(audio.object_key)).not.toBeUndefined();
    }

    // Idempotent re-upload by hash: everything is reused, nothing re-put.
    const manifestRows = await loadAudioManifest(fixture.workDir);
    const again = await uploadAudioAssets(r2, manifestRows, fixture.workDir);
    expect(again).toEqual({ uploaded: 0, reused: manifestRows.length });

    // Staging the same bundle twice fails closed.
    await expect(stageBundle({ db: env.db, r2, bundleDir, audioRoot: fixture.workDir, now: NOW_MS })).rejects.toMatchObject({
      code: "RELEASE_ALREADY_STAGED",
    });
    env.cleanup();
  });

  it("refuses to stage an intentionally broken bundle and keeps the old release active", async () => {
    const env = createDb();
    await seedReadyRelease(env, "rel-a", "w-a");
    const releases = new ReleaseRepository(env.db);
    await releases.setActive("rel-a", NOW_MS);

    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);
    // Corrupt one bundled file after packaging.
    const cardsSql = path.join(bundleDir, "d1", "002-cards.sql");
    await writeFile(cardsSql, (await readFile(cardsSql, "utf8")).replace("ACTIVE", "DEPRECATED"), "utf8");

    const verified = await verifyBundle(bundleDir);
    expect(verified.ok).toBe(false);
    expect(verified.errors[0]?.path).toBe("d1/002-cards.sql");

    await expect(
      stageBundle({ db: env.db, r2: new FakeR2(), bundleDir, audioRoot: fixture.workDir, now: NOW_MS }),
    ).rejects.toMatchObject({ code: "BUNDLE_VERIFY_FAILED" });
    expect((await releases.getMeta())?.activeReleaseId).toBe("rel-a");
    env.cleanup();
  });

  it("moves IMPORTING through VALIDATING to READY, and failures to FAILED with the pointer unchanged", async () => {
    // Happy path: the release reaches READY while the old pointer stays put.
    const env = createDb();
    await seedReadyRelease(env, "rel-a", "w-a");
    const releases = new ReleaseRepository(env.db);
    await releases.setActive("rel-a", NOW_MS);

    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);
    const r2 = new FakeR2();
    const staged = await stageBundle({ db: env.db, r2, bundleDir, audioRoot: fixture.workDir, now: NOW_MS });
    expect((await releases.getById(staged.releaseId))?.status).toBe("IMPORTING");

    const smoke = await smokeRelease({ db: env.db, r2, releaseId: staged.releaseId });
    expect(smoke.checks.every((check) => check.passed)).toBe(true);
    expect((await releases.getById(staged.releaseId))?.status).toBe("READY");
    expect((await releases.getMeta())?.activeReleaseId).toBe("rel-a");
    env.cleanup();

    // Failure path: a broken FTS index fails the release smoke; the old
    // release remains ACTIVE and the broken release is marked FAILED.
    const env2 = createDb();
    await seedReadyRelease(env2, "rel-a", "w-a");
    const releases2 = new ReleaseRepository(env2.db);
    await releases2.setActive("rel-a", NOW_MS);

    const fixture2 = await makeReleaseFixture();
    const staged2 = await stageBundle({
      db: env2.db,
      r2: new FakeR2(),
      bundleDir: (await packageBundle(fixture2)).bundleDir,
      audioRoot: fixture2.workDir,
      now: NOW_MS,
    });
    env2.sqlite.prepare("DELETE FROM content_search_fts WHERE release_id = ?").run(staged2.releaseId);

    await expect(smokeRelease({ db: env2.db, r2: new FakeR2(), releaseId: staged2.releaseId })).rejects.toMatchObject({
      code: "SMOKE_FAILED",
    });
    expect((await releases2.getById(staged2.releaseId))?.status).toBe("FAILED");
    expect((await releases2.getMeta())?.activeReleaseId).toBe("rel-a");
    env2.cleanup();
  });

  it("activates only READY releases and switches the pointer atomically", async () => {
    const env = createDb();
    await seedReadyRelease(env, "rel-a", "w-a");
    const releases = new ReleaseRepository(env.db);
    await releases.setActive("rel-a", NOW_MS);

    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);
    const r2 = new FakeR2();
    const staged = await stageBundle({ db: env.db, r2, bundleDir, audioRoot: fixture.workDir, now: NOW_MS });

    // Only READY may activate: the freshly staged release is still IMPORTING.
    await expect(activateRelease({ db: env.db, releaseId: staged.releaseId, now: NOW_MS })).rejects.toMatchObject({
      code: "RELEASE_NOT_READY",
    });
    expect((await releases.getMeta())?.activeReleaseId).toBe("rel-a");

    await smokeRelease({ db: env.db, r2, releaseId: staged.releaseId });

    const before = await snapshotUserState(env);
    const activated = await activateRelease({ db: env.db, releaseId: staged.releaseId, now: NOW_MS });
    expect(activated.previousReleaseId).toBe("rel-a");
    expect((await releases.getById(staged.releaseId))?.status).toBe("ACTIVE");
    expect((await releases.getById("rel-a"))?.status).toBe("RETIRED");
    expect((await releases.getMeta())?.activeReleaseId).toBe(staged.releaseId);
    // User state and review logs are byte-identical across activation.
    expect(await snapshotUserState(env)).toBe(before);
    env.cleanup();
  });

  it("rolls back to the retired release and re-presents the older keys", async () => {
    const env = createDb();
    await seedReadyRelease(env, "rel-a", "w-a");
    const releases = new ReleaseRepository(env.db);
    await releases.setActive("rel-a", NOW_MS);

    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);
    const r2 = new FakeR2();
    const staged = await stageBundle({ db: env.db, r2, bundleDir, audioRoot: fixture.workDir, now: NOW_MS });
    await smokeRelease({ db: env.db, r2, releaseId: staged.releaseId });
    await activateRelease({ db: env.db, releaseId: staged.releaseId, now: NOW_MS });

    const before = await snapshotUserState(env);
    const rolled = await rollbackRelease({ db: env.db, releaseId: "rel-a", now: NOW_MS });
    expect(rolled.previousReleaseId).toBe(staged.releaseId);
    expect((await releases.getMeta())?.activeReleaseId).toBe("rel-a");
    expect((await releases.getById(staged.releaseId))?.status).toBe("RETIRED");
    expect(await snapshotUserState(env)).toBe(before);

    // Rollback again onto the ACTIVE release is refused (no pointer churn).
    await expect(rollbackRelease({ db: env.db, releaseId: "rel-a", now: NOW_MS })).rejects.toMatchObject({
      code: "RELEASE_NOT_RETIRED",
    });
    env.cleanup();
  });

  it("publishes end to end through scripts/publish-release.ts (local rehearsal wiring)", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);
    const scriptPath = fileURLToPath(new URL("../../../../scripts/publish-release.ts", import.meta.url));
    const tsxBin = fileURLToPath(new URL("../../../../node_modules/.bin/tsx", import.meta.url));
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const dbFile = path.join(await makeTempDir("publish-db-"), "d1.sqlite");
    const r2Dir = await makeTempDir("publish-r2-");

    const { stdout } = await run(
      tsxBin,
      [scriptPath, "--bundle", bundleDir, "--db", dbFile, "--r2-dir", r2Dir, "--private-root", fixture.privateRoot],
      { cwd: repoRoot, timeout: 120_000 },
    );
    expect(stdout).toContain("verify OK");
    expect(stdout).toContain("stage OK");
    expect(stdout).toContain("smoke OK");
    expect(stdout).toContain("activate OK");

    // The rehearsed database mirrors the repository invariants.
    const sqlite = new Database(dbFile);
    const staged = (await new ReleaseRepository(createSqliteDatabase(sqlite)).getActive())!;
    expect(staged.status).toBe("ACTIVE");
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audio_asset WHERE validation = 'PASSED'").get())
      .toMatchObject({ n: fixture.audioRows.length });
    expect(sqlite.prepare("SELECT active_release_id FROM app_meta WHERE id = 1").get()).toEqual({
      active_release_id: staged.releaseId,
    });
    sqlite.close();
  });

  it("imports validated alias edges with activation and keeps user state immutable", async () => {
    const env = createDb();
    await seedReadyRelease(env, "rel-a", "w-legacy");
    const releases = new ReleaseRepository(env.db);
    await releases.setActive("rel-a", NOW_MS);

    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);
    const r2 = new FakeR2();
    const staged = await stageBundle({ db: env.db, r2, bundleDir, audioRoot: fixture.workDir, now: NOW_MS });
    await smokeRelease({ db: env.db, r2, releaseId: staged.releaseId });

    // State under the new key (not the canonical root) would collapse into the
    // old root: rejected before anything is written.
    env.sqlite
      .prepare("INSERT INTO app_user (user_id, normalized_username, password_salt, password_verifier, created_at) VALUES ('u1', 'u1', 's', 'v', ?)")
      .run(NOW_MS);
    env.sqlite
      .prepare("INSERT INTO word_progress (user_id, word_key, stage, first_seen_at, last_seen_at) VALUES ('u1', 'u01-abandon', 'IN_PROGRESS', ?, ?)")
      .run(NOW_MS, NOW_MS);
    const aliases = [
      {
        entity_type: "word",
        from_release_id: staged.releaseId,
        from_key: "u01-abandon",
        to_release_id: "rel-a",
        to_key: "w-legacy",
        canonical_key: "w-legacy",
      },
    ];
    await expect(
      activateRelease({ db: env.db, releaseId: staged.releaseId, aliases, now: NOW_MS }),
    ).rejects.toMatchObject({ code: "ALIAS_STATE_COLLISION" });
    expect((await releases.getMeta())?.activeReleaseId).toBe("rel-a");

    // Remove the conflicting state; activation imports the edge + switches.
    env.sqlite.prepare("DELETE FROM word_progress WHERE user_id = 'u1' AND word_key = 'u01-abandon'").run();
    const before = await snapshotUserState(env);
    const activated = await activateRelease({ db: env.db, releaseId: staged.releaseId, aliases, now: NOW_MS });
    expect(activated.aliasesImported).toBe(1);
    expect((await releases.getMeta())?.activeReleaseId).toBe(staged.releaseId);
    expect(await snapshotUserState(env)).toBe(before);

    // Bidirectional, version-aware canonical resolution.
    const aliasesRepo = new AliasRepository(env.db);
    await expect(aliasesRepo.resolve({ releaseId: "rel-a", key: "w-legacy" })).resolves.toBe("w-legacy");
    await expect(aliasesRepo.resolve({ releaseId: staged.releaseId, key: "u01-abandon" })).resolves.toBe("w-legacy");
    env.cleanup();
  });

  it("rejects cross-activation alias fan-out against stored edges before importing", async () => {
    const env = createDb();
    await seedReadyRelease(env, "rel-2", "k2");
    await seedReadyRelease(env, "rel-3", "k2");
    env.sqlite
      .prepare("INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) VALUES ('rel-3', 'k4', 'u1', 'k4', NULL, 'core', 2, '{}')")
      .run();
    env.sqlite
      .prepare("INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) VALUES ('rel-3', 'k3', 'u1', 'k3', NULL, 'core', 3, '{}')")
      .run();
    // Stored by an earlier activation: rel-2 already renames k2 -> k3.
    env.sqlite
      .prepare("INSERT INTO content_key_alias (release_id, from_key, to_key, edge_type, canonical_key, created_at) VALUES ('rel-2', 'k2', 'k3', 'RENAME', 'k3', ?)")
      .run(NOW_MS);
    const releases = new ReleaseRepository(env.db);

    // One-to-many across activations: k2 already migrates to k3.
    const fanOut = [
      { entity_type: "word", from_release_id: "rel-3", from_key: "k2", to_release_id: "rel-3", to_key: "k4", canonical_key: "k4" },
    ];
    await expect(activateRelease({ db: env.db, releaseId: "rel-3", aliases: fanOut, now: NOW_MS })).rejects.toMatchObject({
      code: "ALIAS_ONE_TO_MANY",
    });

    // Many-to-one across activations: k3 is already a migration target.
    const fanIn = [
      { entity_type: "word", from_release_id: "rel-3", from_key: "k4", to_release_id: "rel-3", to_key: "k3", canonical_key: "k3" },
    ];
    await expect(activateRelease({ db: env.db, releaseId: "rel-3", aliases: fanIn, now: NOW_MS })).rejects.toMatchObject({
      code: "ALIAS_MANY_TO_ONE",
    });

    // Both rejections leave the pointer, statuses, and stored aliases untouched.
    expect((await releases.getMeta())?.activeReleaseId ?? null).toBeNull();
    expect((await releases.getById("rel-3"))?.status).toBe("READY");
    expect(env.sqlite.prepare("SELECT COUNT(*) AS n FROM content_key_alias").get()).toMatchObject({ n: 1 });
    env.cleanup();
  });

  it("rolls the whole batch back when an alias row violates the schema", async () => {
    const env = createDb();
    await seedReadyRelease(env, "rel-a", "w-a");
    const releases = new ReleaseRepository(env.db);
    await releases.setActive("rel-a", NOW_MS);
    await seedReadyRelease(env, "rel-b", "w-b");

    await expect(
      releases.activateBatch({
        releaseId: "rel-b",
        activatedAt: NOW_MS,
        aliasRows: [{ releaseId: "missing-release", fromKey: "x", toKey: "y", canonicalKey: "y", createdAt: NOW_MS }],
      }),
    ).rejects.toThrow();
    // Atomic: pointer, statuses, and alias table are unchanged.
    expect((await releases.getMeta())?.activeReleaseId).toBe("rel-a");
    expect((await releases.getById("rel-b"))?.status).toBe("READY");
    expect(env.sqlite.prepare("SELECT COUNT(*) AS n FROM content_key_alias").get()).toMatchObject({ n: 0 });
    env.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Alias repository: chains, both directions, loud inconsistencies
// ---------------------------------------------------------------------------

describe("AliasRepository (D1)", () => {
  async function seedEdge(
    db: TestDb,
    edge: { releaseId: string; fromKey: string; toKey: string; canonicalKey: string },
  ): Promise<void> {
    // content_key_alias.release_id is a FK: seed the declaring release row.
    db.sqlite
      .prepare(
        "INSERT OR IGNORE INTO content_release (release_id, source_pdf_sha256, schema_version, prompt_version, model_config_json, status, created_at, manifest_sha256) VALUES (?, ?, 'schema-v1', 'prompt-v1', '{}', 'READY', ?, ?)",
      )
      .run(edge.releaseId, sha(`pdf-${edge.releaseId}`), NOW_MS, sha(`manifest-${edge.releaseId}`));
    db.sqlite
      .prepare(
        "INSERT INTO content_key_alias (release_id, from_key, to_key, edge_type, canonical_key, created_at) VALUES (?, ?, ?, 'RENAME', ?, ?)",
      )
      .run(edge.releaseId, edge.fromKey, edge.toKey, edge.canonicalKey, NOW_MS);
  }

  it("resolves multi-release chains to the single canonical root", async () => {
    const env = createDb();
    // rel-1 renames k1 -> k2; rel-2 renames k2 -> k3. Canonical root: k3.
    await seedEdge(env, { releaseId: "rel-1", fromKey: "k1", toKey: "k2", canonicalKey: "k3" });
    await seedEdge(env, { releaseId: "rel-2", fromKey: "k2", toKey: "k3", canonicalKey: "k3" });
    const repo = new AliasRepository(env.db);
    await expect(repo.resolve({ releaseId: "rel-1", key: "k1" })).resolves.toBe("k3");
    await expect(repo.resolve({ releaseId: "rel-2", key: "k2" })).resolves.toBe("k3");
    await expect(repo.resolve({ releaseId: "rel-2", key: "k3" })).resolves.toBe("k3");
    // Unknown keys resolve to themselves (identity).
    await expect(repo.resolve({ releaseId: "rel-1", key: "unrelated" })).resolves.toBe("unrelated");
    env.cleanup();
  });

  it("resolves in either direction of a migration", async () => {
    const env = createDb();
    // Forward: rel-1's old key maps to rel-2's new canonical key.
    await seedEdge(env, { releaseId: "rel-1", fromKey: "k-old", toKey: "k-new", canonicalKey: "k-new" });
    // Reverse: rel-2's key merges into rel-1's older canonical key.
    await seedEdge(env, { releaseId: "rel-2", fromKey: "e-new", toKey: "e-old", canonicalKey: "e-old" });
    const repo = new AliasRepository(env.db);
    await expect(repo.resolve({ releaseId: "rel-1", key: "k-old" })).resolves.toBe("k-new");
    await expect(repo.resolve({ releaseId: "rel-2", key: "e-new" })).resolves.toBe("e-old");
    env.cleanup();
  });

  it("fails loudly on cycles, ambiguous fan-out, and canonical disagreements", async () => {
    const env = createDb();
    await seedEdge(env, { releaseId: "rel-1", fromKey: "k1", toKey: "k2", canonicalKey: "k1" });
    await seedEdge(env, { releaseId: "rel-1", fromKey: "k2", toKey: "k1", canonicalKey: "k1" });
    const repo = new AliasRepository(env.db);
    await expect(repo.resolve({ releaseId: "rel-1", key: "k1" })).rejects.toThrow(/cycle/);

    // Ambiguous fan-out across releases.
    const env2 = createDb();
    await seedEdge(env2, { releaseId: "rel-1", fromKey: "k1", toKey: "k2", canonicalKey: "k2" });
    await seedEdge(env2, { releaseId: "rel-3", fromKey: "k1", toKey: "k3", canonicalKey: "k3" });
    await expect(new AliasRepository(env2.db).resolve({ releaseId: "rel-1", key: "k1" })).rejects.toThrow(/ambiguous/);

    // Stored canonical root disagrees with the walked sink.
    const env3 = createDb();
    await seedEdge(env3, { releaseId: "rel-1", fromKey: "k1", toKey: "k2", canonicalKey: "zzz" });
    await expect(new AliasRepository(env3.db).resolve({ releaseId: "rel-1", key: "k1" })).rejects.toThrow(/canonical/);
    env.cleanup();
    env2.cleanup();
    env3.cleanup();
  });

  it("detects user state that would collapse under a declared component", async () => {
    const env = createDb();
    await seedEdge(env, { releaseId: "rel-1", fromKey: "k1", toKey: "k2", canonicalKey: "k2" });
    env.sqlite
      .prepare("INSERT INTO app_user (user_id, normalized_username, password_salt, password_verifier, created_at) VALUES ('u1', 'u1', 's', 'v', ?)")
      .run(NOW_MS);
    env.sqlite
      .prepare("INSERT INTO card_state (user_id, content_card_key, fsrs_state, due, updated_at) VALUES ('u1', 'k1', '{\"version\":1}', 0, ?)")
      .run(NOW_MS);
    const repo = new AliasRepository(env.db);
    const graph = {
      edges: [],
      components: [{ keys: ["k1", "k2"], canonicalKey: "k2" }],
      canonicalByKey: new Map([["k1", "k2"], ["k2", "k2"]]),
    };
    const conflicts = await repo.findStateConflicts(graph);
    expect(conflicts).toEqual([
      { userId: "u1", table: "card_state", key: "k1", canonicalKey: "k2" },
    ]);
    env.cleanup();
  });
});

// ---------------------------------------------------------------------------
// CLI wiring: every `release` subcommand with injected fake D1/R2 deps
// ---------------------------------------------------------------------------


describe("cli: release", () => {
  interface CliHarness {
    out: string[];
    exitCode: number | undefined;
    cli: ReturnType<typeof buildCli>;
    deps: CliDeps;
  }

  function makeHarness(options: { release?: { db: LexiloopDatabase; r2: R2AudioStore }; ledger?: LedgerStore } = {}): CliHarness {
    const out: string[] = [];
    const state: { exitCode: number | undefined } = { exitCode: undefined };
    const workRoot = mkdtempSync(path.join(tmpdir(), "release-cli-"));
    tempDirs.push(workRoot);
    const deps: CliDeps = {
      workRoot,
      stages: [],
      createLedger: (sourceHash) =>
        options.ledger
          ? options.ledger
          : createFileLedger({ directory: path.join(workRoot, sourceHash, "ledger") }),
      logger: silentLogger,
      writeLine: (line) => out.push(line),
      exit: (code) => {
        state.exitCode = code;
      },
      ...(options.release ? { release: options.release } : {}),
    };
    return {
      out,
      get exitCode() {
        return state.exitCode;
      },
      cli: buildCli(deps),
      deps,
    };
  }

  it("packages, verifies, stages, smokes, activates, and rolls back end to end", async () => {
    const fixture = await makeReleaseFixture();
    const env = createDb();
    const r2 = new FakeR2();
    const harness = makeHarness({ release: { db: env.db, r2 }, ledger: fixture.ledger });

    // Pre-seed the previously-active release (the rollback target).
    await seedReadyRelease(env, "rel-a", "w-legacy");
    const releases = new ReleaseRepository(env.db);
    await releases.setActive("rel-a", NOW_MS);
    const aliasFile = path.join(tmpdir(), `aliases-${process.pid}.json`);
    await writeFile(
      aliasFile,
      JSON.stringify({
        version: 1,
        edges: [
          {
            entity_type: "word",
            from_release_id: "BUNDLED",
            from_key: "u01-abandon",
            to_release_id: "rel-a",
            to_key: "w-legacy",
            canonical_key: "w-legacy",
          },
        ],
      }),
      "utf8",
    );

    const cli = harness.cli;
    await cli.parseAsync(
      ["release", "package", "--source-hash", SOURCE_HASH, "--private-root", fixture.privateRoot],
      { from: "user" },
    );
    expect(harness.out.join("\n")).toContain("release package OK");
    expect(await fixture.ledger.load("RELEASE_PACKAGE")).toMatchObject({ status: "PASSED" });
    const releaseId = (await readdir(path.join(fixture.privateRoot, "releases")))[0]!;
    const bundleDir = path.join(fixture.privateRoot, "releases", releaseId);

    // Rewrite the alias file with the real staged release id.
    const aliases = JSON.parse(await readFile(aliasFile, "utf8")) as { edges: Array<Record<string, string>> };
    aliases.edges[0]!.from_release_id = releaseId;
    await writeFile(aliasFile, JSON.stringify(aliases), "utf8");

    harness.out.length = 0;
    await cli.parseAsync(["release", "verify", "--bundle", bundleDir], { from: "user" });
    expect(harness.out.join("\n")).toContain("release verify OK");

    harness.out.length = 0;
    await cli.parseAsync(
      ["release", "stage", "--bundle", bundleDir, "--private-root", fixture.privateRoot],
      { from: "user" },
    );
    expect(harness.out.join("\n")).toContain("release stage OK");
    expect(harness.out.join("\n")).toContain("IMPORTING");
    expect((await releases.getMeta())?.activeReleaseId).toBe("rel-a");

    harness.out.length = 0;
    await cli.parseAsync(["release", "smoke", "--release", releaseId], { from: "user" });
    expect(harness.out.join("\n")).toContain("release smoke OK");
    expect(harness.out.join("\n")).toContain("READY");

    harness.out.length = 0;
    await cli.parseAsync(["release", "activate", "--release", releaseId, "--aliases", aliasFile], { from: "user" });
    expect(harness.out.join("\n")).toContain("release activate OK");
    expect((await releases.getMeta())?.activeReleaseId).toBe(releaseId);

    harness.out.length = 0;
    await cli.parseAsync(["release", "rollback", "--release", "rel-a"], { from: "user" });
    expect(harness.out.join("\n")).toContain("release rollback OK");
    expect((await releases.getMeta())?.activeReleaseId).toBe("rel-a");

    // Tamper with the staged bundle: verify reports it with exit code 1.
    const cardsSql = path.join(bundleDir, "d1", "002-cards.sql");
    await writeFile(cardsSql, `${await readFile(cardsSql, "utf8")}-- tampered\n`, "utf8");
    harness.out.length = 0;
    await cli.parseAsync(["release", "verify", "--bundle", bundleDir], { from: "user" });
    expect(harness.out.join("\n")).toContain("release verify failed");
    expect(harness.exitCode).toBe(1);

    env.cleanup();
  });

  it("release package refuses a work directory edited after it packaged (CLI path)", async () => {
    const fixture = await makeReleaseFixture();
    const harness = makeHarness({ ledger: fixture.ledger });
    const packageArgs = ["release", "package", "--source-hash", SOURCE_HASH, "--private-root", fixture.privateRoot];

    await harness.cli.parseAsync(packageArgs, { from: "user" });
    expect(harness.out.join("\n")).toContain("release package OK");
    expect(await readdir(path.join(fixture.privateRoot, "releases"))).toHaveLength(1);

    // Edit a packaged artifact after the PASSED gate: the CLI must refuse.
    const cardsFile = path.join(fixture.workDir, "cards.jsonl");
    await writeFile(
      cardsFile,
      (await readFile(cardsFile, "utf8")).replace('"template_version":"v1"', '"template_version":"v9"'),
      "utf8",
    );
    harness.out.length = 0;
    await harness.cli.parseAsync(packageArgs, { from: "user" });
    expect(harness.out.join("\n")).toContain("release package failed");
    expect(harness.out.join("\n")).toContain("RELEASE_INPUT_STALE");
    // No second bundle was written for the tampered content.
    expect(await readdir(path.join(fixture.privateRoot, "releases"))).toHaveLength(1);
  });

  it("fails closed when the D1/R2 dependencies are not configured", async () => {
    const fixture = await makeReleaseFixture();
    const { bundleDir } = await packageBundle(fixture);
    const harness = makeHarness();

    await harness.cli.parseAsync(
      ["release", "stage", "--bundle", bundleDir, "--private-root", fixture.privateRoot],
      { from: "user" },
    );
    expect(harness.out.join("\n")).toContain("release stage failed");
    expect(harness.out.join("\n")).toContain("D1");
    expect(harness.exitCode).toBe(1);

    await harness.cli.parseAsync(["release", "smoke", "--release", "rel-x"], { from: "user" });
    expect(harness.out.join("\n")).toContain("release smoke failed");
    expect(harness.exitCode).toBe(1);
  });
});
