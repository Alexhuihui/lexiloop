import { describe, expect, it } from "vitest";
import { runRemoteSample, type SampleRunner } from "../../scripts/remote-sample";
import { sha256HexOf, syntheticWav } from "../../apps/worker/e2e-harness/wav";

const bytes = syntheticWav("sample");

function fixture(corrupt = false): { runner: SampleRunner; queries: string[]; fetched: string[] } {
  const queries: string[] = [];
  const fetched: string[] = [];
  const runner: SampleRunner = {
    async d1(sql) {
      queries.push(sql);
      if (sql.includes("FROM app_meta")) return [{ active_release_id: "rel-a" }];
      if (sql.includes("FROM content_release")) return [{ status: "ACTIVE" }];
      if (sql.includes("FROM release_unit")) return [{ unit_key: "u01", status: "PASSED" }];
      if (sql.includes("FROM word")) return [{ word_key: "w.u01.0001.labor", unit_key: "u01", source_order: 1, headword: "labo(u)r" }];
      if (sql.includes("FROM card_definition")) return [{ content_card_key: "a".repeat(64) }];
      if (sql.includes("FROM audio_asset")) {
        const prefix = sql.split("asset_key >= 'audio/")[1]?.slice(0, 2);
        return [{ asset_key: `audio/${prefix}/sample.wav`, content_sha256: sha256HexOf(bytes), validation: "PASSED", sample_rate_hz: 8000 }];
      }
      throw new Error("unexpected D1 sample query");
    },
    async r2Get(key) {
      fetched.push(key);
      return corrupt ? syntheticWav("changed") : bytes;
    },
  };
  return { runner, queries, fetched };
}

describe("read-only remote sample", () => {
  it("limits indexed D1 reads and R2 readback to eight hash ranges", async () => {
    const fx = fixture();
    const result = await runRemoteSample("rel-a", fx.runner);
    expect(result.passed).toBe(true);
    expect(result.d1Queries).toBe(13);
    expect(result.r2Objects).toBe(8);
    expect(fx.fetched).toHaveLength(8);
    expect(fx.queries.every((sql) => !/COUNT\s*\(|PRAGMA/i.test(sql))).toBe(true);
    expect(fx.queries.filter((sql) => /FROM audio_asset/.test(sql)).every((sql) => /LIMIT 1/.test(sql))).toBe(true);
  });

  it("fails when a sampled remote audio object differs from its D1 hash", async () => {
    const fx = fixture(true);
    const result = await runRemoteSample("rel-a", fx.runner);
    expect(result.passed).toBe(false);
    expect(result.problems).toContain("sampled audio hashMismatch");
  });
});
