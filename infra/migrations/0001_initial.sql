-- LexiLoop initial schema: one D1 database, three logical table groups
-- (spec 6.1/6.2). This file is the source of truth; the Drizzle schema in
-- packages/db/src/schema mirrors it for typed queries.
--
-- Conventions:
-- - All timestamps are UTC epoch milliseconds stored as INTEGER, column
--   names ending in `_at`.
-- - Versioned JSON blobs are stored as TEXT with a `{ version, ... }`
--   envelope and are validated at repository boundaries; `json_valid`
--   CHECKs guarantee syntactic validity at the storage layer.
-- - Content tables are release-scoped with composite `(release_id,
--   logical_key)` primary keys (spec 6.2); user learning tables reference
--   stable logical keys only, never release-scoped row ids (spec 6.4).

-- ---------------------------------------------------------------------------
-- Release & metadata
-- ---------------------------------------------------------------------------

CREATE TABLE content_release (
  release_id          TEXT    PRIMARY KEY,
  source_pdf_sha256   TEXT    NOT NULL,
  schema_version      TEXT    NOT NULL,
  prompt_version      TEXT    NOT NULL,
  -- generation/review/repair/tts model + voice configuration (spec 5.9).
  model_config_json   TEXT    NOT NULL CHECK (json_valid(model_config_json)),
  -- DRAFT -> IMPORTING -> VALIDATING -> READY -> ACTIVE -> RETIRED | FAILED.
  status              TEXT    NOT NULL CHECK (status IN ('DRAFT','IMPORTING','VALIDATING','READY','ACTIVE','RETIRED','FAILED')),
  created_at          INTEGER NOT NULL,
  activated_at        INTEGER,
  manifest_sha256     TEXT    NOT NULL
);

CREATE TABLE release_unit (
  release_id     TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  unit_key       TEXT    NOT NULL,
  status         TEXT    NOT NULL CHECK (status IN ('PASSED','BLOCKED')),
  words          INTEGER NOT NULL DEFAULT 0 CHECK (words >= 0),
  senses         INTEGER NOT NULL DEFAULT 0 CHECK (senses >= 0),
  phrases        INTEGER NOT NULL DEFAULT 0 CHECK (phrases >= 0),
  examples       INTEGER NOT NULL DEFAULT 0 CHECK (examples >= 0),
  explanations   INTEGER NOT NULL DEFAULT 0 CHECK (explanations >= 0),
  cards          INTEGER NOT NULL DEFAULT 0 CHECK (cards >= 0),
  qa_summary     TEXT,
  PRIMARY KEY (release_id, unit_key)
);

-- Singleton row (id = 1) holding the unique active release pointer and the
-- global configuration version (spec 6.2). Seeded by this migration.
CREATE TABLE app_meta (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  active_release_id  TEXT    REFERENCES content_release(release_id) ON DELETE RESTRICT,
  config_version     INTEGER NOT NULL DEFAULT 1 CHECK (config_version >= 1)
);

INSERT INTO app_meta (id, active_release_id, config_version) VALUES (1, NULL, 1);

-- ---------------------------------------------------------------------------
-- Textbook content (release-scoped, immutable per release)
-- ---------------------------------------------------------------------------

CREATE TABLE book (
  release_id      TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  book_key        TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  edition         TEXT    NOT NULL,
  -- Source provenance (spec 5.5): pdf/page/bbox/confidences as JSON.
  provenance_json TEXT    NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (release_id, book_key)
);

CREATE TABLE unit (
  release_id      TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  unit_key        TEXT    NOT NULL,
  book_key        TEXT    NOT NULL,
  level           INTEGER NOT NULL CHECK (level >= 1),
  unit_order      INTEGER NOT NULL CHECK (unit_order >= 1),
  title           TEXT    NOT NULL,
  provenance_json TEXT    NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (release_id, unit_key),
  FOREIGN KEY (release_id, book_key) REFERENCES book(release_id, book_key) ON DELETE CASCADE
);

CREATE INDEX unit_release_book_idx ON unit (release_id, book_key);

CREATE TABLE word (
  release_id      TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  word_key        TEXT    NOT NULL,
  unit_key        TEXT    NOT NULL,
  headword        TEXT    NOT NULL,
  phonetic        TEXT,
  tier            TEXT    NOT NULL,
  source_order    INTEGER NOT NULL CHECK (source_order >= 1),
  provenance_json TEXT    NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (release_id, word_key),
  FOREIGN KEY (release_id, unit_key) REFERENCES unit(release_id, unit_key) ON DELETE CASCADE
);

-- spec 6.3: word(release_id, unit_key, tier, source_order).
CREATE INDEX word_release_unit_tier_order_idx ON word (release_id, unit_key, tier, source_order);

CREATE TABLE sense (
  release_id      TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  sense_key       TEXT    NOT NULL,
  word_key        TEXT    NOT NULL,
  pos             TEXT    NOT NULL,
  gloss           TEXT    NOT NULL,
  sense_order     INTEGER NOT NULL CHECK (sense_order >= 1),
  provenance_json TEXT    NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (release_id, sense_key),
  FOREIGN KEY (release_id, word_key) REFERENCES word(release_id, word_key) ON DELETE CASCADE
);

CREATE INDEX sense_release_word_idx ON sense (release_id, word_key);

CREATE TABLE phrase (
  release_id      TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  phrase_key      TEXT    NOT NULL,
  word_key        TEXT    NOT NULL,
  sense_key       TEXT,
  text            TEXT    NOT NULL,
  gloss           TEXT    NOT NULL,
  source_order    INTEGER NOT NULL CHECK (source_order >= 1),
  provenance_json TEXT    NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (release_id, phrase_key),
  FOREIGN KEY (release_id, word_key) REFERENCES word(release_id, word_key) ON DELETE CASCADE,
  FOREIGN KEY (release_id, sense_key) REFERENCES sense(release_id, sense_key) ON DELETE CASCADE
);

-- spec 6.3: phrase(release_id, word_key).
CREATE INDEX phrase_release_word_idx ON phrase (release_id, word_key);

CREATE TABLE example (
  release_id      TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  example_key     TEXT    NOT NULL,
  word_key        TEXT    NOT NULL,
  sense_key       TEXT,
  phrase_key      TEXT,
  origin          TEXT    NOT NULL CHECK (origin IN ('exam','textbook')),
  source_ref      TEXT,
  text            TEXT    NOT NULL,
  target_start    INTEGER NOT NULL CHECK (target_start >= 0),
  target_end      INTEGER NOT NULL CHECK (target_end > target_start),
  source_order    INTEGER NOT NULL CHECK (source_order >= 1),
  provenance_json TEXT    NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (release_id, example_key),
  FOREIGN KEY (release_id, word_key) REFERENCES word(release_id, word_key) ON DELETE CASCADE,
  FOREIGN KEY (release_id, sense_key) REFERENCES sense(release_id, sense_key) ON DELETE CASCADE,
  FOREIGN KEY (release_id, phrase_key) REFERENCES phrase(release_id, phrase_key) ON DELETE CASCADE
);

-- spec 6.3: example(release_id, word_key).
CREATE INDEX example_release_word_idx ON example (release_id, word_key);

-- Teacher-style generated notes (spec 6.2): searchable core fields stay plain
-- columns (word_key/unit_key); everything else lives in generated_json.
CREATE TABLE explanation (
  release_id       TEXT NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  explanation_key  TEXT NOT NULL,
  word_key         TEXT NOT NULL,
  unit_key         TEXT NOT NULL,
  generated_json   TEXT NOT NULL CHECK (json_valid(generated_json)),
  PRIMARY KEY (release_id, explanation_key),
  FOREIGN KEY (release_id, word_key) REFERENCES word(release_id, word_key) ON DELETE CASCADE,
  FOREIGN KEY (release_id, unit_key) REFERENCES unit(release_id, unit_key) ON DELETE CASCADE
);

CREATE INDEX explanation_release_word_idx ON explanation (release_id, word_key);

CREATE TABLE lexical_relation (
  release_id      TEXT NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  relation_key    TEXT NOT NULL,
  from_word_key   TEXT NOT NULL,
  to_word_key     TEXT NOT NULL,
  relation_type   TEXT NOT NULL CHECK (relation_type IN ('synonym','antonym','derivative','confusable')),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  PRIMARY KEY (release_id, relation_key),
  FOREIGN KEY (release_id, from_word_key) REFERENCES word(release_id, word_key) ON DELETE CASCADE,
  FOREIGN KEY (release_id, to_word_key) REFERENCES word(release_id, word_key) ON DELETE CASCADE
);

CREATE INDEX lexical_relation_release_from_idx ON lexical_relation (release_id, from_word_key);

CREATE TABLE card_definition (
  release_id        TEXT NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  content_card_key  TEXT NOT NULL,
  card_type         TEXT NOT NULL CHECK (card_type IN ('WORD_MEANING','CONTEXT_MEANING','PHRASE','SENSE_DISCRIMINATION')),
  target_entity_key TEXT NOT NULL,
  word_key          TEXT NOT NULL,
  unit_key          TEXT NOT NULL,
  template_version  TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE','DEPRECATED')),
  PRIMARY KEY (release_id, content_card_key),
  FOREIGN KEY (release_id, word_key) REFERENCES word(release_id, word_key) ON DELETE CASCADE,
  FOREIGN KEY (release_id, unit_key) REFERENCES unit(release_id, unit_key) ON DELETE CASCADE
);

CREATE INDEX card_definition_release_word_idx ON card_definition (release_id, word_key);

CREATE TABLE audio_asset (
  release_id               TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  asset_key                TEXT    NOT NULL,
  content_sha256           TEXT    NOT NULL,
  text_hash                TEXT    NOT NULL,
  provider                 TEXT    NOT NULL,
  model_id                 TEXT    NOT NULL,
  voice                    TEXT    NOT NULL,
  synthesis_config_version TEXT    NOT NULL,
  format_container         TEXT    NOT NULL DEFAULT 'wav' CHECK (format_container = 'wav'),
  sample_rate_hz           INTEGER NOT NULL CHECK (sample_rate_hz > 0),
  channels                 INTEGER NOT NULL CHECK (channels BETWEEN 1 AND 2),
  encoding                 TEXT    NOT NULL,
  duration_ms              INTEGER NOT NULL CHECK (duration_ms > 0),
  validation               TEXT    NOT NULL CHECK (validation IN ('PENDING','PASSED','FAILED')),
  PRIMARY KEY (release_id, asset_key)
);

-- Maps content entities to their audio assets. V1 pre-generates audio for
-- every headword and exam sentence (spec 5.8); entity keys are stable logical
-- keys and therefore not enforceable by composite foreign keys.
CREATE TABLE content_audio_link (
  release_id   TEXT NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('word','example')),
  entity_key   TEXT NOT NULL,
  asset_key    TEXT NOT NULL,
  PRIMARY KEY (release_id, entity_type, entity_key, asset_key),
  FOREIGN KEY (release_id, asset_key) REFERENCES audio_asset(release_id, asset_key) ON DELETE CASCADE
);

CREATE INDEX content_audio_link_release_asset_idx ON content_audio_link (release_id, asset_key);

-- Explicit, typed, release-aware stable-key migration edges (spec 5.5/6.2).
-- Edges are strictly one-to-one per release (both UNIQUE constraints), never
-- self-referential; acyclicity is validated when edges are resolved.
CREATE TABLE content_key_alias (
  release_id    TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  from_key      TEXT    NOT NULL,
  to_key        TEXT    NOT NULL,
  edge_type     TEXT    NOT NULL CHECK (edge_type IN ('RENAME','EQUIVALENT')),
  -- Stable canonical root key user state references (spec 6.4).
  canonical_key TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (release_id, from_key, to_key),
  UNIQUE (release_id, from_key),
  UNIQUE (release_id, to_key),
  CHECK (from_key <> to_key)
);

-- ---------------------------------------------------------------------------
-- Users, auth, and learning state (stable-key based, spec 6.2/6.4)
-- ---------------------------------------------------------------------------

CREATE TABLE app_user (
  user_id             TEXT    PRIMARY KEY,
  normalized_username TEXT    NOT NULL UNIQUE,
  password_salt       TEXT    NOT NULL,
  password_verifier   TEXT    NOT NULL,
  status              TEXT    NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  session_version     INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  created_at          INTEGER NOT NULL
);

CREATE TABLE auth_session (
  session_id      TEXT    PRIMARY KEY,
  token_hash      TEXT    NOT NULL UNIQUE,
  user_id         TEXT    NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  session_version INTEGER NOT NULL CHECK (session_version >= 1),
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  revoked_at      INTEGER,
  last_used_at    INTEGER
);

-- spec 6.3: auth_session(token_hash) unique; (user_id, expires_at) indexed.
CREATE INDEX auth_session_user_expires_idx ON auth_session (user_id, expires_at);

CREATE TABLE user_settings (
  user_id                  TEXT    PRIMARY KEY REFERENCES app_user(user_id) ON DELETE CASCADE,
  start_unit_key           TEXT,
  new_words_per_group      INTEGER NOT NULL DEFAULT 10 CHECK (new_words_per_group >= 1),
  daily_goal               INTEGER NOT NULL DEFAULT 20 CHECK (daily_goal >= 0),
  timezone                 TEXT    NOT NULL DEFAULT 'UTC',
  display_preferences_json TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(display_preferences_json))
);

CREATE TABLE word_progress (
  user_id               TEXT    NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  word_key              TEXT    NOT NULL,
  stage                 TEXT    NOT NULL DEFAULT 'UNSEEN' CHECK (stage IN ('UNSEEN','IN_PROGRESS','INTRODUCED')),
  -- First-contact familiarity classification (spec 9.3): 很陌生/有印象/熟悉.
  initial_familiarity   TEXT    CHECK (initial_familiarity IN ('UNKNOWN','RECOGNIZABLE','KNOWN')),
  first_seen_at         INTEGER NOT NULL,
  introduced_release_id TEXT    REFERENCES content_release(release_id) ON DELETE RESTRICT,
  introduced_at         INTEGER,
  last_seen_at          INTEGER NOT NULL,
  PRIMARY KEY (user_id, word_key),
  CHECK (
    (stage = 'INTRODUCED' AND introduced_release_id IS NOT NULL)
    OR (stage <> 'INTRODUCED' AND introduced_release_id IS NULL)
  )
);

CREATE TABLE card_state (
  user_id          TEXT    NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  content_card_key TEXT    NOT NULL,
  -- Versioned FSRS state envelope, validated at repository boundaries.
  fsrs_state       TEXT    NOT NULL CHECK (json_valid(fsrs_state)),
  -- Mirror columns of the envelope for the due-queue index (spec 6.3).
  due              INTEGER NOT NULL,
  reps             INTEGER NOT NULL DEFAULT 0 CHECK (reps >= 0),
  lapses           INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
  last_review_at   INTEGER,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (user_id, content_card_key)
);

-- spec 6.3: card_state(user_id, content_card_key) unique (= PK); (user_id, due)
-- for the due queue.
CREATE INDEX card_state_user_due_idx ON card_state (user_id, due);

-- Append-only grading evidence (spec 6.2/8.3): stores the canonical state key
-- plus the exact presented key/release so history stays immutable across
-- releases and alias migrations.
CREATE TABLE review_log (
  event_id             TEXT    PRIMARY KEY,
  user_id              TEXT    NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  -- Owning study session when the grade was submitted inside one; no FK so
  -- expired sessions can be cleaned without touching immutable evidence.
  session_id           TEXT,
  content_card_key     TEXT    NOT NULL,
  presented_card_key   TEXT    NOT NULL,
  presented_release_id TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE RESTRICT,
  rating               INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
  -- NULL before_state marks the first grade of a card (spec 8.3 undo).
  before_state         TEXT    CHECK (before_state IS NULL OR json_valid(before_state)),
  after_state          TEXT    NOT NULL CHECK (json_valid(after_state)),
  reviewed_at          INTEGER NOT NULL,
  duration_ms          INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  undone_at            INTEGER
);

-- spec 6.3: review_log(event_id) unique (= PK); (user_id, reviewed_at desc).
CREATE INDEX review_log_user_reviewed_idx ON review_log (user_id, reviewed_at DESC);

-- Fixed-release study session with a versioned queue snapshot (spec 5.7/6.4).
CREATE TABLE study_session (
  session_id     TEXT    PRIMARY KEY,
  user_id        TEXT    NOT NULL REFERENCES app_user(user_id) ON DELETE CASCADE,
  mode           TEXT    NOT NULL CHECK (mode IN ('NEW_WORDS','QUICK_TEST','REVIEW')),
  release_id     TEXT    NOT NULL REFERENCES content_release(release_id) ON DELETE CASCADE,
  queue_snapshot TEXT    NOT NULL CHECK (json_valid(queue_snapshot)),
  position       INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at     INTEGER NOT NULL,
  -- Sessions live at most 24 hours (spec 6.4).
  expires_at     INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + 86400000)
);

CREATE INDEX study_session_user_expires_idx ON study_session (user_id, expires_at);
