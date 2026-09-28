---
name: lexiloop-account-admin
description: Create and manage LexiLoop learning accounts, including fixed 90-minute trials and non-expiring formal accounts. Use for issuing buyer credentials, inspecting access, promoting a trial while preserving progress, disabling access, resetting passwords, or sweeping expired trials. Do not use for content releases or ordinary learner activity.
---

# LexiLoop Account Admin

Use the repository's deterministic `pnpm accounts` CLI. Locate the LexiLoop repository from the current workspace or `LEXILOOP_REPO`, then run commands from its root.

## Account modes

- `trial`: always expires exactly 90 minutes after creation. This duration is intentionally not configurable.
- `formal`: active with no access deadline by default.
- Promote a trial instead of creating a second account when the buyer should keep trial progress. Promotion preserves the username, password, and learning data, and invalidates existing sessions so the buyer must log in again.

## Safety

- Inspect or list before changing an existing account.
- Only mutate the remote production D1 when the user explicitly asked for that account operation. Remote mutations require `--confirm-remote` as a final guard.
- Never put a password in argv, chat logs, SQL, Git, or an order reference. The CLI generates it and writes it once to a new mode-0600 receipt file.
- Treat the receipt as sensitive. Read it only when the authorized buyer's credentials must be delivered; do not commit it. Do not delete it unless the user requested deletion or an established retention procedure applies.
- Use a unique, non-secret `--external-ref` such as an order number when available. The database rejects reuse.
- Apply database migrations before the first remote account operation after installing this feature.
- Never delete learner data through this skill. Disable access instead.

## Workflow

1. Determine whether the request is for a new trial, new formal account, promotion, password reset, disable/enable, inspection, or expired-trial sweep.
2. For an existing account, run `inspect` first and verify the exact normalized username and external reference.
3. Choose an explicit target: `--db <sqlite>` for isolated/local work or `--remote --database ... --config ...` for production.
4. For credential-producing operations, choose a private receipt path under `.lexiloop-private/account-receipts/` or another ignored private directory.
5. Run the command once. Do not blindly retry a failed create or password reset; inspect the account and receipt path first.
6. Report the username, account type, expiry in the user's timezone, and receipt path. Reveal the generated password only when the user explicitly needs the delivery message or credentials.

Read [references/operations.md](references/operations.md) for exact commands, installation, receipt format, and failure recovery.
