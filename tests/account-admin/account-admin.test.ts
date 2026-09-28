import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../../apps/worker/src/auth/password";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(repoRoot, "scripts", "account-admin.ts");
const T0 = 1_700_000_000_000;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lexiloop-account-admin-"));
  dirs.push(dir);
  return dir;
}

function run(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [tsxCli, cli, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("account-admin CLI", () => {
  it("creates a 90-minute trial without printing its password", async () => {
    const dir = tempDir();
    const dbFile = join(dir, "db.sqlite");
    const receiptFile = join(dir, "trial.private.json");
    const result = run([
      "create", "--type", "trial", "--username", "trial-alice", "--db", dbFile,
      "--receipt", receiptFile, "--external-ref", "order-1", "--now", String(T0),
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("type=TRIAL");
    const receipt = JSON.parse(readFileSync(receiptFile, "utf8")) as { password: string; access_expires_at: number };
    expect(receipt.access_expires_at).toBe(T0 + 90 * 60 * 1000);
    expect(receipt.password).toHaveLength(18);
    expect(result.stdout).not.toContain(receipt.password);
    expect(statSync(receiptFile).mode & 0o777).toBe(0o600);

    const db = new Database(dbFile);
    const row = db.prepare("SELECT * FROM app_user WHERE normalized_username = 'trial-alice'").get() as {
      account_type: string;
      access_expires_at: number;
      password_salt: string;
      password_verifier: string;
    };
    expect(row.account_type).toBe("TRIAL");
    expect(row.access_expires_at).toBe(receipt.access_expires_at);
    await expect(verifyPassword(receipt.password, { salt: row.password_salt, verifier: row.password_verifier })).resolves.toBe(true);
    db.close();

    const duplicateReceipt = run([
      "create", "--type", "formal", "--username", "buyer-other", "--db", dbFile,
      "--receipt", receiptFile, "--now", String(T0),
    ]);
    expect(duplicateReceipt.status).not.toBe(0);
    expect(duplicateReceipt.stderr).toContain("receipt already exists");
    const verifyDb = new Database(dbFile);
    expect(verifyDb.prepare("SELECT COUNT(*) AS n FROM app_user WHERE normalized_username = 'buyer-other'").get()).toEqual({ n: 0 });
    verifyDb.close();
  });

  it("creates permanent formal accounts and promotes trials without losing the account", () => {
    const dir = tempDir();
    const dbFile = join(dir, "db.sqlite");
    const formalReceipt = join(dir, "formal.private.json");
    const trialReceipt = join(dir, "trial.private.json");
    expect(run(["create", "--type", "formal", "--username", "buyer-001", "--db", dbFile, "--receipt", formalReceipt, "--now", String(T0)]).status).toBe(0);
    expect(run(["create", "--type", "trial", "--username", "trial-bob", "--db", dbFile, "--receipt", trialReceipt, "--now", String(T0)]).status).toBe(0);
    expect(run(["promote", "--username", "trial-bob", "--db", dbFile, "--now", String(T0)]).status).toBe(0);

    const db = new Database(dbFile);
    const rows = db.prepare("SELECT normalized_username, account_type, access_expires_at, status FROM app_user ORDER BY normalized_username").all() as Array<{
      normalized_username: string;
      account_type: string;
      access_expires_at: number | null;
      status: string;
    }>;
    expect(rows).toEqual([
      { normalized_username: "buyer-001", account_type: "FORMAL", access_expires_at: null, status: "ACTIVE" },
      { normalized_username: "trial-bob", account_type: "FORMAL", access_expires_at: null, status: "ACTIVE" },
    ]);
    db.close();
  });

  it("sweeps expired trials while leaving formal accounts active", () => {
    const dir = tempDir();
    const dbFile = join(dir, "db.sqlite");
    expect(run(["create", "--type", "trial", "--username", "trial-old", "--db", dbFile, "--receipt", join(dir, "trial.json"), "--now", String(T0)]).status).toBe(0);
    expect(run(["create", "--type", "formal", "--username", "buyer-live", "--db", dbFile, "--receipt", join(dir, "formal.json"), "--now", String(T0)]).status).toBe(0);
    expect(run(["sweep-expired", "--db", dbFile, "--now", String(T0 + 91 * 60 * 1000)]).status).toBe(0);
    const enable = run(["enable", "--username", "trial-old", "--db", dbFile, "--now", String(T0 + 91 * 60 * 1000)]);
    expect(enable.status).not.toBe(0);
    expect(enable.stderr).toContain("promote it instead");

    const db = new Database(dbFile);
    const statuses = db.prepare("SELECT normalized_username, status FROM app_user ORDER BY normalized_username").all();
    expect(statuses).toEqual([
      { normalized_username: "buyer-live", status: "ACTIVE" },
      { normalized_username: "trial-old", status: "DISABLED" },
    ]);
    db.close();
  });

  it("refuses a remote mutation without the explicit confirmation flag", () => {
    const result = run(["disable", "--username", "buyer-001", "--remote", "--database", "lexiloop"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("remote mutations require --confirm-remote");
    expect(result.stderr).not.toContain("pbkdf2-sha256$");
  });
});
