/**
 * Stage ledger persistence (spec 5.2).
 *
 * The ledger records one JSON entry per stage under
 * `.lexiloop-private/work/<source-hash>/ledger/<STAGE>.json`, holding the
 * stage's current status, input/output hashes, config version hash, attempt
 * count, timestamps, and last error code. Writes are atomic: a temp file is
 * written in the same directory and renamed over the target, so a crash can
 * never leave a half-written entry (at worst a stale RUNNING entry, which the
 * pipeline recovers on the next invocation).
 *
 * Single-writer assumption: a work directory must have at most one compile
 * run writing the ledger at a time. `runPipeline` enforces this with an
 * advisory lockfile (see pipeline.ts); any direct ledger use outside the
 * pipeline must uphold the same constraint.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { STAGE_STATUSES } from "./stage";

export const LedgerEntrySchema = z.object({
  stage: z.string().min(1),
  status: z.enum(STAGE_STATUSES),
  compile_run_id: z.string().min(1),
  input_hash: z.string().nullable(),
  config_version_hash: z.string().nullable(),
  output_hash: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  updated_at: z.string().min(1),
  error_code: z.string().nullable(),
});

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export interface LedgerStore {
  /** Latest entry for a stage, or null when missing/corrupt (fail open to a re-run). */
  load(stage: string): Promise<LedgerEntry | null>;
  /** Atomically persist one stage entry. */
  save(entry: LedgerEntry): Promise<void>;
  /** All readable entries, sorted by stage name. */
  list(): Promise<LedgerEntry[]>;
}

const SOURCE_HASH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Validate a source hash and derive the ledger directory:
 * `<workRoot>/<source-hash>/ledger/`. Source hashes end up in file paths, so
 * anything that could traverse out of the work root is rejected.
 */
export function ledgerDirectory(workRoot: string, sourceHash: string): string {
  if (!SOURCE_HASH_PATTERN.test(sourceHash)) {
    throw new Error(`Invalid source hash ${JSON.stringify(sourceHash)}`);
  }
  return path.join(workRoot, sourceHash, "ledger");
}

export function createFileLedger(options: { directory: string }): LedgerStore {
  const { directory } = options;
  const fileFor = (stage: string): string => path.join(directory, `${stage}.json`);

  const store: LedgerStore = {
    async load(stage) {
      let raw: string;
      try {
        raw = await readFile(fileFor(stage), "utf8");
      } catch {
        // Missing or unreadable entry: the stage simply has no history.
        return null;
      }
      try {
        return LedgerEntrySchema.parse(JSON.parse(raw));
      } catch {
        // Corrupt entry: treat as absent so the stage re-runs fail-closed.
        return null;
      }
    },

    async save(entry) {
      await mkdir(directory, { recursive: true });
      const tmp = path.join(directory, `.${entry.stage}.json.tmp-${randomBytes(6).toString("hex")}`);
      await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
      await rename(tmp, fileFor(entry.stage));
    },

    async list() {
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        return [];
      }
      const entries: LedgerEntry[] = [];
      for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
        const entry = await store.load(name.slice(0, -".json".length));
        if (entry) entries.push(entry);
      }
      return entries;
    },
  };
  return store;
}
