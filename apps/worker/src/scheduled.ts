/**
 * Worker scheduled handler (spec 13.1, plan Task 14): the daily
 * application-level backup. Drives the SAME `exportUserData` exporter as the
 * local `scripts/backup-user-data.ts` — gzip JSONL of the six personal tables
 * plus the required-release manifest, uploaded to the private R2 bucket —
 * on the Wrangler cron `0 19 * * *` (19:00 UTC = 03:00 Asia/Shanghai).
 *
 * The handler has no request, so it creates its own log context and
 * instruments the D1/R2 bindings with it: the scheduled run's usage lands in
 * one `backup_completed` log line, mirroring the per-request counters.
 */

import { drizzle } from "drizzle-orm/d1";
import { schema, type LexiloopDatabase } from "@lexiloop/db";
import { exportUserData, type BackupManifest, type BackupObjectStore } from "./backups/export";
import { generateRequestId, createRequestLogContext, instrumentD1, instrumentR2 } from "./observability/request-context";
import { writeLogLine, type LogWriter } from "./observability/logger";

/**
 * Bindings the scheduled backup needs (a subset of the fetch Env). Fields are
 * optional at the type level so tests can inject overrides; the production
 * bindings (DB, AUDIO) must exist whenever neither is overridden.
 */
export interface ScheduledBackupEnv {
  DB?: D1Database;
  AUDIO?: R2Bucket;
  /** Worker release id for the backup log line (optional). */
  WORKER_RELEASE_ID?: string;
}

/** Injectable overrides for tests and local rehearsals. */
export interface ScheduledBackupOverrides {
  db?: LexiloopDatabase;
  bucket?: BackupObjectStore;
  now?: number;
  /** Log sink; defaults to console.log. Tests capture lines here. */
  logWrite?: LogWriter;
}

function requireBinding<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`scheduled backup: binding ${name} is not configured and no override was provided`);
  }
  return value;
}

/**
 * Runs one scheduled backup and emits one structured `backup_completed` line
 * (fixed safe fields only — no user data, per spec 13.2 redaction rules).
 */
export async function runScheduledBackup(
  env: ScheduledBackupEnv,
  overrides: ScheduledBackupOverrides = {},
): Promise<BackupManifest> {
  const context = createRequestLogContext(generateRequestId(), env.WORKER_RELEASE_ID);
  const db = overrides.db ?? drizzle(instrumentD1(requireBinding(env.DB, "DB"), context.usage), { schema });
  // R2Bucket satisfies the structural BackupObjectStore port (its `put`
  // overload accepts a Uint8Array body); the cast crosses the overload set.
  const bucket: BackupObjectStore =
    overrides.bucket ??
    (instrumentR2(requireBinding(env.AUDIO, "AUDIO"), context.usage) as unknown as BackupObjectStore);
  const startedAt = performance.now();
  const result = await exportUserData({ db, bucket, now: overrides.now ?? Date.now() });
  writeLogLine(overrides.logWrite, {
    time: overrides.now ?? Date.now(),
    level: "info",
    msg: "backup_completed",
    request_id: context.requestId,
    method: "SCHEDULED",
    route: "backup",
    status: 200,
    duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    d1_rows_read: context.d1RowsRead,
    d1_rows_written: context.d1RowsWritten,
    r2_operations: context.r2Operations,
    ...(env.WORKER_RELEASE_ID !== undefined ? { release_id: env.WORKER_RELEASE_ID } : {}),
  });
  return result.manifest;
}

/** The Wrangler cron entry point (`0 19 * * *`). */
export async function scheduled(
  event: ScheduledController,
  env: ScheduledBackupEnv,
  _ctx: ExecutionContext,
): Promise<void> {
  void event;
  void _ctx;
  await runScheduledBackup(env);
}
