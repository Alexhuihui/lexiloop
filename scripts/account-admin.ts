/**
 * Agent-friendly LexiLoop account administration CLI.
 *
 * Passwords are generated internally and written once to a mode-0600 receipt.
 * They never appear in argv, SQL logs, or normal stdout. Remote mutations use
 * a private temporary SQL file and require the explicit --confirm-remote flag.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { hashPassword, normalizeUsername, randomBytes } from "../apps/worker/src/auth/password";
import { sha256Hex } from "../apps/worker/src/auth/session";

const TRIAL_DURATION_MS = 90 * 60 * 1000;
const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;

type AccountType = "TRIAL" | "FORMAL";
type Command = "create" | "inspect" | "list" | "promote" | "disable" | "enable" | "reset-password" | "sweep-expired";

interface ParsedArgs {
  command: Command;
  options: Map<string, string | true>;
}

interface LocalTarget {
  kind: "local";
  dbFile: string;
}

interface RemoteTarget {
  kind: "remote";
  database: string;
  config: string;
  confirmed: boolean;
}

type Target = LocalTarget | RemoteTarget;

interface AccountRow {
  user_id: string;
  normalized_username: string;
  status: string;
  account_type: AccountType;
  access_expires_at: number | null;
  external_ref: string | null;
  session_version: number;
  created_at: number;
}

interface CredentialReceipt {
  version: 1;
  username: string;
  password: string;
  account_type: AccountType;
  access_expires_at: number | null;
  external_ref: string | null;
  login_url: string | null;
  issued_at: number;
}

function usage(message?: string): never {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(`usage:
  pnpm accounts create --type trial|formal (--db <sqlite> | --remote) --receipt <private.json> [--username <name>] [--external-ref <order>] [--login-url <url>]
  pnpm accounts inspect --username <name> (--db <sqlite> | --remote)
  pnpm accounts list (--db <sqlite> | --remote) [--limit <1-500>]
  pnpm accounts promote|disable|enable --username <name> (--db <sqlite> | --remote)
  pnpm accounts reset-password --username <name> (--db <sqlite> | --remote) --receipt <private.json> [--login-url <url>]
  pnpm accounts sweep-expired (--db <sqlite> | --remote)

remote options: --database <name> --config <wrangler.toml>; mutations also require --confirm-remote
testing option: --now <ISO-8601 or epoch-ms>
`);
  process.exit(2);
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] as Command | undefined;
  const commands = new Set<Command>([
    "create",
    "inspect",
    "list",
    "promote",
    "disable",
    "enable",
    "reset-password",
    "sweep-expired",
  ]);
  if (!command || !commands.has(command)) usage("missing or unknown command");
  const options = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) usage(`unexpected argument: ${token}`);
    const key = token.slice(2);
    if (options.has(key)) usage(`duplicate option: --${key}`);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { command, options };
}

function stringOption(options: Map<string, string | true>, key: string): string | undefined {
  const value = options.get(key);
  if (value === true) usage(`--${key} requires a value`);
  return value;
}

function requiredOption(options: Map<string, string | true>, key: string): string {
  const value = stringOption(options, key);
  if (!value) usage(`missing --${key}`);
  return value;
}

function absolutePath(value: string): string {
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

function targetFrom(options: Map<string, string | true>): Target {
  const db = stringOption(options, "db");
  const remote = options.get("remote") === true;
  if ((db ? 1 : 0) + (remote ? 1 : 0) !== 1) {
    usage("choose exactly one target: --db <sqlite> or --remote");
  }
  if (db) return { kind: "local", dbFile: absolutePath(db) };
  const config = absolutePath(stringOption(options, "config") ?? "infra/wrangler/wrangler.toml");
  return {
    kind: "remote",
    database: stringOption(options, "database") ?? databaseNameFromConfig(config),
    config,
    confirmed: options.get("confirm-remote") === true,
  };
}

function databaseNameFromConfig(config: string): string {
  if (!existsSync(config)) throw new Error(`wrangler config not found: ${config}`);
  const content = readFileSync(config, "utf8");
  const block = /\[\[d1_databases\]\]([\s\S]*?)(?=\n\[|$)/.exec(content)?.[1] ?? "";
  const name = /^\s*database_name\s*=\s*"([^"]+)"\s*$/m.exec(block)?.[1];
  if (!name || name.includes("<")) {
    throw new Error(`cannot resolve production database_name from: ${config}`);
  }
  return name;
}

function nowFrom(options: Map<string, string | true>): number {
  const raw = stringOption(options, "now");
  if (!raw) return Date.now();
  const numeric = Number(raw);
  const parsed = Number.isFinite(numeric) && raw.trim() !== "" ? numeric : Date.parse(raw);
  if (!Number.isFinite(parsed)) usage("--now must be ISO-8601 or epoch milliseconds");
  return Math.trunc(parsed);
}

function quoteSql(value: string | null): string {
  return value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;
}

function ensureLocalDatabase(dbFile: string): Database.Database {
  mkdirSync(dirname(dbFile), { recursive: true });
  const sqlite = new Database(dbFile);
  sqlite.pragma("foreign_keys = ON");
  const exists = sqlite
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'app_user'")
    .get() as { n: number };
  if (exists.n === 0) {
    const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../infra/migrations");
    for (const file of readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort()) {
      sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
    }
  }
  return sqlite;
}

function remoteQuery(target: RemoteTarget, sql: string): unknown {
  if (!existsSync(target.config)) throw new Error(`wrangler config not found: ${target.config}`);
  const result = spawnSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", target.database, "--remote", "-c", target.config, "--command", sql, "--json"],
    { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) {
    const summary = (result.stderr || result.stdout || "wrangler failed").trim().split("\n").slice(-4).join("\n");
    throw new Error(summary);
  }
  const output = result.stdout.trim();
  if (output === "") return [];
  return JSON.parse(output);
}

function remoteMutation(target: RemoteTarget, sql: string): void {
  if (!existsSync(target.config)) throw new Error(`wrangler config not found: ${target.config}`);
  const dir = mkdtempSync(join(tmpdir(), "lexiloop-account-sql-"));
  const sqlFile = join(dir, "command.sql");
  try {
    writeFileSync(sqlFile, sql, { encoding: "utf8", mode: 0o600 });
    const result = spawnSync(
      "pnpm",
      ["exec", "wrangler", "d1", "execute", target.database, "--remote", "-c", target.config, "--file", sqlFile],
      { cwd: process.cwd(), encoding: "utf8", timeout: 120_000 },
    );
    if (result.status !== 0) {
      const summary = (result.stderr || result.stdout || "wrangler failed").trim().split("\n").slice(-4).join("\n");
      throw new Error(summary);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function flattenRemoteRows(value: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (!entry || typeof entry !== "object") return;
    const record = entry as Record<string, unknown>;
    if (Array.isArray(record["results"])) {
      for (const result of record["results"]) {
        if (result && typeof result === "object") rows.push(result as Record<string, unknown>);
      }
    }
    if (record["result"] !== undefined) visit(record["result"]);
  };
  visit(value);
  return rows;
}

function query(target: Target, sql: string): Array<Record<string, unknown>> {
  if (target.kind === "remote") return flattenRemoteRows(remoteQuery(target, sql));
  const sqlite = ensureLocalDatabase(target.dbFile);
  try {
    return sqlite.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    sqlite.close();
  }
}

function mutate(target: Target, sql: string): void {
  if (target.kind === "remote") {
    if (!target.confirmed) usage("remote mutations require --confirm-remote");
    remoteMutation(target, sql);
    return;
  }
  const sqlite = ensureLocalDatabase(target.dbFile);
  try {
    sqlite.exec(sql);
  } finally {
    sqlite.close();
  }
}

function normalizedUsername(raw: string): string {
  const normalized = normalizeUsername(raw);
  if (!USERNAME_PATTERN.test(normalized)) {
    usage("username must be 3-64 lowercase letters, digits, dots, underscores, or hyphens");
  }
  return normalized;
}

function generatedUsername(type: AccountType, now: number): string {
  const date = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = [...randomBytes(4)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${type === "TRIAL" ? "trial" : "member"}-${date}-${suffix}`;
}

function generatedPassword(): string {
  return [...randomBytes(18)].map((byte) => PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]!).join("");
}

function writeReceipt(pathValue: string, receipt: CredentialReceipt): void {
  const path = absolutePath(pathValue);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function assertReceiptAvailable(pathValue: string): void {
  const path = absolutePath(pathValue);
  if (existsSync(path)) throw new Error(`receipt already exists: ${path}`);
}

function accountSelect(where = "1 = 1", limit = 100): string {
  return `SELECT user_id, normalized_username, status, account_type, access_expires_at, external_ref, session_version, created_at
FROM app_user WHERE ${where} ORDER BY created_at DESC LIMIT ${limit};`;
}

function printRows(rows: Array<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

async function createAccount(target: Target, options: Map<string, string | true>, now: number): Promise<void> {
  const rawType = requiredOption(options, "type").toLowerCase();
  const accountType: AccountType = rawType === "trial" ? "TRIAL" : rawType === "formal" ? "FORMAL" : usage("--type must be trial or formal");
  const username = normalizedUsername(stringOption(options, "username") ?? generatedUsername(accountType, now));
  const receiptPath = requiredOption(options, "receipt");
  assertReceiptAvailable(receiptPath);
  const externalRef = stringOption(options, "external-ref") ?? null;
  const loginUrl = stringOption(options, "login-url") ?? null;
  const accessExpiresAt = accountType === "TRIAL" ? now + TRIAL_DURATION_MS : null;
  if (query(target, accountSelect(`normalized_username = ${quoteSql(username)}`, 1)).length > 0) {
    throw new Error(`account already exists: ${username}`);
  }
  const password = generatedPassword();
  const hashed = await hashPassword(password);
  const userId = `user-${(await sha256Hex(username)).slice(0, 16)}`;
  mutate(
    target,
    `INSERT INTO app_user (
  user_id, normalized_username, password_salt, password_verifier, status,
  account_type, access_expires_at, external_ref, session_version, created_at
) VALUES (
  ${quoteSql(userId)}, ${quoteSql(username)}, ${quoteSql(hashed.salt)}, ${quoteSql(hashed.verifier)}, 'ACTIVE',
  ${quoteSql(accountType)}, ${accessExpiresAt ?? "NULL"}, ${quoteSql(externalRef)}, 1, ${now}
);`,
  );
  writeReceipt(receiptPath, {
    version: 1,
    username,
    password,
    account_type: accountType,
    access_expires_at: accessExpiresAt,
    external_ref: externalRef,
    login_url: loginUrl,
    issued_at: now,
  });
  const expiry = accessExpiresAt === null ? "none" : new Date(accessExpiresAt).toISOString();
  process.stdout.write(`created username=${username} type=${accountType} expires_at=${expiry} receipt=${absolutePath(receiptPath)}\n`);
}

async function resetPassword(target: Target, options: Map<string, string | true>, now: number): Promise<void> {
  const username = normalizedUsername(requiredOption(options, "username"));
  const receiptPath = requiredOption(options, "receipt");
  assertReceiptAvailable(receiptPath);
  const rows = query(target, accountSelect(`normalized_username = ${quoteSql(username)}`, 1));
  if (rows.length !== 1) throw new Error(`account not found: ${username}`);
  const row = rows[0] as unknown as AccountRow;
  const password = generatedPassword();
  const hashed = await hashPassword(password);
  mutate(
    target,
    `UPDATE app_user SET password_salt = ${quoteSql(hashed.salt)}, password_verifier = ${quoteSql(hashed.verifier)}, session_version = session_version + 1 WHERE normalized_username = ${quoteSql(username)};`,
  );
  writeReceipt(receiptPath, {
    version: 1,
    username,
    password,
    account_type: row.account_type,
    access_expires_at: row.access_expires_at,
    external_ref: row.external_ref,
    login_url: stringOption(options, "login-url") ?? null,
    issued_at: now,
  });
  process.stdout.write(`password-reset username=${username} sessions_invalidated=true\n`);
}

function mutationFor(command: Exclude<Command, "create" | "inspect" | "list" | "reset-password" | "sweep-expired">, username: string, now: number): string {
  switch (command) {
    case "promote":
      return `UPDATE app_user SET account_type = 'FORMAL', access_expires_at = NULL, status = 'ACTIVE', session_version = session_version + 1 WHERE normalized_username = ${quoteSql(username)};`;
    case "disable":
      return `UPDATE app_user SET status = 'DISABLED', session_version = session_version + 1 WHERE normalized_username = ${quoteSql(username)};`;
    case "enable":
      return `UPDATE app_user SET status = 'ACTIVE', session_version = session_version + 1 WHERE normalized_username = ${quoteSql(username)} AND (access_expires_at IS NULL OR access_expires_at > ${now});`;
  }
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  const target = targetFrom(options);
  const mutating = command !== "inspect" && command !== "list";
  if (mutating && target.kind === "remote" && !target.confirmed) {
    usage("remote mutations require --confirm-remote");
  }
  const now = nowFrom(options);
  if (command === "create") return await createAccount(target, options, now);
  if (command === "reset-password") return await resetPassword(target, options, now);
  if (command === "inspect") {
    const username = normalizedUsername(requiredOption(options, "username"));
    return printRows(query(target, accountSelect(`normalized_username = ${quoteSql(username)}`, 1)));
  }
  if (command === "list") {
    const rawLimit = stringOption(options, "limit") ?? "100";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) usage("--limit must be an integer from 1 to 500");
    return printRows(query(target, accountSelect("1 = 1", limit)));
  }
  if (command === "sweep-expired") {
    mutate(
      target,
      `UPDATE app_user SET status = 'DISABLED', session_version = session_version + 1 WHERE account_type = 'TRIAL' AND status = 'ACTIVE' AND access_expires_at IS NOT NULL AND access_expires_at <= ${now};`,
    );
    process.stdout.write(`expired-trials-swept cutoff=${new Date(now).toISOString()}\n`);
    return;
  }
  const username = normalizedUsername(requiredOption(options, "username"));
  const existing = query(target, accountSelect(`normalized_username = ${quoteSql(username)}`, 1));
  if (existing.length !== 1) throw new Error(`account not found: ${username}`);
  const row = existing[0] as unknown as AccountRow;
  if (command === "enable" && row.access_expires_at !== null && row.access_expires_at <= now) {
    throw new Error(`cannot enable expired trial; promote it instead: ${username}`);
  }
  mutate(target, mutationFor(command, username, now));
  process.stdout.write(`${command} username=${username} sessions_invalidated=true\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`account-admin failed: ${message}\n`);
  process.exitCode = 1;
});
