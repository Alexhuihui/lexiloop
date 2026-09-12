/**
 * Deterministic synthetic WAV assets for the E2E fixture (plan Task 18).
 *
 * These are TINY, VALID, SYNTHETIC audio files — 100 ms of generated tone at
 * 8 kHz mono 16-bit — never real speech and never derived from any private
 * material. All arithmetic is integer-only so the bytes (and therefore the
 * content-addressed asset keys and SHA-256 values) are identical on every
 * machine and run.
 */
import { createHash } from "node:crypto";

const SAMPLE_RATE_HZ = 8000;
const SAMPLE_COUNT = 800; // 100 ms
const BYTES_PER_SAMPLE = 2;

/** One deterministic 16-bit sample (pure integer math, no platform drift). */
function sampleAt(index: number): number {
  const square = (index % 20) < 10 ? 6000 : -6000;
  const ripple = ((index * 131) % 997) - 498;
  const envelope = 1 - Math.floor((index * 60) / SAMPLE_COUNT); // integer decay
  const value = Math.trunc((square + ripple) * envelope);
  return Math.max(-32768, Math.min(32767, value));
}

/** Builds a valid mono 16-bit PCM WAV file (44-byte header + data chunk). */
export function syntheticWav(text: string): Uint8Array {
  // Mix the text into the phase so different words produce different bytes
  // (content-addressed keys stay distinct without real speech).
  const phase = text.length % 20;
  const data = Buffer.alloc(SAMPLE_COUNT * BYTES_PER_SAMPLE);
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const shifted = (index + phase * 13) % SAMPLE_COUNT;
    data.writeInt16LE(sampleAt(shifted), index * BYTES_PER_SAMPLE);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  header.writeUInt32LE(SAMPLE_RATE_HZ * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  return Uint8Array.from(Buffer.concat([header, data]));
}

export function sha256HexOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const SYNTHETIC_AUDIO = {
  sampleRateHz: SAMPLE_RATE_HZ,
  channels: 1,
  encoding: "pcm_s16le",
  durationMs: Math.round((SAMPLE_COUNT / SAMPLE_RATE_HZ) * 1000),
} as const;

/**
 * The content-addressed asset key for one synthetic word's audio — the same
 * derivation the harness seeder uses, exported so specs can address assets
 * without a database round trip.
 */
export function syntheticAudioAssetKey(text: string): string {
  const sha = sha256HexOf(syntheticWav(text));
  return `audio/${text.slice(0, 2)}/${sha.slice(0, 16)}.wav`;
}
