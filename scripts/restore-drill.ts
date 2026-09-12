/**
 * Restore drill (spec 13.1/17, plan Task 14): restores a user-data backup into
 * an EXPLICITLY newly-created temporary SQLite database and verifies it —
 * migrations, the exact required-release bundle set (every bundle hash),
 * release/alias import, user-data import, active/previous pointer restore,
 * FTS rebuild, then row-count/FK/alias-resolution verification. Missing or
 * extra ambiguous bundles fail BEFORE any user row is written; a failed
 * verification deletes the temporary database.
 *
 * Example (matches the committed synthetic fixtures):
 *   tsx scripts/restore-drill.ts \
 *     --release-bundle-dir tests/fixtures/releases/retained-set \
 *     --backup tests/fixtures/backup/minimal.jsonl.gz \
 *     --temporary-db .lexiloop-private/restore-drill.sqlite
 *
 * Only exact paths are accepted: no globs, no broad prefixes, and cleanup/
 * retention decisions stay in apps/worker/src/releases/retention.ts (dry-run
 * by default, exact ids only).
 */
import process from "node:process";
import {
  RestoreDrillError,
  runRestoreDrill,
  toAbsolute,
} from "../apps/worker/src/backups/restore";

interface Args {
  backup?: string;
  releaseBundleDir?: string;
  temporaryDb?: string;
}

function usage(): never {
  process.stderr.write(
    "usage: tsx scripts/restore-drill.ts --release-bundle-dir <dir-with-every-required-bundle> " +
      "--backup <user-data.jsonl.gz> --temporary-db <new-sqlite-file>\n",
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--backup": args.backup = value; i += 1; break;
      case "--release-bundle-dir": args.releaseBundleDir = value; i += 1; break;
      case "--temporary-db": args.temporaryDb = value; i += 1; break;
      default: usage();
    }
  }
  if (!args.backup || !args.releaseBundleDir || !args.temporaryDb) usage();
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runRestoreDrill({
    backupPath: toAbsolute(args.backup!),
    releaseBundleDir: toAbsolute(args.releaseBundleDir!),
    temporaryDbPath: toAbsolute(args.temporaryDb!),
  });
  for (const releaseId of result.releases) {
    process.stdout.write(`release imported: ${releaseId}\n`);
  }
  for (const entry of result.checks) {
    process.stdout.write(`check ${entry.passed ? "PASS" : "FAIL"} ${entry.name}${entry.detail ? ` (${entry.detail})` : ""}\n`);
  }
  process.stdout.write(
    `restore drill OK: ${result.temporaryDbPath} (${result.ftsRows} FTS row(s) rebuilt from content tables)\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof RestoreDrillError) {
      process.stderr.write(`restore drill failed [${error.code}]: ${error.message}\n`);
    } else {
      process.stderr.write(`restore drill failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.stderr.write("no temporary database was kept; fix the inputs and re-run\n");
    process.exitCode = 1;
  });
