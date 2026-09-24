-- FTS5 dictionary search index (spec 6.2/9.5): headwords, Chinese sense
-- glosses, phrase text, and example sentences.
--
-- Sync strategy: a standalone FTS5 table kept in sync by triggers on the four
-- searchable content tables, so ordinary inserts/deletes always leave the
-- index queryable.
--
-- CJK tokenizer decision (Task 3 review): unicode61 treats a run of Han
-- characters as ONE token, so substring matching inside Chinese glosses is
-- impossible by design. Kept unicode61 anyway; Chinese-sense search
-- (Task 12, spec 9.5) uses token-prefix queries, e.g.
--   SELECT ... FROM content_search_fts WHERE content_search_fts MATCH '放弃*'
-- which matches glosses like 放弃计划 but not 计划 (no substring matches).
-- Alternative considered and rejected: the trigram tokenizer would enable
-- substring search, but its D1 support is unverified and its index size for
-- the English headword corpus that dominates V1 is disproportionate.
--
-- Retention/rollback delete ordering (review finding): the per-row delete
-- triggers below scan this table for (release_id, entity_type, entity_key).
-- Any bulk delete of a release (retention cleanup or rollback, spec 6.4)
-- MUST therefore first bulk-clear the index, then delete the content rows:
--   DELETE FROM content_search_fts WHERE release_id = ?;   -- 1st
--   DELETE FROM word ...  -- then cascading content deletes -- 2nd
-- so every trigger scans a near-empty index instead of the whole table.
--
-- FTS is not a backup source (spec 6.3); after a restore, repopulate via the
-- 'rebuild' command:
--   INSERT INTO content_search_fts(content_search_fts) VALUES('rebuild');

CREATE VIRTUAL TABLE content_search_fts USING fts5 (
  text,
  release_id UNINDEXED,
  entity_type UNINDEXED,
  entity_key UNINDEXED,
  tokenize = 'unicode61'
);

-- word: headword -----------------------------------------------------------

CREATE TRIGGER content_search_word_ai AFTER INSERT ON word BEGIN
  INSERT INTO content_search_fts (release_id, entity_type, entity_key, text)
  VALUES (NEW.release_id, 'word', NEW.word_key, NEW.headword);
END;

CREATE TRIGGER content_search_word_au AFTER UPDATE ON word BEGIN
  DELETE FROM content_search_fts
    WHERE release_id = OLD.release_id AND entity_type = 'word' AND entity_key = OLD.word_key;
  INSERT INTO content_search_fts (release_id, entity_type, entity_key, text)
  VALUES (NEW.release_id, 'word', NEW.word_key, NEW.headword);
END;

CREATE TRIGGER content_search_word_ad AFTER DELETE ON word BEGIN
  DELETE FROM content_search_fts
    WHERE release_id = OLD.release_id AND entity_type = 'word' AND entity_key = OLD.word_key;
END;

-- sense: Chinese gloss ------------------------------------------------------

CREATE TRIGGER content_search_sense_ai AFTER INSERT ON sense BEGIN
  INSERT INTO content_search_fts (release_id, entity_type, entity_key, text)
  VALUES (NEW.release_id, 'sense', NEW.sense_key, NEW.gloss);
END;

CREATE TRIGGER content_search_sense_au AFTER UPDATE ON sense BEGIN
  DELETE FROM content_search_fts
    WHERE release_id = OLD.release_id AND entity_type = 'sense' AND entity_key = OLD.sense_key;
  INSERT INTO content_search_fts (release_id, entity_type, entity_key, text)
  VALUES (NEW.release_id, 'sense', NEW.sense_key, NEW.gloss);
END;

CREATE TRIGGER content_search_sense_ad AFTER DELETE ON sense BEGIN
  DELETE FROM content_search_fts
    WHERE release_id = OLD.release_id AND entity_type = 'sense' AND entity_key = OLD.sense_key;
END;

-- phrase: phrase text --------------------------------------------------------

CREATE TRIGGER content_search_phrase_ai AFTER INSERT ON phrase BEGIN
  INSERT INTO content_search_fts (release_id, entity_type, entity_key, text)
  VALUES (NEW.release_id, 'phrase', NEW.phrase_key, NEW.text);
END;

CREATE TRIGGER content_search_phrase_au AFTER UPDATE ON phrase BEGIN
  DELETE FROM content_search_fts
    WHERE release_id = OLD.release_id AND entity_type = 'phrase' AND entity_key = OLD.phrase_key;
  INSERT INTO content_search_fts (release_id, entity_type, entity_key, text)
  VALUES (NEW.release_id, 'phrase', NEW.phrase_key, NEW.text);
END;

CREATE TRIGGER content_search_phrase_ad AFTER DELETE ON phrase BEGIN
  DELETE FROM content_search_fts
    WHERE release_id = OLD.release_id AND entity_type = 'phrase' AND entity_key = OLD.phrase_key;
END;

-- example: sentence text ------------------------------------------------------

CREATE TRIGGER content_search_example_ai AFTER INSERT ON example BEGIN
  INSERT INTO content_search_fts (release_id, entity_type, entity_key, text)
  VALUES (NEW.release_id, 'example', NEW.example_key, NEW.text);
END;

CREATE TRIGGER content_search_example_au AFTER UPDATE ON example BEGIN
  DELETE FROM content_search_fts
    WHERE release_id = OLD.release_id AND entity_type = 'example' AND entity_key = OLD.example_key;
  INSERT INTO content_search_fts (release_id, entity_type, entity_key, text)
  VALUES (NEW.release_id, 'example', NEW.example_key, NEW.text);
END;

CREATE TRIGGER content_search_example_ad AFTER DELETE ON example BEGIN
  DELETE FROM content_search_fts
    WHERE release_id = OLD.release_id AND entity_type = 'example' AND entity_key = OLD.example_key;
END;
