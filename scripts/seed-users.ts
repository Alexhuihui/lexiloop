/**
 * seed-users — local-only account provisioning (spec 7.1).
 *
 * There is no registration/OAuth/recovery anywhere in LexiLoop: accounts are
 * preseeded with this command on a workstation, against the local D1-shaped
 * SQLite database.
 *
 *   tsx scripts/seed-users.ts --db <d1-shaped-sqlite-file> --input <private-file>
 *   tsx scripts/seed-users.ts --db <d1-shaped-sqlite-file>          (TTY prompts)
 *
 * Usernames/passwords are read from an untracked private file or from
 * interactive input — NEVER from command-line arguments. The input file holds
 * one account per line as `username:password`; `#` comments and blank lines
 * are skipped. Keep it under `.lexiloop-private/` (git-ignored) and delete
 * it after seeding.
 *
 * Every account gets an independent random salt and a PBKDF2-SHA256 verifier
 * (Web Crypto, versioned envelope) — D1 never stores plaintext. Re-seeding an
 * existing username rotates salt/verifier and increments `session_version`,
 * instantly invalidating all of that account's outstanding sessions.
 *
 * Output prints only user ids, usernames, and status — never credentials.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { stdin, stdout } from "node:process";
import Database from "better-sqlite3";
import { UserRepository, createSqliteDatabase, type LexiloopDatabase } from "../packages/db/src/index";
import { hashPassword, normalizeUsername } from "../apps/worker/src/auth/password";
import { sha256Hex } from "../apps/worker/src/auth/session";

interface Account {
  username: string;
  password: string;
}

const MIN_PASSWORD_LENGTH = 8;

const toAbs = (value: string): string => (isAbsolute(value) ? value : resolve(process.cwd(), value));

function usage(): never {
  process.stderr.write(
    "usage: tsx scripts/seed-users.ts --db <d1-shaped-sqlite-file> [--input <private-users-file>]\n" +
      "credentials are read from the private input file or interactive input only; they are never command-line arguments\n",
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): { db: string; input?: string } {
  const args: { db?: string; input?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    switch (argv[i]) {
      case "--db": args.db = value; i += 1; break;
      case "--input": args.input = value; i += 1; break;
      default: usage();
    }
  }
  if (!args.db) usage();
  return { db: toAbs(args.db), ...(args.input !== undefined ? { input: toAbs(args.input) } : {}) };
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

function readInputFile(path: string): Account[] {
  const content = readFileSync(path, "utf8");
  const accounts: Account[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf(":");
    if (separator <= 0 || separator === trimmed.length - 1) {
      throw new Error(`input line ${index + 1}: expected "username:password"`);
    }
    accounts.push({ username: trimmed.slice(0, separator), password: trimmed.slice(separator + 1) });
  }
  return accounts;
}

async function readInteractiveAccounts(): Promise<Account[]> {
  const rl = createInterface({ input: stdin, output: stdout });
  const accounts: Account[] = [];
  try {
    for (;;) {
      const username = (await rl.question("username (empty to finish): ")).trim();
      if (username.length === 0) {
        break;
      }
      const password = await rl.question(`password for ${username}: `);
      accounts.push({ username, password });
    }
  } finally {
    rl.close();
  }
  return accounts;
}

function assertAccountUsable(account: Account): string {
  const normalized = normalizeUsername(account.username);
  if (normalized.length === 0) {
    throw new Error(`account "${account.username}" rejected: username is empty after normalization`);
  }
  if (account.password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`account "${account.username}" rejected: password shorter than ${MIN_PASSWORD_LENGTH} characters`);
  }
  return normalized;
}

/** Creates or rotates one account; prints only id/username/status/version. */
async function seedAccount(db: LexiloopDatabase, account: Account, now: number): Promise<void> {
  const normalized = assertAccountUsable(account);
  const hashed = await hashPassword(account.password);
  const users = new UserRepository(db);
  const existing = await users.getByNormalizedUsername(normalized);
  if (existing) {
    const updated = await users.rotateCredentials(
      { userId: existing.userId },
      { passwordSalt: hashed.salt, passwordVerifier: hashed.verifier },
    );
    const sessionVersion = updated?.sessionVersion ?? existing.sessionVersion + 1;
    console.log(`seeded user_id=${existing.userId} username=${normalized} status=upserted session_version=${sessionVersion}`);
    return;
  }
  const userId = `user-${(await sha256Hex(normalized)).slice(0, 16)}`;
  const created = await users.create({
    userId,
    normalizedUsername: normalized,
    passwordSalt: hashed.salt,
    passwordVerifier: hashed.verifier,
    createdAt: now,
  });
  console.log(`seeded user_id=${created.userId} username=${normalized} status=created session_version=${created.sessionVersion}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.input === undefined && !stdin.isTTY) {
    process.stderr.write("seed-users: no --input file given; interactive input requires a TTY\n");
    return 2;
  }
  const accounts = args.input !== undefined ? readInputFile(args.input) : await readInteractiveAccounts();
  if (accounts.length === 0) {
    console.error("seed-users: no accounts provided");
    return 1;
  }
  const sqlite = ensureMigrated(args.db);
  try {
    const db = createSqliteDatabase(sqlite);
    const now = Date.now();
    for (const account of accounts) {
      await seedAccount(db, account, now);
    }
  } finally {
    sqlite.close();
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    // Never include account input in the failure output.
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`seed-users failed: ${message}`);
    process.exitCode = 1;
  });
