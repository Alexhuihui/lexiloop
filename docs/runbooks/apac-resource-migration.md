# Runbook: migrate LexiLoop D1, R2, and Worker to APAC

This runbook moves only the resources dedicated to LexiLoop. It creates new
APAC resources, performs a one-shot full D1 import and a complete R2 copy,
then switches the Worker bindings. The old database and bucket remain intact
until the rollback window closes.

Never put real resource IDs, API tokens, account IDs, or credentials in Git.
Use the ignored production Wrangler file and a private shell environment.

## 1. Define the cutover inputs

```bash
export WRANGLER_CONFIG="infra/wrangler/wrangler.toml"
export SOURCE_D1="lexiloop"
export TARGET_D1="lexiloop-apac"
export SOURCE_R2="lexiloop-audio"
export TARGET_R2="lexiloop-audio-apac"
export WORKER_URL="https://<worker-host>"
export R2_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com"
export MIGRATION_DIR="<private-absolute-directory>"
export D1_EXPORT="$MIGRATION_DIR/lexiloop-cutover.sql"
```

Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` through the private shell
environment for an R2 token restricted to the two named buckets. Do not pass
secrets on the command line. Confirm authentication and record, outside Git,
the D1/R2 daily usage before cutover:

```bash
pnpm exec wrangler whoami
pnpm exec wrangler d1 list --json
pnpm exec wrangler r2 bucket list --json
```

Abort if the named source is not the LexiLoop resource, either target already
contains data from an unrelated migration, the account lacks room for one
additional D1/R2 copy, or current daily usage leaves insufficient headroom.
Do not touch any other database or bucket in the account.

## 2. Capture source validation values

Run the same count query before export and after import. Save both outputs in
the private migration directory and compare every row count, including FTS.

```bash
export COUNT_SQL="SELECT 'app_meta' AS table_name, COUNT(*) AS row_count FROM app_meta UNION ALL SELECT 'app_user', COUNT(*) FROM app_user UNION ALL SELECT 'audio_asset', COUNT(*) FROM audio_asset UNION ALL SELECT 'auth_session', COUNT(*) FROM auth_session UNION ALL SELECT 'book', COUNT(*) FROM book UNION ALL SELECT 'card_definition', COUNT(*) FROM card_definition UNION ALL SELECT 'card_state', COUNT(*) FROM card_state UNION ALL SELECT 'content_audio_link', COUNT(*) FROM content_audio_link UNION ALL SELECT 'content_key_alias', COUNT(*) FROM content_key_alias UNION ALL SELECT 'content_release', COUNT(*) FROM content_release UNION ALL SELECT 'content_search_fts', COUNT(*) FROM content_search_fts UNION ALL SELECT 'example', COUNT(*) FROM example UNION ALL SELECT 'explanation', COUNT(*) FROM explanation UNION ALL SELECT 'lexical_relation', COUNT(*) FROM lexical_relation UNION ALL SELECT 'phrase', COUNT(*) FROM phrase UNION ALL SELECT 'release_unit', COUNT(*) FROM release_unit UNION ALL SELECT 'review_log', COUNT(*) FROM review_log UNION ALL SELECT 'sense', COUNT(*) FROM sense UNION ALL SELECT 'study_session', COUNT(*) FROM study_session UNION ALL SELECT 'unit', COUNT(*) FROM unit UNION ALL SELECT 'user_settings', COUNT(*) FROM user_settings UNION ALL SELECT 'word', COUNT(*) FROM word UNION ALL SELECT 'word_progress', COUNT(*) FROM word_progress ORDER BY table_name"
pnpm exec wrangler d1 execute "$SOURCE_D1" --remote --json --config "$WRANGLER_CONFIG" --command "$COUNT_SQL" \
  | jq 'map(.results) | add' > "$MIGRATION_DIR/source-counts.json"
pnpm exec wrangler d1 execute "$SOURCE_D1" --remote --json --config "$WRANGLER_CONFIG" --command "PRAGMA foreign_key_check" \
  | jq 'map(.results) | add' > "$MIGRATION_DIR/source-foreign-keys.json"
test "$(jq 'length' "$MIGRATION_DIR/source-foreign-keys.json")" -eq 0
```

`source-foreign-keys.json` must contain no violation rows. Record source R2
object count and total bytes with an S3-compatible client:

```bash
aws s3 ls "s3://$SOURCE_R2" --recursive --endpoint-url "$R2_ENDPOINT" \
  | awk '{print $3, $4}' | LC_ALL=C sort > "$MIGRATION_DIR/source-r2-size-keys.txt"
awk '{count += 1; bytes += $1} END {print count, bytes}' \
  "$MIGRATION_DIR/source-r2-size-keys.txt" > "$MIGRATION_DIR/source-r2-count-bytes.txt"
```

## 3. Create and copy the APAC resources

Create only the two approved LexiLoop targets:

```bash
pnpm exec wrangler d1 create "$TARGET_D1" --location apac
pnpm exec wrangler r2 bucket create "$TARGET_R2" --location apac
pnpm exec wrangler d1 info "$TARGET_D1" --json > "$MIGRATION_DIR/target-d1-info.json"
pnpm exec wrangler r2 bucket info "$TARGET_R2" --json > "$MIGRATION_DIR/target-r2-info.json"
```

Keep the application on the source bindings during the copy. Perform the R2
copy first because it is independent of the final database snapshot:

```bash
aws s3 sync "s3://$SOURCE_R2" "s3://$TARGET_R2" \
  --endpoint-url "$R2_ENDPOINT" --only-show-errors
aws s3 ls "s3://$TARGET_R2" --recursive --endpoint-url "$R2_ENDPOINT" \
  | awk '{print $3, $4}' | LC_ALL=C sort > "$MIGRATION_DIR/target-r2-size-keys.txt"
awk '{count += 1; bytes += $1} END {print count, bytes}' \
  "$MIGRATION_DIR/target-r2-size-keys.txt" > "$MIGRATION_DIR/target-r2-count-bytes.txt"
cmp "$MIGRATION_DIR/source-r2-size-keys.txt" "$MIGRATION_DIR/target-r2-size-keys.txt"
cmp "$MIGRATION_DIR/source-r2-count-bytes.txt" "$MIGRATION_DIR/target-r2-count-bytes.txt"
```

If the source bucket changes during the copy, rerun `aws s3 sync` and both
manifest/count commands immediately before binding cutover. Both `cmp`
commands must succeed. For full content-hash evidence, configure an `r2` rclone
remote with the same private credentials and download-check every object:

```bash
rclone check "r2:$SOURCE_R2" "r2:$TARGET_R2" --download --one-way
```

For D1, use one final full export and one import. Choose a quiet cutover window
and keep the export-to-deploy interval as short as possible:

```bash
pnpm exec wrangler d1 export "$SOURCE_D1" --remote --config "$WRANGLER_CONFIG" \
  --output "$D1_EXPORT" --skip-confirmation
pnpm exec wrangler d1 execute "$TARGET_D1" --remote --file "$D1_EXPORT"
pnpm exec wrangler d1 execute "$TARGET_D1" --remote --json --command "$COUNT_SQL" \
  | jq 'map(.results) | add' > "$MIGRATION_DIR/target-counts.json"
pnpm exec wrangler d1 execute "$TARGET_D1" --remote --json \
  --command "PRAGMA foreign_key_check" | jq 'map(.results) | add' \
  > "$MIGRATION_DIR/target-foreign-keys.json"
diff -u "$MIGRATION_DIR/source-counts.json" "$MIGRATION_DIR/target-counts.json"
test "$(jq 'length' "$MIGRATION_DIR/target-foreign-keys.json")" -eq 0
```

Refresh `source-counts.json` immediately before the export if any source write
occurred after step 2. The diff must be empty and the target foreign-key output
must contain no violation rows. Do not deploy against a partial import.

## 4. Switch bindings and Worker placement

In the ignored `infra/wrangler/wrangler.toml`, change only:

- `DB.database_name` and `DB.database_id` to the APAC D1 values;
- `AUDIO.bucket_name` to `lexiloop-audio-apac`;
- `[placement] region` to `gcp:asia-east1` by default.

The location hint is applied only when a D1 is created. Inspect
`target-d1-info.json` for `served_by_colo`; if evidence shows another supported
Asia Worker region is closer to that primary and the users, update the ignored
production region and the decision record before deploying.

```bash
pnpm --filter @lexiloop/web build
pnpm exec wrangler deploy --config "$WRANGLER_CONFIG"
```

## 5. Verify the cutover

Do not declare success until all gates pass:

1. `GET $WORKER_URL/` returns the PWA and security headers.
2. A designated account can log in and `/api/auth/me` returns a CSRF token.
3. `/api/content/bootstrap` reports the expected active release.
4. One grade followed by undo succeeds and leaves the review state restored.
5. Several audio objects, including an example sentence, play from the new R2 binding.
6. Worker logs show the intended Asia placement and no credential or token leakage.
7. At least five grade requests are timed; record client latency, Worker
   `duration_ms`, CPU time, `d1_rows_read`, and `d1_rows_written`. Compare the
   median with the pre-cutover baseline and record the actual result even when
   it misses the target.
8. Recheck D1 and R2 daily operations so the new request pattern remains within
   the free-account read/write/Class A/Class B allowances.

## 6. rollback

If any data, audio, authentication, placement, or latency gate fails, restore
the old values in the ignored Wrangler config and redeploy the same verified
Git commit:

```bash
pnpm --filter @lexiloop/web build
pnpm exec wrangler deploy --config "$WRANGLER_CONFIG"
```

Then repeat the production smoke against the source D1/R2 bindings. Keep the
failed APAC resources for diagnosis, but do not write to them or delete the
original resources. Deletion requires a separate, explicit decision after the
rollback window and backup verification.
