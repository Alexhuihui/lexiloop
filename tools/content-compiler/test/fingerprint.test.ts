/**
 * SOURCE_FINGERPRINT stage (spec 5.2): the first stage of every compile run.
 *
 * It computes the source PDF's SHA-256, reads the page count through the
 * versioned Python media bridge (`lexiloop_media fingerprint`, argument-array
 * spawn), and emits the ledger output later stages chain (output hash) and
 * `plan`/`run` surface (page-count expectation check). The stage fails closed
 * with a machine-readable code on every misuse: no source path wired, file
 * missing, run-context hash mismatch, or a worker that hashed other content.
 *
 * Fast tests inject the runner; one integration test runs the real
 * `uv`-spawned module against the synthetic scan fixture (which, like the
 * real book, has 2 pages) to prove the bridge contract end to end.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LLCY_2024_EXPECTED_PAGE_COUNT,
  SourceFingerprintOutputSchema,
  createImageExtractStage,
  createSourceFingerprintStage,
} from "../src/stage-registry";
import { fingerprintSpawnArgs, sha256File } from "../src/media";
import { createFileLedger, ledgerDirectory } from "../src/ledger";
import { silentLogger } from "../src/logging";
import { runPipeline } from "../src/pipeline";
import type { SpawnPythonFn } from "../src/media";
import type { AnyStage, StageRunContext } from "../src/stage";

const execFile = promisify(execFileCb);

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const SOURCE_HASH = "b6".repeat(32);

async function ctxFor(
  sourceHash: string,
  upstream: StageRunContext["upstream"] = null,
): Promise<StageRunContext> {
  const dir = await makeTempDir("lexiloop-fp-ctx-");
  return {
    runId: "fingerprint-test",
    sourceHash,
    config: {},
    ledger: createFileLedger({ directory: ledgerDirectory(dir, sourceHash) }),
    logger: silentLogger,
    upstream,
  };
}

/** Stub runner emitting a worker summary for the given content hash. */
function stubRunner(summary: { source_sha256: string; page_count: number }): SpawnPythonFn {
  return async (args) => {
    if (args[0] !== "fingerprint") {
      throw new Error(`unexpected worker invocation: ${args.join(" ")}`);
    }
    return { stdout: `${JSON.stringify({ algorithm: "sha256", ...summary })}\n` };
  };
}

describe("SOURCE_FINGERPRINT stage", () => {
  it("computes the source hash and page count through the real Python bridge", async () => {
    // Synthetic scan fixture (2 pages, like the real book's test double).
    const { stdout } = await execFile("uv", [
      "run",
      "python",
      "tests/fixtures/media/make_fixture.py",
    ]);
    const fixturePath = stdout.trim().split("\n")[0]!.trim();
    const stage = createSourceFingerprintStage({ sourcePath: fixturePath });
    const output = SourceFingerprintOutputSchema.parse(
      await stage.run(undefined, await ctxFor(await sha256File(fixturePath))),
    );
    expect(output.source_sha256).toBe(await sha256File(fixturePath));
    expect(output.page_count).toBe(2);
    expect(output.algorithm).toBe("sha256");
    expect(output.fingerprint_config_version).toBe("1");
  }, 120_000);

  it("emits a schema-valid ledger output for later stages to chain", async () => {
    const dir = await makeTempDir("lexiloop-fp-schema-");
    const pdfPath = path.join(dir, "source.pdf");
    await writeFile(pdfPath, "pdf bytes");
    const stage = createSourceFingerprintStage({
      sourcePath: pdfPath,
      runPython: stubRunner({ source_sha256: await sha256File(pdfPath), page_count: 440 }),
    });
    const pdfHash = await sha256File(pdfPath);
    const output = await stage.run(undefined, await ctxFor(pdfHash));
    expect(SourceFingerprintOutputSchema.parse(output)).toMatchObject({
      source_sha256: pdfHash,
      page_count: 440,
    });
  });

  it("fails closed with SOURCE_NOT_FOUND on a missing file (runner never invoked)", async () => {
    let spawned = false;
    const stage = createSourceFingerprintStage({
      sourcePath: path.join(await makeTempDir("lexiloop-fp-missing-"), "absent.pdf"),
      runPython: async () => {
        spawned = true;
        return { stdout: "" };
      },
    });
    await expect(stage.run(undefined, await ctxFor(SOURCE_HASH))).rejects.toMatchObject({
      code: "SOURCE_NOT_FOUND",
    });
    expect(spawned).toBe(false);
  });

  it("fails closed with FINGERPRINT_CONFIG_INVALID when no source path is wired", async () => {
    const stage = createSourceFingerprintStage({ runPython: async () => ({ stdout: "" }) });
    await expect(stage.run(undefined, await ctxFor(SOURCE_HASH))).rejects.toMatchObject({
      code: "FINGERPRINT_CONFIG_INVALID",
    });
  });

  it("fails closed with SOURCE_HASH_MISMATCH when the run context names other content", async () => {
    const dir = await makeTempDir("lexiloop-fp-ctx-");
    const pdfPath = path.join(dir, "source.pdf");
    await writeFile(pdfPath, "pdf bytes");
    const stage = createSourceFingerprintStage({
      sourcePath: pdfPath,
      runPython: stubRunner({ source_sha256: "a".repeat(64), page_count: 1 }),
    });
    await expect(stage.run(undefined, await ctxFor("c".repeat(32)))).rejects.toMatchObject({
      code: "SOURCE_HASH_MISMATCH",
    });
  });

  it("fails closed when the worker hashed different content than the stage", async () => {
    const dir = await makeTempDir("lexiloop-fp-worker-");
    const pdfPath = path.join(dir, "source.pdf");
    await writeFile(pdfPath, "pdf bytes");
    const stage = createSourceFingerprintStage({
      sourcePath: pdfPath,
      runPython: stubRunner({ source_sha256: "a".repeat(64), page_count: 3 }),
    });
    await expect(stage.run(undefined, await ctxFor(SOURCE_HASH))).rejects.toMatchObject({
      code: "SOURCE_HASH_MISMATCH",
    });
  });

  it("fails closed on a malformed worker summary", async () => {
    const dir = await makeTempDir("lexiloop-fp-badsummary-");
    const pdfPath = path.join(dir, "source.pdf");
    await writeFile(pdfPath, "pdf bytes");
    const stage = createSourceFingerprintStage({
      sourcePath: pdfPath,
      runPython: async () => ({ stdout: "not json\n" }),
    });
    await expect(stage.run(undefined, await ctxFor(await sha256File(pdfPath)))).rejects.toMatchObject(
      { code: "MEDIA_OUTPUT_INVALID" },
    );
  });

  it("binds its input hash to content identity, not the source path", async () => {
    const dir = await makeTempDir("lexiloop-fp-hash-");
    const pdfPath = path.join(dir, "源文件 with 空格 【版】.pdf");
    await writeFile(pdfPath, "pdf bytes");
    const byPath = createSourceFingerprintStage({
      sourcePath: pdfPath,
      runPython: stubRunner({ source_sha256: SOURCE_HASH, page_count: 440 }),
    });
    const byOtherPath = createSourceFingerprintStage({
      sourcePath: "/somewhere/else.pdf",
      runPython: stubRunner({ source_sha256: SOURCE_HASH, page_count: 440 }),
    });
    const ctx = await ctxFor(SOURCE_HASH);
    expect(await byPath.computeInputHash(ctx)).toBe(await byOtherPath.computeInputHash(ctx));
  });

  it("runs before IMAGE_EXTRACT in the pipeline and chains its output hash", async () => {
    const dir = await makeTempDir("lexiloop-fp-chain-");
    const pdfPath = path.join(dir, "source.pdf");
    await writeFile(pdfPath, "pdf bytes");
    let downstreamUpstream: StageRunContext["upstream"] = null;
    const downstream: AnyStage = {
      name: "IMAGE_EXTRACT",
      configVersion: "1",
      inputSchema: z.unknown(),
      outputSchema: z.object({ stage: z.string() }),
      computeInputHash: (ctx) => {
        downstreamUpstream = ctx.upstream;
        return "downstream";
      },
      async run() {
        return { stage: "IMAGE_EXTRACT" };
      },
    };
    const ledger = createFileLedger({ directory: ledgerDirectory(dir, SOURCE_HASH) });
    const pdfHash = await sha256File(pdfPath);
    const report = await runPipeline(
      [
        createSourceFingerprintStage({
          sourcePath: pdfPath,
          runPython: stubRunner({ source_sha256: pdfHash, page_count: 12 }),
        }),
        downstream,
      ],
      ledger,
      { sourceHash: pdfHash },
    );
    expect(report.status).toBe("COMPLETED");
    const entry = await ledger.load("SOURCE_FINGERPRINT");
    expect(entry).toMatchObject({ status: "PASSED", error_code: null });
    expect(downstreamUpstream).toEqual({
      stage: "SOURCE_FINGERPRINT",
      outputHash: entry!.output_hash,
    });
  });

  it("spawns the worker with an argument array carrying the resolved source path", async () => {
    expect(fingerprintSpawnArgs("/source dir/源.pdf")).toEqual([
      "fingerprint",
      "--source",
      path.resolve("/source dir/源.pdf"),
    ]);
  });

  it("declares the approved llcy-2024 source inventory page count", () => {
    expect(LLCY_2024_EXPECTED_PAGE_COUNT).toBe(440);
  });

  it("is wired as the first production stage with a real runner by default", async () => {
    const { getProductionStages } = await import("../src/stage-registry");
    const stages = getProductionStages();
    expect(stages[0]!.name).toBe("SOURCE_FINGERPRINT");
    // Without a wired source path the stage still fails closed at run time.
    await expect(stages[0]!.run(undefined, await ctxFor(SOURCE_HASH))).rejects.toMatchObject({
      code: "FINGERPRINT_CONFIG_INVALID",
    });
    // The media options resolver keeps providing a real argument-array runner.
    const { resolveMediaStageOptions } = await import("../src/stage-registry");
    expect(resolveMediaStageOptions().runPython).toBeTruthy();
    void createImageExtractStage; // imported to keep the registry module loaded
  });
});
