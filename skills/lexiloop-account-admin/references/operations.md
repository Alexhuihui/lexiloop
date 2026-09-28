# LexiLoop account operations

Run all commands from the repository root. `pnpm accounts` is the stable interface; agents should not hand-write production `UPDATE app_user` statements.

## Install the skill on another computer

Clone the repository, install project dependencies, then run:

```bash
bash skills/lexiloop-account-admin/scripts/install.sh
```

The default destination is `${CODEX_HOME:-$HOME/.codex}/skills`. A different agent can pass its skill directory explicitly:

```bash
bash skills/lexiloop-account-admin/scripts/install.sh /absolute/path/to/agent/skills
```

The portable contract is the standard `SKILL.md` plus the repository CLI, so agents that understand directory-based skills can use the same package.

## One-time production preparation

Apply the new D1 migration, then deploy the Worker that enforces account deadlines. Do both before creating the first trial account:

```bash
pnpm exec wrangler d1 migrations apply lexiloop-apac --remote -c infra/wrangler/wrangler.toml
pnpm --filter @lexiloop/web build
pnpm exec wrangler deploy -c infra/wrangler/wrangler.toml
```

Create a private ignored receipt directory:

```bash
mkdir -p .lexiloop-private/account-receipts
chmod 700 .lexiloop-private/account-receipts
```

## Create a 90-minute trial

```bash
pnpm accounts create \
  --type trial \
  --remote --confirm-remote \
  --database lexiloop-apac \
  --config infra/wrangler/wrangler.toml \
  --external-ref ORDER-123 \
  --login-url https://lexiloop.juzong.cloud \
  --receipt .lexiloop-private/account-receipts/ORDER-123.json
```

Omit `--username` to generate a collision-resistant `trial-YYYYMMDD-...` username. A trial's `access_expires_at` is creation time plus exactly 90 minutes. Authentication enforces the deadline even before a sweep runs.

## Create a formal account

```bash
pnpm accounts create \
  --type formal \
  --remote --confirm-remote \
  --database lexiloop-apac \
  --config infra/wrangler/wrangler.toml \
  --external-ref ORDER-456 \
  --login-url https://lexiloop.juzong.cloud \
  --receipt .lexiloop-private/account-receipts/ORDER-456.json
```

Formal accounts default to `access_expires_at = NULL`, meaning no account-level deadline. Login sessions still have the ordinary idle timeout and can be renewed by logging in again.

## Inspect and list

```bash
pnpm accounts inspect --username trial-20260928-ab12cd34 --remote \
  --database lexiloop-apac --config infra/wrangler/wrangler.toml

pnpm accounts list --remote --database lexiloop-apac \
  --config infra/wrangler/wrangler.toml --limit 100
```

These outputs never include password hashes, salts, cookies, or plaintext passwords.

## Convert a trial after purchase

```bash
pnpm accounts promote --username trial-20260928-ab12cd34 \
  --remote --confirm-remote --database lexiloop-apac \
  --config infra/wrangler/wrangler.toml
```

Promotion preserves progress and credentials, removes the access deadline, activates the account, and invalidates existing sessions. Tell the buyer to log in again.

## Disable, re-enable, or reset a password

```bash
pnpm accounts disable --username member-20260928-ab12cd34 \
  --remote --confirm-remote --database lexiloop-apac \
  --config infra/wrangler/wrangler.toml

pnpm accounts enable --username member-20260928-ab12cd34 \
  --remote --confirm-remote --database lexiloop-apac \
  --config infra/wrangler/wrangler.toml

pnpm accounts reset-password --username member-20260928-ab12cd34 \
  --remote --confirm-remote --database lexiloop-apac \
  --config infra/wrangler/wrangler.toml \
  --login-url https://lexiloop.juzong.cloud \
  --receipt .lexiloop-private/account-receipts/ORDER-456-reset.json
```

An expired trial cannot be re-enabled without promotion because `enable` refuses to bypass its deadline.

## Sweep expired trials

```bash
pnpm accounts sweep-expired --remote --confirm-remote \
  --database lexiloop-apac --config infra/wrangler/wrangler.toml
```

The sweep changes expired trials from `ACTIVE` to `DISABLED` and invalidates their sessions. It is operational cleanup; access is already denied by the absolute deadline.

## Local dry run

Replace the remote flags with `--db /tmp/lexiloop-account-test.sqlite`. The CLI creates and migrates a new local database automatically. Use a task-specific temporary directory, not a broad shared path.

## Receipt format

The private JSON receipt contains `username`, generated `password`, account type, expiry, order reference, login URL, and issue time. Creation refuses to overwrite an existing receipt. If a command fails ambiguously, inspect both the account and receipt path before deciding whether to retry.
