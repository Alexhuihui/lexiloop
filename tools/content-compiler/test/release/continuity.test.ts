import { describe, expect, it } from "vitest";
import {
  buildKeyContinuity,
  parseReleaseSnapshot,
} from "../../src/release/continuity";

const OLD = "rel-old";
const NEXT = "rel-next";

describe("release stable-key continuity", () => {
  it("parses escaped SQL and emits exact word/card aliases for ordinal key shifts", () => {
    const previous = parseReleaseSnapshot(
      [
        `INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) VALUES ('${OLD}', 'w.u1.0001.coworker', 'u1', 'coworker', '[''x]', 'core', 1, '{}');`,
        `INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) VALUES ('${OLD}', 'w.u1.0002.o''clock', 'u1', 'o''clock', NULL, 'core', 2, '{}');`,
      ].join("\n"),
      [
        `INSERT INTO card_definition (release_id, content_card_key, card_type, target_entity_key, word_key, unit_key, template_version, status) VALUES ('${OLD}', 'card-old', 'WORD_MEANING', 's.w.u1.0001.coworker.1', 'w.u1.0001.coworker', 'u1', 'v1', 'ACTIVE');`,
      ].join("\n"),
    );

    const result = buildKeyContinuity(previous, {
      releaseId: NEXT,
      words: [
        { word_key: "w.u1.0002.coworker", unit_key: "u1", headword: "coworker" },
        { word_key: "w.u1.0003.o-clock", unit_key: "u1", headword: "o'clock" },
        { word_key: "w.u1.0004.new", unit_key: "u1", headword: "new" },
      ],
      cards: [
        {
          content_card_key: "card-next",
          card_type: "WORD_MEANING",
          target_entity_key: "s.w.u1.0002.coworker.1",
          word_key: "w.u1.0002.coworker",
        },
      ],
    });

    expect(previous.releaseId).toBe(OLD);
    expect(result.report.words).toEqual({ preserved: 0, aliased: 2, added: 1, removed: 0 });
    expect(result.report.cards).toEqual({ preserved: 0, aliased: 1, added: 0, removed: 0 });
    expect(result.aliasFile.edges).toEqual([
      {
        entity_type: "card",
        from_release_id: OLD,
        from_key: "card-old",
        to_release_id: NEXT,
        to_key: "card-next",
        canonical_key: "card-next",
      },
      {
        entity_type: "word",
        from_release_id: OLD,
        from_key: "w.u1.0001.coworker",
        to_release_id: NEXT,
        to_key: "w.u1.0002.coworker",
        canonical_key: "w.u1.0002.coworker",
      },
      {
        entity_type: "word",
        from_release_id: OLD,
        from_key: "w.u1.0002.o'clock",
        to_release_id: NEXT,
        to_key: "w.u1.0003.o-clock",
        canonical_key: "w.u1.0003.o-clock",
      },
    ]);
  });

  it("reports removed entities and never guesses across renamed headwords", () => {
    const previous = parseReleaseSnapshot(
      `INSERT INTO word (release_id, word_key, unit_key, headword, phonetic, tier, source_order, provenance_json) VALUES ('${OLD}', 'w.old', 'u1', 'wrong', NULL, 'core', 1, '{}');`,
      `INSERT INTO card_definition (release_id, content_card_key, card_type, target_entity_key, word_key, unit_key, template_version, status) VALUES ('${OLD}', 'card-old', 'SENSE_DISCRIMINATION', 'w.old', 'w.old', 'u1', 'v1', 'ACTIVE');`,
    );
    const result = buildKeyContinuity(previous, {
      releaseId: NEXT,
      words: [{ word_key: "w.new", unit_key: "u1", headword: "correct" }],
      cards: [],
    });

    expect(result.report.words).toEqual({ preserved: 0, aliased: 0, added: 1, removed: 1 });
    expect(result.report.cards).toEqual({ preserved: 0, aliased: 0, added: 0, removed: 1 });
    expect(result.aliasFile.edges).toEqual([]);
  });
});
