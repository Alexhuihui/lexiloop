/**
 * Security: Git hygiene scan (plan Task 18 step 4). Asserts that NO tracked
 * file is (or looks like) a secret or private artifact: no .env/.dev.vars,
 * no key-shaped values, no PDFs, nothing under .lexiloop-private/, no
 * cleaned page images / OCR text / real audio / release bundles. Runs
 * against `git ls-files`, so a file only passes by NOT BEING TRACKED.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface TrackedFile {
  path: string;
  /** File bytes (empty for oversized files; they are still path-scanned). */
  bytes: Buffer;
  truncated: boolean;
}

/** Files that legitimately mention secret-shaped words but hold no secret. */
const PATH_ALLOWLIST = [".env.example"];

/** Text files that are too large to scan fully (path rules still apply). */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

function trackedFiles(): TrackedFile[] {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "buffer" });
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path !== "")
    .map((path) => {
      try {
        const bytes = readFileSync(join(repoRoot, path));
        return { path, bytes, truncated: bytes.length > MAX_SCAN_BYTES };
      } catch {
        // Deleted between ls-files and read (race): treat as empty text.
        return { path, bytes: Buffer.alloc(0), truncated: false };
      }
    });
}

const files = trackedFiles();

describe("tracked-file secret and private-artifact scan", () => {
  it("scans a healthy number of tracked files (git repo is real)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("tracks no .env, .dev.vars, or private credential file", () => {
    const offenders = files
      .map((file) => file.path)
      .filter((path) => {
        const base = path.split("/").pop() ?? path;
        if (path === ".env.example") {
          return false;
        }
        return base === ".env" || base.startsWith(".env.") || base === ".dev.vars" || base === ".dev.vars.";
      });
    expect(offenders, "credential files must never be tracked").toEqual([]);
  });

  it("tracks no key-shaped secret values in any file", () => {
    const patterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
      { name: "OpenAI-style API key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
      { name: "bearer token literal", pattern: /Bearer\s+[A-Za-z0-9._-]{25,}/ },
      { name: "MiMo API key with content", pattern: /MIMO_API_KEY[ \t]*=[ \t]*\S+/ },
      { name: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    ];
    const offenders: string[] = [];
    for (const file of files) {
      if (file.truncated || PATH_ALLOWLIST.includes(file.path)) {
        continue;
      }
      const text = file.bytes.toString("latin1");
      for (const { name, pattern } of patterns) {
        if (pattern.test(text)) {
          offenders.push(`${file.path} (${name})`);
        }
      }
    }
    expect(offenders, "key-shaped values must never be tracked").toEqual([]);
  });

  it("tracks no credential-looking assignment outside test fixtures", () => {
    // Test files hold intentionally synthetic dummy credentials; anywhere
    // else, a quoted literal assigned to a credential-named variable is a
    // leak signal.
    const generic = /(?:api_key|apikey|secret|password|token|passwd)[ \t]*=[ \t]*["'][^"']{12,}["']/i;
    const offenders: string[] = [];
    for (const file of files) {
      if (file.truncated || PATH_ALLOWLIST.includes(file.path)) {
        continue;
      }
      if (/(?:^|\/)(?:test|tests|e2e)(?:\/|\.)/.test(file.path)) {
        continue;
      }
      if (generic.test(file.bytes.toString("latin1"))) {
        offenders.push(file.path);
      }
    }
    expect(offenders, "credential assignments outside tests must never be tracked").toEqual([]);
  });

  it("tracks no PDF source or private pipeline artifact", () => {
    const offenders = files
      .map((file) => file.path)
      .filter(
        (path) =>
          path.toLowerCase().endsWith(".pdf") ||
          path.startsWith(".lexiloop-private/") ||
          path.startsWith("artifacts/"),
      );
    expect(offenders, "source PDFs and private artifacts must never be tracked").toEqual([]);
  });

  it("tracks no real audio, cleaned page image, or release bundle", () => {
    const audioExtensions = [".wav", ".mp3", ".m4a", ".flac", ".ogg", ".opus"];
    const offenders = files
      .map((file) => file.path)
      .filter((path) => {
        const lower = path.toLowerCase();
        if (audioExtensions.some((extension) => lower.endsWith(extension))) {
          return true;
        }
        // Compiled release bundles and OCR dumps travel with the private
        // work dir; any tracked occurrence is a leak.
        return /(^|\/)(release-bundle|ocr-output|cleaned-pages)(\/|$)/.test(lower);
      });
    expect(offenders, "real audio and private media must never be tracked").toEqual([]);
  });

  it("keeps the tracked tree free of file paths that embed credential material", () => {
    const offenders = files
      .map((file) => file.path)
      .filter((path) =>
        /(?:credentials?|api[_-]?key|secret[_-]?key|\.pem$|\.p12$|\.keystore$)/i.test(path),
      );
    expect(offenders, "no tracked path should embed credential material").toEqual([]);
  });
});
