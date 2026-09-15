/**
 * Remote-mode publish tests for the wrangler-driven release lifecycle
 * (Task 19): verify -> stage (R2 upload + D1 import) -> smoke -> activate,
 * plus remote rollback — the same lifecycle and fail-closed semantics as the
 * local rehearsal in publish.ts, applied through the Wrangler CLI.
 *
 * The wrangler spawn boundary is injected (`WranglerCli`, argument arrays in /
 * structured results out), the same fake-at-the-process-boundary style as the
 * verify-release remote-gates tests. Proven under test:
 * - happy path: bundle verification runs locally first, every manifest audio
 *   asset is uploaded to R2 before the three D1 import files are applied in
 *   order, the release row is created IMPORTING, smoke passes, and the
 *   activation sequence ends with the app_meta pointer switch, which is
 *   verified afterwards;
 * - a broken bundle fails BEFORE any wrangler invocation;
 * - a smoke failure records FAILED and emits NO pointer statement — the
 *   previous release stays ACTIVE;
 * - a wrangler invocation that fails or returns unparseable JSON is a NAMED
 *   failure, never a pass;
 * - remote rollback emits demote/promote/pointer with no alias upserts;
 * - remote activation with declared alias edges validates them against the
 *   remote data through the SAME alias rules as local mode and emits the
 *   alias upserts first in the sequence;
 * - wrangler.toml target resolution and the --remote mutual-exclusion of
 *   --db/--r2-dir (real process spawn).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AliasEdge } from "@lexiloop/domain";
import {
  parseWranglerRows,
  readWranglerTarget,
  remoteActivateRelease,
  remoteRollbackRelease,
  runRemotePublish,
  type RemoteTarget,
  type Row,
  type WranglerCli,
  type WranglerResult,
} from "../../src/release/remote";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const sha256Hex = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

const TEST_TARGET: RemoteTarget = {
  configPath: "/tmp/lexiloop-fake/wrangler.toml",
  d1Database: "lexiloop",
  r2Bucket: "lexiloop-audio",
};

// ---------------------------------------------------------------------------
// Synthetic verified bundle (same layout RELEASE_PACKAGE produces)
// ---------------------------------------------------------------------------

interface TestBundle {
  root: string;
  bundleDir: string;
  privateRoot: string;
  releaseId: string;
  audioObjectKeys: string[];
}

async function buildRemoteBundle(): Promise<TestBundle> {
  const root = await mkdtemp(join(tmpdir(), "lexiloop-remote-publish-"));
  const releaseId = "rel-remote-test";
  const sourceHash = sha256Hex("remote-test-source");
  const bundleDir = join(root, "releases", releaseId);
  const privateRoot = root;
  const audioRoot = join(privateRoot, "work", sourceHash);
  for (const dir of [
    join(bundleDir, "d1"),
    join(bundleDir, "qa"),
    join(bundleDir, "r2"),
    join(audioRoot, "audio", "rt"),
  ]) {
    await mkdir(dir, { recursive: true });
  }

  // Audio manifest + private WAVs (arbitrary bytes; staging re-hashes them).
  const rows: string[] = [];
  const audioObjectKeys: string[] = [];
  for (const index of [1, 2]) {
    const bytes = Buffer.from(`remote-test-wav-${index}`);
    const objectKey = `audio/rt/${sha256Hex(`text-${index}`)}.wav`;
    await writeFile(join(audioRoot, objectKey), bytes);
    audioObjectKeys.push(objectKey);
    rows.push(
      JSON.stringify({
        cache_key: sha256Hex(`cache-${index}`),
        object_key: objectKey,
        wav_path: objectKey,
        text_sha256: sha256Hex(`text-${index}`),
        text_chars: 5,
        min_seconds: 0.2,
        max_seconds: 4,
        sha256: sha256Hex(bytes),
        bytes: bytes.length,
        provider: "fixture",
        model: "fixture-model",
        voice: "fixture-voice",
        synthesis_config_version: "scv-1",
      }),
    );
  }
  const audioManifest = rows.join("\n") + "\n";

  const bodies: Record<string, string> = {
    "d1/001-content.sql": "-- fixture content import\n",
    "d1/002-cards.sql": "-- fixture card definitions\n",
    "d1/003-search.sql": "-- fixture search pass\n",
    "qa/unit-status.json": "[]\n",
    "qa/validation-summary.json": "{}\n",
    "rollback.json": "{}\n",
    "r2/audio-manifest.jsonl": audioManifest,
  };
  for (const [filePath, body] of Object.entries(bodies)) {
    await writeFile(join(bundleDir, filePath), body);
  }
  const manifestFiles = Object.entries(bodies)
    .map(([filePath, body]) => ({ path: filePath, sha256: sha256Hex(body), bytes: Buffer.byteLength(body) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const manifest = {
    release_id: releaseId,
    status: "DRAFT",
    created_at: "2026-09-10T19:00:00.000Z",
    book: { book_key: "bk-1", edition: "1st" },
    source_pdf_sha256: sourceHash,
    target_units: ["u-1"],
    config_versions: {
      schema_version: "schema-v1",
      watermark_rules_version: "1",
      ocr_config_version: "1",
      prompt_version: "prompt-v1",
      card_rules_version: "v1",
      synthesis_config_version: "scv-1",
    },
    model_config: {
      generation_model_id: "fixture-generation",
      review_model_id: "fixture-review",
      repair_model_id: "fixture-repair",
      tts_model_id: "fixture-tts",
      tts_voice: "fixture-voice",
    },
    units: [
      {
        unit_key: "u-1",
        status: "PASSED",
        counts: { words: 1, senses: 1, phrases: 0, examples: 0, explanations: 0, cards: 2 },
      },
    ],
    totals: { units: 1, units_passed: 1, units_blocked: 0, words: 1, cards: 2, audio_assets: 2 },
    files: manifestFiles,
    gates: [{ name: "fixture_synthetic", passed: true }],
  };
  await writeFile(join(bundleDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { root, bundleDir, privateRoot, releaseId, audioObjectKeys };
}

// ---------------------------------------------------------------------------
// Fake wrangler CLI: routes --command SQL / --file / r2 object argv, records
// every invocation in order, and mutates a small remote state like real D1.
// ---------------------------------------------------------------------------

interface FakeWrangler {
  cli: WranglerCli;
  /** Every invocation, tagged in order ("put:<key>", "file:<path>", "cmd:<sql>"). */
  order: string[];
  commands: string[];
  files: string[];
  puts: string[];
  r2Gets: string[];
  state: { status: string; pointer: string | null };
}

interface FakeWranglerOptions {
  releaseStatus?: string;
  pointer?: string | null;
  actualCounts?: Row;
  ftsCount?: number;
  audioRows?: Row[];
  storedEdges?: Row[];
  progressRows?: Row[];
  cardRows?: Row[];
  /** Exit 1 for any --command matching this substring. */
  failCommandOn?: string;
  /** Return unparseable stdout for any --command matching this substring. */
  garbageCommandOn?: string;
}

const HEALTHY_COUNTS: Row = { words: 1, senses: 1, phrases: 0, examples: 0, explanations: 0, cards: 2 };

function fakeWrangler(bundle: TestBundle, options: FakeWranglerOptions = {}): FakeWrangler {
  const state = {
    status: options.releaseStatus ?? "IMPORTING",
    pointer: options.pointer ?? null,
  };
  const fake: FakeWrangler = {
    cli: { run: async (argv) => respond(argv) },
    order: [],
    commands: [],
    files: [],
    puts: [],
    r2Gets: [],
    state,
  };

  const routeD1 = (statement: string): Row[] => {
    if (statement.startsWith("INSERT INTO content_release")) return [];
    if (statement.startsWith("INSERT INTO release_unit")) return [];
    if (statement.startsWith("INSERT INTO content_key_alias")) return [];
    if (statement.startsWith("UPDATE content_release SET status = 'VALIDATING'")) {
      state.status = "VALIDATING";
      return [];
    }
    if (statement.startsWith("UPDATE content_release SET status = 'READY'")) {
      state.status = "READY";
      return [];
    }
    if (statement.startsWith("UPDATE content_release SET status = 'FAILED'")) {
      state.status = "FAILED";
      return [];
    }
    if (statement.startsWith("UPDATE content_release SET status = 'ACTIVE'")) {
      state.status = "ACTIVE";
      return [];
    }
    if (statement.startsWith("UPDATE content_release SET status = 'RETIRED'")) {
      state.status = "RETIRED";
      return [];
    }
    if (statement.startsWith("UPDATE app_meta SET active_release_id")) {
      state.pointer = /active_release_id = '([^']*)'/.exec(statement)?.[1] ?? null;
      return [];
    }
    if (statement.includes("COUNT(*) AS n FROM content_release")) return [{ n: 0 }];
    if (statement.includes("FROM content_release WHERE release_id")) return [{ status: state.status }];
    if (statement.includes("COUNT(*) AS n FROM release_unit")) return [{ n: 1 }];
    if (statement.includes("COALESCE(SUM(words)")) {
      return [{ words: 1, senses: 1, phrases: 0, examples: 0, explanations: 0, cards: 2 }];
    }
    if (statement.includes("LEFT JOIN")) {
      return [
        {
          unit_book: 0,
          word_unit: 0,
          sense_word: 0,
          phrase_word: 0,
          example_word: 0,
          explanation_word: 0,
          card_word: 0,
          link_asset: 0,
        },
      ];
    }
    if (statement.includes("content_search_fts")) return [{ n: options.ftsCount ?? 2 }];
    if (statement.includes("(SELECT COUNT(*) FROM word")) return [options.actualCounts ?? HEALTHY_COUNTS];
    if (statement.includes("FROM audio_asset")) {
      return (
        options.audioRows ?? bundle.audioObjectKeys.map((key) => ({ asset_key: key, validation: "PASSED" }))
      );
    }
    if (statement.includes("FROM app_meta")) return [{ active_release_id: state.pointer }];
    if (statement.includes("FROM content_key_alias")) return options.storedEdges ?? [];
    if (statement.includes("FROM word WHERE") || statement.includes("FROM card_definition WHERE")) {
      return [{ n: 1 }];
    }
    if (statement.includes("FROM word_progress")) return options.progressRows ?? [];
    if (statement.includes("FROM card_state")) return options.cardRows ?? [];
    throw new Error(`fake wrangler: unhandled SQL: ${statement.slice(0, 80)}`);
  };

  const respond = (argv: readonly string[]): WranglerResult => {
    if (argv[0] === "d1") {
      const fileIndex = argv.indexOf("--file");
      if (fileIndex !== -1) {
        const path = argv[fileIndex + 1]!;
        fake.files.push(path);
        fake.order.push(`file:${path}`);
        if (options.failCommandOn !== undefined && path.includes(options.failCommandOn)) {
          return { status: 1, stdout: "", stderr: "[ERROR] statement failed in import file" };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      }
      const commandIndex = argv.indexOf("--command");
      const statement = argv[commandIndex + 1]!;
      fake.commands.push(statement);
      fake.order.push(`cmd:${statement}`);
      if (options.garbageCommandOn !== undefined && statement.includes(options.garbageCommandOn)) {
        return { status: 0, stdout: "wrangler exploded; nothing JSON here", stderr: "" };
      }
      if (options.failCommandOn !== undefined && statement.includes(options.failCommandOn)) {
        return { status: 1, stdout: "", stderr: "[ERROR] constraint check failed in sqlite" };
      }
      return { status: 0, stdout: JSON.stringify([{ results: routeD1(statement), success: true }]), stderr: "" };
    }
    if (argv[0] === "r2" && argv[1] === "object" && argv[2] === "put") {
      fake.puts.push(argv[3]!);
      fake.order.push(`put:${argv[3]}`);
      return { status: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "r2" && argv[1] === "object" && argv[2] === "get") {
      fake.r2Gets.push(argv[3]!);
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`fake wrangler: unhandled argv: ${argv.join(" ")}`);
  };

  return fake;
}

const writeCommands = (fake: FakeWrangler): string[] =>
  fake.commands.filter((statement) => !statement.trimStart().toUpperCase().startsWith("SELECT"));

/** PublishError carries a machine-readable code off-message. */
const thrownCode = (invoke: () => unknown): string => {
  try {
    invoke();
  } catch (err) {
    return (err as { code?: string }).code ?? "";
  }
  return "NO_ERROR_THROWN";
};

async function runPublish(
  bundle: TestBundle,
  fake: FakeWrangler,
  overrides: Partial<Parameters<typeof runRemotePublish>[0]> = {},
): Promise<Awaited<ReturnType<typeof runRemotePublish>>> {
  return await runRemotePublish({
    cli: fake.cli,
    target: TEST_TARGET,
    bundleDir: bundle.bundleDir,
    privateRoot: bundle.privateRoot,
    activate: true,
    now: 1_700_000_000_000,
    log: () => {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("remote publish lifecycle (injected wrangler boundary)", () => {
  let cleanup: string | undefined;
  afterEach(async () => {
    if (cleanup !== undefined) {
      await rm(cleanup, { recursive: true, force: true });
      cleanup = undefined;
    }
  });

  it("happy path: uploads every manifest asset (no presence probes, with progress lines), imports the D1 files in order, then activates with the pointer switch last", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    const fake = fakeWrangler(bundle);
    const lines: string[] = [];

    const outcome = await runPublish(bundle, fake, { log: (line) => lines.push(line) });

    expect(outcome.releaseId).toBe(bundle.releaseId);
    expect(outcome.uploaded).toBe(2);
    expect(outcome.reused).toBe(0);
    // Upload count equals the manifest asset count, one put per object key
    // into the configured private bucket.
    expect(fake.puts).toEqual([
      `${TEST_TARGET.r2Bucket}/${bundle.audioObjectKeys[0]}`,
      `${TEST_TARGET.r2Bucket}/${bundle.audioObjectKeys[1]}`,
    ]);
    // Uploads are unconditional: smoke re-probes NOTHING (no r2 object get),
    // presence was established by stage's verified puts.
    expect(fake.r2Gets).toEqual([]);
    // Progress is observable in a background run: a line per 50 uploads plus
    // a final count.
    expect(lines.filter((line) => /^uploaded \d+\/\d+$/.test(line))).toEqual(["uploaded 2/2"]);
    // The three bundle import files are applied in order, after the uploads.
    expect(fake.files).toEqual([
      join(bundle.bundleDir, "d1", "001-content.sql"),
      join(bundle.bundleDir, "d1", "002-cards.sql"),
      join(bundle.bundleDir, "d1", "003-search.sql"),
    ]);
    const lastPut = (() => {
      for (let index = fake.order.length - 1; index >= 0; index -= 1) {
        if (fake.order[index]!.startsWith("put:")) return index;
      }
      return -1;
    })();
    const firstFile = fake.order.findIndex((entry) => entry.startsWith("file:"));
    expect(lastPut).toBeGreaterThanOrEqual(0);
    expect(firstFile).toBeGreaterThan(lastPut);
    // The release-status preamble created the release IMPORTING and its unit
    // reports; app_meta is never written before activation.
    expect(fake.commands.some((statement) => statement.startsWith("INSERT INTO content_release"))).toBe(true);
    expect(
      fake.commands.some((statement) => statement.includes("'IMPORTING'") && statement.includes("content_release")),
    ).toBe(true);
    expect(fake.commands.some((statement) => statement.startsWith("INSERT INTO release_unit"))).toBe(true);
    // Smoke passed every check before activation ran.
    expect(outcome.activation).not.toBeNull();
    expect(outcome.activeReleaseId).toBe(bundle.releaseId);
    // The activation sequence ends with the pointer switch (last write), and
    // the pointer was verified afterwards.
    const writes = writeCommands(fake);
    const pointerSwitch = writes[writes.length - 1]!;
    expect(pointerSwitch).toContain(
      `UPDATE app_meta SET active_release_id = '${bundle.releaseId}', config_version = config_version + 1 WHERE id = 1`,
    );
    expect(writes.some((statement) => statement.includes("SET status = 'ACTIVE'"))).toBe(true);
    expect(fake.state.pointer).toBe(bundle.releaseId);
    expect(fake.state.status).toBe("ACTIVE");
  });

  it("fails a corrupted bundle BEFORE any wrangler invocation", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    await writeFile(join(bundle.bundleDir, "d1", "002-cards.sql"), "-- tampered\n");
    const fake = fakeWrangler(bundle);

    await expect(runPublish(bundle, fake)).rejects.toMatchObject({ code: "BUNDLE_VERIFY_FAILED" });
    expect(fake.order).toEqual([]);
  });

  it("smoke failure: records FAILED, emits NO pointer statement, leaves the old release ACTIVE", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    // Remote content rows disagree with the release_unit reports.
    const fake = fakeWrangler(bundle, {
      actualCounts: { words: 0, senses: 0, phrases: 0, examples: 0, explanations: 0, cards: 0 },
    });

    await expect(runPublish(bundle, fake)).rejects.toMatchObject({ code: "SMOKE_FAILED" });
    expect(fake.commands.some((statement) => statement.includes("SET status = 'FAILED'"))).toBe(true);
    expect(fake.state.status).toBe("FAILED");
    const writes = writeCommands(fake);
    expect(writes.some((statement) => statement.includes("UPDATE app_meta SET active_release_id"))).toBe(false);
    expect(writes.some((statement) => statement.includes("SET status = 'ACTIVE'"))).toBe(false);
    expect(fake.state.pointer).toBeNull();
  });

  it("smoke audio check stays honest without probes: an imported row not backed by the verified manifest uploads fails smoke", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    const fake = fakeWrangler(bundle, {
      audioRows: [
        { asset_key: bundle.audioObjectKeys[0], validation: "PASSED" },
        { asset_key: "audio/rt/not-in-this-bundle.wav", validation: "PASSED" },
      ],
    });

    await expect(runPublish(bundle, fake)).rejects.toMatchObject({ code: "SMOKE_FAILED" });
    expect(fake.r2Gets).toEqual([]); // still no probe traffic
    const writes = writeCommands(fake);
    expect(writes.some((statement) => statement.includes("UPDATE app_meta SET active_release_id"))).toBe(false);
    expect(fake.state.status).toBe("FAILED");
  });

  it("retries a failing r2 put up to 3 attempts with 5s/15s backoff, then continues", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    const fake = fakeWrangler(bundle);
    const innerRun = fake.cli.run;
    const firstKey = `${TEST_TARGET.r2Bucket}/${bundle.audioObjectKeys[0]}`;
    let firstObjectAttempts = 0;
    fake.cli = {
      run: async (argv, input) => {
        if (argv[0] === "r2" && argv[2] === "put" && argv[3] === firstKey) {
          firstObjectAttempts += 1;
          if (firstObjectAttempts <= 2) {
            return { status: 1, stdout: "", stderr: "[ERROR] 500 Internal Server Error" };
          }
        }
        return await innerRun(argv, input);
      },
    };
    const sleeps: number[] = [];

    const outcome = await runPublish(bundle, fake, { sleep: async (ms) => void sleeps.push(ms) });

    // Two failed attempts for the first object, then the third succeeded;
    // the run completed with every manifest asset uploaded exactly once.
    expect(firstObjectAttempts).toBe(3);
    expect(sleeps).toEqual([5_000, 15_000]);
    expect(outcome.uploaded).toBe(2);
    expect(outcome.activeReleaseId).toBe(bundle.releaseId);
  });

  it("aborts fail-closed after 3 consecutive put failures: no pointer switch", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    const fake = fakeWrangler(bundle);
    const innerRun = fake.cli.run;
    const sleeps: number[] = [];
    fake.cli = {
      run: async (argv, input) => {
        if (argv[0] === "r2" && argv[2] === "put") {
          return { status: 1, stdout: "", stderr: "[ERROR] 503 Service Unavailable" };
        }
        return await innerRun(argv, input);
      },
    };

    await expect(runPublish(bundle, fake, { sleep: async (ms) => void sleeps.push(ms) })).rejects.toMatchObject({
      code: "WRANGLER_FAILED",
    });
    expect(sleeps).toEqual([5_000, 15_000]);
    const writes = writeCommands(fake);
    expect(writes.some((statement) => statement.includes("UPDATE app_meta SET active_release_id"))).toBe(false);
    expect(fake.commands.some((statement) => statement.startsWith("INSERT INTO content_release"))).toBe(false);
  });

  it("unparseable wrangler output is a NAMED failure, never a pass", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    const fake = fakeWrangler(bundle, { garbageCommandOn: "COUNT(*) AS n FROM content_release" });

    await expect(runPublish(bundle, fake)).rejects.toMatchObject({ code: "WRANGLER_OUTPUT_INVALID" });
  });

  it("a failing wrangler invocation (nonzero exit) is a NAMED failure", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    const fake = fakeWrangler(bundle, { failCommandOn: "001-content" });

    await expect(runPublish(bundle, fake)).rejects.toMatchObject({ code: "WRANGLER_FAILED" });
    // Nothing past the failed import ran: no smoke probe, no pointer switch.
    expect(fake.commands.some((statement) => statement.includes("FROM app_meta"))).toBe(false);
  });

  it("remote rollback demotes the undone release, promotes the target, and switches the pointer", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    const fake = fakeWrangler(bundle, { releaseStatus: "RETIRED", pointer: "rel-undone-by-rollback" });

    const result = await remoteRollbackRelease({
      cli: fake.cli,
      target: TEST_TARGET,
      releaseId: bundle.releaseId,
      now: 1_700_000_000_000,
    });

    expect(result.releaseId).toBe(bundle.releaseId);
    expect(result.previousReleaseId).toBe("rel-undone-by-rollback");
    expect(result.aliasesImported).toBe(0);
    const writes = writeCommands(fake);
    expect(writes.some((statement) => statement.includes("SET status = 'RETIRED' WHERE release_id = 'rel-undone-by-rollback'"))).toBe(true);
    const last = writes[writes.length - 1]!;
    expect(last).toContain(`UPDATE app_meta SET active_release_id = '${bundle.releaseId}'`);
    expect(fake.state.pointer).toBe(bundle.releaseId);
    expect(fake.state.status).toBe("ACTIVE");
  });

  it("remote activation with alias edges validates against remote data and emits the upserts first", async () => {
    const bundle = await buildRemoteBundle();
    cleanup = bundle.root;
    const fromKey = sha256Hex("word-remote");
    const toKey = sha256Hex("word-old");
    const fake = fakeWrangler(bundle, { releaseStatus: "READY", pointer: null });
    const edges: AliasEdge[] = [
      {
        entity_type: "word",
        from_release_id: bundle.releaseId,
        from_key: fromKey,
        to_release_id: "rel-old",
        to_key: toKey,
        canonical_key: toKey,
      },
    ];

    const result = await remoteActivateRelease({
      cli: fake.cli,
      target: TEST_TARGET,
      releaseId: bundle.releaseId,
      aliases: edges,
      now: 1_700_000_000_000,
    });

    expect(result.aliasesImported).toBe(1);
    // Alias upserts come first in the activation sequence (before demote/
    // promote/pointer), matching the batch's statement order.
    expect(writeCommands(fake)[0]).toContain("INSERT INTO content_key_alias");
    expect(writeCommands(fake)[0]).toContain(fromKey);
    const writes = writeCommands(fake);
    expect(writes[writes.length - 1]).toContain(`UPDATE app_meta SET active_release_id = '${bundle.releaseId}'`);
  });

  it("parses wrangler's mixed-output JSON into result rows", () => {
    const rows = parseWranglerRows('noise\nXR [\n{"results": [{"n": 3}], "success": true}\n] tail\n');
    expect(rows).toEqual([{ n: 3 }]);
    const shaped = parseWranglerRows('[{"results": {"columns": ["a", "b"], "rows": [[1, "x"]]}, "success": true}]');
    expect(shaped).toEqual([{ a: 1, b: "x" }]);
    expect(() => parseWranglerRows("no json payload at all")).toThrow(/JSON/);
  });

  it("resolves the remote target from wrangler.toml with CLI overrides winning", async () => {
    const root = await mkdtemp(join(tmpdir(), "lexiloop-remote-target-"));
    cleanup = root;
    const configPath = join(root, "wrangler.toml");
    await writeFile(
      configPath,
      [
        'name = "lexiloop-worker"',
        "[[d1_databases]]",
        'binding = "DB"',
        'database_name = "lexiloop"',
        'database_id = "53e89027-0ed2-434c-9c07-5900f7bf2804"',
        "[[r2_buckets]]",
        'binding = "AUDIO"',
        'bucket_name = "lexiloop-audio"',
        "",
      ].join("\n"),
    );
    expect(readWranglerTarget(configPath)).toEqual({
      configPath,
      d1Database: "lexiloop",
      r2Bucket: "lexiloop-audio",
    });
    expect(readWranglerTarget(configPath, { d1Database: "other-db", r2Bucket: "other-bucket" })).toEqual({
      configPath,
      d1Database: "other-db",
      r2Bucket: "other-bucket",
    });
    const empty = join(root, "empty.toml");
    await writeFile(empty, 'name = "lexiloop-worker"\n');
    expect(thrownCode(() => readWranglerTarget(empty))).toBe("REMOTE_CONFIG_MISSING");
    expect(thrownCode(() => readWranglerTarget(join(root, "absent.toml")))).toBe("REMOTE_CONFIG_MISSING");
  });

  it("keeps --remote mutually exclusive with --db/--r2-dir (real process spawn)", () => {
    const tsx = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const run = (args: string[]): ReturnType<typeof spawnSync> =>
      spawnSync(process.execPath, [tsx, "scripts/publish-release.ts", ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 60_000,
      });
    const both = run(["--bundle", "x", "--remote", "--db", "y.sqlite", "--r2-dir", "z"]);
    expect(both.status).toBe(2);
    expect(both.stderr).toContain("--remote");
    const r2Only = run(["--bundle", "x", "--remote", "--r2-dir", "z"]);
    expect(r2Only.status).toBe(2);
    expect(r2Only.stderr).toContain("--remote");
    const noTarget = run(["--bundle", "x"]);
    expect(noTarget.status).toBe(2);
  });
});
