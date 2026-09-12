/**
 * Remote-mode gate tests for scripts/verify-release.ts (review fix, Task 18).
 *
 * The wrangler invocation boundary is injected (RemoteRunner), exactly like
 * other process boundaries in this repo's tests. Proves the "no bypass"
 * contract for `--remote`:
 * - a broken remote D1 (missing table) FAILS the schema gate — the JSON
 *   output is actually parsed and judged;
 * - healthy output passes EVERY data gate with audio GENUINELY evaluated
 *   through the R2 seam (bytes hashed against content_sha256);
 * - corrupted remote audio bytes FAIL the audio gate;
 * - an unusable R2 seam is a NAMED SKIP counted as a FAILURE, never a
 *   silent pass;
 * - unknown CLI arguments still exit 2 (real process spawn).
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_TABLES,
  runRemoteDataGates,
  type RemoteRunner,
  type Row,
} from "../../scripts/verify-release";
import { sha256HexOf, syntheticWav } from "../../apps/worker/e2e-harness/wav";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface FakeD1Handlers {
  integrity?: string;
  tables?: string[];
  meta?: Row | null;
  foreignKeyViolations?: number;
  malformed?: number;
  totalKeys?: number;
  alias?: { ambiguous: number; cyclic: number; bad_sink: number };
  audioRows?: Row[];
  releases?: string[];
  capacity?: Record<string, { words: number; cards: number; audio: number; parity: Row; fts: Row }>;
}

/** Builds a runner whose D1 responses match the given (healthy or broken) state. */
function fakeD1(state: FakeD1Handlers): RemoteRunner["d1"] {
  return async (sql: string): Promise<Row[]> => {
    if (sql.startsWith("PRAGMA integrity_check")) {
      return [{ integrity_check: state.integrity ?? "ok" }];
    }
    if (sql.includes("sqlite_master")) {
      return (state.tables ?? []).map((name) => ({ name }));
    }
    if (sql.includes("FROM app_meta")) {
      return state.meta ? [state.meta] : [];
    }
    if (sql.startsWith("PRAGMA foreign_key_check")) {
      return Array.from({ length: state.foreignKeyViolations ?? 0 }, () => ({}));
    }
    if (sql.includes("AS malformed")) {
      return [{ malformed: state.malformed ?? 0, total: state.totalKeys ?? 0 }];
    }
    if (sql.includes("RECURSIVE chain")) {
      return [state.alias ?? { ambiguous: 0, cyclic: 0, bad_sink: 0 }];
    }
    if (sql.includes("FROM audio_asset")) {
      return state.audioRows ?? [];
    }
    if (sql.includes("FROM content_release")) {
      return (state.releases ?? []).map((release_id) => ({ release_id }));
    }
    if (sql.includes("report_words")) {
      const releaseId = /release_id = '([^']+)'/.exec(sql)?.[1] ?? "";
      const perRelease = state.capacity?.[releaseId];
      return perRelease ? [perRelease.parity] : [];
    }
    if (sql.includes("content_search_fts")) {
      const releaseId = /release_id = '([^']+)'/.exec(sql)?.[1] ?? "";
      const perRelease = state.capacity?.[releaseId];
      return perRelease ? [perRelease.fts] : [];
    }
    if (sql.includes("AS words")) {
      const releaseId = /release_id = '([^']+)'/.exec(sql)?.[1] ?? "";
      const perRelease = state.capacity?.[releaseId];
      return perRelease ? [{ words: perRelease.words, cards: perRelease.cards, audio: perRelease.audio }] : [];
    }
    throw new Error(`fake runner: unhandled SQL: ${sql.slice(0, 60)}`);
  };
}

const AUDIO_BYTES = [syntheticWav("anchor"), syntheticWav("tide")];

function healthyState(): FakeD1Handlers {
  return {
    integrity: "ok",
    tables: [...REQUIRED_TABLES],
    meta: { active_release_id: "rel-a", config_version: 1 },
    foreignKeyViolations: 0,
    malformed: 0,
    totalKeys: 82,
    alias: { ambiguous: 0, cyclic: 0, bad_sink: 0 },
    audioRows: [
      {
        asset_key: "audio/aa/anchor.wav",
        content_sha256: sha256HexOf(AUDIO_BYTES[0]!),
        validation: "PASSED",
        sample_rate_hz: 8000,
      },
      {
        asset_key: "audio/ti/tide.wav",
        content_sha256: sha256HexOf(AUDIO_BYTES[1]!),
        validation: "PASSED",
        sample_rate_hz: 8000,
      },
    ],
    releases: ["rel-a", "rel-b"],
    capacity: {
      "rel-a": {
        words: 7,
        cards: 14,
        audio: 2,
        parity: { report_words: 7, words: 7, report_cards: 14, cards: 14, report_examples: 1, examples: 1 },
        fts: { fts: 15, searchable: 15 },
      },
      "rel-b": {
        words: 8,
        cards: 16,
        audio: 2,
        parity: { report_words: 8, words: 8, report_cards: 16, cards: 16, report_examples: 1, examples: 1 },
        fts: { fts: 16, searchable: 16 },
      },
    },
  };
}

function healthyRunner(state: FakeD1Handlers, r2Get: RemoteRunner["r2Get"]): RemoteRunner {
  const d1 = fakeD1(state);
  return { d1, r2Get };
}

function failuresOf(results: Awaited<ReturnType<typeof runRemoteDataGates>>): string[] {
  return results.filter((result) => !result.verdict.passed).map((result) => result.gate);
}

describe("verify-release remote gates (injected wrangler boundary)", () => {
  it("FAILS the schema gate when the remote D1 is missing a required table", async () => {
    const state = healthyState();
    state.tables = state.tables!.filter((table) => table !== "word");
    const results = await runRemoteDataGates({ runner: healthyRunner(state, async () => AUDIO_BYTES[0]!) });
    expect(failuresOf(results)).toContain("schema");
    const schema = results.find((result) => result.gate === "schema")!;
    expect(schema.verdict.details.join(" ")).toContain("word");
  });

  it("passes every data gate on healthy output and GENUINELY evaluates audio via R2", async () => {
    const fetchedKeys: string[] = [];
    const results = await runRemoteDataGates({
      runner: healthyRunner(healthyState(), async (key) => {
        fetchedKeys.push(key);
        return key === "audio/aa/anchor.wav" ? AUDIO_BYTES[0]! : AUDIO_BYTES[1]!;
      }),
    });
    expect(failuresOf(results)).toEqual([]);
    expect(results.map((result) => result.gate)).toEqual(["schema", "fk", "key", "audio", "capacity"]);
    // The audio gate ran the real seam: every asset key was fetched and its
    // bytes judged against the row's content hash.
    expect(fetchedKeys).toEqual(["audio/aa/anchor.wav", "audio/ti/tide.wav"]);
  });

  it("FAILS the audio gate when remote bytes do not match the recorded hash", async () => {
    const results = await runRemoteDataGates({
      runner: healthyRunner(healthyState(), async () => syntheticWav("corrupted")),
    });
    const audio = results.find((result) => result.gate === "audio")!;
    expect(audio.verdict.passed).toBe(false);
    expect(audio.verdict.details.join(" ")).toContain("hashMismatch=2");
  });

  it("counts an unusable R2 seam as a NAMED SKIP failure, never a silent pass", async () => {
    const results = await runRemoteDataGates({
      runner: healthyRunner(healthyState(), async () => {
        throw new Error("no r2 bucket configured in wrangler.toml");
      }),
    });
    const audio = results.find((result) => result.gate === "audio")!;
    expect(audio.verdict.passed).toBe(false);
    expect(audio.verdict.details.join(" ")).toContain("SKIP");
    expect(failuresOf(results)).toContain("audio");
  });

  it("keeps unknown CLI arguments a hard exit 2 (real process spawn)", () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/verify-release.ts", "--definitely-not-a-flag"],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown argument");
  });
});
