/**
 * Content-addressed audio cache and private manifest (spec 5.8).
 *
 * Cache key: SHA-256 over provider + model + voice + normalized text +
 * synthesis config version, so ANY provider/model/voice/synthesis-parameter
 * change produces a new key and re-runs the audio gate. Object keys mirror
 * the R2 layout (`audio/<hash-prefix>/<hash>.wav`) inside the private,
 * git-ignored work directory; different releases can reuse identical objects.
 *
 * Every synthesized WAV carries its `text_hash` (the SHA-256 of the
 * normalized text) as standard RIFF LIST/INFO metadata (`ICMT`), which the
 * deterministic audio gate verifies against the content records — the only
 * metadata channel, no ASR and no audio read-back.
 *
 * Nothing here ever sees or stores the API key.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MediaOutputInvalidError, readJsonl } from "../media";
import { hashString } from "../stage";

const HEX64 = /^[0-9a-f]{64}$/;

/** Name of the audio directory inside the per-source work directory. */
export const AUDIO_DIR = "audio";
/** The manifest the TTS stage writes and the audio gate consumes. */
export const AUDIO_MANIFEST = `${AUDIO_DIR}/manifest.jsonl`;
/** The per-asset deterministic inspection report the audio gate writes. */
export const AUDIO_INSPECTION = `${AUDIO_DIR}/inspection.jsonl`;

/**
 * Deterministic cache key: sha256(provider, model, voice, normalized text,
 * synthesis config version). Exported for tests and the planner; a change to
 * ANY input component yields a fresh key.
 */
export function ttsCacheKey(input: {
  provider: string;
  model: string;
  voice: string;
  text: string;
  synthesisConfigVersion: string;
}): string {
  // JSON encoding keeps the concatenation unambiguous (quotes/newlines in
  // text are escaped, so no separator can be smuggled into a field).
  return hashString(
    JSON.stringify([
      input.provider,
      input.model,
      input.voice,
      input.text,
      input.synthesisConfigVersion,
    ]),
  );
}

/** Content-addressed R2 object key layout: `audio/<prefix2>/<hash>.wav`. */
export function audioObjectKey(cacheKey: string): string {
  if (!HEX64.test(cacheKey)) {
    throw new Error(`cache key must be sha-256 hex: ${JSON.stringify(cacheKey)}`);
  }
  return `${AUDIO_DIR}/${cacheKey.slice(0, 2)}/${cacheKey}.wav`;
}

// ---------------------------------------------------------------------------
// WAV LIST/INFO metadata: the text_hash travels inside the audio file itself
// ---------------------------------------------------------------------------

function findChunk(data: Buffer, start: number, end: number, id: string): { start: number; size: number } | null {
  let offset = start;
  while (offset + 8 <= end) {
    const chunkId = data.subarray(offset, offset + 4).toString("latin1");
    const size = data.readUInt32LE(offset + 4);
    if (chunkId === id) return { start: offset, size };
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Return the RIFF LIST/INFO `ICMT` comment of a WAV buffer, or null. Tolerant
 * of any chunk order; never throws on malformed input (callers treat null as
 * "metadata missing", which the audio gate rejects).
 */
export function readWavInfoComment(wav: Buffer): string | null {
  if (wav.length < 12) return null;
  if (wav.subarray(0, 4).toString("latin1") !== "RIFF") return null;
  if (wav.subarray(8, 12).toString("latin1") !== "WAVE") return null;
  const riffSize = Math.min(wav.readUInt32LE(4) + 8, wav.length);
  const list = findChunk(wav, 12, riffSize, "LIST");
  if (!list) return null;
  const listEnd = Math.min(list.start + 8 + list.size, riffSize);
  // LIST payload: form type ("INFO") then subchunks.
  const icmt = findChunk(wav, list.start + 12, listEnd, "ICMT");
  if (!icmt) return null;
  const payloadEnd = Math.min(icmt.start + 8 + icmt.size, listEnd);
  // ICMT strings are NUL-terminated; strip the terminator(s).
  let text = wav.subarray(icmt.start + 8, payloadEnd).toString("utf8");
  while (text.endsWith("\u0000")) {
    text = text.slice(0, -1);
  }
  return text;
}

/**
 * Return `wav` with the LIST/INFO `ICMT` comment set to `comment` (any prior
 * comment is replaced, not stacked). The original chunks are preserved
 * byte-for-byte, so the audio payload never changes.
 */
export function withWavInfoComment(wav: Buffer, comment: string): Buffer {
  if (wav.length < 12 || wav.subarray(0, 4).toString("latin1") !== "RIFF" || wav.subarray(8, 12).toString("latin1") !== "WAVE") {
    throw new Error("withWavInfoComment requires a RIFF/WAVE buffer");
  }
  const commentBytes = Buffer.concat([Buffer.from(comment, "utf8"), Buffer.from([0])]);
  const icmtPayloadPad = commentBytes.length % 2;
  const icmtChunk = Buffer.concat([
    Buffer.from("ICMT", "latin1"),
    (() => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(commentBytes.length, 0);
      return size;
    })(),
    commentBytes,
    Buffer.alloc(icmtPayloadPad),
  ]);
  const listPayload = Buffer.concat([Buffer.from("INFO", "latin1"), icmtChunk]);
  const listSize = Buffer.alloc(4);
  listSize.writeUInt32LE(listPayload.length, 0);
  const listChunk = Buffer.concat([Buffer.from("LIST", "latin1"), listSize, listPayload]);

  // Walk the original chunks, dropping any LIST chunk that carries an ICMT
  // subchunk (it would shadow the new comment).
  const riffSize = Math.min(wav.readUInt32LE(4) + 8, wav.length);
  const kept: Buffer[] = [];
  let offset = 12;
  while (offset + 8 <= riffSize) {
    const chunkId = wav.subarray(offset, offset + 4).toString("latin1");
    const size = wav.readUInt32LE(offset + 4);
    const chunkEnd = Math.min(offset + 8 + size, riffSize);
    const isShadowedInfo =
      chunkId === "LIST" &&
      chunkEnd - (offset + 12) >= 4 &&
      wav.subarray(offset + 8, offset + 12).toString("latin1") === "INFO" &&
      findChunk(wav, offset + 12, chunkEnd, "ICMT") !== null;
    if (!isShadowedInfo) {
      kept.push(wav.subarray(offset, chunkEnd));
      if (size % 2 === 1 && offset + 8 + size < riffSize) kept.push(Buffer.from([0]));
    }
    offset += 8 + size + (size % 2);
  }
  const body = Buffer.concat([Buffer.from("WAVE", "latin1"), listChunk, ...kept]);
  const header = Buffer.concat([
    Buffer.from("RIFF", "latin1"),
    (() => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(body.length, 0);
      return size;
    })(),
  ]);
  return Buffer.concat([header, body]);
}

// ---------------------------------------------------------------------------
// Private audio manifest (strict JSONL; mirrors the pydantic row in audio.py)
// ---------------------------------------------------------------------------

export const AudioManifestRowSchema = z.strictObject({
  /** sha256(provider, model, voice, normalized text, synthesis config). */
  cache_key: z.string().regex(HEX64),
  /** Content-addressed object key (`audio/<prefix2>/<hash>.wav`). */
  object_key: z.string().min(1),
  /** Path of the private WAV, relative to the per-source work directory. */
  wav_path: z.string().min(1),
  /** SHA-256 of the normalized text; verified against the WAV metadata. */
  text_sha256: z.string().regex(HEX64),
  text_chars: z.number().int().positive(),
  /** Lenient duration band computed from the text length. */
  min_seconds: z.number().nonnegative(),
  max_seconds: z.number().positive(),
  /** SHA-256 of the private WAV file (integrity of the cached asset). */
  sha256: z.string().regex(HEX64),
  bytes: z.number().int().positive(),
  provider: z.string().min(1),
  model: z.string().min(1),
  voice: z.string().min(1),
  synthesis_config_version: z.string().min(1),
});
export type AudioManifestRow = z.output<typeof AudioManifestRowSchema>;

/** Load the private audio manifest; a missing file means an empty cache. */
export async function loadAudioManifest(workDir: string): Promise<AudioManifestRow[]> {
  try {
    return await readJsonl(path.join(workDir, AUDIO_MANIFEST), AudioManifestRowSchema);
  } catch (err) {
    if (err instanceof MediaOutputInvalidError && err.message.includes("file not found")) {
      return [];
    }
    throw err;
  }
}

/**
 * Atomically rewrite the manifest with exactly `rows`, sorted by cache key so
 * the artifact (and its SHA-256, which downstream stages anchor on) is
 * deterministic for identical synthesis inputs. Returns the file hash.
 */
export async function writeAudioManifest(
  workDir: string,
  rows: readonly AudioManifestRow[],
): Promise<string> {
  const manifestPath = path.join(workDir, AUDIO_MANIFEST);
  await mkdir(path.dirname(manifestPath), { recursive: true });
  const sorted = [...rows].sort((a, b) => (a.cache_key < b.cache_key ? -1 : a.cache_key > b.cache_key ? 1 : 0));
  const body = sorted.map((row) => JSON.stringify(row)).join("\n") + (sorted.length > 0 ? "\n" : "");
  const tmp = path.join(
    path.dirname(manifestPath),
    `.${path.basename(manifestPath)}.tmp-${randomBytes(6).toString("hex")}`,
  );
  await writeFile(tmp, body, "utf8");
  await rename(tmp, manifestPath);
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Mirror of the Python worker's per-asset inspection row
 * (`audio/inspection.jsonl`). Measurements are informational; `ok` and the
 * text-hash echo are enforced by the audio gate.
 */
export const AudioInspectionRowSchema = z.object({
  cache_key: z.string().regex(HEX64),
  wav_path: z.string().min(1),
  ok: z.boolean(),
  error: z.string().min(1).optional(),
  message: z.string().optional(),
  text_sha256: z.string().regex(HEX64).optional(),
  container: z.string().optional(),
  codec: z.string().optional(),
  sample_rate: z.number().int().optional(),
  channels: z.number().int().optional(),
  duration_seconds: z.number().optional(),
  peak: z.number().optional(),
  clipping_ratio: z.number().optional(),
  head_silence_seconds: z.number().optional(),
  tail_silence_seconds: z.number().optional(),
  rms: z.number().optional(),
  size_bytes: z.number().int().optional(),
  sha256: z.string().regex(HEX64).optional(),
});
export type AudioInspectionRow = z.output<typeof AudioInspectionRowSchema>;
