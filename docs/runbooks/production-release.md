# Runbook: production release deployment (V1)

This runbook records the V1 production deployment steps as actually executed,
with the exact commands. Real IDs live in the untracked
`infra/wrangler/wrangler.toml` (D1 database id, R2 bucket name) and in
`.lexiloop-private/` (release bundles, user credential file).

## Preconditions

- `npx wrangler whoami` authenticated against the production account.
- The configured D1 database and private R2 bucket are dedicated to LexiLoop.
  During an APAC migration the old and new resources coexist for rollback.
  No public R2 access; the Worker and the publish script are the only writers.
- For APAC production, follow
  [`apac-resource-migration.md`](./apac-resource-migration.md) before changing
  bindings. The tracked placement default is `gcp:asia-east1`; real resource
  IDs and any evidence-based region override stay in the ignored config.
- `infra/wrangler/wrangler.toml` contains the real D1 id / R2 bucket, the
  login rate limiter, the daily backup cron, and the `[assets]` PWA binding.
- Migrations applied: `npx wrangler d1 migrations apply lexiloop --remote -c infra/wrangler/wrangler.toml`.
- Accounts seeded (never from argv): seed rows locally with
  `tsx scripts/seed-users.ts --db <temp sqlite> --input <private file>`,
  export the `app_user` rows, and insert them into the remote D1 with
  `wrangler d1 execute lexiloop --remote --file <rows.sql>`. Rotating an
  account = re-run the same local seed + insert (salt/verifier rotate,
  `session_version` increments).

## Publish a release (stage → smoke → activate)

```bash
tsx scripts/publish-release.ts --bundle .lexiloop-private/releases/<release-id> \
  --remote --d1-database lexiloop --r2-bucket lexiloop-audio
```

The script: verifies the bundle manifest → uploads every manifest audio asset
to the private R2 bucket (content-addressed keys, unconditional retrying
puts) → applies the bundle's D1 SQL as a release in `IMPORTING` (`app_meta`
untouched) → runs pre-activation smoke (row counts, FK integrity, FTS parity,
audio coverage) → activates (alias upserts, status promotion, atomic
`app_meta` pointer switch last).

Notes:
- Remote activation is sequential (wrangler has no batch): every failure
  stops BEFORE the pointer switch; re-running the same command after a
  failure resumes safely (idempotent upserts; content-addressed audio keys).
- There is no `--force` and no status override. A release that fails smoke
  stays `IMPORTING` and the active pointer is unchanged.
- First production release: `previous_release_id` is null; rollback is
  unavailable until a second real release exists. The local two-release
  rollback exercise (Playwright content-upgrade suite) is the V1 rollback
  evidence.

## Deploy the Worker + PWA

```bash
pnpm --filter @lexiloop/web build
npx wrangler deploy -c infra/wrangler/wrangler.toml
```

The Worker serves `/api/*`; the PWA static build is served through the
`[assets]` binding for everything else. Web and Worker deploy in lockstep:
the web client requires `csrf_token` in `/api/auth/me` (deployed Worker must
not predate the web bundle).

## Post-deployment smoke

1. `GET <worker>/` returns the PWA shell with security headers.
2. Login with a seeded test account; `/api/auth/me` returns `csrf_token`.
3. `/api/content/bootstrap` returns the active release (no personal fields).
4. One grade + undo with a designated test user.
5. Structured logs contain no credentials, tokens, cookies, or textbook text.

For a bounded remote spot check under free-tier limits, run
`pnpm exec tsx scripts/remote-sample.ts <release-id>`. It makes 13 small D1
queries and reads at most 8 R2 audio objects across hash-key ranges, checking
the active pointer, sampled source/card keys, object hashes, and WAV headers.
This is sample evidence only. The full release-bundle file-hash check is
`pnpm compiler release verify --bundle .lexiloop-private/releases/<release-id>`
and runs locally. Do not run the full remote verifier when quota limits require
sampling.

## Backups

The scheduled handler uploads gzip JSONL + manifest to the private R2 bucket
daily at 19:00 UTC (03:00 Asia/Shanghai). Restore drills:
`tsx scripts/restore-drill.ts --release-bundle-dir <dir> --backup <jsonl.gz> --temporary-db <path>`.
