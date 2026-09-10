import { describe, expect, it } from "vitest";
import { createMigratedTestDb, T0, type TestDatabase } from "./helpers";

/**
 * Every logical table group of spec 6.2 must exist in ONE database after all
 * migrations are applied in filename order (single-D1 requirement, spec 6.1).
 */
const SPEC_TABLES = [
  "content_release", "release_unit", "app_meta", "book", "unit", "word",
  "sense", "phrase", "example", "explanation", "lexical_relation",
  "card_definition", "audio_asset", "content_audio_link", "content_key_alias",
  "app_user", "auth_session", "user_settings", "word_progress", "card_state",
  "review_log", "study_session", "content_search_fts",
];

function tableNames(sqlite: TestDatabase["sqlite"]): string[] {
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

const INSERT_RELEASE = `INSERT INTO content_release
  (release_id, source_pdf_sha256, schema_version, prompt_version, model_config_json, status, created_at, manifest_sha256)
  VALUES (?, ?, 'schema-v1', 'prompt-v1', '{}', ?, ?, 'manifest-sha')`;

const INSERT_USER = `INSERT INTO app_user
  (user_id, normalized_username, password_salt, password_verifier, status, session_version, created_at)
  VALUES (?, ?, 'salt', 'verifier', 'ACTIVE', 1, ?)`;

/** Seeds release -> book -> unit -> word so dependent tables can be tested. */
function seedWord(sqlite: TestDatabase["sqlite"], releaseId: string, wordKey: string, headword: string): void {
  sqlite.prepare(INSERT_RELEASE).run(releaseId, "a".repeat(64), "DRAFT", T0);
  sqlite
    .prepare("INSERT INTO book (release_id, book_key, title, edition, provenance_json) VALUES (?, ?, 't', 'e', '{}')")
    .run(releaseId, "bk-1");
  sqlite
    .prepare("INSERT INTO unit (release_id, unit_key, book_key, level, unit_order, title, provenance_json) VALUES (?, ?, ?, 1, 1, 'Unit 1', '{}')")
    .run(releaseId, "u1", "bk-1");
  sqlite
    .prepare("INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) VALUES (?, ?, ?, ?, NULL, 'core', 1, '{}')")
    .run(releaseId, wordKey, "u1", headword);
}

describe("D1 migrations", () => {
  it("creates every spec table group in a single database", () => {
    const env = createMigratedTestDb();
    try {
      expect(tableNames(env.sqlite)).toEqual(expect.arrayContaining(SPEC_TABLES));
    } finally {
      env.cleanup();
    }
  });

  it("defines content_search_fts as an FTS5 virtual table", () => {
    const env = createMigratedTestDb();
    try {
      const row = env.sqlite
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'content_search_fts'")
        .get() as { sql: string } | undefined;
      expect(row?.sql).toBeDefined();
      expect(row?.sql.toLowerCase()).toContain("fts5");
      // A plain insert + MATCH proves the virtual table is actually usable.
      env.sqlite
        .prepare("INSERT INTO content_search_fts (release_id, entity_type, entity_key, text) VALUES ('r1', 'word', 'w1', 'abandon')")
        .run();
      const hits = env.sqlite
        .prepare("SELECT entity_key FROM content_search_fts WHERE content_search_fts MATCH 'abandon' AND release_id = 'r1'")
        .all() as Array<{ entity_key: string }>;
      expect(hits).toEqual([{ entity_key: "w1" }]);
    } finally {
      env.cleanup();
    }
  });

  it("rejects duplicate normalized usernames", () => {
    const env = createMigratedTestDb();
    try {
      const insert = env.sqlite.prepare(INSERT_USER);
      insert.run("user-1", "alice", T0);
      expect(() => insert.run("user-2", "alice", T0)).toThrow(/UNIQUE/i);
    } finally {
      env.cleanup();
    }
  });

  it("rejects a second card state for the same user and card key", () => {
    const env = createMigratedTestDb();
    try {
      env.sqlite.prepare(INSERT_USER).run("user-1", "alice", T0);
      const insert = env.sqlite.prepare(
        "INSERT INTO card_state (user_id, content_card_key, fsrs_state, due, reps, lapses, updated_at) VALUES (?, ?, '{}', ?, 0, 0, ?)",
      );
      insert.run("user-1", "card-1", T0 + 1000, T0);
      expect(() => insert.run("user-1", "card-1", T0 + 2000, T0)).toThrow(/UNIQUE|PRIMARY/i);
      // A different user may hold state for the same card key.
      env.sqlite.prepare(INSERT_USER).run("user-2", "bob", T0);
      expect(() => insert.run("user-2", "card-1", T0 + 2000, T0)).not.toThrow();
    } finally {
      env.cleanup();
    }
  });

  it("rejects duplicate review event ids", () => {
    const env = createMigratedTestDb();
    try {
      env.sqlite.prepare(INSERT_USER).run("user-1", "alice", T0);
      env.sqlite.prepare(INSERT_RELEASE).run("r1", "a".repeat(64), "READY", T0);
      const insert = env.sqlite.prepare(
        `INSERT INTO review_log
           (event_id, user_id, content_card_key, presented_card_key, presented_release_id, rating, before_state, after_state, reviewed_at)
         VALUES (?, ?, 'card-1', 'card-1', 'r1', 3, NULL, '{}', ?)`,
      );
      insert.run("event-1", "user-1", T0);
      expect(() => insert.run("event-1", "user-1", T0 + 1)).toThrow(/UNIQUE|PRIMARY/i);
    } finally {
      env.cleanup();
    }
  });

  it("enforces release-scoped foreign keys", () => {
    const env = createMigratedTestDb();
    try {
      seedWord(env.sqlite, "r1", "w1", "abandon");
      // sense references (release_id, word_key) that does not exist -> reject.
      expect(() =>
        env.sqlite
          .prepare("INSERT INTO sense (release_id, sense_key, word_key, pos, gloss, sense_order, provenance_json) VALUES ('r1', 's-missing', 'missing-word', 'v', '放弃', 1, '{}')")
          .run(),
      ).toThrow(/FOREIGN KEY/i);
      // Cross-release reference (word key exists only in r1) -> reject.
      env.sqlite.prepare(INSERT_RELEASE).run("r2", "a".repeat(64), "DRAFT", T0);
      expect(() =>
        env.sqlite
          .prepare("INSERT INTO sense (release_id, sense_key, word_key, pos, gloss, sense_order, provenance_json) VALUES ('r2', 's-cross', 'w1', 'v', '放弃', 1, '{}')")
          .run(),
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      env.cleanup();
    }
  });

  it("enforces CHECK constraints on statuses and ratings", () => {
    const env = createMigratedTestDb();
    try {
      expect(() => env.sqlite.prepare(INSERT_RELEASE).run("r-bad", "a".repeat(64), "PUBLISHED", T0)).toThrow(/CHECK/i);
      env.sqlite.prepare(INSERT_USER).run("user-1", "alice", T0);
      env.sqlite.prepare(INSERT_RELEASE).run("r1", "a".repeat(64), "READY", T0);
      expect(() =>
        env.sqlite
          .prepare(
            `INSERT INTO review_log (event_id, user_id, content_card_key, presented_card_key, presented_release_id, rating, before_state, after_state, reviewed_at)
             VALUES ('event-bad', 'user-1', 'card-1', 'card-1', 'r1', 5, NULL, '{}', ?)`,
          )
          .run(T0),
      ).toThrow(/CHECK/i);
      // study_session must expire within 24h of creation (spec 6.4).
      expect(() =>
        env.sqlite
          .prepare(
            `INSERT INTO study_session (session_id, user_id, mode, release_id, queue_snapshot, position, created_at, expires_at)
             VALUES ('s1', 'user-1', 'REVIEW', 'r1', '{}', 0, ?, ?)`,
          )
          .run(T0, T0 + 25 * 60 * 60 * 1000),
      ).toThrow(/CHECK/i);
    } finally {
      env.cleanup();
    }
  });

  it("syncs searchable content into content_search_fts and supports rebuild", () => {
    const env = createMigratedTestDb();
    try {
      seedWord(env.sqlite, "r1", "w1", "abandon");
      env.sqlite
        .prepare("INSERT INTO sense (release_id, sense_key, word_key, pos, gloss, sense_order, provenance_json) VALUES ('r1', 's1', 'w1', 'v', '放弃计划', 1, '{}')")
        .run();
      env.sqlite
        .prepare("INSERT INTO phrase (release_id, phrase_key, word_key, sense_key, text, gloss, source_order, provenance_json) VALUES ('r1', 'p1', 'w1', 's1', 'abandon ship', '弃船', 1, '{}')")
        .run();
      env.sqlite
        .prepare("INSERT INTO example (release_id, example_key, word_key, sense_key, origin, text, target_start, target_end, source_order, provenance_json) VALUES ('r1', 'e1', 'w1', 's1', 'exam', 'We abandon the plan.', 3, 10, 1, '{}')")
        .run();

      const match = (term: string): string[] =>
        (env.sqlite
          .prepare("SELECT entity_type FROM content_search_fts WHERE content_search_fts MATCH ? AND release_id = 'r1'")
          .all(term) as Array<{ entity_type: string }>).map((row) => row.entity_type).sort();

      expect(match("abandon")).toEqual(["example", "phrase", "word"]);
      // unicode61 pins each Han-character run as ONE token: no substring
      // matches. Chinese-sense search (Task 12) must use prefix queries
      // (decision recorded in 0002_content_search_fts.sql).
      expect(match("放弃")).toEqual([]);
      expect(match("放弃*")).toEqual(["sense"]);
      expect(match("计划")).toEqual([]);
      expect(match("放弃计划")).toEqual(["sense"]);
      // V1 indexes phrase text, not phrase glosses (spec 9.5 search fields).
      expect(match("弃船")).toEqual([]);

      // FTS is not a backup source (spec 6.3): the rebuild command must work.
      env.sqlite.exec("INSERT INTO content_search_fts(content_search_fts) VALUES('rebuild')");
      expect(match("abandon")).toEqual(["example", "phrase", "word"]);

      // Deleting the word removes its indexed row via the sync triggers.
      env.sqlite.prepare("DELETE FROM word WHERE release_id = 'r1' AND word_key = 'w1'").run();
      expect(match("abandon")).toEqual([]);
    } finally {
      env.cleanup();
    }
  });

  it("seeds the app_meta singleton with no active release", () => {
    const env = createMigratedTestDb();
    try {
      const row = env.sqlite.prepare("SELECT active_release_id, config_version FROM app_meta WHERE id = 1").get() as
        | { active_release_id: string | null; config_version: number }
        | undefined;
      expect(row).toEqual({ active_release_id: null, config_version: 1 });
    } finally {
      env.cleanup();
    }
  });
});
