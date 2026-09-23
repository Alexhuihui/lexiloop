/**
 * Release publishing script (spec 5.9/6.4/11.3): the operator entry point for
 * the release lifecycle — verify -> stage -> smoke -> activate, or rollback.
 *
 * Local rehearsal wiring: the D1 database is a D1-shaped SQLite file and the
 * private R2 store is a content-addressed directory. Both are exact fakes of
 * the production bindings' semantics (same schema, same idempotent
 * content-addressed objects), which makes the whole lifecycle rehearsable on
 * a workstation before a remote deployment (spec 17: rollback rehearsal).
 *
 * Remote wiring (--remote, Task 19): the SAME lifecycle runs against the real
 * Cloudflare bindings through the Wrangler CLI — `wrangler d1 execute
 * --remote` for D1 and `wrangler r2 object` for the private bucket. The
 * target comes from infra/wrangler/wrangler.toml (untracked production
 * config), overridable with --d1-database/--r2-bucket. The checks, evaluators,
 * and statements are the SAME functions the local flow uses
 * (tools/content-compiler/src/release/*): uploads are unconditional
 * (content-addressed keys make re-uploads byte-identical), smoke failures
 * record FAILED and never move the pointer, and activation applies the exact
 * batch statement list sequentially with the pointer switch last — a failure
 * stops before it. There is no --force and no manual status override: a
 * failed verification, smoke check, or activation leaves the previous
 * release ACTIVE.
 *
 * Examples:
 *   tsx scripts/publish-release.ts --bundle .lexiloop-private/releases/<id> \
 *     --db .lexiloop-private/d1/rehearsal.sqlite --r2-dir .lexiloop-private/r2
 *   tsx scripts/publish-release.ts --rollback <previous-release-id> --db ... --r2-dir ...
 *   tsx scripts/publish-release.ts --bundle .lexiloop-private/releases/<id> --remote \
 *     [--aliases <edges.json>] [--no-activate]
 *   tsx scripts/publish-release.ts --rollback <release-id> --remote
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import Database from "better-sqlite3";
import { createSqliteDatabase } from "../packages/db/src/index";
import { ReleaseRepository } from "../packages/db/src/index";
import {
  AliasFileSchema,
  activateRelease,
  rollbackRelease,
  smokeRelease,
  stageBundle,
  type R2AudioStore,
} from "../tools/content-compiler/src/release/publish";
import { verifyBundle } from "../tools/content-compiler/src/release/validate";
import {
  createWranglerCli,
  readWranglerTarget,
  remoteRollbackRelease,
  runRemotePublish,
} from "../tools/content-compiler/src/release/remote";

interface Args {
  bundle?: string;
  db?: string;
  r2Dir?: string;
  privateRoot?: string;
  aliases?: string;
  rollback?: string;
  noActivate: boolean;
  remote: boolean;
  d1Database?: string;
  r2Bucket?: string;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_TOML = join(REPO_ROOT, "infra", "wrangler", "wrangler.toml");

function usage(): never {
  process.stderr.write(
    "usage: tsx scripts/publish-release.ts --bundle <dir> --db <sqlite-file> --r2-dir <dir> " +
      "[--private-root <dir>] [--aliases <edges.json>] [--no-activate]\n" +
      "       tsx scripts/publish-release.ts --rollback <release-id> --db <sqlite-file> --r2-dir <dir>\n" +
      "       tsx scripts/publish-release.ts --bundle <dir> --remote [--d1-database <name>] " +
      "[--r2-bucket <name>] [--aliases <edges.json>] [--no-activate]\n" +
      "       tsx scripts/publish-release.ts --rollback <release-id> --remote\n",
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { noActivate: false, remote: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--bundle": args.bundle = value; i += 1; break;
      case "--db": args.db = value; i += 1; break;
      case "--r2-dir": args.r2Dir = value; i += 1; break;
      case "--private-root": args.privateRoot = value; i += 1; break;
      case "--aliases": args.aliases = value; i += 1; break;
      case "--rollback": args.rollback = value; i += 1; break;
      case "--no-activate": args.noActivate = true; break;
      case "--remote": args.remote = true; break;
      case "--d1-database": args.d1Database = value; i += 1; break;
      case "--r2-bucket": args.r2Bucket = value; i += 1; break;
      default: usage();
    }
  }
  if (args.remote && (args.db !== undefined || args.r2Dir !== undefined)) {
    process.stderr.write(
      "--remote is mutually exclusive with --db/--r2-dir: the remote target comes from " +
        "infra/wrangler/wrangler.toml (or --d1-database/--r2-bucket overrides)\n",
    );
    process.exit(2);
  }
  if (!args.remote && (!args.db || !args.r2Dir)) usage();
  if (!args.bundle && !args.rollback) usage();
  return args;
}

const toAbs = (value: string): string => (isAbsolute(value) ? value : resolve(process.cwd(), value));

/** Filesystem-backed private object store with R2 key semantics. */
function createDirectoryR2(root: string): R2AudioStore {
  const objectPath = (objectKey: string): string => join(root, objectKey);
  return {
    async head(objectKey) {
      const filePath = objectPath(objectKey);
      if (!existsSync(filePath)) return null;
      return { size: statSync(filePath).size };
    },
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

/** The --remote lifecycle against the real Cloudflare bindings. */
async function runRemote(args: Args): Promise<number> {
  const target = readWranglerTarget(WRANGLER_TOML, { d1Database: args.d1Database, r2Bucket: args.r2Bucket });
  console.log(
    `remote target: d1=${target.d1Database} r2=${target.r2Bucket} (config ${target.configPath}); ` +
      "no --force and no bypass exists",
  );
  const cli = createWranglerCli();
  if (args.rollback) {
    const result = await remoteRollbackRelease({ cli, target, releaseId: args.rollback, now: Date.now() });
    console.log(`rollback OK: release ${result.releaseId} ACTIVE again (undone ${result.previousReleaseId ?? "none"})`);
    return 0;
  }
  let aliases: readonly unknown[] | undefined;
  if (args.aliases) {
    aliases = AliasFileSchema.parse(JSON.parse(readFileSync(toAbs(args.aliases), "utf8"))).edges;
  }
  await runRemotePublish({
    cli,
    target,
    bundleDir: toAbs(args.bundle!),
    privateRoot: toAbs(args.privateRoot ?? ".lexiloop-private"),
    ...(aliases !== undefined ? { aliases } : {}),
    activate: !args.noActivate,
    uploadConcurrency: 16,
    now: Date.now(),
    log: (line) => console.log(line),
  });
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.remote) {
    return await runRemote(args);
  }

  const privateRoot = toAbs(args.privateRoot ?? ".lexiloop-private");
  const sqlite = ensureMigrated(toAbs(args.db!));
  const db = createSqliteDatabase(sqlite);
  const r2 = createDirectoryR2(toAbs(args.r2Dir!));

  if (args.rollback) {
    const result = await rollbackRelease({ db, releaseId: args.rollback, now: Date.now() });
    console.log(`rollback OK: release ${result.releaseId} ACTIVE again (undone ${result.previousReleaseId ?? "none"})`);
    return 0;
  }

  const bundleDir = toAbs(args.bundle!);
  const verified = await verifyBundle(bundleDir);
  if (!verified.ok || !verified.manifest) {
    for (const error of verified.errors) {
      console.error(`verify FAIL ${error.path}: ${error.reason}`);
    }
    console.error("bundle verification failed; the old release stays ACTIVE");
    return 1;
  }
  console.log(
    `verify OK: release ${verified.manifest.release_id} (${verified.manifest.files.length} file(s), ` +
      `manifest ${verified.manifestSha256?.slice(0, 12)})`,
  );

  const audioRoot = join(privateRoot, "work", verified.manifest.source_pdf_sha256);
  const staged = await stageBundle({ db, r2, bundleDir, audioRoot, now: Date.now() });
  console.log(
    `stage OK: release ${staged.releaseId} IMPORTING (audio uploaded=${staged.uploaded} reused=${staged.reused}; app_meta untouched)`,
  );

  const smoke = await smokeRelease({ db, r2, releaseId: staged.releaseId });
  for (const check of smoke.checks) {
    console.log(`smoke ${check.passed ? "PASS" : "FAIL"} ${check.name}${check.detail ? ` (${check.detail})` : ""}`);
  }
  console.log(`smoke OK: release ${staged.releaseId} READY`);

  if (args.noActivate) {
    console.log("activation skipped (--no-activate); the old release stays ACTIVE");
    return 0;
  }

  let aliases: readonly unknown[] | undefined;
  if (args.aliases) {
    aliases = AliasFileSchema.parse(JSON.parse(readFileSync(toAbs(args.aliases), "utf8"))).edges;
  }
  const activated = await activateRelease({
    db,
    releaseId: staged.releaseId,
    ...(aliases !== undefined ? { aliases } : {}),
    now: Date.now(),
  });
  console.log(
    `activate OK: release ${activated.releaseId} ACTIVE (previous ${activated.previousReleaseId ?? "none"}, ` +
      `aliases ${activated.aliasesImported})`,
  );

  const active = await new ReleaseRepository(db).getActive();
  console.log(`active release: ${active?.releaseId ?? "none"}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : "PUBLISH_FAILED";
    console.error(`publish failed [${code}]: ${message}`);
    console.error("the previous release stays ACTIVE; nothing was activated");
    process.exitCode = 1;
  });
