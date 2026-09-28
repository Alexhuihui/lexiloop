-- Sellable learning-account lifecycle.
-- Existing accounts remain FORMAL and have no access deadline.

ALTER TABLE app_user ADD COLUMN access_expires_at INTEGER;
ALTER TABLE app_user ADD COLUMN account_type TEXT NOT NULL DEFAULT 'FORMAL'
  CHECK (account_type IN ('TRIAL', 'FORMAL'));
ALTER TABLE app_user ADD COLUMN external_ref TEXT;

CREATE INDEX app_user_access_expiry_idx
  ON app_user (status, account_type, access_expires_at);
CREATE UNIQUE INDEX app_user_external_ref_unique
  ON app_user (external_ref)
  WHERE external_ref IS NOT NULL;
