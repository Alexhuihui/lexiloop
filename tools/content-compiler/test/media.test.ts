/**
 * Media worker integration (spec 5.3): argument-array spawn of the versioned
 * Python module, Zod validation of its JSONL artifacts, and the fail-closed
 * guarantee that later stages never start when a media stage fails.
 *
 * Python is never actually invoked in the fast unit tests: the spawn fn is
 * injected, and the JSONL artifacts the real worker would produce are seeded
 * on disk. One integration test runs the real `uv`-spawned module to prove
 * CJK/space paths survive the argument-array round trip.
 */
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildCli, type CliDeps } from "../src/cli";
import {
  CleanRecordSchema,
  DEFAULT_RULE_PATH,
  MediaOutputInvalidError,
  MediaSpawnError,
  MediaStageConfigSchema,
  REPO_ROOT,
  WatermarkRuleSchema,
  cleanSpawnArgs,
  createPythonRunner,
  extractSpawnArgs,
  parseJsonl,
  readJsonl,
  sha256File,
  validateCleanArtifacts,
  validateExtractArtifacts,
  workDirectory,
} from "../src/media";
import { createFileLedger, ledgerDirectory } from "../src/ledger";
import { silentLogger } from "../src/logging";
import { runPipeline } from "../src/pipeline";
import {
  createImageExtractStage,
  createWatermarkCleanStage,
  resolveMediaStageOptions,
} from "../src/stage-registry";
import type { SpawnPythonFn } from "../src/media";
import type { AnyStage } from "../src/stage";
import { ocrSpawnArgs } from "../src/ocr-adapter";

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
/** A path with spaces and CJK punctuation, like the real source PDF. */
const AWKWARD_NAME = "源文件 with 空格 【版】.pdf";

function stubStage(name: string, calls: string[]): AnyStage {
  return {
    name,
    configVersion: "1",
    inputSchema: z.unknown(),
    outputSchema: z.object({ stage: z.string() }),
    computeInputHash: () => `stub-${name}`,
    async run() {
      calls.push(name);
      return { stage: name };
    },
  };
}

async function seedExtractArtifacts(
  workDir: string,
  pages: number[],
  sourceHash: string = SOURCE_HASH,
): Promise<void> {
  const rows: unknown[] = [];
  for (const page of pages) {
    const imageBytes = Buffer.from(`raster-${sourceHash}-${page}`);
    const imagePath = `pages/page-${String(page).padStart(4, "0")}.original.png`;
    await mkdir(path.dirname(path.join(workDir, imagePath)), { recursive: true });
    await writeFile(path.join(workDir, imagePath), imageBytes);
    rows.push({
      source_sha256: sourceHash,
      page,
      width_px: 1240 + page,
      height_px: 1754,
      method: "embedded",
      image_sha256: createHash("sha256").update(imageBytes).digest("hex"),
      image_path: imagePath,
      dpi: null,
      ext: "png",
    });
  }
  await writeFile(
    path.join(workDir, "pages.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

async function seedCleanArtifacts(
  workDir: string,
  pages: number[],
  sourceHash: string = SOURCE_HASH,
): Promise<void> {
  const rows: unknown[] = [];
  for (const page of pages) {
    const imageBytes = Buffer.from(`clean-${sourceHash}-${page}`);
    const cleanedPath = `pages-clean/page-${String(page).padStart(4, "0")}.cleaned.png`;
    await mkdir(path.dirname(path.join(workDir, cleanedPath)), { recursive: true });
    await writeFile(path.join(workDir, cleanedPath), imageBytes);
    rows.push({
      source_sha256: sourceHash,
      page,
      rule_version: 1,
      original_image_path: `pages/page-${String(page).padStart(4, "0")}.original.png`,
      original_image_sha256: "c".repeat(64),
      cleaned_image_path: cleanedPath,
      cleaned_image_sha256: createHash("sha256").update(imageBytes).digest("hex"),
      mask_bounds: [0.2, 0.03, 0.8, 0.085],
      region_names: ["top-banner"],
      changed_pixels: 42,
      changed_pixels_outside: 0,
      body_overlap_detected: false,
    });
  }
  await writeFile(
    path.join(workDir, "clean.jsonl"),
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8",
  );
}

function mediaStageConfig(sourcePath: string): Record<string, unknown> {
  return { media: { sourcePath, pages: [1, 2], dpi: 300 } };
}

// ---------------------------------------------------------------------------
// Schemas and helpers
// ---------------------------------------------------------------------------

describe("media schemas", () => {
  it("accepts the shipped versioned llcy-2024 rule", async () => {
    const raw = JSON.parse(await readFile(DEFAULT_RULE_PATH, "utf8"));
    const rule = WatermarkRuleSchema.parse(raw);
    expect(rule.rule_version).toBeGreaterThanOrEqual(1);
    expect(rule.book_key).toBe("llcy-2024");
    expect(rule.regions.length).toBeGreaterThanOrEqual(3);
    for (const region of rule.regions) {
      expect(region.name).toMatch(/^[a-z0-9-]+$/); // generic names, no book content
      expect(JSON.stringify(region)).not.toMatch(/[\u4e00-\u9fff]/); // no CJK text stored
    }
  });

  it("parses JSONL strictly and points at the offending line", () => {
    const rows = parseJsonl(
      "x.jsonl",
      '{"n": 1}\n\n   \n{"n": 2}\n',
      z.object({ n: z.number() }),
    );
    expect(rows).toEqual([{ n: 1 }, { n: 2 }]);

    expect(() => parseJsonl("x.jsonl", "{broken}\n", z.object({ n: z.number() }))).toThrow(
      MediaOutputInvalidError,
    );
    try {
      parseJsonl("x.jsonl", '{"n": 1}\n{"nope": true}\n', z.object({ n: z.number() }));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MediaOutputInvalidError);
      expect((err as MediaOutputInvalidError).message).toContain("line 2");
    }
  });

  it("rejects changed pixels outside the mask at the schema level", () => {
    const base = {
      source_sha256: SOURCE_HASH,
      page: 1,
      rule_version: 1,
      original_image_path: "pages/page-0001.original.png",
      original_image_sha256: "c".repeat(64),
      cleaned_image_path: "pages-clean/page-0001.cleaned.png",
      cleaned_image_sha256: "d".repeat(64),
      mask_bounds: [0, 0, 1, 1],
      region_names: ["top"],
      changed_pixels: 5,
      changed_pixels_outside: 0,
      body_overlap_detected: false,
    };
    expect(CleanRecordSchema.safeParse(base).success).toBe(true);
    // Any non-zero leak is a schema violation: the stage can never advance.
    expect(
      CleanRecordSchema.safeParse({ ...base, changed_pixels_outside: 3 }).success,
    ).toBe(false);
  });
});

describe("media bridge", () => {
  it("derives the per-source work directory under <private-root>/work", () => {
    expect(workDirectory(".lexiloop-private", SOURCE_HASH)).toBe(
      path.join(path.resolve(".lexiloop-private"), "work", SOURCE_HASH),
    );
    expect(() => workDirectory(".lexiloop-private", "../escape")).toThrow(/source hash/i);
  });

  it("passes CJK and space paths through the argument array to the real module", async () => {
    const dir = await makeTempDir("lexiloop-cjk-");
    const sourcePath = path.join(dir, AWKWARD_NAME);
    await writeFile(sourcePath, "not really a pdf");
    const runPython = createPythonRunner();
    await expect(runPython(["extract", "--source", sourcePath, "--pages", "1", "--out-dir", dir])).rejects.toMatchObject({
      name: "MediaSpawnError",
    });
  }, 120_000);

  it("reports worker timeouts with the configured duration", async () => {
    const runPython = createPythonRunner({ timeoutMs: 300 });
    await expect(runPython(["selftest-sleep", "--seconds", "5"])).rejects.toMatchObject({
      code: "MEDIA_TIMEOUT",
      message: expect.stringContaining("timed out after 300ms"),
    });
  }, 30_000);

  it("accepts a per-call timeout override that wins over the runner default", async () => {
    // Runner-level timeout (5s) is longer than the sleep; only the per-call
    // override (300ms) can fire — if it were ignored the probe would resolve.
    const runPython = createPythonRunner({ timeoutMs: 5_000 });
    await expect(
      runPython(["selftest-sleep", "--seconds", "2"], { timeoutMs: 300 }),
    ).rejects.toMatchObject({
      code: "MEDIA_TIMEOUT",
      message: expect.stringContaining("timed out after 300ms"),
    });
  }, 30_000);

  it("surfaces the worker's JSON error code from stderr instead of a generic code", async () => {
    const dir = await makeTempDir("lexiloop-stderr-json-");
    const runPython = createPythonRunner();
    await expect(runPython(cleanSpawnArgs(DEFAULT_RULE_PATH, dir))).rejects.toMatchObject({
      code: "PAGES_JSONL_NOT_FOUND",
      name: "MediaSpawnError",
    });
  }, 120_000);
});

describe("ocr spawn arguments", () => {
  const expectedBase = (workDir: string) => [
    "ocr",
    "--clean-jsonl", path.join(workDir, "clean.jsonl"),
    "--config", path.resolve("/cfg/ocr.json"),
    "--out-dir", workDir,
  ];

  it("appends --pages with the comma-joined chunk when a page filter is present", () => {
    expect(ocrSpawnArgs("/cfg/ocr.json", "/work/dir", [3, 1, 2])).toEqual([
      ...expectedBase("/work/dir"),
      "--pages", "3,1,2",
    ]);
  });

  it("omits --pages entirely without a filter (full-run contract unchanged)", () => {
    // An empty list must also omit the flag: `--pages ""` would disable the
    // filter on the worker side and silently trigger a FULL re-run.
    expect(ocrSpawnArgs("/cfg/ocr.json", "/work/dir")).toEqual(expectedBase("/work/dir"));
    expect(ocrSpawnArgs("/cfg/ocr.json", "/work/dir", [])).toEqual(expectedBase("/work/dir"));
  });
});

// ---------------------------------------------------------------------------
// Production wiring (spec 5.3): a media stage always has a real runner
// ---------------------------------------------------------------------------

describe("media stage wiring", () => {
  it("resolveMediaStageOptions always provides a python runner", () => {
    const defaults = resolveMediaStageOptions({});
    expect(typeof defaults.runPython).toBe("function");
    expect(defaults.privateRoot).toBe(".lexiloop-private");

    const injected = resolveMediaStageOptions({
      runPython: async () => ({ stdout: "" }),
      privateRoot: "/tmp/priv",
      rulePath: "/tmp/rule.json",
    });
    expect(injected.privateRoot).toBe("/tmp/priv");
    expect(injected.rulePath).toBe("/tmp/rule.json");
    // The injected stub wins over the default runner.
    expect(typeof injected.runPython).toBe("function");
  });

  it("spawns the module for the clean round-trip of a real fixture run", async () => {
    // Build the synthetic scan fixture (paths printed by the script).
    const { stdout } = await execFile(
      "uv",
      ["run", "python", "tests/fixtures/media/make_fixture.py"],
      { cwd: REPO_ROOT },
    );
    const fixturePath = stdout.trim().split("\n")[0]!.trim();

    const privateRoot = await makeTempDir("lexiloop-roundtrip-");
    const sourceHash = await sha256File(fixturePath);
    const workDir = workDirectory(privateRoot, sourceHash);
    const media = MediaStageConfigSchema.parse({ sourcePath: fixturePath, pages: [1, 2] });
    const runPython = createPythonRunner();

    // Real extract + clean through the exact argument builders the stages use.
    await runPython(extractSpawnArgs(media, workDir));
    await runPython(cleanSpawnArgs(DEFAULT_RULE_PATH, workDir));

    const extractRecords = await validateExtractArtifacts(workDir, sourceHash, media.pages);
    expect(extractRecords.map((r) => r.page)).toEqual([1, 2]);
    const cleanRecords = await validateCleanArtifacts(
      workDir,
      sourceHash,
      extractRecords.map((r) => r.page),
    );
    expect(cleanRecords.map((r) => r.page)).toEqual([1, 2]);
    expect(
      cleanRecords.every((r) => r.changed_pixels_outside === 0 && r.changed_pixels > 0),
    ).toBe(true);

    // The raw artifact parses directly against the Zod CleanRecord schema.
    const rows = await readJsonl(path.join(workDir, "clean.jsonl"), CleanRecordSchema);
    expect(rows).toEqual(cleanRecords);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Media stages inside the pipeline
// ---------------------------------------------------------------------------

describe("IMAGE_EXTRACT stage", () => {
  it("spawns the module with an argument array and validates the JSONL artifact", async () => {
    const privateRoot = await makeTempDir("lexiloop-media-priv-");
    const workDir = workDirectory(privateRoot, SOURCE_HASH);
    await seedExtractArtifacts(workDir, [1, 2]);
    const spawnArgs: string[][] = [];
    const runPython: SpawnPythonFn = async (args) => {
      spawnArgs.push([...args]);
      return { stdout: "" };
    };
    const ledger = createFileLedger({ directory: ledgerDirectory(privateRoot, SOURCE_HASH) });
    const report = await runPipeline([createImageExtractStage({ privateRoot, runPython })], ledger, {
      sourceHash: SOURCE_HASH,
      config: mediaStageConfig(path.join("/source", AWKWARD_NAME)),
    });
    expect(report.status).toBe("COMPLETED");
    expect(spawnArgs).toEqual([
      [
        "extract",
        "--source", path.join("/source", AWKWARD_NAME),
        "--pages", "1,2",
        "--out-dir", workDir,
        "--dpi", "300",
      ],
    ]);
    const entry = await ledger.load("IMAGE_EXTRACT");
    expect(entry).toMatchObject({ status: "PASSED", error_code: null });
    // Resume skips the stage when input and config hashes are unchanged.
    const rerun = await runPipeline([createImageExtractStage({ privateRoot, runPython })], ledger, {
      sourceHash: SOURCE_HASH,
      config: mediaStageConfig(path.join("/source", AWKWARD_NAME)),
    });
    expect(rerun.results[0]).toMatchObject({ status: "SKIPPED" });
  });

  it("fails closed on duplicated page records", async () => {
    const privateRoot = await makeTempDir("lexiloop-media-dup-");
    const workDir = workDirectory(privateRoot, SOURCE_HASH);
    await seedExtractArtifacts(workDir, [1, 1]); // duplicated page record
    await expect(
      validateExtractArtifacts(workDir, SOURCE_HASH, [1, 2]),
    ).rejects.toMatchObject({ code: "MEDIA_OUTPUT_INVALID" });
  });

  it("fails closed with MEDIA_OUTPUT_INVALID when an image hash mismatches", async () => {
    const privateRoot = await makeTempDir("lexiloop-media-badhash-");
    const workDir = workDirectory(privateRoot, SOURCE_HASH);
    await seedExtractArtifacts(workDir, [1]);
    // Corrupt the artifact after seeding.
    const firstLine = (await readFile(path.join(workDir, "pages.jsonl"), "utf8"))
      .trim()
      .split("\n")[0]!;
    const record = JSON.parse(firstLine) as { image_path: string };
    await writeFile(path.join(workDir, record.image_path), "tampered");
    const calls: string[] = [];
    const runPython: SpawnPythonFn = async () => ({ stdout: "" });
    const downstream = stubStage("LAYOUT_OCR", calls);
    const ledger = createFileLedger({ directory: ledgerDirectory(privateRoot, SOURCE_HASH) });
    const report = await runPipeline(
      [createImageExtractStage({ privateRoot, runPython }), downstream],
      ledger,
      { sourceHash: SOURCE_HASH, config: mediaStageConfig("/source.pdf") },
    );
    expect(report.status).toBe("FAILED");
    expect(report.stoppedAt).toBe("IMAGE_EXTRACT");
    expect(report.results[0]).toMatchObject({ error_code: "MEDIA_OUTPUT_INVALID" });
    expect(calls).toEqual([]); // the later stage never started
    expect(await ledger.load("IMAGE_EXTRACT")).toMatchObject({
      status: "FAILED",
      error_code: "MEDIA_OUTPUT_INVALID",
    });
  });
});

describe("media handler failure propagation", () => {
  const failingSpawn: SpawnPythonFn = async () => {
    throw new MediaSpawnError("MEDIA_WORKER_FAILED", "exited with code 2", 2, "boom");
  };

  it("never starts later stages when IMAGE_EXTRACT fails", async () => {
    const privateRoot = await makeTempDir("lexiloop-media-fail-extract-");
    const calls: string[] = [];
    const ledger = createFileLedger({ directory: ledgerDirectory(privateRoot, SOURCE_HASH) });
    const report = await runPipeline(
      [
        stubStage("SOURCE_FINGERPRINT", calls),
        createImageExtractStage({ privateRoot, runPython: failingSpawn }),
        stubStage("WATERMARK_CLEAN", calls),
        stubStage("LAYOUT_OCR", calls),
      ],
      ledger,
      { sourceHash: SOURCE_HASH, config: mediaStageConfig("/source.pdf") },
    );
    expect(report.status).toBe("FAILED");
    expect(report.stoppedAt).toBe("IMAGE_EXTRACT");
    expect(calls).toEqual(["SOURCE_FINGERPRINT"]);
    expect(await ledger.load("IMAGE_EXTRACT")).toMatchObject({
      status: "FAILED",
      error_code: "MEDIA_WORKER_FAILED",
    });
    // The later stage only ever got its materialized PENDING placeholder.
    expect(await ledger.load("LAYOUT_OCR")).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("never starts later stages when WATERMARK_CLEAN fails", async () => {
    const privateRoot = await makeTempDir("lexiloop-media-fail-clean-");
    const workDir = workDirectory(privateRoot, SOURCE_HASH);
    await seedExtractArtifacts(workDir, [1, 2]); // upstream artifact exists
    const calls: string[] = [];
    const ledger = createFileLedger({ directory: ledgerDirectory(privateRoot, SOURCE_HASH) });
    const report = await runPipeline(
      [
        createImageExtractStage({
          privateRoot,
          runPython: async () => ({ stdout: "" }), // artifacts already seeded
        }),
        createWatermarkCleanStage({ privateRoot, runPython: failingSpawn }),
        stubStage("LAYOUT_OCR", calls),
      ],
      ledger,
      { sourceHash: SOURCE_HASH, config: mediaStageConfig("/source.pdf") },
    );
    expect(report.status).toBe("FAILED");
    expect(report.stoppedAt).toBe("WATERMARK_CLEAN");
    expect(calls).toEqual([]); // OCR never started
    expect(await ledger.load("WATERMARK_CLEAN")).toMatchObject({
      status: "FAILED",
      error_code: "MEDIA_WORKER_FAILED",
    });
  });

  it("fails closed when the worker claims to succeed but changed pixels leak", async () => {
    const privateRoot = await makeTempDir("lexiloop-media-leak-");
    const workDir = workDirectory(privateRoot, SOURCE_HASH);
    await seedExtractArtifacts(workDir, [1, 2]);
    await seedCleanArtifacts(workDir, [1, 2]);
    // Tamper: the worker reported changes outside the mask (must never pass).
    const cleanRows = (await readFile(path.join(workDir, "clean.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((row) => ({ ...row, changed_pixels_outside: 7 }));
    await writeFile(
      path.join(workDir, "clean.jsonl"),
      cleanRows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );
    const runPython: SpawnPythonFn = async () => ({ stdout: "" });
    const calls: string[] = [];
    const ledger = createFileLedger({ directory: ledgerDirectory(privateRoot, SOURCE_HASH) });
    const report = await runPipeline(
      [
        createImageExtractStage({ privateRoot, runPython }),
        createWatermarkCleanStage({ privateRoot, runPython }),
        stubStage("LAYOUT_OCR", calls),
      ],
      ledger,
      { sourceHash: SOURCE_HASH, config: mediaStageConfig("/source.pdf") },
    );
    expect(report.status).toBe("FAILED");
    expect(report.stoppedAt).toBe("WATERMARK_CLEAN");
    expect(report.results[1]).toMatchObject({ error_code: "MEDIA_OUTPUT_INVALID" });
    expect(calls).toEqual([]);
  });

  it("completes the media prefix when both workers succeed", async () => {
    const privateRoot = await makeTempDir("lexiloop-media-ok-");
    const workDir = workDirectory(privateRoot, SOURCE_HASH);
    await seedExtractArtifacts(workDir, [1, 2]);
    await seedCleanArtifacts(workDir, [1, 2]);
    const runPython: SpawnPythonFn = async () => ({ stdout: "" });
    const ledger = createFileLedger({ directory: ledgerDirectory(privateRoot, SOURCE_HASH) });
    const report = await runPipeline(
      [
        createImageExtractStage({ privateRoot, runPython }),
        createWatermarkCleanStage({ privateRoot, runPython }),
      ],
      ledger,
      { sourceHash: SOURCE_HASH, config: mediaStageConfig("/source.pdf") },
    );
    expect(report.status).toBe("COMPLETED");
    expect(report.results.map((r) => r.status)).toEqual(["PASSED", "PASSED"]);
    expect(await ledger.load("WATERMARK_CLEAN")).toMatchObject({ status: "PASSED" });
  });
});

// ---------------------------------------------------------------------------
// CLI media commands
// ---------------------------------------------------------------------------

describe("media cli commands", () => {
  function makeDeps(workRoot: string, out: string[], runPython?: SpawnPythonFn): CliDeps {
    return {
      workRoot,
      stages: [],
      createLedger: (sourceHash) =>
        createFileLedger({ directory: ledgerDirectory(workRoot, sourceHash) }),
      logger: silentLogger,
      writeLine: (line) => out.push(line),
      exit: (code) => out.push(`exit:${code}`),
      runPython,
    };
  }

  it("media extract spawns python, validates output, and records the ledger entry", async () => {
    const privateRoot = await makeTempDir("lexiloop-cli-extract-");
    const sourceDir = await makeTempDir("lexiloop-cli-src-");
    const sourcePath = path.join(sourceDir, AWKWARD_NAME);
    await writeFile(sourcePath, "fake pdf bytes");
    const sourceHash = await sha256File(sourcePath);

    const out: string[] = [];
    const spawnArgs: string[][] = [];
    const deps = makeDeps(path.join(privateRoot, "work"), out, async (args) => {
      spawnArgs.push([...args]);
      // Emulate the Python worker: create the artifacts it would create.
      const outDirIndex = args.indexOf("--out-dir");
      await seedExtractArtifacts(args[outDirIndex + 1] as string, [1], sourceHash);
      return { stdout: "" };
    });
    const cli = buildCli(deps);
    await cli.parseAsync(
      ["media", "extract", "--source", sourcePath, "--pages", "1", "--private-root", privateRoot],
      { from: "user" },
    );

    // The CJK/space path traveled verbatim inside the argument array.
    expect(spawnArgs[0]).toContain(sourcePath);
    expect(out.join("\n")).toContain("media extract OK (1 page(s))");
    expect(out.join("\n")).not.toContain("exit:1");

    const ledger = createFileLedger({
      directory: ledgerDirectory(path.join(privateRoot, "work"), sourceHash),
    });
    expect(await ledger.load("IMAGE_EXTRACT")).toMatchObject({ status: "PASSED", attempts: 1 });
  });

  it("media extract reports failure and writes no ledger entry when python fails", async () => {
    const privateRoot = await makeTempDir("lexiloop-cli-extract-fail-");
    const sourceDir = await makeTempDir("lexiloop-cli-src-fail-");
    const sourcePath = path.join(sourceDir, "source.pdf");
    await writeFile(sourcePath, "fake pdf bytes");
    const sourceHash = await sha256File(sourcePath);

    const out: string[] = [];
    const deps = makeDeps(path.join(privateRoot, "work"), out, async () => {
      throw new MediaSpawnError("MEDIA_WORKER_FAILED", "exited with code 2", 2, "boom");
    });
    const cli = buildCli(deps);
    await cli.parseAsync(
      ["media", "extract", "--source", sourcePath, "--pages", "1", "--private-root", privateRoot],
      { from: "user" },
    );
    expect(out.join("\n")).toContain("media extract failed");
    expect(out).toContain("exit:1");
    const ledger = createFileLedger({ directory: ledgerDirectory(privateRoot, sourceHash) });
    expect(await ledger.load("IMAGE_EXTRACT")).toBeNull();
  });
});
