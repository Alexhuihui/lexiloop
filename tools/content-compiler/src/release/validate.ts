/**
 * Bundle verification (spec 5.9): the manifest is the root of trust for an
 * immutable release bundle. Verification re-hashes every declared file and
 * compares byte sizes, so any post-packaging mutation is caught before the
 * bundle is staged, and again after upload/import (publish.ts).
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ReleaseManifest } from "@lexiloop/content-schema";
import type { z } from "zod";

export const BUNDLE_MANIFEST = "manifest.json";

export interface BundleFileError {
  path: string;
  reason: string;
}

export interface VerifyResult {
  ok: boolean;
  manifest: z.output<typeof ReleaseManifest> | null;
  /** SHA-256 of manifest.json itself (the D1 content_release anchor). */
  manifestSha256: string | null;
  errors: BundleFileError[];
}

/**
 * Verify one bundle directory: parse + validate manifest.json, then re-hash
 * every file it declares (path, SHA-256, byte size). The manifest file itself
 * is not self-listed; it is the trust root.
 */
export async function verifyBundle(bundleDir: string): Promise<VerifyResult> {
  const errors: BundleFileError[] = [];
  const manifestPath = path.join(bundleDir, BUNDLE_MANIFEST);

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      manifest: null,
      manifestSha256: null,
      errors: [{ path: BUNDLE_MANIFEST, reason: `unreadable: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }
  const manifestSha256 = createHash("sha256").update(raw, "utf8").digest("hex");

  let manifest: z.output<typeof ReleaseManifest>;
  try {
    manifest = ReleaseManifest.parse(JSON.parse(raw));
  } catch (err) {
    return {
      ok: false,
      manifest: null,
      manifestSha256,
      errors: [
        {
          path: BUNDLE_MANIFEST,
          reason: `manifest violates the release contract: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  for (const file of manifest.files) {
    const filePath = path.join(bundleDir, file.path);
    let bytes: Buffer;
    try {
      const info = await stat(filePath);
      if (!info.isFile()) {
        errors.push({ path: file.path, reason: "not a regular file" });
        continue;
      }
      bytes = await readFile(filePath);
    } catch (err) {
      errors.push({ path: file.path, reason: `missing: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    const actualSha = createHash("sha256").update(bytes).digest("hex");
    if (actualSha !== file.sha256) {
      errors.push({
        path: file.path,
        reason: `sha256 mismatch: ${actualSha.slice(0, 12)} != manifest ${file.sha256.slice(0, 12)}`,
      });
      continue;
    }
    if (bytes.length !== file.bytes) {
      errors.push({ path: file.path, reason: `size mismatch: ${bytes.length} != manifest ${file.bytes}` });
    }
  }

  return { ok: errors.length === 0, manifest, manifestSha256, errors };
}
