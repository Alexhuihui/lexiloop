/**
 * Local user-data backup (spec 13.1, plan Task 14): runs the SAME exporter as
 * the Worker `scheduled()` handler (apps/worker/src/backups/export.ts) against
 * a D1-shaped SQLite database and a directory-backed private R2 store —
 * exact fakes of the production bindings (publish-release.ts conventions), so
 * an on-demand backup is byte-compatible with the scheduled one and can feed
 * scripts/restore-drill.ts.
 *
 * Examples:
 *   tsx scripts/backup-user-data.ts --db .lexiloop-private/d1/rehearsal.sqlite \
 *     --r2-dir .lexiloop-private/r2
 *
 * Exports app_user / user_settings / word_progress / card_state / review_log /
 * study_session as gzip JSONL + manifest under backups/<UTC-date>/ in the
 * private store. Content is never exported: it is rebuilt from the retained
 * immutable release bundles (spec 13.1).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import Database from "better-sqlite3";
import { createSqliteDatabase, type LexiloopDatabase } from "../packages/db/src/index";
import { exportUserData } from "../apps/worker/src/backups/export";

interface Args {
  db?: string;
  r2Dir?: string;
}

function usage(): never {
  process.stderr.write("usage: tsx scripts/backup-user-data.ts --db <sqlite-file> --r2-dir <dir>\n");
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--db": args.db = value; i += 1; break;
      case "--r2-dir": args.r2Dir = value; i += 1; break;
      default: usage();
    }
  }
  if (!args.db || !args.r2Dir) usage();
  return args;
}

const toAbs = (value: string): string => (isAbsolute(value) ? value : resolve(process.cwd(), value));

/** Filesystem-backed private object store with R2 key semantics (publish-release convention). */
function createDirectoryR2(root: string): { put(objectKey: string, body: Uint8Array): Promise<void> } {
  const objectPath = (objectKey: string): string => join(root, objectKey);
  return {
    async put(objectKey, body) {
      const filePath = objectPath(objectKey);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    },
  };
}

/** Applies infra/migrations when the database is empty (idempotent). */
function ensureMigrated(dbFile: string): Database.Database {
  const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../infra/migrations");
  const firstRun = !existsSync(dbFile) || statSync(dbFile).size === 0;
  mkdirSync(dirname(dbFile), { recursive: true });
  const sqlite = new Database(dbFile);
  sqlite.pragma("foreign_keys = ON");
  const hasAppMeta =
    sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'app_meta'").get() as
      { n: number } | undefined;
  if (firstRun || (hasAppMeta?.n ?? 0) === 0) {
    const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
  }
  return sqlite;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const sqlite = ensureMigrated(toAbs(args.db!));
  const db: LexiloopDatabase = createSqliteDatabase(sqlite);
  const bucket = createDirectoryR2(toAbs(args.r2Dir!));

  const result = await exportUserData({
    db,
    bucket: bucket,
    now: Date.now(),
  });
  const rowTotal = Object.values(result.manifest.row_counts).reduce((accumulator, count) => accumulator + count, 0);
  process.stdout.write(
    `backup OK: ${result.manifest.object_key} (${rowTotal} row(s), sha256 ${result.manifest.sha256.slice(0, 12)})\n`,
  );
  for (const entry of result.manifest.required_releases) {
    process.stdout.write(`  required release ${entry.release_id}: ${entry.reasons.join(", ")}\n`);
  }
  process.stdout.write(
    `manifest uploaded next to the data object; restore with scripts/restore-drill.ts ` +
      `--backup <user-data.jsonl.gz> --release-bundle-dir <retained bundles>\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`backup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
