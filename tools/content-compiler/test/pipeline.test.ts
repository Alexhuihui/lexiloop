import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { buildCli, type CliDeps } from "../src/cli";
import { createFileLedger, ledgerDirectory, type LedgerEntry, type LedgerStore } from "../src/ledger";
import { collectEnvSecrets, createCompilerLogger, silentLogger } from "../src/logging";
import { runPipeline } from "../src/pipeline";
import {
  PRODUCTION_STAGE_DEPENDENCIES,
  PRODUCTION_STAGE_NAMES,
  getProductionStages,
} from "../src/stage-registry";
import { StageError, hashString, type AnyStage } from "../src/stage";

// ---------------------------------------------------------------------------
// Fixtures: temp ledger directories and synthetic stages. Tests never touch
// the real `.lexiloop-private/` path.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeLedger(): Promise<{ store: LedgerStore; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "lexiloop-ledger-"));
  tempDirs.push(directory);
  return { store: createFileLedger({ directory }), directory };
}

afterEach(async () => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

interface FixtureStageOptions {
  /** The stage throws on its first `failTimes` runs. */
  failTimes?: number;
  error?: StageError;
  /** Raw source-text-like content flowing through the stage output. */
  rawText?: string;
}

function fixtureStage(name: string, calls: string[], opts: FixtureStageOptions = {}): AnyStage {
  let runs = 0;
  return {
    name,
    configVersion: "1",
    inputSchema: z.unknown(),
    outputSchema: z.object({ stage: z.string() }),
    computeInputHash: (ctx) => hashString(`${name}:${JSON.stringify(ctx.config[name] ?? null)}`),
    async run() {
      calls.push(name);
      runs += 1;
      if (opts.failTimes !== undefined && runs <= opts.failTimes) {
        throw opts.error ?? new StageError("TRANSIENT_FAILURE", "transient", { retryable: true });
      }
      if (opts.rawText !== undefined) {
        // Extra keys are stripped by outputSchema.parse before anything is logged.
        return { stage: name, text: opts.rawText } as unknown as { stage: string };
      }
      return { stage: name };
    },
  };
}

function fixtureStages(calls: string[]): AnyStage[] {
  return ["source", "images", "ocr"].map((name) => fixtureStage(name, calls));
}

function invalidationStages(calls: string[]): AnyStage[] {
  return ["source", "images", "watermark", "ocr", "normalize"].map((name) =>
    fixtureStage(name, calls),
  );
}

/** Minimal valid ledger entry with sensible defaults for seeding. */
function entryFor(overrides: Partial<LedgerEntry> & { stage: string }): LedgerEntry {
  return {
    status: "PASSED",
    compile_run_id: "seed-run",
    input_hash: null,
    config_version_hash: null,
    output_hash: null,
    attempts: 1,
    started_at: null,
    finished_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    error_code: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Resume semantics (spec 5.2)
// ---------------------------------------------------------------------------

describe("pipeline resume", () => {
  it("resumes after the last matching passed stage", async () => {
    const calls: string[] = [];
    const ledger = await makeLedger();
    await runPipeline(fixtureStages(calls), ledger.store);
    await runPipeline(fixtureStages(calls), ledger.store);
    expect(calls).toEqual(["source", "images", "ocr"]);
  });

  it("reruns a stage and dependents when its input hash changes", async () => {
    const ledger = await makeLedger();
    const firstCalls: string[] = [];
    await runPipeline(invalidationStages(firstCalls), ledger.store, {
      config: { watermark: { rulesVersion: 1 } },
    });
    expect(firstCalls).toEqual(["source", "images", "watermark", "ocr", "normalize"]);

    const rerunCalls: string[] = [];
    const report = await runPipeline(invalidationStages(rerunCalls), ledger.store, {
      config: { watermark: { rulesVersion: 2 } },
    });
    expect(report.status).toBe("COMPLETED");
    expect(rerunCalls).toEqual(["watermark", "ocr", "normalize"]);
  });

  it("records PASSED entries with hashes and attempt counts", async () => {
    const ledger = await makeLedger();
    const calls: string[] = [];
    await runPipeline(fixtureStages(calls), ledger.store);
    const entry = await ledger.store.load("images");
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({
      stage: "images",
      status: "PASSED",
      attempts: 1,
      error_code: null,
    });
    expect(entry?.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.output_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.config_version_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.compile_run_id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Stage registry (spec 5.2 stage order)
// ---------------------------------------------------------------------------

describe("stage registry", () => {
  it("declares the complete production stage order", () => {
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
  });

  it("declares a linear dependency chain over the stage order", () => {
    expect(PRODUCTION_STAGE_DEPENDENCIES.SOURCE_FINGERPRINT).toEqual([]);
    for (let i = 1; i < PRODUCTION_STAGE_NAMES.length; i += 1) {
      const stage = PRODUCTION_STAGE_NAMES[i]!;
      const predecessor = PRODUCTION_STAGE_NAMES[i - 1]!;
      expect(PRODUCTION_STAGE_DEPENDENCIES[stage]).toEqual([predecessor]);
    }
  });

  it("starts every production stage as a fail-closed handler", async () => {
    const ledger = await makeLedger();
    const report = await runPipeline(getProductionStages(), ledger.store);
    expect(report.status).toBe("FAILED");
    expect(report.stoppedAt).toBe("SOURCE_FINGERPRINT");
    expect(report.results[0]).toMatchObject({
      name: "SOURCE_FINGERPRINT",
      status: "FAILED",
      error_code: "STAGE_NOT_IMPLEMENTED",
    });
    const entry = await ledger.store.load("SOURCE_FINGERPRINT");
    expect(entry).toMatchObject({ status: "FAILED", error_code: "STAGE_NOT_IMPLEMENTED" });
  });
});

// ---------------------------------------------------------------------------
// Stage state machine (spec 5.2)
// ---------------------------------------------------------------------------

describe("stage state machine", () => {
  it("turns a stale RUNNING entry into resumable FAILED on the next invocation", async () => {
    const ledger = await makeLedger();
    await ledger.store.save(entryFor({ stage: "source", status: "RUNNING", attempts: 1 }));
    await ledger.store.save(entryFor({ stage: "images", status: "RUNNING", attempts: 1 }));

    const calls: string[] = [];
    const report = await runPipeline(
      [
        fixtureStage("source", calls, {
          failTimes: 1,
          error: new StageError("BOOM", "hard failure", { retryable: false }),
        }),
        fixtureStage("images", calls),
        fixtureStage("ocr", calls),
      ],
      ledger.store,
    );
    expect(report.status).toBe("FAILED");
    // The stale RUNNING entry was recovered before scheduling: it is FAILED
    // with a stable error code, not re-entered as RUNNING by a crashed run.
    expect(await ledger.store.load("images")).toMatchObject({
      status: "FAILED",
      error_code: "STALE_RUNNING",
    });
    expect(await ledger.store.load("source")).toMatchObject({
      status: "FAILED",
      error_code: "BOOM",
    });
  });

  it("retries retryable failures with capped exponential backoff", async () => {
    const ledger = await makeLedger();
    const calls: string[] = [];
    const sleeps: number[] = [];
    const stage = fixtureStage("flaky", calls, {
      failTimes: 3,
      error: new StageError("RATE_LIMITED", "slow down", { retryable: true }),
    });
    const report = await runPipeline([stage], ledger.store, {
      retry: {
        baseDelayMs: 100,
        factor: 2,
        maxDelayMs: 250,
        maxAttempts: 4,
        jitterRatio: 0,
        random: () => 0,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    expect(report.status).toBe("COMPLETED");
    expect(calls).toEqual(["flaky", "flaky", "flaky", "flaky"]);
    // 100 * 2^0, 100 * 2^1, then 400 capped at maxDelayMs=250.
    expect(sleeps).toEqual([100, 200, 250]);
    expect(await ledger.store.load("flaky")).toMatchObject({ status: "PASSED", attempts: 4 });
  });

  it("records FAILED after exhausting retry attempts and stops downstream", async () => {
    const ledger = await makeLedger();
    const calls: string[] = [];
    const flaky = fixtureStage("flaky", calls, {
      failTimes: 99,
      error: new StageError("RATE_LIMITED", "429", { retryable: true }),
    });
    const downstream = fixtureStage("downstream", calls);
    const report = await runPipeline([flaky, downstream], ledger.store, {
      retry: { maxAttempts: 2, sleep: async () => {}, random: () => 0 },
    });
    expect(report.status).toBe("FAILED");
    expect(report.stoppedAt).toBe("flaky");
    expect(calls).toEqual(["flaky", "flaky"]);
    expect(await ledger.store.load("flaky")).toMatchObject({
      status: "FAILED",
      error_code: "RATE_LIMITED",
      attempts: 2,
    });
  });

  it("fails immediately without retry for non-retryable errors", async () => {
    const ledger = await makeLedger();
    const calls: string[] = [];
    const sleeps: number[] = [];
    const broken = fixtureStage("broken", calls, {
      failTimes: 99,
      error: new StageError("CONFIG_INVALID", "bad config", { retryable: false }),
    });
    const downstream = fixtureStage("downstream", calls);
    const report = await runPipeline([broken, downstream], ledger.store, {
      retry: {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        random: () => 0,
      },
    });
    expect(report.status).toBe("FAILED");
    expect(calls).toEqual(["broken"]);
    expect(sleeps).toEqual([]);
    expect(await ledger.store.load("broken")).toMatchObject({
      status: "FAILED",
      error_code: "CONFIG_INVALID",
      attempts: 1,
    });
  });

  it("refuses to re-run a BLOCKED stage without explicit intervention", async () => {
    const ledger = await makeLedger();
    await ledger.store.save(
      entryFor({ stage: "source", status: "BLOCKED", error_code: "UNIT_BLOCKED" }),
    );
    const calls: string[] = [];
    const report = await runPipeline(fixtureStages(calls), ledger.store);
    expect(report.status).toBe("BLOCKED");
    expect(report.stoppedAt).toBe("source");
    expect(calls).toEqual([]);
  });

  it("treats a corrupt ledger entry as absent and re-runs the stage", async () => {
    const ledger = await makeLedger();
    await writeFile(path.join(ledger.directory, "source.json"), "{corrupt", "utf8");
    const calls: string[] = [];
    const report = await runPipeline(fixtureStages(calls), ledger.store);
    expect(report.status).toBe("COMPLETED");
    expect(calls).toEqual(["source", "images", "ocr"]);
  });
});

// ---------------------------------------------------------------------------
// Ledger persistence
// ---------------------------------------------------------------------------

describe("ledger persistence", () => {
  it("persists entries atomically without leaving temp files", async () => {
    const ledger = await makeLedger();
    await ledger.store.save(entryFor({ stage: "source", status: "RUNNING" }));
    await ledger.store.save(entryFor({ stage: "source" }));
    const files = await readdir(ledger.directory);
    expect(files.sort()).toEqual(["source.json"]);
    expect(await ledger.store.load("source")).toMatchObject({ status: "PASSED" });
  });

  it("lists recorded entries", async () => {
    const ledger = await makeLedger();
    await ledger.store.save(entryFor({ stage: "source" }));
    await ledger.store.save(entryFor({ stage: "ocr", status: "FAILED", error_code: "BOOM" }));
    const listed = await ledger.store.list();
    expect(listed.map((e) => `${e.stage}:${e.status}`)).toEqual(["ocr:FAILED", "source:PASSED"]);
  });

  it("rejects unsafe source hashes", () => {
    expect(() => ledgerDirectory("/tmp/work", "../escape")).toThrow(/source hash/i);
    expect(() => ledgerDirectory("/tmp/work", "")).toThrow(/source hash/i);
    expect(ledgerDirectory("/tmp/work", "abc123")).toBe(path.join("/tmp/work", "abc123", "ledger"));
  });
});

// ---------------------------------------------------------------------------
// Release gate
// ---------------------------------------------------------------------------

describe("release gate", () => {
  const gate = { stage: "RELEASE_PACKAGE", requires: ["AUDIO_VALIDATE"] };

  it("refuses to run the release stage when a predecessor lacks a PASSED entry", async () => {
    const ledger = await makeLedger();
    const calls: string[] = [];
    const report = await runPipeline([fixtureStage("RELEASE_PACKAGE", calls)], ledger.store, {
      releaseGate: gate,
    });
    expect(report.status).toBe("BLOCKED");
    expect(report.stoppedAt).toBe("RELEASE_PACKAGE");
    expect(calls).toEqual([]);
    expect(await ledger.store.load("RELEASE_PACKAGE")).toMatchObject({
      status: "BLOCKED",
      error_code: "RELEASE_GATE_UNMET",
    });
  });

  it("runs the release stage once every required predecessor has PASSED", async () => {
    const ledger = await makeLedger();
    await ledger.store.save(entryFor({ stage: "AUDIO_VALIDATE", status: "PASSED" }));
    const calls: string[] = [];
    const report = await runPipeline([fixtureStage("RELEASE_PACKAGE", calls)], ledger.store, {
      releaseGate: gate,
    });
    expect(report.status).toBe("COMPLETED");
    expect(calls).toEqual(["RELEASE_PACKAGE"]);
  });
});

// ---------------------------------------------------------------------------
// Contiguous traversal
// ---------------------------------------------------------------------------

describe("contiguous traversal", () => {
  it("runs only the contiguous prefix up to --through", async () => {
    const ledger = await makeLedger();
    const calls: string[] = [];
    const report = await runPipeline(fixtureStages(calls), ledger.store, { through: "images" });
    expect(report.status).toBe("COMPLETED");
    expect(calls).toEqual(["source", "images"]);
  });

  it("rejects a through stage that is not registered", async () => {
    const ledger = await makeLedger();
    await expect(runPipeline([], ledger.store, { through: "bogus" })).rejects.toThrow(
      /unknown stage/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Logging and redaction (spec 13.2)
// ---------------------------------------------------------------------------

describe("compiler logging", () => {
  it("drops fields outside the allowlist", () => {
    const lines: string[] = [];
    const logger = createCompilerLogger({ sink: (line) => lines.push(line) });
    logger.info("stage_completed", {
      stage: "LAYOUT_OCR",
      duration_ms: 12,
      // Forbidden fields: full source text must never be logged (spec 13.2).
      text: "entire textbook page contents",
      raw: "ocr blob",
    } as never);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.event).toBe("stage_completed");
    expect(parsed.stage).toBe("LAYOUT_OCR");
    expect(parsed.duration_ms).toBe(12);
    expect(parsed).not.toHaveProperty("text");
    expect(parsed).not.toHaveProperty("raw");
    expect(JSON.stringify(parsed)).not.toContain("entire textbook page");
  });

  it("redacts configured secret values anywhere in the emitted line", () => {
    const lines: string[] = [];
    const logger = createCompilerLogger({
      sink: (line) => lines.push(line),
      secrets: ["mimo-api-key-123"],
    });
    logger.info("stage_completed", { stage: "TTS_SYNTHESIZE token=mimo-api-key-123" });
    const joined = lines.join("\n");
    expect(joined).not.toContain("mimo-api-key-123");
    expect(joined).toContain("[REDACTED]");
  });

  it("emits structured stage events without raw content or secrets during a run", async () => {
    const lines: string[] = [];
    const logger = createCompilerLogger({
      sink: (line) => lines.push(line),
      secrets: ["mimo-api-key-123"],
    });
    const ledger = await makeLedger();
    const stage = fixtureStage("ocr", [], {
      failTimes: 1,
      error: new StageError("RATE_LIMITED", "ocr call failed (key mimo-api-key-123)", {
        retryable: true,
      }),
      rawText: "The entire textbook sentence about gravity",
    });
    const report = await runPipeline([stage], ledger.store, {
      runId: "compile-run-1",
      logger,
      config: { ocr: { apiKey: "mimo-api-key-123" } },
      retry: { maxAttempts: 2, sleep: async () => {}, random: () => 0 },
    });
    expect(report.status).toBe("COMPLETED");

    const joined = lines.join("\n");
    // Required structured fields (spec 13.2) are present.
    expect(joined).toContain('"compile_run_id":"compile-run-1"');
    expect(joined).toContain('"event":"stage_completed"');
    expect(joined).toContain('"stage":"ocr"');
    expect(joined).toContain('"duration_ms"');
    expect(joined).toContain('"attempt"');
    expect(joined).toContain('"input_hash"');
    expect(joined).toContain('"output_hash"');
    expect(joined).toContain('"error_code":"RATE_LIMITED"');
    expect(joined).toContain('"retry_count"');
    // Secrets and full source text never appear.
    expect(joined).not.toContain("mimo-api-key-123");
    expect(joined).not.toContain("The entire textbook sentence");
  });

  it("collects likely secrets from the environment by key name", () => {
    expect(
      collectEnvSecrets({ MIMO_API_KEY: "mimo-api-key-123", HOME: "/home/alex", PATH: "/usr/bin" }),
    ).toEqual(["mimo-api-key-123"]);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe("cli", () => {
  function makeDeps(workRoot: string, stages: readonly AnyStage[], out: string[]): CliDeps {
    return {
      workRoot,
      stages,
      createLedger: (sourceHash) =>
        createFileLedger({ directory: ledgerDirectory(workRoot, sourceHash) }),
      logger: silentLogger,
      writeLine: (line) => out.push(line),
    };
  }

  it("runs, reports status, plans, and resumes without new work", async () => {
    const workRoot = await mkdtemp(path.join(tmpdir(), "lexiloop-cli-"));
    tempDirs.push(workRoot);
    const out: string[] = [];
    const calls: string[] = [];
    const cli = buildCli(makeDeps(workRoot, fixtureStages(calls), out));

    await cli.parseAsync(["run", "--source-hash", "abc123"], { from: "user" });
    expect(calls).toEqual(["source", "images", "ocr"]);
    expect(out.join("\n")).toContain("COMPLETED");

    out.length = 0;
    await cli.parseAsync(["status", "--source-hash", "abc123"], { from: "user" });
    const status = out.join("\n");
    expect(status).toContain("source PASSED");
    expect(status).toContain("ocr PASSED");

    out.length = 0;
    await cli.parseAsync(["plan", "--source-hash", "abc123"], { from: "user" });
    const plan = out.join("\n");
    expect(plan).toContain("source");
    expect(plan).toContain("would-skip");

    // Resume performs no stage work: everything is PASSED with matching hashes.
    out.length = 0;
    await cli.parseAsync(["resume", "--source-hash", "abc123"], { from: "user" });
    expect(calls).toEqual(["source", "images", "ocr"]);
    expect(out.join("\n")).toContain("SKIPPED");
  });

  it("limits run --through to the contiguous registered prefix", async () => {
    const workRoot = await mkdtemp(path.join(tmpdir(), "lexiloop-cli-through-"));
    tempDirs.push(workRoot);
    const out: string[] = [];
    const calls: string[] = [];
    const cli = buildCli(makeDeps(workRoot, fixtureStages(calls), out));

    await cli.parseAsync(["run", "--source-hash", "abc123", "--through", "images"], { from: "user" });
    expect(calls).toEqual(["source", "images"]);
  });

  it("rejects an unregistered --through stage name", async () => {
    const workRoot = await mkdtemp(path.join(tmpdir(), "lexiloop-cli-bogus-"));
    tempDirs.push(workRoot);
    const cli = buildCli(makeDeps(workRoot, fixtureStages([]), []));
    await expect(
      cli.parseAsync(["run", "--source-hash", "abc123", "--through", "bogus"], { from: "user" }),
    ).rejects.toThrow(/unknown stage/i);
  });
});
