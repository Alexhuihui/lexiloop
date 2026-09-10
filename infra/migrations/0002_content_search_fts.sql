-- FTS5 dictionary search index (spec 6.2/9.5): headwords, Chinese sense
-- glosses, phrase text, and example sentences.
--
-- Sync strategy: a standalone FTS5 table kept in sync by triggers on the four
-- searchable content tables, so ordinary inserts/deletes always leave the
-- index queryable. FTS5 is not a backup source (spec 6.3); after a restore,
-- repopulate via the 'rebuild' command:
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
