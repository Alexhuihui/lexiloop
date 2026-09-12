/**
 * Restore drill (spec 13.1: 仅"成功上传"不算备份有效): rebuilds a backup into
 * an EXPLICITLY newly-created temporary SQLite database and verifies it end
 * to end. Node-only module (better-sqlite3 + fs) — used by
 * `scripts/restore-drill.ts` and the backup tests; NEVER import it from the
 * Worker request path.
 *
 * Order of operations (plan Task 14):
 *   1. read the gzip JSONL backup + sibling manifest; re-verify the backup
 *      SHA-256;
 *   2. verify the bundle directory holds EXACTLY the manifest's required
 *      releases — a missing bundle OR an extra ambiguous one fails BEFORE the
 *      temporary database is even created (so before any user row is written);
 *   3. re-hash every file of every required bundle against its manifest;
 *   4. create the temporary database, apply migrations, import every required
 *      release (unit reports + content SQL) with the alias edges from the
 *      manifest;
 *   5. restore active/previous pointers;
 *   6. import user data (FK-safe order);
 *   7. rebuild FTS from the content tables (FTS5 is not a backup source);
 *   8. verify row counts, foreign keys, and canonical alias resolution — any
 *      failed check deletes the temporary database and fails the drill.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { z } from "zod";
import { AliasRepository, createSqliteDatabase } from "@lexiloop/db";
import { verifyBundle } from "../../../../tools/content-compiler/src/release/validate";
import { BACKUP_TABLES, gunzipBytes } from "./export";

/** Fail-closed restore error with a machine-readable code. */
export class RestoreDrillError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RestoreDrillError";
  }
}

const BackupManifestSchema = z.object({
  version: z.literal(1),
  created_at: z.number(),
  object_key: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  active_release_id: z.string().nullable(),
  previous_release_id: z.string().nullable(),
  row_counts: z.record(z.string(), z.number().int().nonnegative()),
  required_releases: z.array(z.object({ release_id: z.string().min(1), reasons: z.array(z.string()) })),
  alias_edges: z.array(
    z.object({
      release_id: z.string().min(1),
      from_key: z.string().min(1),
      to_key: z.string().min(1),
      edge_type: z.string().min(1),
      canonical_key: z.string().min(1),
      created_at: z.number(),
    }),
  ),
});

export interface RestoreCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface RestoreDrillInput {
  /** The gzip JSONL user-data backup (`user-data.jsonl.gz`). */
  backupPath: string;
  /** Directory containing EVERY immutable bundle named in the manifest. */
  releaseBundleDir: string;
  /** Temporary SQLite database file, created fresh (any existing file is replaced). */
  temporaryDbPath: string;
}

export interface RestoreDrillResult {
  temporaryDbPath: string;
  releases: string[];
  restoredRows: Record<string, number>;
  ftsRows: number;
  checks: RestoreCheck[];
}

function check(label: string, passed: boolean, detail?: string): RestoreCheck {
  return { name: label, passed, ...(detail !== undefined ? { detail } : {}) };
}

/** Executes one immutable bundle's D1 import file (one INSERT per line). */
function executeImportFile(sqlite: Database.Database, filePath: string): number {
  const text = readFileSync(filePath, "utf8");
  let executed = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    // One statement per generated line; comments and blanks are skipped.
    if (!trimmed.startsWith("INSERT")) continue;
    sqlite.exec(trimmed);
    executed += 1;
  }
  return executed;
}

function removeTemporaryDb(temporaryDbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${temporaryDbPath}${suffix}`, { force: true });
  }
}

/**
 * Runs the full restore drill. Throws `RestoreDrillError` when any
 * pre-import gate fails (missing/extra/tampered bundles, unreadable backup);
 * throws after deleting the temporary database when a post-import
 * verification check fails.
 */
export async function runRestoreDrill(input: RestoreDrillInput): Promise<RestoreDrillResult> {
  // -- 1. Backup + manifest -------------------------------------------------
  if (!existsSync(input.backupPath)) {
    throw new RestoreDrillError("BACKUP_MISSING", `backup file not found: ${input.backupPath}`);
  }
  const manifestPath = join(dirname(input.backupPath), "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new RestoreDrillError(
      "BACKUP_MANIFEST_MISSING",
      `backup manifest not found next to the backup: ${manifestPath}`,
    );
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new RestoreDrillError(
      "BACKUP_MANIFEST_INVALID",
      `backup manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = BackupManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new RestoreDrillError(
      "BACKUP_MANIFEST_INVALID",
      `backup manifest violates the backup contract: ${parsed.error.issues[0]?.message ?? "unknown issue"}`,
    );
  }
  const manifest = parsed.data;

  const backupBytes = new Uint8Array(readFileSync(input.backupPath));
  const backupSha256 = createHash("sha256").update(backupBytes).digest("hex");
  if (backupSha256 !== manifest.sha256) {
    throw new RestoreDrillError(
      "BACKUP_HASH_MISMATCH",
      `backup hash ${backupSha256.slice(0, 12)} does not match manifest ${manifest.sha256.slice(0, 12)}`,
    );
  }

  let jsonlText: string;
  try {
    jsonlText = new TextDecoder().decode(await gunzipBytes(backupBytes));
  } catch (error) {
    throw new RestoreDrillError(
      "BACKUP_UNREADABLE",
      `backup is not readable gzip JSONL: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const rowsByTable = new Map<string, Array<Record<string, unknown>>>();
  for (const line of jsonlText.split("\n")) {
    if (line.length === 0) continue;
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      throw new RestoreDrillError("BACKUP_UNREADABLE", "backup contains a line that is not valid JSON");
    }
    const record = parsedLine as { table?: unknown; row?: unknown };
    if (
      typeof record.table !== "string" ||
      !BACKUP_TABLES.includes(record.table as (typeof BACKUP_TABLES)[number]) ||
      record.row === null ||
      typeof record.row !== "object"
    ) {
      throw new RestoreDrillError("BACKUP_UNREADABLE", `backup line has an unknown table: ${String(record.table)}`);
    }
    const rows = rowsByTable.get(record.table) ?? [];
    rows.push(record.row as Record<string, unknown>);
    rowsByTable.set(record.table, rows);
  }

  // -- 2. Exact bundle set (fails before the temporary DB exists). ----------
  if (!existsSync(input.releaseBundleDir)) {
    throw new RestoreDrillError("BUNDLE_DIR_MISSING", `release bundle directory not found: ${input.releaseBundleDir}`);
  }
  const checks: RestoreCheck[] = [];
  const requiredIds = manifest.required_releases.map((entry) => entry.release_id).sort();
  const presentIds = readdirSync(input.releaseBundleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(input.releaseBundleDir, entry.name, "manifest.json")))
    .map((entry) => entry.name)
    .sort();
  const missing = requiredIds.filter((id) => !presentIds.includes(id));
  if (missing.length > 0) {
    throw new RestoreDrillError(
      "RESTORE_BUNDLE_MISSING",
      `release bundle directory is missing required bundle(s): ${missing.join(", ")}`,
    );
  }
  const extra = presentIds.filter((id) => !requiredIds.includes(id));
  if (extra.length > 0) {
    throw new RestoreDrillError(
      "RESTORE_BUNDLE_EXTRA",
      `release bundle directory holds extra ambiguous bundle(s) not named by the manifest: ${extra.join(", ")}`,
    );
  }

  // -- 3. Hash-verify every required bundle. --------------------------------
  const verifiedBundles = new Map<string, Exclude<Awaited<ReturnType<typeof verifyBundle>>["manifest"], null>>();
  for (const releaseId of requiredIds) {
    const verified = await verifyBundle(join(input.releaseBundleDir, releaseId));
    if (!verified.ok || verified.manifest === null || verified.manifestSha256 === null) {
      const detail = verified.errors.map((error) => `${error.path}: ${error.reason}`).join("; ");
      throw new RestoreDrillError(
        "RESTORE_BUNDLE_INVALID",
        `bundle for release ${releaseId} failed verification: ${detail || "unknown error"}`,
      );
    }
    verifiedBundles.set(releaseId, verified.manifest);
    checks.push(check(`bundle_hashes:${releaseId}`, true));
  }
  checks.push(check("required_release_set", true, `${requiredIds.length} bundle(s), exact set`));
  checks.push(check("backup_sha256", true));

  // -- 4. Fresh temporary database + migrations + release import. -----------
  removeTemporaryDb(input.temporaryDbPath);
  mkdirSync(dirname(input.temporaryDbPath), { recursive: true });
  const sqlite = new Database(input.temporaryDbPath);
  try {
    sqlite.pragma("foreign_keys = ON");
    const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../infra/migrations");
    const migrationFiles = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    if (migrationFiles.length === 0) {
      throw new RestoreDrillError("MIGRATIONS_MISSING", `no SQL migrations found in ${migrationsDir}`);
    }
    for (const file of migrationFiles) {
      sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }

    for (const releaseId of requiredIds) {
      const releaseManifest = verifiedBundles.get(releaseId);
      if (!releaseManifest) {
        throw new RestoreDrillError("RESTORE_BUNDLE_INVALID", `bundle for ${releaseId} vanished mid-restore`);
      }
      const bundleDir = join(input.releaseBundleDir, releaseId);
      sqlite
        .prepare(
          `INSERT INTO content_release (release_id, source_pdf_sha256, schema_version, prompt_version,
             model_config_json, status, created_at, activated_at, manifest_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          releaseId,
          releaseManifest.source_pdf_sha256,
          releaseManifest.config_versions.schema_version,
          releaseManifest.config_versions.prompt_version,
          JSON.stringify(releaseManifest.model_config),
          // Pointers are restored below; every import starts RETIRED.
          "RETIRED",
          Date.parse(releaseManifest.created_at),
          null,
          createHash("sha256")
            .update(readFileSync(join(bundleDir, "manifest.json"), "utf8"))
            .digest("hex"),
        );
      for (const unitReport of releaseManifest.units) {
        sqlite
          .prepare(
            `INSERT INTO release_unit (release_id, unit_key, status, words, senses, phrases, examples,
               explanations, cards, qa_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            releaseId,
            unitReport.unit_key,
            unitReport.status,
            unitReport.counts.words,
            unitReport.counts.senses,
            unitReport.counts.phrases,
            unitReport.counts.examples,
            unitReport.counts.explanations,
            unitReport.counts.cards,
            unitReport.qa_summary ?? null,
          );
      }
      for (const file of ["d1/001-content.sql", "d1/002-cards.sql", "d1/003-search.sql"]) {
        executeImportFile(sqlite, join(bundleDir, file));
      }
    }

    // -- 5. Restore active/previous pointers. -------------------------------
    if (manifest.active_release_id !== null) {
      sqlite
        .prepare("UPDATE content_release SET status = 'ACTIVE', activated_at = ? WHERE release_id = ?")
        .run(manifest.created_at, manifest.active_release_id);
      sqlite.prepare("UPDATE app_meta SET active_release_id = ? WHERE id = 1").run(manifest.active_release_id);
    }
    if (manifest.previous_release_id !== null && manifest.previous_release_id !== manifest.active_release_id) {
      sqlite
        .prepare("UPDATE content_release SET status = 'RETIRED' WHERE release_id = ?")
        .run(manifest.previous_release_id);
    }

    // -- 6. Alias edges, then user data (FK-safe table order). --------------
    for (const edge of manifest.alias_edges) {
      sqlite
        .prepare(
          `INSERT INTO content_key_alias (release_id, from_key, to_key, edge_type, canonical_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(edge.release_id, edge.from_key, edge.to_key, edge.edge_type, edge.canonical_key, edge.created_at);
    }
    const restoredRows: Record<string, number> = {};
    for (const table of BACKUP_TABLES) {
      const rows = rowsByTable.get(table) ?? [];
      for (const row of rows) {
        const columns = Object.keys(row);
        const quoted = columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(", ");
        const placeholders = columns.map(() => "?").join(", ");
        sqlite
          .prepare(`INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`)
          .run(...columns.map((column) => row[column]));
      }
      restoredRows[table] = rows.length;
    }
    const countsMatch = BACKUP_TABLES.every((table) => (manifest.row_counts[table] ?? -1) === restoredRows[table]);
    checks.push(
      check(
        "row_counts",
        countsMatch,
        BACKUP_TABLES.map((table) => `${table}=${restoredRows[table] ?? 0}`).join(", "),
      ),
    );

    // -- 7. Rebuild FTS from the content tables (not a backup source). ------
    sqlite.exec("INSERT INTO content_search_fts(content_search_fts) VALUES('rebuild');");

    // -- 8. Post-import verification. ---------------------------------------
    const foreignKeyViolations = sqlite.prepare("PRAGMA foreign_key_check").all();
    checks.push(
      check(
        "foreign_keys",
        foreignKeyViolations.length === 0,
        foreignKeyViolations.length === 0 ? undefined : `${foreignKeyViolations.length} dangling reference(s)`,
      ),
    );
    const ftsRows = Number((sqlite.prepare("SELECT COUNT(*) AS n FROM content_search_fts").get() as { n: number }).n);
    const searchable = Number(
      (
        sqlite
          .prepare(
            `SELECT (SELECT COUNT(*) FROM word) + (SELECT COUNT(*) FROM sense)
                    + (SELECT COUNT(*) FROM phrase) + (SELECT COUNT(*) FROM example) AS n`,
          )
          .get() as { n: number }
      ).n,
    );
    checks.push(
      check(
        "fts_rebuilt",
        ftsRows === searchable && searchable > 0,
        `index rows ${ftsRows} vs searchable content ${searchable}`,
      ),
    );

    const aliases = new AliasRepository(createSqliteDatabase(sqlite));
    let aliasOk = true;
    const aliasDetails: string[] = [];
    for (const edge of manifest.alias_edges) {
      try {
        const resolved = await aliases.resolve({ releaseId: edge.release_id, key: edge.from_key });
        if (resolved !== edge.canonical_key) {
          aliasOk = false;
          aliasDetails.push(`${edge.from_key} -> ${resolved} != ${edge.canonical_key}`);
        }
      } catch (error) {
        aliasOk = false;
        aliasDetails.push(`${edge.from_key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    checks.push(
      check(
        "alias_resolution",
        aliasOk,
        aliasOk ? `${manifest.alias_edges.length} edge(s) resolve canonically` : aliasDetails.join("; "),
      ),
    );

    const failed = checks.filter((candidate) => !candidate.passed);
    if (failed.length > 0) {
      throw new RestoreDrillError(
        "RESTORE_VERIFICATION_FAILED",
        `restore drill verification failed: ${failed.map((candidate) => candidate.name).join(", ")}`,
      );
    }
    return {
      temporaryDbPath: input.temporaryDbPath,
      releases: requiredIds,
      restoredRows,
      ftsRows,
      checks,
    };
  } catch (error) {
    // Never leave a failed drill database behind.
    removeTemporaryDb(input.temporaryDbPath);
    throw error;
  } finally {
    sqlite.close();
  }
}

/** Resolves a CLI path against the process working directory. */
export function toAbsolute(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}
