/** Read-only production spot check. This is sampling evidence, not the full
 * verify-release gate. It reads at most 8 rows from each content table and
 * one indexed audio row from each of 8 hash-key ranges. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { audioRowProblem, type Row } from "./verify-release";
import { parseWranglerRows } from "../tools/content-compiler/src/release/remote";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "infra", "wrangler", "wrangler.toml");
const HEX_KEY = /^[0-9a-f]{64}$/;
const RELEASE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const PREFIXES = ["00", "20", "40", "60", "80", "a0", "c0", "e0"] as const;

export interface SampleRunner {
  d1(sql: string): Promise<Row[]>;
  r2Get(key: string): Promise<Uint8Array | null>;
}

export interface SampleResult {
  passed: boolean;
  d1Queries: number;
  r2Objects: number;
  releaseActive: boolean;
  sampledWords: number;
  sampledCards: number;
  sampledAudio: number;
  problems: string[];
}

/** Fixed-size, indexed spot check. It never issues count(*), quick_check,
 * foreign_key_check, or any whole-table audio listing. */
export async function runRemoteSample(releaseId: string, runner: SampleRunner): Promise<SampleResult> {
  if (!RELEASE_ID.test(releaseId)) throw new Error("invalid release id");
  let d1Queries = 0;
  let r2Objects = 0;
  const read = async (sql: string): Promise<Row[]> => {
    d1Queries += 1;
    return await runner.d1(sql);
  };
  const problems: string[] = [];
  const meta = (await read("SELECT active_release_id FROM app_meta WHERE id = 1"))[0];
  const release = (await read(`SELECT release_id, status FROM content_release WHERE release_id = '${releaseId}'`))[0];
  const releaseActive = meta?.["active_release_id"] === releaseId && release?.["status"] === "ACTIVE";
  if (!releaseActive) problems.push("release pointer/status mismatch");

  const units = await read(`SELECT unit_key, status FROM release_unit WHERE release_id = '${releaseId}' ORDER BY unit_key LIMIT 8`);
  if (units.length === 0 || units.some((row) => row["status"] !== "PASSED")) problems.push("sampled units missing or blocked");

  const words = await read(`SELECT word_key, unit_key, source_order, headword FROM word WHERE release_id = '${releaseId}' ORDER BY word_key LIMIT 8`);
  if (words.length === 0) problems.push("no sampled words");
  for (const row of words) {
    const key = String(row["word_key"] ?? "");
    const expected = `w.${row["unit_key"]}.${String(row["source_order"]).padStart(4, "0")}.${row["headword"]}`;
    if (!HEX_KEY.test(key) && key !== expected) { problems.push("sampled word key mismatch"); break; }
  }

  const cards = await read(`SELECT content_card_key FROM card_definition WHERE release_id = '${releaseId}' ORDER BY content_card_key LIMIT 8`);
  if (cards.length === 0 || cards.some((row) => !HEX_KEY.test(String(row["content_card_key"] ?? "")))) {
    problems.push("sampled card key malformed");
  }

  const audioRows: Row[] = [];
  for (let index = 0; index < PREFIXES.length; index += 1) {
    const lower = PREFIXES[index]!;
    const upper = PREFIXES[index + 1] ?? "g0";
    const rows = await read(`SELECT asset_key, content_sha256, validation, sample_rate_hz FROM audio_asset
      WHERE release_id = '${releaseId}' AND asset_key >= 'audio/${lower}/' AND asset_key < 'audio/${upper}/'
      ORDER BY asset_key LIMIT 1`);
    if (rows[0]) audioRows.push(rows[0]);
  }
  if (audioRows.length === 0) problems.push("no sampled audio objects");
  for (const row of audioRows) {
    r2Objects += 1;
    const bytes = await runner.r2Get(String(row["asset_key"]));
    const problem = audioRowProblem(bytes, {
      content_sha256: String(row["content_sha256"] ?? ""),
      validation: String(row["validation"] ?? ""),
      sample_rate_hz: Number(row["sample_rate_hz"] ?? 0),
    });
    if (problem) problems.push(`sampled audio ${problem}`);
  }
  return {
    passed: problems.length === 0,
    d1Queries,
    r2Objects,
    releaseActive,
    sampledWords: words.length,
    sampledCards: cards.length,
    sampledAudio: audioRows.length,
    problems: [...new Set(problems)],
  };
}

function createRunner(bucket: string): SampleRunner {
  return {
    async d1(sql) {
      const result = spawnSync("wrangler", ["d1", "execute", "lexiloop", "--remote", "--config", CONFIG, "--json", "--command", sql], {
        cwd: ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
      });
      if (result.status !== 0 || result.error) throw new Error("remote D1 sample query failed");
      return parseWranglerRows(result.stdout);
    },
    async r2Get(key) {
      const result = spawnSync("wrangler", ["r2", "object", "get", `${bucket}/${key}`, "--remote", "--config", CONFIG, "--pipe"], {
        cwd: ROOT, encoding: "buffer", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      });
      return result.status === 0 && !result.error ? new Uint8Array(result.stdout) : null;
    },
  };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const releaseId = args[0];
  if (args.length !== 1 || releaseId === undefined || !RELEASE_ID.test(releaseId) || !existsSync(CONFIG)) {
    console.error("usage: tsx scripts/remote-sample.ts <release-id> (configured wrangler.toml required)");
    process.exitCode = 2;
  } else {
    const bucket = /bucket_name\s*=\s*"([^"]+)"/.exec(readFileSync(CONFIG, "utf8"))?.[1];
    if (!bucket) {
      console.error("remote sample: R2 bucket binding is missing");
      process.exitCode = 2;
    } else {
      runRemoteSample(releaseId, createRunner(bucket)).then((result) => {
        console.log(`remote sample ${result.passed ? "PASS" : "FAIL"}: D1 queries=${result.d1Queries}, word rows=${result.sampledWords}, card rows=${result.sampledCards}, R2 objects=${result.r2Objects}`);
        for (const problem of result.problems) console.error(`  ${problem}`);
        process.exitCode = result.passed ? 0 : 1;
      }).catch(() => {
        console.error("remote sample failed before completion");
        process.exitCode = 1;
      });
    }
  }
}
