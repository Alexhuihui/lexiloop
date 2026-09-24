/**
 * Cached MiMo TTS compilation and deterministic audio validation (spec 5.8).
 *
 * The MiMo HTTP contract is mocked at the `fetchFn` boundary: the provider
 * must send the target text as an ASSISTANT-role message (the MiMo v2.5
 * contract forbids user-role target text), authenticate with a bearer token
 * that is redacted from every error/log surface, and retry only retryable
 * status codes. Cache keys must cover provider/model/voice/text/config
 * version so any synthesis-parameter change re-runs the audio gate.
 *
 * Python is never actually invoked in the fast unit tests: the spawn fn is
 * injected, and the inspection JSONL the real worker would produce is seeded
 * on disk. The real ffprobe/soundfile inspection lives in
 * python/tests/test_audio.py.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  Example,
  Sense,
  SourceSnapshot,
  Unit,
  Word,
} from "@lexiloop/content-schema";
import { buildCli, type CliDeps } from "../../src/cli";
import { createFileLedger, type LedgerStore } from "../../src/ledger";
import { collectEnvSecrets, createCompilerLogger, silentLogger } from "../../src/logging";
import type { UnitWorkload } from "../../src/agents/work-packets";
import { MediaSpawnError, createPythonRunner } from "../../src/media";
import {
  CardGenerateOutputSchema,
  createAudioValidateStage,
  createTtsSynthesizeStage,
  getProductionStages,
} from "../../src/stage-registry";
import { hashJson, StageError, type AnyStage, type StageRunContext } from "../../src/stage";
import {
  audioObjectKey,
  loadAudioManifest,
  readWavInfoComment,
  ttsCacheKey,
  withWavInfoComment,
  writeAudioManifest,
  type AudioManifestRow,
} from "../../src/tts/cache";
import {
  collectTtsItems,
  durationBoundsSeconds,
  normalizeTtsText,
  readTtsConfig,
  buildTtsPlan,
} from "../../src/tts/plan";
import { resolveTtsApiKey, TtsProviderError, type TtsFetchFn } from "../../src/tts/provider";
import { createMiMoTtsProvider } from "../../src/tts/mimo";

const sha = (label: string): string => createHash("sha256").update(label).digest("hex");

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

// ---------------------------------------------------------------------------
// Fixtures: one unit of strict source evidence (headwords + exam examples)
// ---------------------------------------------------------------------------

const SOURCE_HASH = "d4".repeat(32);
const PDF_HASH = sha("source.pdf");

function provenance(page: number, text: string) {
  return {
    source_pdf_sha256: PDF_HASH,
    page_number: page,
    bbox: [0.1, 0.2, 0.5, 0.6] as [number, number, number, number],
    page_image_sha256: sha(`page-${page}`),
    source_raw_ref_hash: sha(`raw-${page}`),
    source_normalized_text: text,
    ocr_confidence: 0.98,
    structure_confidence: 0.97,
  };
}

const EXAMPLE_TEXT = "He abandoned the plan without a second thought.";

/** Unit `unitKey` with headwords `words` and one exam example per word. */
function makeWorkload(unitKey: string, words: string[], exampleText = EXAMPLE_TEXT): UnitWorkload {
  const unit = Unit.parse({
    unit_key: unitKey,
    book_key: "llcy",
    level: 1,
    unit_order: unitKey === "u01" ? 1 : 2,
    title: `Unit ${unitKey}`,
    ...provenance(12, `Unit ${unitKey}`),
  });
  const wordRows = words.map((headword, index) =>
    Word.parse({
      word_key: `${unitKey}-${headword}`,
      unit_key: unitKey,
      headword,
      tier: "core",
      source_order: index + 1,
      ...provenance(12, headword),
    }),
  );
  const example = Example.parse({
    example_key: `${unitKey}-${words[0]}-ex1`,
    word_key: `${unitKey}-${words[0]}`,
    origin: "exam",
    source_ref: "2019 阅读 Text 2",
    text: exampleText,
    target_span: [4, 13],
    source_order: 1,
    ...provenance(12, exampleText),
  });
  const source = SourceSnapshot.parse({
    unit,
    words: wordRows,
    senses: [
      Sense.parse({
        sense_key: `${unitKey}-${words[0]}-s1`,
        word_key: `${unitKey}-${words[0]}`,
        pos: "vt",
        gloss: "放弃；抛弃",
        sense_order: 1,
        ...provenance(12, "放弃；抛弃"),
      }),
    ],
    phrases: [],
    examples: [example],
    relations: [],
  });
  return { unitKey, source };
}

/** Write the normalized.jsonl artifact STRUCTURE_NORMALIZE would produce. */
async function writeNormalizedArtifact(workDir: string, workloads: readonly UnitWorkload[]): Promise<void> {
  const rows: unknown[] = [];
  for (const { source } of workloads) {
    const { unit, words, senses, phrases, examples } = source;
    rows.push(
      { entity_type: "unit" as const, ...unit },
      ...words.map((word) => ({ entity_type: "word" as const, ...word })),
      ...senses.map((sense) => ({ entity_type: "sense" as const, ...sense })),
      ...phrases.map((phrase) => ({ entity_type: "phrase" as const, ...phrase })),
      ...examples.map((example) => ({ entity_type: "example" as const, ...example })),
    );
  }
  await writeFile(
    path.join(workDir, "normalized.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

/** Minimal valid RIFF/WAVE container (44-byte header + 4 PCM frames). */
function minimalWavBytes(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + 8, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(8, 40);
  return Buffer.concat([header, Buffer.alloc(8)]);
}

interface TtsConfigOverrides {
  synthesisConfigVersion?: string;
  voice?: string;
  model?: string;
}

/** Private copy of the versioned synthesis config so tests can revise it. */
async function copyTtsConfig(
  dir: string,
  overrides: TtsConfigOverrides = {},
  fileName = "mimo-v2.5.json",
): Promise<string> {
  const repoConfig = await readFile(
    fileURLToPath(new URL("../../config/tts/mimo-v2.5.json", import.meta.url)),
    "utf8",
  );
  const config = JSON.parse(repoConfig) as Record<string, unknown>;
  if (overrides.synthesisConfigVersion !== undefined) {
    config.synthesis_config_version = overrides.synthesisConfigVersion;
  }
  if (overrides.voice !== undefined) config.voice = overrides.voice;
  if (overrides.model !== undefined) config.model = overrides.model;
  const configPath = path.join(dir, fileName);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

// ---------------------------------------------------------------------------
// Seed: work dir + CARD_GENERATE provenance the TTS stages anchor on
// ---------------------------------------------------------------------------

const WORKLOADS: readonly UnitWorkload[] = [
  makeWorkload("u01", ["abandon", "ability"]),
];

interface SeededWorkDir {
  privateRoot: string;
  workDir: string;
  ledger: LedgerStore;
  cardsOutput: z.output<typeof CardGenerateOutputSchema>;
  cardsOutputHash: string;
}

async function seedWorkDir(prefix: string, workloads: readonly UnitWorkload[] = WORKLOADS): Promise<SeededWorkDir> {
  const privateRoot = await makeTempDir(prefix);
  const workDir = path.join(privateRoot, "work", SOURCE_HASH);
  await mkdir(workDir, { recursive: true });
  await writeNormalizedArtifact(workDir, workloads);
  const cardsBytes = `${JSON.stringify({ card: "fixture" })}\n`;
  await writeFile(path.join(workDir, "cards.jsonl"), cardsBytes, "utf8");
  const cardsOutput = CardGenerateOutputSchema.parse({
    source_sha256: SOURCE_HASH,
    cards_jsonl: "cards.jsonl",
    cards_jsonl_sha256: sha(cardsBytes),
    card_rules_version: "cards-v1",
    counts: {
      units: 1,
      words: workloads.reduce((acc, w) => acc + w.source.words.length, 0),
      cards: 2,
      by_type: { WORD_MEANING: 2, CONTEXT_MEANING: 0, PHRASE: 0, SENSE_DISCRIMINATION: 0 },
    },
    units: [{ unit_key: workloads[0]!.unitKey, words: workloads[0]!.source.words.length, cards: 2 }],
  });
  const cardsOutputHash = hashJson(cardsOutput);
  const ledger = createFileLedger({ directory: await makeTempDir(`${prefix}-ledger-`) });
  const now = new Date().toISOString();
  await ledger.save({
    stage: "CARD_GENERATE",
    status: "PASSED",
    compile_run_id: "seed",
    input_hash: sha("card-input"),
    config_version_hash: sha("card-config"),
    output_hash: cardsOutputHash,
    attempts: 1,
    started_at: now,
    finished_at: now,
    updated_at: now,
    error_code: null,
  });
  return { privateRoot, workDir, ledger, cardsOutput, cardsOutputHash };
}

function stageContext(
  seeded: SeededWorkDir,
  options: { upstreamStage?: string | null; upstreamHash?: string | null } = {},
): StageRunContext {
  const upstreamStage = options.upstreamStage === undefined ? "CARD_GENERATE" : options.upstreamStage;
  const upstreamHash =
    options.upstreamHash === undefined ? seeded.cardsOutputHash : options.upstreamHash;
  return {
    runId: "tts-test",
    sourceHash: SOURCE_HASH,
    config: {},
    ledger: seeded.ledger,
    logger: silentLogger,
    upstream:
      upstreamStage && upstreamHash ? { stage: upstreamStage, outputHash: upstreamHash } : null,
  };
}

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

interface FetchScript {
  calls: FetchCall[];
  fetchFn: TtsFetchFn;
}

/** Scripted fetch: one response per call; throws after the script runs dry. */
function fetchScript(
  responses: Array<{ ok: boolean; status: number; body?: unknown }>,
  audioBase64 = Buffer.from(minimalWavBytes()).toString("base64"),
): FetchScript {
  const calls: FetchCall[] = [];
  let index = 0;
  return {
    calls,
    fetchFn: async (url, init) => {
      calls.push({ url, init: { ...init, headers: { ...init.headers } } });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      if (!response) throw new Error("unexpected fetch call");
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.body,
      };
    },
    ...(audioBase64 ? {} : {}),
  };
}

const OK_AUDIO_BASE64 = Buffer.from(minimalWavBytes()).toString("base64");

const mimoBody = (audioBase64: string) => ({
  choices: [{ message: { audio: { data: audioBase64 } } }],
});

async function errOf(run: () => Promise<unknown>): Promise<StageError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof StageError) return err;
    throw err;
  }
  throw new Error("expected the stage to fail");
}

// ---------------------------------------------------------------------------
// MiMo provider contract
// ---------------------------------------------------------------------------

describe("MiMo TTS provider", () => {
  const providerOptions = {
    apiKey: "sk-mimo-test-key",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-tts",
    voice: "Mia",
    sleep: async () => {},
  };

  it("sends the target text as an assistant-role message with bearer auth", async () => {
    const script = fetchScript([{ ok: true, status: 200, body: mimoBody(OK_AUDIO_BASE64) }]);
    const provider = createMiMoTtsProvider({ ...providerOptions, fetchFn: script.fetchFn });
    const result = await provider.synthesize({ text: "abandon" });

    expect(script.calls).toHaveLength(1);
    const call = script.calls[0]!;
    expect(call.url).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.Authorization).toBe("Bearer sk-mimo-test-key");
    expect(call.init.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call.init.body) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      audio: { format: string; voice: string };
    };
    expect(body.model).toBe("mimo-v2.5-tts");
    // The MiMo contract requires the synthesis target text in the assistant
    // role; it must never be placed in a user message.
    expect(body.messages).toEqual([{ role: "assistant", content: "abandon" }]);
    expect(body.messages.every((message) => message.role !== "user")).toBe(true);
    expect(body.audio).toEqual({ format: "wav", voice: "Mia" });
    expect(result.audioBase64).toBe(OK_AUDIO_BASE64);
    expect(result.audioBase64).toBe(Buffer.from(result.audioBase64, "base64").toString("base64"));
  });

  it("redacts the auth header from errors and never logs the key", async () => {
    const lines: string[] = [];
    const logger = createCompilerLogger({ sink: (line) => lines.push(line) });
    const script = fetchScript([
      { ok: false, status: 500, body: { error: { message: "boom" } } },
      { ok: false, status: 500, body: { error: { message: "boom" } } },
      { ok: false, status: 500, body: { error: { message: "boom" } } },
      { ok: false, status: 500, body: { error: { message: "boom" } } },
    ]);
    const provider = createMiMoTtsProvider({
      ...providerOptions,
      fetchFn: script.fetchFn,
      maxRetries: 2,
      logger,
    });
    let thrown: unknown;
    try {
      await provider.synthesize({ text: "abandon" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TtsProviderError);
    // The error surfaces a header dump whose Authorization value is redacted.
    const details = JSON.stringify((thrown as TtsProviderError).details);
    expect(details).toContain("[REDACTED]");
    expect(details).not.toContain("sk-mimo-test-key");
    // And no log line ever carries the raw key either.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("sk-mimo-test-key");
  });

  it("retries only retryable status codes, bounded times", async () => {
    // 429 twice, then success: retried to success.
    const retryable = fetchScript([
      { ok: false, status: 429, body: {} },
      { ok: false, status: 503, body: {} },
      { ok: true, status: 200, body: mimoBody(OK_AUDIO_BASE64) },
    ]);
    const provider = createMiMoTtsProvider({
      ...providerOptions,
      fetchFn: retryable.fetchFn,
      maxRetries: 2,
    });
    await expect(provider.synthesize({ text: "abandon" })).resolves.toMatchObject({
      audioBase64: OK_AUDIO_BASE64,
    });
    expect(retryable.calls).toHaveLength(3);

    // 400 is not retryable: exactly one call, non-retryable error.
    const badRequest = fetchScript([{ ok: false, status: 400, body: {} }]);
    await expect(
      createMiMoTtsProvider({
        ...providerOptions,
        fetchFn: badRequest.fetchFn,
        maxRetries: 2,
      }).synthesize({ text: "abandon" }),
    ).rejects.toMatchObject({ code: "TTS_HTTP_400", retryable: false });
    expect(badRequest.calls).toHaveLength(1);

    // 429 forever: 1 initial + maxRetries attempts, then a retryable error.
    const always = fetchScript([
      { ok: false, status: 429, body: {} },
      { ok: false, status: 429, body: {} },
      { ok: false, status: 429, body: {} },
      { ok: false, status: 429, body: {} },
    ]);
    await expect(
      createMiMoTtsProvider({
        ...providerOptions,
        fetchFn: always.fetchFn,
        maxRetries: 2,
      }).synthesize({ text: "abandon" }),
    ).rejects.toMatchObject({ code: "TTS_HTTP_429", retryable: true });
    expect(always.calls).toHaveLength(3);
  });

  it("rejects a response without audio data as non-retryable", async () => {
    const script = fetchScript([{ ok: true, status: 200, body: { choices: [{ message: {} }] } }]);
    await expect(
      createMiMoTtsProvider({ ...providerOptions, fetchFn: script.fetchFn }).synthesize({
        text: "abandon",
      }),
    ).rejects.toMatchObject({ code: "TTS_RESPONSE_INVALID", retryable: false });
    expect(script.calls).toHaveLength(1);
  });
});

describe("TTS API key resolution", () => {
  it("supports MIMO_API_KEY and the legacy local mimo-key without logging either", async () => {
    expect(resolveTtsApiKey({})).toBeNull();
    expect(resolveTtsApiKey({ MIMO_API_KEY: "current-key-value" })).toBe("current-key-value");
    expect(resolveTtsApiKey({ "mimo-key": "legacy-key-value" })).toBe("legacy-key-value");
    expect(
      resolveTtsApiKey({ MIMO_API_KEY: "current-key-value", "mimo-key": "legacy-key-value" }),
    ).toBe("current-key-value");

    // Neither value may ever reach a log line: run a full failing synthesis
    // per key name against a capturing logger scrubbed with the same env.
    for (const [envName, keyValue] of [
      ["MIMO_API_KEY", "current-key-value"],
      ["mimo-key", "legacy-key-value"],
    ] as const) {
      const env = { [envName]: keyValue };
      const lines: string[] = [];
      const logger = createCompilerLogger({
        sink: (line) => lines.push(line),
        secrets: collectEnvSecrets(env),
      });
      const script = fetchScript([{ ok: false, status: 500, body: {} }]);
      const provider = createMiMoTtsProvider({
        apiKey: keyValue,
        baseUrl: "https://api.xiaomimimo.com/v1",
        model: "mimo-v2.5-tts",
        voice: "Mia",
        fetchFn: script.fetchFn,
        maxRetries: 1,
        logger,
        sleep: async () => {},
      });
      await expect(provider.synthesize({ text: "abandon" })).rejects.toThrow(TtsProviderError);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("\n")).not.toContain(keyValue);
    }
  });
});

// ---------------------------------------------------------------------------
// Cache keys, object layout, WAV metadata, manifest
// ---------------------------------------------------------------------------

describe("TTS cache", () => {
  const base = {
    provider: "mimo",
    model: "mimo-v2.5-tts",
    voice: "Mia",
    text: "abandon",
    synthesisConfigVersion: "mimo-v2.5-tts-1",
  };

  it("derives the cache key from provider, model, voice, text, and config version", () => {
    const key = ttsCacheKey(base);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(ttsCacheKey({ ...base })).toBe(key);
    expect(
      ttsCacheKey({ ...base, synthesisConfigVersion: "mimo-v2.5-tts-2" }),
    ).not.toBe(key);
    for (const field of ["provider", "model", "voice", "text"] as const) {
      expect(ttsCacheKey({ ...base, [field]: `${base[field]}!` })).not.toBe(key);
    }
  });

  it("lays out content-addressed R2 object keys", () => {
    const key = ttsCacheKey(base);
    expect(audioObjectKey(key)).toBe(`audio/${key.slice(0, 2)}/${key}.wav`);
  });

  it("embeds the text hash as WAV metadata and reads it back", () => {
    const wav = minimalWavBytes();
    expect(readWavInfoComment(wav)).toBeNull();
    const marked = withWavInfoComment(wav, "a".repeat(64));
    expect(readWavInfoComment(marked)).toBe("a".repeat(64));
    // Still a valid RIFF/WAVE container with the original chunks intact.
    expect(marked.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(marked.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(marked.includes(Buffer.from("fmt "))).toBe(true);
    expect(marked.includes(Buffer.from("data"))).toBe(true);
    // Re-marking replaces the previous comment instead of duplicating it.
    const remarked = withWavInfoComment(marked, "b".repeat(64));
    expect(readWavInfoComment(remarked)).toBe("b".repeat(64));
    expect(remarked.indexOf(Buffer.from("a".repeat(64)))).toBe(-1);
  });

  it("round-trips the audio manifest deterministically", async () => {
    const seeded = await seedWorkDir("tts-manifest-");
    const key = ttsCacheKey(base);
    const row: AudioManifestRow = {
      cache_key: key,
      object_key: audioObjectKey(key),
      wav_path: audioObjectKey(key),
      text_sha256: sha("abandon"),
      text_chars: 7,
      min_seconds: 0.35,
      max_seconds: 10.5,
      sha256: sha("wav-bytes"),
      bytes: 52,
      provider: "mimo",
      model: "mimo-v2.5-tts",
      voice: "Mia",
      synthesis_config_version: "mimo-v2.5-tts-1",
    };
    const sha256 = await writeAudioManifest(seeded.workDir, [row]);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    const loaded = await loadAudioManifest(seeded.workDir);
    expect(loaded).toEqual([row]);
    // Sorted by cache key: writing the same rows in another order is stable.
    const again = await writeAudioManifest(seeded.workDir, [{ ...row }, { ...row, cache_key: "0".repeat(64) }]);
    const reloaded = await loadAudioManifest(seeded.workDir);
    expect(reloaded.map((entry) => entry.cache_key)).toEqual([
      "0".repeat(64),
      row.cache_key,
    ]);
    expect(again).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Planning: coverage, normalization, dedup, bounds
// ---------------------------------------------------------------------------

describe("tts plan", () => {
  it("covers every headword and every example sentence", () => {
    const items = collectTtsItems(WORKLOADS);
    expect(items.map((item) => [item.kind, item.entityKey])).toEqual([
      ["word", "u01-abandon"],
      ["word", "u01-ability"],
      ["example", "u01-abandon-ex1"],
    ]);
  });

  it("normalizes text without changing the English wording", () => {
    expect(normalizeTtsText("  He  abandoned\tthe plan.  ")).toBe("He abandoned the plan.");
    expect(normalizeTtsText("abandon")).toBe("abandon");
    expect(normalizeTtsText("café\r\nover\u00A0there")).toBe("café over there");
  });

  it("reuses duplicate text across items (one request per unique text)", () => {
    const workloads = [
      makeWorkload("u01", ["abandon", "ability"]),
      makeWorkload("u02", ["abandon"]),
    ];
    const items = collectTtsItems(workloads);
    expect(items).toHaveLength(5); // 3 headwords + 2 examples
    const config = {
      synthesis_config_version: "mimo-v2.5-tts-1",
      provider: "mimo",
      model: "mimo-v2.5-tts",
      voice: "Mia",
      audio_format: "wav",
      base_url: "https://api.xiaomimimo.com/v1",
      timeout_ms: 1000,
      max_retries: 2,
      retryable_status_codes: [429],
      duration_bounds: { seconds_per_char_min: 0.05, seconds_per_char_max: 1.5, floor_seconds: 0.3, ceiling_seconds: 180 },
      audio_gate: {
        container: "wav",
        codec: "pcm_s16le",
        sample_rate_hz: 24000,
        channels: 1,
        silence: { window_seconds: 0.02, rms_threshold: 0.005, max_head_seconds: 2, max_tail_seconds: 2 },
        levels: { min_peak: 0.01, max_clipping_ratio: 0.001 },
      },
    } as const;
    const plan = buildTtsPlan({ items, config: config as never });
    // abandon appears twice and both example sentences share their text.
    expect(plan.requestCount).toBe(3);
    const shared = plan.entries.find((entry) => entry.text === "abandon");
    expect(shared?.items).toHaveLength(2);
    expect(plan.characters).toBe(
      plan.entries.reduce((acc, entry) => acc + entry.textChars, 0),
    );
    expect(plan.cacheHits).toBe(0);
    expect(plan.cacheMisses).toBe(3);
  });

  it("reports cache hits/misses and estimated bytes before any call", () => {
    const items = collectTtsItems(WORKLOADS);
    const config = {
      synthesis_config_version: "mimo-v2.5-tts-1",
      provider: "mimo",
      model: "mimo-v2.5-tts",
      voice: "Mia",
      audio_format: "wav",
      base_url: "https://api.xiaomimimo.com/v1",
      timeout_ms: 1000,
      max_retries: 2,
      retryable_status_codes: [429],
      duration_bounds: { seconds_per_char_min: 0.05, seconds_per_char_max: 1.5, floor_seconds: 0.3, ceiling_seconds: 180 },
      audio_gate: {
        container: "wav",
        codec: "pcm_s16le",
        sample_rate_hz: 24000,
        channels: 1,
        silence: { window_seconds: 0.02, rms_threshold: 0.005, max_head_seconds: 2, max_tail_seconds: 2 },
        levels: { min_peak: 0.01, max_clipping_ratio: 0.001 },
      },
    } as const;
    const cold = buildTtsPlan({ items, config: config as never });
    expect(cold.cacheHits).toBe(0);
    expect(cold.cacheMisses).toBe(cold.requestCount);
    expect(cold.estimatedOutputBytes).toBeGreaterThan(0);

    const hitKey = cold.entries[0]!.cacheKey;
    const existing: AudioManifestRow[] = [
      {
        cache_key: hitKey,
        object_key: audioObjectKey(hitKey),
        wav_path: audioObjectKey(hitKey),
        text_sha256: cold.entries[0]!.textSha256,
        text_chars: cold.entries[0]!.textChars,
        min_seconds: cold.entries[0]!.minSeconds,
        max_seconds: cold.entries[0]!.maxSeconds,
        sha256: sha("cached"),
        bytes: 1234,
        provider: "mimo",
        model: "mimo-v2.5-tts",
        voice: "Mia",
        synthesis_config_version: "mimo-v2.5-tts-1",
      },
    ];
    const warm = buildTtsPlan({ items, config: config as never, existing });
    expect(warm.cacheHits).toBe(1);
    expect(warm.cacheMisses).toBe(cold.requestCount - 1);
    expect(warm.hitRate).toBeCloseTo(1 / cold.requestCount, 5);
  });

  it("computes a lenient duration band from the text length", () => {
    const bounds = {
      seconds_per_char_min: 0.05,
      seconds_per_char_max: 1.5,
      floor_seconds: 0.3,
      ceiling_seconds: 180,
    };
    expect(durationBoundsSeconds(12, bounds)).toEqual({ minSeconds: 0.6, maxSeconds: 18 });
    // One-character headword: the floor keeps the band non-degenerate.
    expect(durationBoundsSeconds(1, bounds).minSeconds).toBe(0.3);
    // A very long sentence is capped by the ceiling.
    expect(durationBoundsSeconds(1000, bounds).maxSeconds).toBe(180);
    expect(durationBoundsSeconds(1000, bounds).minSeconds).toBeGreaterThan(0);
  });

  it("reads the versioned synthesis config and fails closed on violations", async () => {
    const dir = await makeTempDir("tts-config-");
    const configPath = await copyTtsConfig(dir);
    const config = await readTtsConfig(configPath);
    expect(config.synthesis_config_version).toBe("mimo-v2.5-tts-1");
    expect(config.model).toBe("mimo-v2.5-tts");
    expect(config.provider).toBe("mimo");
    expect(config.audio_gate.sample_rate_hz).toBeGreaterThan(0);

    const broken = path.join(dir, "broken.json");
    await writeFile(broken, JSON.stringify({ ...config, model: 42 }), "utf8");
    await expect(readTtsConfig(broken)).rejects.toMatchObject({ code: "TTS_CONFIG_INVALID" });
    await expect(readTtsConfig(path.join(dir, "missing.json"))).rejects.toMatchObject({
      code: "TTS_CONFIG_INVALID",
    });
  });
});

// ---------------------------------------------------------------------------
// TTS_SYNTHESIZE stage
// ---------------------------------------------------------------------------

describe("TTS_SYNTHESIZE stage", () => {
  async function makeStage(seeded: SeededWorkDir, overrides: Record<string, unknown> = {}) {
    const configPath = await copyTtsConfig(seeded.privateRoot);
    const script = fetchScript([]);
    const stage = createTtsSynthesizeStage({
      privateRoot: seeded.privateRoot,
      ttsConfigPath: configPath,
      fetchFn: script.fetchFn,
      apiKey: "sk-stage-key",
      sleep: async () => {},
      ...(overrides as object),
    });
    return { stage, script, configPath };
  }

  function okScript(count: number): FetchScript {
    return fetchScript(
      Array.from({ length: count }, () => ({ ok: true, status: 200, body: mimoBody(OK_AUDIO_BASE64) })),
    );
  }

  it("requires a matching CARD_GENERATE output hash before synthesizing", async () => {
    const seeded = await seedWorkDir("tts-guard-");
    const { stage } = await makeStage(seeded);

    // No upstream context at all: fail closed.
    const missingUpstream = await errOf(() =>
      stage.run(undefined, stageContext(seeded, { upstreamStage: null })),
    );
    expect(missingUpstream.code).toBe("CARD_GENERATE_NOT_PASSED");
    expect(missingUpstream.blocked).toBe(false);
    // Upstream hash disagreeing with the CARD_GENERATE ledger entry: fail closed.
    const stale = await errOf(() =>
      stage.run(undefined, stageContext(seeded, { upstreamHash: sha("stale") })),
    );
    expect(stale.code).toBe("CARD_GENERATE_HASH_MISMATCH");
    // Ledger entry not PASSED: fail closed.
    await seeded.ledger.save({
      stage: "CARD_GENERATE",
      status: "FAILED",
      compile_run_id: "seed",
      input_hash: null,
      config_version_hash: null,
      output_hash: null,
      attempts: 1,
      started_at: null,
      finished_at: null,
      updated_at: new Date().toISOString(),
      error_code: "WORD_HAS_NO_CARDS",
    });
    const failedCards = await errOf(() => stage.run(undefined, stageContext(seeded)));
    expect(failedCards.code).toBe("CARD_GENERATE_NOT_PASSED");
  });

  it("synthesizes every unique text and writes private content-addressed assets", async () => {
    const seeded = await seedWorkDir("tts-run-");
    const script = okScript(3);
    const configPath = await copyTtsConfig(seeded.privateRoot);
    const stage = createTtsSynthesizeStage({
      privateRoot: seeded.privateRoot,
      ttsConfigPath: configPath,
      fetchFn: script.fetchFn,
      apiKey: "sk-stage-key",
      sleep: async () => {},
    });
    const output = stage.outputSchema.parse(
      await stage.run(undefined, stageContext(seeded)),
    ) as z.output<typeof stage.outputSchema> & {
      counts: { items: number; unique_texts: number; cache_hits: number; synthesized: number };
      characters: number;
      assets: Array<{ cache_key: string; object_key: string; sha256: string; bytes: number; text_sha256: string }>;
      audio_manifest_sha256: string;
      synthesis_config_version: string;
    };

    expect(output.counts).toEqual({ items: 3, unique_texts: 3, cache_hits: 0, synthesized: 3 });
    expect(output.synthesis_config_version).toBe("mimo-v2.5-tts-1");
    expect(output.assets).toHaveLength(3);
    for (const asset of output.assets) {
      expect(asset.object_key).toBe(`audio/${asset.cache_key.slice(0, 2)}/${asset.cache_key}.wav`);
      const wavPath = path.join(seeded.workDir, asset.object_key);
      const bytes = await readFile(wavPath);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
      // The audio file carries its text hash as WAV metadata (spec 5.8).
      expect(readWavInfoComment(bytes)).toBe(asset.text_sha256);
    }
    // Every request sent the assistant-role normalized text.
    const texts = script.calls.map((call) => {
      const body = JSON.parse(call.init.body) as { messages: Array<{ role: string; content: string }> };
      return body.messages.map((m) => [m.role, m.content] as const);
    });
    expect(texts.flat()).toContainEqual(["assistant", "abandon"]);
    expect(texts.flat()).toContainEqual(["assistant", "ability"]);
    expect(texts.flat()).toContainEqual(["assistant", EXAMPLE_TEXT]);
    // Manifest on disk covers exactly the synthesized assets, no key material.
    const manifest = await loadAudioManifest(seeded.workDir);
    expect(manifest.map((row) => row.cache_key).sort()).toEqual(
      output.assets.map((asset) => asset.cache_key).sort(),
    );
    expect(JSON.stringify(manifest)).not.toContain("sk-stage-key");
  });

  it("reuses cached assets byte-for-byte without a second network call", async () => {
    const seeded = await seedWorkDir("tts-cache-");
    const script = okScript(3);
    const configPath = await copyTtsConfig(seeded.privateRoot);
    const options = {
      privateRoot: seeded.privateRoot,
      ttsConfigPath: configPath,
      fetchFn: script.fetchFn,
      apiKey: "sk-stage-key",
      sleep: async () => {},
    };
    const stage = createTtsSynthesizeStage(options);
    const ctx = stageContext(seeded);
    const first = stage.outputSchema.parse(await stage.run(undefined, ctx)) as {
      audio_manifest_sha256: string;
      counts: { cache_hits: number };
    };
    expect(script.calls).toHaveLength(3);

    // A fetch that always throws: a warm cache must never touch the network.
    const offline = fetchScript([]);
    const rerun = createTtsSynthesizeStage({
      ...options,
      fetchFn: offline.fetchFn,
      apiKey: null,
    });
    const second = rerun.outputSchema.parse(await rerun.run(undefined, stageContext(seeded))) as {
      audio_manifest_sha256: string;
      counts: { cache_hits: number; synthesized: number };
    };
    expect(offline.calls).toHaveLength(0);
    expect(second.counts).toMatchObject({ cache_hits: 3, synthesized: 0 });
    expect(second.audio_manifest_sha256).toBe(first.audio_manifest_sha256);
  });

  it("re-synthesizes when a cached file was deleted", async () => {
    const seeded = await seedWorkDir("tts-invalidate-");
    const script = okScript(3);
    const configPath = await copyTtsConfig(seeded.privateRoot);
    const options = {
      privateRoot: seeded.privateRoot,
      ttsConfigPath: configPath,
      fetchFn: script.fetchFn,
      apiKey: "sk-stage-key",
      sleep: async () => {},
    };
    const stage = createTtsSynthesizeStage(options);
    await stage.run(undefined, stageContext(seeded));
    const manifest = await loadAudioManifest(seeded.workDir);
    const victim = manifest[0]!;
    await rm(path.join(seeded.workDir, victim.object_key));

    const warm = createTtsSynthesizeStage({
      ...options,
      fetchFn: okScript(1).fetchFn,
    });
    const output = warm.outputSchema.parse(await warm.run(undefined, stageContext(seeded))) as {
      counts: { cache_hits: number; synthesized: number };
    };
    expect(output.counts).toEqual({ items: 3, unique_texts: 3, cache_hits: 2, synthesized: 1 });
  });

  it("fails closed without an API key while synthesis is still owed", async () => {
    const seeded = await seedWorkDir("tts-nokey-");
    const { stage } = await makeStage(seeded, { apiKey: null });
    const err = await errOf(() => stage.run(undefined, stageContext(seeded)));
    expect(err.code).toBe("TTS_API_KEY_MISSING");
    expect(err.retryable).toBe(false);
    expect(await loadAudioManifest(seeded.workDir)).toEqual([]);
  });

  it("maps provider failures to retryable stage errors", async () => {
    const seeded = await seedWorkDir("tts-retry-");
    const configPath = await copyTtsConfig(seeded.privateRoot);
    const script = fetchScript([
      { ok: false, status: 429, body: {} },
      { ok: false, status: 429, body: {} },
      { ok: false, status: 429, body: {} },
    ]);
    const stage = createTtsSynthesizeStage({
      privateRoot: seeded.privateRoot,
      ttsConfigPath: configPath,
      fetchFn: script.fetchFn,
      apiKey: "sk-stage-key",
      maxRetries: 2,
      sleep: async () => {},
    });
    const err = await errOf(() => stage.run(undefined, stageContext(seeded)));
    expect(err.code).toBe("TTS_HTTP_429");
    expect(err.retryable).toBe(true);
    expect(script.calls).toHaveLength(3);
  });

  it("keys the input hash on the config, cards artifact, and limit", async () => {
    const seeded = await seedWorkDir("tts-hash-");
    const { stage, configPath } = await makeStage(seeded);
    const ctx = stageContext(seeded);
    const hashA = await stage.computeInputHash(ctx);

    // A voice change must produce a new cache key (spec 5.8) and re-run TTS.
    const otherVoice = await copyTtsConfig(seeded.privateRoot, { voice: "Dean" }, "dean.json");
    const renamed = createTtsSynthesizeStage({
      privateRoot: seeded.privateRoot,
      ttsConfigPath: otherVoice,
      fetchFn: okScript(3).fetchFn,
      apiKey: "sk-stage-key",
      sleep: async () => {},
    });
    expect(otherVoice).not.toBe(configPath);
    expect(await renamed.computeInputHash(ctx)).not.toBe(hashA);

    const limited = createTtsSynthesizeStage({
      privateRoot: seeded.privateRoot,
      ttsConfigPath: configPath,
      fetchFn: okScript(1).fetchFn,
      apiKey: "sk-stage-key",
      sleep: async () => {},
      limit: 1,
    });
    expect(await limited.computeInputHash(ctx)).not.toBe(hashA);
    const limitedOutput = limited.outputSchema.parse(
      await limited.run(undefined, ctx),
    ) as { counts: { unique_texts: number; synthesized: number } };
    expect(limitedOutput.counts).toMatchObject({ unique_texts: 1, synthesized: 1 });

    // Mutating the cards artifact invalidates the input hash as well.
    await writeFile(path.join(seeded.workDir, "cards.jsonl"), "changed\n", "utf8");
    expect(await stage.computeInputHash(ctx)).not.toBe(hashA);
  });
});

// ---------------------------------------------------------------------------
// AUDIO_VALIDATE stage
// ---------------------------------------------------------------------------

describe("AUDIO_VALIDATE stage", () => {
  type InspectionRow = {
    cache_key: string;
    wav_path: string;
    ok: boolean;
    error?: string;
    message?: string;
    text_sha256?: string;
    duration_seconds?: number;
  };

  interface ValidateFixture {
    seeded: SeededWorkDir;
    stage: AnyStage;
    spawnArgs: string[][];
    runPython: (args: readonly string[]) => Promise<{ stdout: string }>;
    inspection: InspectionRow[];
  }

  /** Seed a fully synthesized work dir; returns the validate stage + spy. */
  async function makeValidated(options: { limit?: number } = {}): Promise<ValidateFixture> {
    const seeded = await seedWorkDir("tts-validate-");
    const configPath = await copyTtsConfig(seeded.privateRoot);
    const synth = createTtsSynthesizeStage({
      privateRoot: seeded.privateRoot,
      ttsConfigPath: configPath,
      fetchFn: fetchScript(
        Array.from({ length: 3 }, () => ({ ok: true, status: 200, body: mimoBody(OK_AUDIO_BASE64) })),
      ).fetchFn,
      apiKey: "sk-stage-key",
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      sleep: async () => {},
    });
    await synth.run(undefined, stageContext(seeded));
    const manifest = await loadAudioManifest(seeded.workDir);

    const spawnArgs: string[][] = [];
    const inspection: InspectionRow[] = manifest.map((row) => ({
      cache_key: row.cache_key,
      wav_path: row.wav_path,
      ok: true,
      text_sha256: row.text_sha256,
      duration_seconds: 1.5,
    }));
    const runPython = async (args: readonly string[]): Promise<{ stdout: string }> => {
      spawnArgs.push([...args]);
      await writeFile(
        path.join(seeded.workDir, "audio", "inspection.jsonl"),
        inspection.map((row) => JSON.stringify(row)).join("\n") + "\n",
        "utf8",
      );
      return { stdout: JSON.stringify({ ok: true, checked: inspection.length }) };
    };
    const stage = createAudioValidateStage({
      privateRoot: seeded.privateRoot,
      ttsConfigPath: configPath,
      runPython,
    });
    return { seeded, stage, spawnArgs, runPython, inspection };
  }

  async function primeTtsLedger(
    fixture: ValidateFixture,
    outputHash: string | null = null,
  ): Promise<void> {
    const now = new Date().toISOString();
    await fixture.seeded.ledger.save({
      stage: "TTS_SYNTHESIZE",
      status: "PASSED",
      compile_run_id: "seed-tts",
      input_hash: sha("tts-input"),
      config_version_hash: sha("tts-config"),
      output_hash: outputHash ?? sha("tts-output"),
      attempts: 1,
      started_at: now,
      finished_at: now,
      updated_at: now,
      error_code: null,
    });
  }

  function validateContext(
    fixture: ValidateFixture,
    upstreamStage: string | null = "TTS_SYNTHESIZE",
  ): StageRunContext {
    return stageContext(fixture.seeded, {
      upstreamStage,
      upstreamHash: upstreamStage ? sha("tts-output") : null,
    });
  }

  it("requires a matching CARD_GENERATE and TTS_SYNTHESIZE provenance", async () => {
    const fixture = await makeValidated();
    await primeTtsLedger(fixture);

    // CARD_GENERATE provenance removed: fail closed.
    await fixture.seeded.ledger.save({
      stage: "CARD_GENERATE",
      status: "FAILED",
      compile_run_id: "seed",
      input_hash: null,
      config_version_hash: null,
      output_hash: null,
      attempts: 1,
      started_at: null,
      finished_at: null,
      updated_at: new Date().toISOString(),
      error_code: "WORD_HAS_NO_CARDS",
    });
    const err = await errOf(() => fixture.stage.run(undefined, validateContext(fixture)));
    expect(err.code).toBe("CARD_GENERATE_NOT_PASSED");
  });

  it("fails closed without a matching TTS_SYNTHESIZE upstream", async () => {
    const fixture = await makeValidated();
    await primeTtsLedger(fixture);
    const missingUpstream = await errOf(() =>
      fixture.stage.run(undefined, validateContext(fixture, null)),
    );
    expect(missingUpstream.code).toBe("TTS_SYNTHESIZE_NOT_PASSED");

    const stale = await errOf(() =>
      fixture.stage.run(
        undefined,
        stageContext(fixture.seeded, {
          upstreamStage: "TTS_SYNTHESIZE",
          upstreamHash: sha("different"),
        }),
      ),
    );
    expect(stale.code).toBe("TTS_SYNTHESIZE_HASH_MISMATCH");
  });

  it("fails when a manifest-required asset is missing from disk", async () => {
    const fixture = await makeValidated();
    await primeTtsLedger(fixture);
    const manifest = await loadAudioManifest(fixture.seeded.workDir);
    await rm(path.join(fixture.seeded.workDir, manifest[0]!.object_key));
    const err = await errOf(() => fixture.stage.run(undefined, validateContext(fixture)));
    expect(err.code).toBe("AUDIO_ASSET_MISSING");
    expect(err.message).toContain(manifest[0]!.cache_key.slice(0, 12));
  });

  it("fails when the manifest does not cover every required text", async () => {
    const fixture = await makeValidated();
    await primeTtsLedger(fixture);
    // Drop one row from the manifest TTS wrote: coverage must fail closed.
    const manifest = await loadAudioManifest(fixture.seeded.workDir);
    await writeAudioManifest(fixture.seeded.workDir, manifest.slice(1));
    const err = await errOf(() => fixture.stage.run(undefined, validateContext(fixture)));
    expect(err.code).toBe("AUDIO_COVERAGE_INCOMPLETE");
  });

  it("passes the versioned policy to the Python worker and records the inspection", async () => {
    const fixture = await makeValidated();
    await primeTtsLedger(fixture);
    const output = fixture.stage.outputSchema.parse(
      await fixture.stage.run(undefined, validateContext(fixture)),
    ) as {
      audio_inspection: string;
      audio_inspection_sha256: string;
      counts: { checked: number; failed: number };
      synthesis_config_version: string;
    };
    expect(fixture.spawnArgs).toHaveLength(1);
    const args = fixture.spawnArgs[0]!;
    expect(args[0]).toBe("inspect");
    expect(args).toContain("--policy");
    expect(args).toContain("--manifest");
    expect(args).toContain("--out");
    expect(output).toMatchObject({
      audio_inspection: "audio/inspection.jsonl",
      counts: { checked: 3, failed: 0 },
      synthesis_config_version: "mimo-v2.5-tts-1",
    });
    expect(output.audio_inspection_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails closed when the Python audio gate rejects an asset", async () => {
    const fixture = await makeValidated();
    await primeTtsLedger(fixture);
    fixture.inspection[0]!.ok = false;
    fixture.inspection[0]!.error = "ALL_SILENT";
    const err = await errOf(() => fixture.stage.run(undefined, validateContext(fixture)));
    expect(err.code).toBe("AUDIO_GATE_FAILED");
    expect(err.message).toContain("ALL_SILENT");
    expect(err.retryable).toBe(false);
  });

  it("surfaces the Python worker's own machine-readable failure", async () => {
    const fixture = await makeValidated();
    await primeTtsLedger(fixture);
    const failing = async (): Promise<{ stdout: string }> => {
      throw new MediaSpawnError("AUDIO_INVALID", "1 asset(s) failed", 2, '{"error":"AUDIO_INVALID"}');
    };
    const stage = createAudioValidateStage({
      privateRoot: fixture.seeded.privateRoot,
      ttsConfigPath: await copyTtsConfig(fixture.seeded.privateRoot),
      runPython: failing,
    });
    const err = await errOf(() => stage.run(undefined, validateContext(fixture)));
    expect(err.code).toBe("AUDIO_INVALID");
  });
});

// ---------------------------------------------------------------------------
// Production registry wiring
// ---------------------------------------------------------------------------

describe("production registry wiring", () => {
  it("registers real TTS_SYNTHESIZE and AUDIO_VALIDATE handlers", () => {
    const stages = getProductionStages({ privateRoot: "/tmp/does-not-exist-tts" });
    const names = stages.map((stage) => stage.name);
    expect(names).toContain("TTS_SYNTHESIZE");
    expect(names).toContain("AUDIO_VALIDATE");
    for (const name of ["TTS_SYNTHESIZE", "AUDIO_VALIDATE"]) {
      const stage = stages.find((candidate) => candidate.name === name)!;
      // Real handlers no longer fail closed as unimplemented stages.
      expect(stage.configVersion).not.toBe("0-unimplemented");
      expect(stage.outputSchema).toBeDefined();
    }
    expect(stages.find((stage) => stage.name === "RELEASE_PACKAGE")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Cross-language integration: TS-injected WAV metadata + manifest must pass
// the REAL Python audio gate (ffprobe/soundfile). One 3-second PCM sine is
// inside every fixture text's duration band, so the mocked provider response
// yields genuinely gate-passing audio.
// ---------------------------------------------------------------------------

/** A real 24 kHz mono PCM-16 sine WAV (the contracted audio format). */
function sinePcm16Wav(seconds: number, freq = 440, amplitude = 0.4): Buffer {
  const rate = 24000;
  const samples = Math.floor(seconds * rate);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(amplitude * Math.sin((2 * Math.PI * freq * index) / rate) * 32767);
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe("audio gate integration (real Python worker)", () => {
  it(
    "passes TS-synthesized assets with injected text-hash metadata end-to-end",
    async () => {
      const seeded = await seedWorkDir("tts-integration-");
      const configPath = await copyTtsConfig(seeded.privateRoot);
      const realWav = sinePcm16Wav(3);
      const script = fetchScript(
        Array.from({ length: 3 }, () => ({
          ok: true,
          status: 200,
          body: mimoBody(Buffer.from(realWav).toString("base64")),
        })),
      );
      const synth = createTtsSynthesizeStage({
        privateRoot: seeded.privateRoot,
        ttsConfigPath: configPath,
        fetchFn: script.fetchFn,
        apiKey: "sk-stage-key",
        sleep: async () => {},
      });
      const synthOutput = synth.outputSchema.parse(await synth.run(undefined, stageContext(seeded)));
      const synthOutputHash = hashJson(synthOutput);
      const now = new Date().toISOString();
      await seeded.ledger.save({
        stage: "TTS_SYNTHESIZE",
        status: "PASSED",
        compile_run_id: "integration",
        input_hash: sha("tts-input"),
        config_version_hash: sha("tts-config"),
        output_hash: synthOutputHash,
        attempts: 1,
        started_at: now,
        finished_at: now,
        updated_at: now,
        error_code: null,
      });

      const validate = createAudioValidateStage({
        privateRoot: seeded.privateRoot,
        ttsConfigPath: configPath,
        runPython: createPythonRunner(),
      });
      const output = validate.outputSchema.parse(
        await validate.run(undefined, stageContext(seeded, {
          upstreamStage: "TTS_SYNTHESIZE",
          upstreamHash: synthOutputHash,
        })),
      );
      expect(output).toMatchObject({
        audio_inspection: "audio/inspection.jsonl",
        synthesis_config_version: "mimo-v2.5-tts-1",
        counts: { checked: 3, failed: 0 },
      });
    },
    240_000,
  );
});

// ---------------------------------------------------------------------------
// CLI wiring: tts plan | tts synthesize | tts validate
// ---------------------------------------------------------------------------

describe("cli: tts", () => {

  function makeDeps(
    workRoot: string,
    out: string[],
    extra: {
      fetchFn?: TtsFetchFn;
      runPython?: (args: readonly string[]) => Promise<{ stdout: string }>;
      apiKey?: string | null;
    } = {},
  ): CliDeps & { exitCode: number | undefined } {
    const state: { exitCode: number | undefined } = { exitCode: undefined };
    const deps: CliDeps = {
      workRoot,
      stages: getProductionStages({ privateRoot: path.join(workRoot, "private") }),
      createLedger: (sourceHash) =>
        createFileLedger({ directory: path.join(workRoot, sourceHash, "ledger") }),
      logger: silentLogger,
      writeLine: (line) => out.push(line),
      exit: (code) => {
        state.exitCode = code;
      },
      ...(extra.fetchFn ? { ttsFetchFn: extra.fetchFn } : {}),
      ...(extra.runPython ? { runPython: extra.runPython } : {}),
      ...(extra.apiKey !== undefined ? { ttsApiKey: extra.apiKey } : {}),
    };
    return Object.defineProperty(deps, "exitCode", {
      get: () => state.exitCode,
      enumerable: true,
    }) as CliDeps & { exitCode: number | undefined };
  }

  async function primeCliWorkDir(
    workRoot: string,
    workloads: readonly UnitWorkload[],
  ): Promise<{ workDir: string; cardsOutputHash: string }> {
    const workDir = path.join(workRoot, "private", "work", SOURCE_HASH);
    await mkdir(workDir, { recursive: true });
    await writeNormalizedArtifact(workDir, workloads);
    const cardsBytes = `${JSON.stringify({ card: "cli-fixture" })}\n`;
    await writeFile(path.join(workDir, "cards.jsonl"), cardsBytes, "utf8");
    const cardsOutput = CardGenerateOutputSchema.parse({
      source_sha256: SOURCE_HASH,
      cards_jsonl: "cards.jsonl",
      cards_jsonl_sha256: sha(cardsBytes),
      card_rules_version: "cards-v1",
      counts: {
        units: 1,
        words: 2,
        cards: 2,
        by_type: { WORD_MEANING: 2, CONTEXT_MEANING: 0, PHRASE: 0, SENSE_DISCRIMINATION: 0 },
      },
      units: [{ unit_key: "u01", words: 2, cards: 2 }],
    });
    const ledger = createFileLedger({ directory: path.join(workRoot, SOURCE_HASH, "ledger") });
    const now = new Date().toISOString();
    await ledger.save({
      stage: "CARD_GENERATE",
      status: "PASSED",
      compile_run_id: "cli-seed",
      input_hash: sha("card-input"),
      config_version_hash: sha("card-config"),
      output_hash: hashJson(cardsOutput),
      attempts: 1,
      started_at: now,
      finished_at: now,
      updated_at: now,
      error_code: null,
    });
    return { workDir, cardsOutputHash: hashJson(cardsOutput) };
  }

  it("plans without any network call or write", async () => {
    const workRoot = await makeTempDir("tts-cli-plan-");
    await primeCliWorkDir(workRoot, WORKLOADS);
    const out: string[] = [];
    const throwingFetch: TtsFetchFn = async () => {
      throw new Error("network must not be touched by plan");
    };
    const deps = makeDeps(workRoot, out, { fetchFn: throwingFetch });
    const cli = buildCli(deps);
    const privateRoot = path.join(workRoot, "private");
    await cli.parseAsync(["tts", "plan", "--source-hash", SOURCE_HASH, "--private-root", privateRoot], { from: "user" });
    const output = out.join("\n");
    expect(output).toContain("tts plan");
    expect(output).toContain("request_count=3");
    expect(output).toContain("cache_hits=0");
    expect(output).toContain("cache_misses=3");
    expect(output).toMatch(/estimated_output_bytes=\d+/);
    expect(deps.exitCode).toBeUndefined();
    expect(await loadAudioManifest(path.join(workRoot, "private", "work", SOURCE_HASH))).toEqual([]);
  });

  it("synthesizes only with --execute and records the ledger entry", async () => {
    const workRoot = await makeTempDir("tts-cli-synth-");
    await primeCliWorkDir(workRoot, WORKLOADS);
    const out: string[] = [];

    // Without --execute the command is INERT: no network, no files, no ledger.
    const inertFetch: TtsFetchFn = async () => {
      throw new Error("network must not be touched without --execute");
    };
    const inertDeps = makeDeps(workRoot, out, { fetchFn: inertFetch });
    const privateRoot = path.join(workRoot, "private");
    await buildCli(inertDeps).parseAsync(
      ["tts", "synthesize", "--source-hash", SOURCE_HASH, "--private-root", privateRoot],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("INERT");
    expect(inertDeps.exitCode).toBeUndefined();
    expect(await loadAudioManifest(path.join(workRoot, "private", "work", SOURCE_HASH))).toEqual([]);
    expect(await inertDeps.createLedger(SOURCE_HASH).load("TTS_SYNTHESIZE")).toBeNull();

    // With --execute it synthesizes and records a resume-consistent entry.
    out.length = 0;
    const script = fetchScript(
      Array.from({ length: 3 }, () => ({ ok: true, status: 200, body: mimoBody(OK_AUDIO_BASE64) })),
    );
    const deps = makeDeps(workRoot, out, { fetchFn: script.fetchFn, apiKey: "cli-test-key" });
    await buildCli(deps).parseAsync(
      ["tts", "synthesize", "--source-hash", SOURCE_HASH, "--execute", "--private-root", privateRoot],
      { from: "user" },
    );
    const output = out.join("\n");
    expect(output).toContain("tts synthesize OK");
    expect(deps.exitCode).toBeUndefined();
    const entry = await deps.createLedger(SOURCE_HASH).load("TTS_SYNTHESIZE");
    expect(entry).toMatchObject({ status: "PASSED" });
    expect(entry?.output_hash).toMatch(/^[0-9a-f]{64}$/);
    // Re-running with a warm cache is up-to-date and makes no network calls.
    out.length = 0;
    script.calls.length = 0;
    await buildCli(deps).parseAsync(
      ["tts", "synthesize", "--source-hash", SOURCE_HASH, "--execute", "--private-root", privateRoot],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("up-to-date");
    expect(script.calls).toHaveLength(0);
  });

  it("validates audio deterministically and records the AUDIO_VALIDATE entry", async () => {
    const workRoot = await makeTempDir("tts-cli-validate-");
    await primeCliWorkDir(workRoot, WORKLOADS);
    const out: string[] = [];

    // Synthesize first through the CLI.
    const script = fetchScript(
      Array.from({ length: 3 }, () => ({ ok: true, status: 200, body: mimoBody(OK_AUDIO_BASE64) })),
    );
    const deps = makeDeps(workRoot, out, { fetchFn: script.fetchFn, apiKey: "cli-test-key" });
    const privateRoot = path.join(workRoot, "private");
    await buildCli(deps).parseAsync(
      ["tts", "synthesize", "--source-hash", SOURCE_HASH, "--execute", "--private-root", privateRoot],
      { from: "user" },
    );

    // Validate with the real Python worker: the tiny fixture WAV cannot pass
    // the audio gate, so the command must fail closed with a stage code.
    out.length = 0;
    await buildCli(deps).parseAsync(["tts", "validate", "--source-hash", SOURCE_HASH, "--private-root", privateRoot], {
      from: "user",
    });
    expect(deps.exitCode).toBe(1);
    expect(out.join("\n")).toContain("tts validate failed");
    expect((await deps.createLedger(SOURCE_HASH).load("AUDIO_VALIDATE"))?.status ?? "PENDING").not.toBe(
      "PASSED",
    );

    // With a stubbed passing worker, validation records the PASSED entry.
    const manifest = await loadAudioManifest(path.join(workRoot, "private", "work", SOURCE_HASH));
    const stubbedRunPython = async (args: readonly string[]): Promise<{ stdout: string }> => {
      const manifestIndex = args.indexOf("--manifest");
      const outIndex = args.indexOf("--out");
      expect(manifestIndex).toBeGreaterThan(-1);
      expect(outIndex).toBeGreaterThan(-1);
      const rows = manifest.map((row) => ({
        cache_key: row.cache_key,
        wav_path: row.wav_path,
        ok: true,
        text_sha256: row.text_sha256,
        duration_seconds: 1.5,
      }));
      await writeFile(args[outIndex + 1]!, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
      return { stdout: JSON.stringify({ ok: true, checked: rows.length }) };
    };
    out.length = 0;
    const stubDeps = makeDeps(workRoot, out, { runPython: stubbedRunPython });
    await buildCli(stubDeps).parseAsync(["tts", "validate", "--source-hash", SOURCE_HASH, "--private-root", privateRoot], {
      from: "user",
    });
    expect(out.join("\n")).toContain("tts validate OK");
    expect(stubDeps.exitCode).toBeUndefined();
    const entry = await stubDeps.createLedger(SOURCE_HASH).load("AUDIO_VALIDATE");
    expect(entry).toMatchObject({ status: "PASSED" });
  });
});
