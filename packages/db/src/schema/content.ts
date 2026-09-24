import { foreignKey, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { contentRelease } from "./releases";

/**
 * Release-scoped textbook content tables (spec 6.2 "教材内容").
 *
 * Every table carries `release_id` and a composite `(release_id, logical_key)`
 * primary key (spec 6.2). Source provenance (spec 5.5) is stored as JSON in
 * `provenance_json`; `explanation` keeps its searchable core fields as plain
 * columns and everything generated in `generated_json` (spec 6.2).
 */

export const book = sqliteTable(
  "book",
  {
    releaseId: text("release_id").notNull(),
    bookKey: text("book_key").notNull(),
    title: text("title").notNull(),
    edition: text("edition").notNull(),
    provenanceJson: text("provenance_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.bookKey] }),
    foreignKey({ name: "book_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
  ],
);

export type BookRow = typeof book.$inferSelect;

export const unit = sqliteTable(
  "unit",
  {
    releaseId: text("release_id").notNull(),
    unitKey: text("unit_key").notNull(),
    bookKey: text("book_key").notNull(),
    level: integer("level").notNull(),
    unitOrder: integer("unit_order").notNull(),
    title: text("title").notNull(),
    provenanceJson: text("provenance_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.unitKey] }),
    foreignKey({ name: "unit_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    foreignKey({ name: "unit_book_fk", columns: [t.releaseId, t.bookKey], foreignColumns: [book.releaseId, book.bookKey] }).onDelete("cascade"),
    index("unit_release_book_idx").on(t.releaseId, t.bookKey),
  ],
);

export type UnitRow = typeof unit.$inferSelect;

export const word = sqliteTable(
  "word",
  {
    releaseId: text("release_id").notNull(),
    wordKey: text("word_key").notNull(),
    unitKey: text("unit_key").notNull(),
    headword: text("headword").notNull(),
    phonetic: text("phonetic"),
    tier: text("tier").notNull(),
    sourceOrder: integer("source_order").notNull(),
    provenanceJson: text("provenance_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.wordKey] }),
    foreignKey({ name: "word_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    foreignKey({ name: "word_unit_fk", columns: [t.releaseId, t.unitKey], foreignColumns: [unit.releaseId, unit.unitKey] }).onDelete("cascade"),
    // spec 6.3: word(release_id, unit_key, tier, source_order).
    index("word_release_unit_tier_order_idx").on(t.releaseId, t.unitKey, t.tier, t.sourceOrder),
  ],
);

export type WordRow = typeof word.$inferSelect;

export const sense = sqliteTable(
  "sense",
  {
    releaseId: text("release_id").notNull(),
    senseKey: text("sense_key").notNull(),
    wordKey: text("word_key").notNull(),
    pos: text("pos").notNull(),
    gloss: text("gloss").notNull(),
    senseOrder: integer("sense_order").notNull(),
    provenanceJson: text("provenance_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.senseKey] }),
    foreignKey({ name: "sense_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    foreignKey({ name: "sense_word_fk", columns: [t.releaseId, t.wordKey], foreignColumns: [word.releaseId, word.wordKey] }).onDelete("cascade"),
    index("sense_release_word_idx").on(t.releaseId, t.wordKey),
  ],
);

export type SenseRow = typeof sense.$inferSelect;

export const phrase = sqliteTable(
  "phrase",
  {
    releaseId: text("release_id").notNull(),
    phraseKey: text("phrase_key").notNull(),
    wordKey: text("word_key").notNull(),
    senseKey: text("sense_key"),
    text: text("text").notNull(),
    gloss: text("gloss").notNull(),
    sourceOrder: integer("source_order").notNull(),
    provenanceJson: text("provenance_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.phraseKey] }),
    foreignKey({ name: "phrase_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    foreignKey({ name: "phrase_word_fk", columns: [t.releaseId, t.wordKey], foreignColumns: [word.releaseId, word.wordKey] }).onDelete("cascade"),
    foreignKey({ name: "phrase_sense_fk", columns: [t.releaseId, t.senseKey], foreignColumns: [sense.releaseId, sense.senseKey] }).onDelete("cascade"),
    // spec 6.3: phrase(release_id, word_key).
    index("phrase_release_word_idx").on(t.releaseId, t.wordKey),
  ],
);

export type PhraseRow = typeof phrase.$inferSelect;

export const example = sqliteTable(
  "example",
  {
    releaseId: text("release_id").notNull(),
    exampleKey: text("example_key").notNull(),
    wordKey: text("word_key").notNull(),
    senseKey: text("sense_key"),
    phraseKey: text("phrase_key"),
    origin: text("origin").notNull(),
    sourceRef: text("source_ref"),
    text: text("text").notNull(),
    targetStart: integer("target_start").notNull(),
    targetEnd: integer("target_end").notNull(),
    sourceOrder: integer("source_order").notNull(),
    provenanceJson: text("provenance_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.exampleKey] }),
    foreignKey({ name: "example_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    foreignKey({ name: "example_word_fk", columns: [t.releaseId, t.wordKey], foreignColumns: [word.releaseId, word.wordKey] }).onDelete("cascade"),
    foreignKey({ name: "example_sense_fk", columns: [t.releaseId, t.senseKey], foreignColumns: [sense.releaseId, sense.senseKey] }).onDelete("cascade"),
    foreignKey({ name: "example_phrase_fk", columns: [t.releaseId, t.phraseKey], foreignColumns: [phrase.releaseId, phrase.phraseKey] }).onDelete("cascade"),
    // spec 6.3: example(release_id, word_key).
    index("example_release_word_idx").on(t.releaseId, t.wordKey),
  ],
);

export type ExampleRow = typeof example.$inferSelect;

export const explanation = sqliteTable(
  "explanation",
  {
    releaseId: text("release_id").notNull(),
    explanationKey: text("explanation_key").notNull(),
    wordKey: text("word_key").notNull(),
    unitKey: text("unit_key").notNull(),
    generatedJson: text("generated_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.explanationKey] }),
    foreignKey({ name: "explanation_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    foreignKey({ name: "explanation_word_fk", columns: [t.releaseId, t.wordKey], foreignColumns: [word.releaseId, word.wordKey] }).onDelete("cascade"),
    foreignKey({ name: "explanation_unit_fk", columns: [t.releaseId, t.unitKey], foreignColumns: [unit.releaseId, unit.unitKey] }).onDelete("cascade"),
    index("explanation_release_word_idx").on(t.releaseId, t.wordKey),
  ],
);

export type ExplanationRow = typeof explanation.$inferSelect;

export const lexicalRelation = sqliteTable(
  "lexical_relation",
  {
    releaseId: text("release_id").notNull(),
    relationKey: text("relation_key").notNull(),
    fromWordKey: text("from_word_key").notNull(),
    toWordKey: text("to_word_key").notNull(),
    relationType: text("relation_type").notNull(),
    provenanceJson: text("provenance_json").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.relationKey] }),
    foreignKey({ name: "lexical_relation_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    foreignKey({ name: "lexical_relation_from_fk", columns: [t.releaseId, t.fromWordKey], foreignColumns: [word.releaseId, word.wordKey] }).onDelete("cascade"),
    foreignKey({ name: "lexical_relation_to_fk", columns: [t.releaseId, t.toWordKey], foreignColumns: [word.releaseId, word.wordKey] }).onDelete("cascade"),
    index("lexical_relation_release_from_idx").on(t.releaseId, t.fromWordKey),
  ],
);

export type LexicalRelationRow = typeof lexicalRelation.$inferSelect;

export const cardDefinition = sqliteTable(
  "card_definition",
  {
    releaseId: text("release_id").notNull(),
    contentCardKey: text("content_card_key").notNull(),
    cardType: text("card_type").notNull(),
    targetEntityKey: text("target_entity_key").notNull(),
    wordKey: text("word_key").notNull(),
    unitKey: text("unit_key").notNull(),
    templateVersion: text("template_version").notNull(),
    status: text("status").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.contentCardKey] }),
    foreignKey({ name: "card_definition_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    foreignKey({ name: "card_definition_word_fk", columns: [t.releaseId, t.wordKey], foreignColumns: [word.releaseId, word.wordKey] }).onDelete("cascade"),
    foreignKey({ name: "card_definition_unit_fk", columns: [t.releaseId, t.unitKey], foreignColumns: [unit.releaseId, unit.unitKey] }).onDelete("cascade"),
    index("card_definition_release_word_idx").on(t.releaseId, t.wordKey),
  ],
);

export type CardDefinitionRow = typeof cardDefinition.$inferSelect;

export const audioAsset = sqliteTable(
  "audio_asset",
  {
    releaseId: text("release_id").notNull(),
    assetKey: text("asset_key").notNull(),
    contentSha256: text("content_sha256").notNull(),
    textHash: text("text_hash").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    voice: text("voice").notNull(),
    synthesisConfigVersion: text("synthesis_config_version").notNull(),
    formatContainer: text("format_container").notNull().default("wav"),
    sampleRateHz: integer("sample_rate_hz").notNull(),
    channels: integer("channels").notNull(),
    encoding: text("encoding").notNull(),
    durationMs: integer("duration_ms").notNull(),
    validation: text("validation").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.assetKey] }),
    foreignKey({ name: "audio_asset_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
  ],
);

export type AudioAssetRow = typeof audioAsset.$inferSelect;

/**
 * Maps content entities to audio assets (spec 5.8/6.2). Entity keys are
 * stable logical keys of the declared `entity_type`; they cannot be enforced
 * by a composite foreign key, only `asset_key` is.
 */
export const contentAudioLink = sqliteTable(
  "content_audio_link",
  {
    releaseId: text("release_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityKey: text("entity_key").notNull(),
    assetKey: text("asset_key").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.entityType, t.entityKey, t.assetKey] }),
    foreignKey({ name: "content_audio_link_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    foreignKey({ name: "content_audio_link_asset_fk", columns: [t.releaseId, t.assetKey], foreignColumns: [audioAsset.releaseId, audioAsset.assetKey] }).onDelete("cascade"),
    index("content_audio_link_release_asset_idx").on(t.releaseId, t.assetKey),
  ],
);

export type ContentAudioLinkRow = typeof contentAudioLink.$inferSelect;
