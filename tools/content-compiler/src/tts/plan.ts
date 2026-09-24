/**
 * TTS planning (spec 5.8): what would be synthesized, at what cost, BEFORE
 * any paid/network call.
 *
 * Coverage is fixed by the spec: every word headword and every example
 * sentence of every target unit. Text is normalized (whitespace collapsed,
 * Unicode NFC) WITHOUT changing the English wording, then deduplicated:
 * duplicate texts share one cache key and one provider call.
 *
 * The versioned synthesis config (`config/tts/mimo-v2.5.json`) is the single
 * source of truth for the provider/model/voice, the retry policy, the
 * duration band, and the deterministic audio-gate policy. Its
 * `synthesis_config_version` participates in the cache key, so any parameter
 * change re-synthesizes and re-validates.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { UnitWorkload } from "../agents/work-packets";
import { COMPILER_ROOT } from "../media";
import { StageError, hashString } from "../stage";
import { audioObjectKey, ttsCacheKey, type AudioManifestRow } from "./cache";

/** Default versioned MiMo synthesis config. */
export const DEFAULT_TTS_CONFIG_PATH = join(COMPILER_ROOT, "config", "tts", "mimo-v2.5.json");

export const TtsSynthesisConfigSchema = z.strictObject({
  /** Cache-key component; bump to invalidate every cached asset. */
  synthesis_config_version: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** Preset English voice (spec 5.8). */
  voice: z.string().min(1),
  audio_format: z.enum(["wav", "pcm16"]),
  /** OpenAI-compatible base URL; only the TTS endpoint is ever contacted. */
  base_url: z.string().url(),
  timeout_ms: z.number().int().positive(),
  max_retries: z.number().int().nonnegative(),
  retryable_status_codes: z.array(z.number().int()).min(1),
  duration_bounds: z.strictObject({
    seconds_per_char_min: z.number().positive(),
    seconds_per_char_max: z.number().positive(),
    floor_seconds: z.number().nonnegative(),
    ceiling_seconds: z.number().positive(),
  }),
  /** Deterministic audio-gate policy consumed by the Python worker. */
  audio_gate: z.strictObject({
    container: z.string().min(1),
    codec: z.string().min(1),
    sample_rate_hz: z.number().int().positive(),
    channels: z.number().int().positive(),
    silence: z.strictObject({
      window_seconds: z.number().positive(),
      rms_threshold: z.number().positive(),
      max_head_seconds: z.number().nonnegative(),
      max_tail_seconds: z.number().nonnegative(),
    }),
    levels: z.strictObject({
      min_peak: z.number().nonnegative(),
      max_clipping_ratio: z.number().nonnegative(),
    }),
  }),
  notes: z.string().optional(),
});
export type TtsSynthesisConfig = z.output<typeof TtsSynthesisConfigSchema>;

/**
 * Read + strictly validate the versioned synthesis config (fail closed with
 * TTS_CONFIG_INVALID; the file is versioned repo config, never user input).
 */
export async function readTtsConfig(filePath: string): Promise<TtsSynthesisConfig> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StageError("TTS_CONFIG_INVALID", `TTS config unreadable at ${filePath}: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StageError("TTS_CONFIG_INVALID", `TTS config at ${filePath} is not valid JSON`);
  }
  const config = TtsSynthesisConfigSchema.safeParse(parsed);
  if (!config.success) {
    throw new StageError(
      "TTS_CONFIG_INVALID",
      `TTS config at ${filePath} violates the contract: ${config.error.issues[0]?.message ?? config.error.message}`,
    );
  }
  return config.data;
}

/**
 * Normalize text for synthesis WITHOUT changing the English wording: NFC
 * normalization plus whitespace collapsing. Case, punctuation, and words are
 * preserved verbatim.
 */
export function normalizeTtsText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** One content record that needs audio (a headword or an example sentence). */
export interface TtsItem {
  kind: "word" | "example";
  /** word_key / example_key of the content record. */
  entityKey: string;
  unitKey: string;
  /** Already-normalized text. */
  text: string;
}

/**
 * Collect the audio coverage of a compile: every headword and every example
 * sentence across the target units, in deterministic (unit, source) order.
 */
export function collectTtsItems(workloads: readonly UnitWorkload[]): TtsItem[] {
  const items: TtsItem[] = [];
  for (const workload of workloads) {
    for (const word of workload.source.words) {
      const text = normalizeTtsText(word.headword);
      if (text.length > 0) items.push({ kind: "word", entityKey: word.word_key, unitKey: workload.unitKey, text });
    }
    for (const example of workload.source.examples) {
      const text = normalizeTtsText(example.text);
      if (text.length > 0) {
        items.push({ kind: "example", entityKey: example.example_key, unitKey: workload.unitKey, text });
      }
    }
  }
  return items;
}

export interface DurationBounds {
  seconds_per_char_min: number;
  seconds_per_char_max: number;
  floor_seconds: number;
  ceiling_seconds: number;
}

/**
 * Lenient duration band for one asset, computed from the text length: the
 * band is [max(floor, chars*per-char-min), min(ceiling, chars*per-char-max)]
 * and is widened so it never inverts. Speech rate varies wildly, hence the
 * generous per-character factors.
 */
export function durationBoundsSeconds(
  chars: number,
  bounds: DurationBounds,
): { minSeconds: number; maxSeconds: number } {
  const rawMin = chars * bounds.seconds_per_char_min;
  const rawMax = chars * bounds.seconds_per_char_max;
  const minSeconds = Math.min(Math.max(rawMin, bounds.floor_seconds), bounds.ceiling_seconds);
  const maxSeconds = Math.min(
    Math.max(Math.max(rawMax, minSeconds + 0.5), bounds.floor_seconds + 0.5),
    bounds.ceiling_seconds,
  );
  return {
    minSeconds: Math.round(minSeconds * 100) / 100,
    maxSeconds: Math.round(maxSeconds * 100) / 100,
  };
}

/** One deduplicated synthesis target: a unique normalized text. */
export interface TtsPlanEntry {
  text: string;
  textChars: number;
  /** sha256 of the normalized text (the WAV `text_hash` metadata). */
  textSha256: string;
  cacheKey: string;
  objectKey: string;
  /** True when a manifest entry already exists for this cache key. */
  cached: boolean;
  minSeconds: number;
  maxSeconds: number;
  /** Content records covered by this text (words and/or examples). */
  items: TtsItem[];
}

export interface TtsPlan {
  entries: TtsPlanEntry[];
  /** Characters across unique texts (what would be sent to the provider). */
  characters: number;
  /** Unique texts = provider calls on a cold cache. */
  requestCount: number;
  cacheHits: number;
  cacheMisses: number;
  hitRate: number;
  /** Estimated private output bytes (24 kHz mono PCM-16 ≈ 48 kB/s). */
  estimatedOutputBytes: number;
}

/** Build the plan from items + versioned config + existing manifest state. */
export function buildTtsPlan(options: {
  items: readonly TtsItem[];
  config: TtsSynthesisConfig;
  existing?: readonly AudioManifestRow[];
}): TtsPlan {
  const { config } = options;
  const byCacheKey = new Map<string, TtsPlanEntry>();
  for (const item of options.items) {
    const cacheKey = ttsCacheKey({
      provider: config.provider,
      model: config.model,
      voice: config.voice,
      text: item.text,
      synthesisConfigVersion: config.synthesis_config_version,
    });
    const existing = byCacheKey.get(cacheKey);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const bounds = durationBoundsSeconds(item.text.length, config.duration_bounds);
    byCacheKey.set(cacheKey, {
      text: item.text,
      textChars: item.text.length,
      textSha256: hashString(item.text),
      cacheKey,
      objectKey: audioObjectKey(cacheKey),
      cached: false,
      minSeconds: bounds.minSeconds,
      maxSeconds: bounds.maxSeconds,
      items: [item],
    });
  }
  const entries = [...byCacheKey.values()];
  const cachedKeys = new Set((options.existing ?? []).map((row) => row.cache_key));
  let cacheHits = 0;
  for (const entry of entries) {
    entry.cached = cachedKeys.has(entry.cacheKey);
    if (entry.cached) cacheHits += 1;
  }
  // Planning-time estimate only: midpoint speech rate over PCM-16 mono.
  const bytesPerSecond =
    config.audio_gate.sample_rate_hz * config.audio_gate.channels * 2;
  const midSecondsPerChar =
    (config.duration_bounds.seconds_per_char_min + config.duration_bounds.seconds_per_char_max) / 2;
  const estimatedOutputBytes = entries.reduce(
    (acc, entry) => acc + Math.ceil(entry.textChars * midSecondsPerChar * bytesPerSecond),
    0,
  );
  const characters = entries.reduce((acc, entry) => acc + entry.textChars, 0);
  return {
    entries,
    characters,
    requestCount: entries.length,
    cacheHits,
    cacheMisses: entries.length - cacheHits,
    hitRate: entries.length === 0 ? 0 : cacheHits / entries.length,
    estimatedOutputBytes,
  };
}
