/**
 * Application-level user-data backup (spec 13.1): exports ONLY the personal
 * tables — `app_user`, `user_settings`, `word_progress`, `card_state`,
 * `review_log`, `study_session` — as gzip-compressed JSONL plus a JSON
 * manifest, uploaded to the private R2 bucket under
 * `backups/<UTC-date>/user-data.jsonl.gz` and `backups/<UTC-date>/manifest.json`.
 *
 * Content is deliberately NOT backed up (spec 13.1): it is rebuilt from the
 * immutable release bundles that remain in private release storage even after
 * their D1 rows age out. FTS is never a backup source (spec 6.3) — restore
 * rebuilds it from the content tables.
 *
 * The manifest inventories every content release the backup depends on:
 * - the active pointer and the immediately previous (rollback) target;
 * - the pinned release of every backed-up study session (unexpired pins and
 *   expired-but-exported sessions alike);
 * - every `word_progress.introduced_release_id`;
 * - every `review_log.presented_release_id` (undone rows included: the rows
 *   themselves are exported);
 * - every release declaring an alias edge on a stored key's canonical
 *   lineage (BFS over `content_key_alias` from the user's keys), so a
 *   restored database resolves the exact same canonical roots. The edges
 *   themselves ride in the manifest (`alias_edges`).
 *
 * Rows stream out in bounded keyset (`rowid`) pages through
 * `CompressionStream("gzip")`, so peak memory stays proportional to one page
 * and the small V1 dataset is well within Worker limits. The SAME exporter
 * drives the Worker `scheduled()` handler (cron `0 19 * * *` = 03:00
 * Asia/Shanghai) and the local `scripts/backup-user-data.ts`.
 */

import { sql } from "drizzle-orm";
import { appMeta, contentKeyAlias, contentRelease, type LexiloopDatabase } from "@lexiloop/db";

/**
 * Minimal private-bucket port used for the two backup objects (the same
 * structural pattern as the compiler's `R2AudioStore`): the Worker passes its
 * (instrumented) `AUDIO` R2 binding, scripts and tests pass directory-backed
 * fakes. Deliberately NOT the workers-types `R2Bucket` so this module also
 * typechecks wherever the Node-typed scripts import it.
 */
export interface BackupObjectStore {
  put(key: string, value: Uint8Array): Promise<void>;
}

/** The six personal tables a backup contains — nothing else, ever. */
export const BACKUP_TABLES = [
  "app_user",
  "user_settings",
  "word_progress",
  "card_state",
  "review_log",
  "study_session",
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

/** FK-safe restore order (referenced rows first). */
const TABLE_ORDER: readonly BackupTable[] = [
  "app_user",
  "user_settings",
  "word_progress",
  "card_state",
  "review_log",
  "study_session",
];

/** R2 key root for backup objects. */
export const BACKUP_ROOT = "backups";

export interface BackupAliasEdge {
  release_id: string;
  from_key: string;
  to_key: string;
  edge_type: string;
  canonical_key: string;
  created_at: number;
}

export interface BackupManifest {
  version: 1;
  created_at: number;
  /** R2 key of the gzip JSONL object this manifest describes. */
  object_key: string;
  /** SHA-256 (hex) of the gzip JSONL bytes. */
  sha256: string;
  active_release_id: string | null;
  previous_release_id: string | null;
  row_counts: Record<BackupTable, number>;
  required_releases: Array<{ release_id: string; reasons: string[] }>;
  alias_edges: BackupAliasEdge[];
}

export interface ExportUserDataInput {
  db: LexiloopDatabase;
  /** Private bucket receiving the gzip JSONL and the manifest. */
  bucket: BackupObjectStore;
  now: number;
  /** Rows per paged SELECT (keyset on rowid). Default 500. */
  pageSize?: number;
  /** Key root override (tests); defaults to `backups`. */
  objectRoot?: string;
}

export interface ExportUserDataResult {
  manifest: BackupManifest;
  /** Exact gzip JSONL bytes uploaded (tests/drills re-verify the hash). */
  bytes: Uint8Array;
}

/** Reasons, in the fixed order they are reported. */
const REASON_ORDER = ["active", "previous", "session", "introduced", "review", "alias"] as const;

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The stream generics of CompressionStream / ReadableStream differ between
// workers-types and @types/node although the runtime behavior is identical
// (Workers + Node >= 18); these two helpers concentrate the structural casts
// and avoid naming either ambient DOM type.
interface ByteTransformPair {
  readable: unknown;
  writable: unknown;
}
interface ByteTransformCtor {
  new (format: string): ByteTransformPair;
}
interface ByteGlobals {
  CompressionStream: ByteTransformCtor;
  DecompressionStream: ByteTransformCtor;
  Blob: new (parts: unknown[]) => { stream(): { pipeThrough(pair: ByteTransformPair): unknown } };
  Response: new (body: unknown) => { arrayBuffer(): Promise<ArrayBuffer> };
}

const byteGlobals = globalThis as unknown as ByteGlobals;

/** Compresses one readable stream of bytes into a gzip Uint8Array. */
export async function gzipStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const transformed = stream.pipeThrough(new byteGlobals.CompressionStream("gzip") as unknown as Parameters<
    ReadableStream<Uint8Array>["pipeThrough"]
  >[0]) as unknown;
  return new Uint8Array(await new byteGlobals.Response(transformed).arrayBuffer());
}

/** Decompresses a gzip payload back to raw bytes. */
export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new byteGlobals.Blob([bytes]).stream();
  const transformed = source.pipeThrough(new byteGlobals.DecompressionStream("gzip")) as unknown;
  return new Uint8Array(await new byteGlobals.Response(transformed).arrayBuffer());
}

interface PagedPage {
  rows: Array<Record<string, unknown>>;
}

/**
 * Streams one table in rowid-keyset pages. The SELECT carries `rowid` as
 * `__rowid` for pagination; the wrapper column is stripped before export.
 */
function pageStatement(table: BackupTable, afterRowId: number, pageSize: number) {
  return sql`SELECT rowid AS __rowid, * FROM ${sql.identifier(table)} WHERE rowid > ${afterRowId} ORDER BY rowid LIMIT ${pageSize}`;
}

/**
 * Exports the six personal tables to gzip JSONL, computes the required-
 * release manifest, uploads both objects to the private bucket, and returns
 * the manifest plus the exact uploaded bytes.
 */
export async function exportUserData(input: ExportUserDataInput): Promise<ExportUserDataResult> {
  const pageSize = input.pageSize ?? 500;
  const encoder = new TextEncoder();

  // Personal-key inventory collected while streaming: drives the alias
  // lineage search and (with the release columns) the required-release set.
  const userKeys = new Set<string>();
  const sessionReleases = new Set<string>();
  const introducedReleases = new Set<string>();
  const presentedReleases = new Set<string>();
  const rowCounts = Object.fromEntries(BACKUP_TABLES.map((table) => [table, 0])) as Record<BackupTable, number>;

  let tableIndex = 0;
  let afterRowId = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (tableIndex < TABLE_ORDER.length) {
        const table = TABLE_ORDER[tableIndex];
        if (table === undefined) {
          break;
        }
        const page = (await input.db.all(pageStatement(table, afterRowId, pageSize))) as PagedPage["rows"];
        if (page.length === 0) {
          tableIndex += 1;
          afterRowId = 0;
          continue;
        }
        const lines: string[] = [];
        for (const raw of page) {
          const { __rowid, ...row } = raw as Record<string, unknown> & { __rowid?: number };
          if (typeof __rowid === "number") {
            afterRowId = Math.max(afterRowId, __rowid);
          }
          lines.push(`${JSON.stringify({ table, row })}\n`);
          rowCounts[table] += 1;
          collectUserFacts(table, row, {
            userKeys,
            sessionReleases,
            introducedReleases,
            presentedReleases,
          });
        }
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        return; // one bounded page per pull: memory stays O(pageSize)
      }
      controller.close();
    },
  });
  const bytes = await gzipStream(stream);

  // -- Required-release inventory. -----------------------------------------
  const required = new Map<string, Set<string>>();
  const requireRelease = (releaseId: string, reason: (typeof REASON_ORDER)[number]): void => {
    const reasons = required.get(releaseId) ?? new Set<string>();
    reasons.add(reason);
    required.set(releaseId, reasons);
  };

  const releaseRows = await input.db.select().from(contentRelease);
  const meta = (await input.db.select().from(appMeta).where(sql`id = 1`).get()) ?? null;
  const activeReleaseId = meta?.activeReleaseId ?? null;
  if (activeReleaseId !== null) {
    requireRelease(activeReleaseId, "active");
  }
  let previousReleaseId: string | null = null;
  let previousActivatedAt = -1;
  for (const row of releaseRows) {
    if (row.releaseId === activeReleaseId || row.activatedAt === null) {
      continue;
    }
    if (row.activatedAt > previousActivatedAt) {
      previousActivatedAt = row.activatedAt;
      previousReleaseId = row.releaseId;
    }
  }
  if (previousReleaseId !== null) {
    requireRelease(previousReleaseId, "previous");
  }
  for (const releaseId of sessionReleases) {
    requireRelease(releaseId, "session");
  }
  for (const releaseId of introducedReleases) {
    requireRelease(releaseId, "introduced");
  }
  for (const releaseId of presentedReleases) {
    requireRelease(releaseId, "review");
  }

  // Alias lineages: BFS from the user's keys across ALL declared edges; every
  // traversed edge's declaring release is required and the edge rides in the
  // manifest for re-import on restore.
  const edgeRows = await input.db.select().from(contentKeyAlias);
  const edgesByFrom = new Map<string, typeof edgeRows>();
  for (const edge of edgeRows) {
    const edges = edgesByFrom.get(edge.fromKey) ?? [];
    edges.push(edge);
    edgesByFrom.set(edge.fromKey, edges);
  }
  const aliasEdges: BackupAliasEdge[] = [];
  const visitedKeys = new Set(userKeys);
  const queue = [...userKeys];
  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined) {
      break;
    }
    for (const edge of edgesByFrom.get(key) ?? []) {
      requireRelease(edge.releaseId, "alias");
      aliasEdges.push({
        release_id: edge.releaseId,
        from_key: edge.fromKey,
        to_key: edge.toKey,
        edge_type: edge.edgeType,
        canonical_key: edge.canonicalKey,
        created_at: edge.createdAt,
      });
      if (!visitedKeys.has(edge.toKey)) {
        visitedKeys.add(edge.toKey);
        queue.push(edge.toKey);
      }
    }
  }
  aliasEdges.sort((a, b) =>
    a.release_id.localeCompare(b.release_id) ||
    a.from_key.localeCompare(b.from_key) ||
    a.to_key.localeCompare(b.to_key),
  );

  const manifest: BackupManifest = {
    version: 1,
    created_at: input.now,
    object_key: "",
    sha256: await sha256Hex(bytes),
    active_release_id: activeReleaseId,
    previous_release_id: previousReleaseId,
    row_counts: rowCounts,
    required_releases: [...required.entries()]
      .map(([releaseId, reasons]) => ({
        release_id: releaseId,
        reasons: REASON_ORDER.filter((reason) => reasons.has(reason)),
      }))
      .sort((a, b) => a.release_id.localeCompare(b.release_id)),
    alias_edges: aliasEdges,
  };

  const dateKey = new Date(input.now).toISOString().slice(0, 10);
  const root = input.objectRoot ?? BACKUP_ROOT;
  manifest.object_key = `${root}/${dateKey}/user-data.jsonl.gz`;
  const manifestKey = `${root}/${dateKey}/manifest.json`;

  await input.bucket.put(manifest.object_key, bytes);
  await input.bucket.put(manifestKey, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  return { manifest, bytes };
}

/** Extracts backup-relevant facts from one exported row. */
function collectUserFacts(
  table: BackupTable,
  row: Record<string, unknown>,
  into: {
    userKeys: Set<string>;
    sessionReleases: Set<string>;
    introducedReleases: Set<string>;
    presentedReleases: Set<string>;
  },
): void {
  const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
  switch (table) {
    case "word_progress": {
      const wordKey = asString(row["word_key"]);
      if (wordKey) into.userKeys.add(wordKey);
      const introduced = asString(row["introduced_release_id"]);
      if (introduced) into.introducedReleases.add(introduced);
      break;
    }
    case "card_state": {
      const cardKey = asString(row["content_card_key"]);
      if (cardKey) into.userKeys.add(cardKey);
      break;
    }
    case "review_log": {
      const contentKey = asString(row["content_card_key"]);
      const presentedKey = asString(row["presented_card_key"]);
      if (contentKey) into.userKeys.add(contentKey);
      if (presentedKey) into.userKeys.add(presentedKey);
      const presentedRelease = asString(row["presented_release_id"]);
      if (presentedRelease) into.presentedReleases.add(presentedRelease);
      break;
    }
    case "study_session": {
      const releaseId = asString(row["release_id"]);
      if (releaseId) into.sessionReleases.add(releaseId);
      break;
    }
    case "app_user":
    case "user_settings":
      break;
  }
}
