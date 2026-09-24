# Runbook: User-data backup, restore drills, and release retention

Scope: the application-level backup of personal learning data (spec 13.1), the
restore drill that proves a backup is restorable, and the release/audio
retention rules that decide what may ever be cleaned up. Content is NEVER
backed up: it is rebuilt from the immutable release bundles kept in private
release storage (`.lexiloop-private/releases/`), which outlive their D1 rows.

## 1. What is backed up, and when

- **Schedule:** Worker cron `0 19 * * *` (19:00 UTC = **03:00 Asia/Shanghai**),
  declared in `infra/wrangler/wrangler.toml.example`, handled by
  `apps/worker/src/scheduled.ts` (`scheduled` in the entry point
  `apps/worker/src/index.ts`).
- **Exporter:** `apps/worker/src/backups/export.ts` — the SAME exporter drives
  the cron handler and the local script. Rows are read in bounded keyset
  (`rowid`) pages and streamed through `CompressionStream("gzip")`, so the
  small V1 dataset stays far inside Worker limits.
- **Tables (only these, ever):** `app_user`, `user_settings`, `word_progress`,
  `card_state`, `review_log`, `study_session`.
- **Objects in the private R2 bucket:**
  - `backups/<UTC-date>/user-data.jsonl.gz` — one JSON object per line,
    `{"table":"<table>","row":{...}}` (snake_case columns);
  - `backups/<UTC-date>/manifest.json` — version, creation time, the gzip
    object's key + SHA-256, per-table row counts, the active/previous release
    pointers, every **required release** (with reasons: `active`, `previous`,
    `session`, `introduced`, `review`, `alias`), and the alias edges
    (`alias_edges`) needed to re-resolve canonical keys after restore.
- **FTS is never a backup source** (spec 6.3): `content_search_fts` is rebuilt
  from the content tables during restore.

### Manual (on-demand) backup

```bash
pnpm tsx scripts/backup-user-data.ts \
  --db .lexiloop-private/d1/rehearsal.sqlite \
  --r2-dir .lexiloop-private/r2
```

The script uses the same directory-backed R2 semantics as
`scripts/publish-release.ts`, so its output feeds the restore drill unchanged.

## 2. Restore drill (a backup is only valid once it is proven restorable)

```bash
pnpm tsx scripts/restore-drill.ts \
  --release-bundle-dir tests/fixtures/releases/retained-set \
  --backup tests/fixtures/backup/minimal.jsonl.gz \
  --temporary-db .lexiloop-private/restore-drill.sqlite
```

The committed fixtures are fully synthetic (no real textbook data) and are
regenerated with `pnpm tsx tests/fixtures/backup/generate-fixture.ts` after
changing the generator.

What the drill does, in order (core logic:
`apps/worker/src/backups/restore.ts`):

1. Reads `manifest.json` from the backup's directory, re-verifies the gzip
   SHA-256, and parses every JSONL line.
2. Checks the bundle directory contains **exactly** the manifest's required
   releases — a MISSING or an EXTRA (ambiguous) bundle fails before the
   temporary database is created, i.e. before any user row is written.
3. Re-hashes every file of every required bundle against its own
   `manifest.json`.
4. Creates the temporary database **fresh** (an existing file at the explicit
   `--temporary-db` path is replaced), applies `infra/migrations/*.sql`, and
   imports every required release (unit reports + `d1/00{1,2,3}-*.sql`).
5. Restores the active/previous pointers (`app_meta` + statuses).
6. Imports the manifest's alias edges, then the user rows in FK-safe order.
7. Rebuilds FTS: `INSERT INTO content_search_fts(content_search_fts)
   VALUES('rebuild');`.
8. Verifies row counts, `PRAGMA foreign_key_check`, FTS/content parity, and
   canonical alias resolution (`AliasRepository.resolve` per recorded edge).
   Any failure deletes the temporary database and exits non-zero.

Restore is only ever performed into an explicitly named, newly created
temporary database — never in place, never onto the live D1 database.

## 3. Release retention (what may be cleaned up, and when)

Logic: `apps/worker/src/releases/retention.ts` (`planRetention` /
`applyRetentionPlan`). A RETIRED release is cleanup-eligible only when ALL of
these hold:

| Condition | Reason tag |
| --- | --- |
| status is `RETIRED` (never the ACTIVE release) | `status-not-retired` |
| not the immediately previous rollback target (latest `activated_at` among non-active releases) | `immediately-previous-rollback-target` |
| no unexpired `study_session` pins it (spec 15: even past 14 days, a live session blocks cleanup) | `session-pin` |
| no `word_progress.introduced_release_id` reference | `introduced-reference` |
| no `review_log.presented_release_id` reference | `review-reference` |
| at least 14 days since its last activation (previous-release availability floor, spec 15) | `retention-window-14d` |

**R2 audio:** objects under the `audio/` prefix that no `audio_asset` row
references become deletable only after a **7-day grace period** measured from
the object's `uploaded` timestamp (`audio-grace-7d`); referenced objects and
non-audio prefixes (e.g. `backups/`) are never candidates. Immutable release
bundles stay in private release storage even after their D1 rows age out.

### Cleanup commands: dry-run by default, exact ids only

`planRetention` is the dry run: it deletes nothing and reports, per release
and audio object, `eligible` + `blockedBy`, plus the exact `deletions` sets.
`applyRetentionPlan` **defaults to `dryRun: true`**; the executing path
(`dryRun: false`) requires the exact eligible release ids and audio keys,
refuses anything else (never globs, prefixes, or unresolved variables), and
re-verifies eligibility at execution time so a stale plan cannot delete a
release that gained a session pin in the meantime. Deletion clears the FTS
index rows for the release first (the ordering mandated by
`infra/migrations/0002_content_search_fts.sql`), then deletes the
`content_release` row and lets its cascades remove the immutable content.

## 4. Operator checklist

1. Backup ran? Check `backups/<today>/manifest.json` in the private bucket and
   the `backup_completed` log line.
2. Restore drill on the latest backup + the retained bundle set (command in
   section 2) — all checks PASS before any backup is considered valid.
3. Cleanup: run the plan, review `blockedBy` reasons, and only then apply the
   exact deletions with `dryRun: false`.
