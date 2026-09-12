/**
 * Directory-backed private object store with R2 key semantics (plan Task 18
 * harness). Objects live under an explicitly created temp directory; the
 * store implements exactly the R2 surface the worker's audio route uses —
 * `get` (whole object and ranged), `head`, `put`, `delete` — with the same
 * content-addressing rules the local rehearsal wiring assumes
 * (scripts/publish-release.ts). Ranged reads resolve against the stored
 * object size; a missing object reads as `null` like real R2.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** R2 `R2Range` shape (apps/worker/src/http/cache.ts parseRangeSpec). */
export type ObjectRange = { offset: number } | { offset: number; length: number } | { suffix: number };

export interface GetObject {
  body: ReadableStream;
  size: number;
}

export class DirectoryObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
  }

  private objectPath(objectKey: string): string {
    if (objectKey.includes("..")) {
      throw new Error(`object store: refusing unsafe key ${objectKey}`);
    }
    return join(this.root, objectKey);
  }

  async head(objectKey: string): Promise<{ size: number } | null> {
    const filePath = this.objectPath(objectKey);
    if (!existsSync(filePath)) {
      return null;
    }
    return { size: statSync(filePath).size };
  }

  async put(objectKey: string, bytes: Uint8Array): Promise<void> {
    const filePath = this.objectPath(objectKey);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, bytes);
  }

  async get(objectKey: string, range?: ObjectRange): Promise<GetObject | null> {
    const filePath = this.objectPath(objectKey);
    if (!existsSync(filePath)) {
      return null;
    }
    const bytes = readFileSync(filePath);
    const size = bytes.length;
    let slice: Buffer;
    if (range === undefined) {
      slice = bytes;
    } else if ("suffix" in range) {
      const start = Math.max(size - Math.min(range.suffix, size), 0);
      slice = bytes.subarray(start);
    } else if ("length" in range) {
      slice = bytes.subarray(range.offset, Math.min(range.offset + range.length, size));
    } else {
      slice = bytes.subarray(range.offset);
    }
    return { body: new Blob([new Uint8Array(slice)]).stream(), size };
  }

  /** Whole-object byte read (verification tooling; never a route path). */
  read(objectKey: string): Uint8Array | null {
    const filePath = this.objectPath(objectKey);
    if (!existsSync(filePath)) {
      return null;
    }
    return new Uint8Array(readFileSync(filePath));
  }

  /** Harness-only operation: simulates R2 object loss (denial journeys). */
  async delete(objectKey: string): Promise<boolean> {
    const filePath = this.objectPath(objectKey);
    if (!existsSync(filePath)) {
      return false;
    }
    rmSync(filePath);
    return true;
  }

  /** Iterates every stored object key (verify-release audio gate). */
  keys(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSorted(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else {
          out.push(full.slice(this.root.length + 1));
        }
      }
    };
    if (existsSync(this.root)) {
      walk(this.root);
    }
    return out.sort();
  }
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort();
}
