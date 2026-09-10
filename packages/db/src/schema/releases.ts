import { foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Release and metadata tables (spec 6.2 "发布与元数据").
 *
 * DDL source of truth is infra/migrations/*.sql; these builders mirror the
 * SQL for typed queries. CHECK constraints live in the SQL migrations only.
 */

export const contentRelease = sqliteTable("content_release", {
  releaseId: text("release_id").primaryKey(),
  sourcePdfSha256: text("source_pdf_sha256").notNull(),
  schemaVersion: text("schema_version").notNull(),
  promptVersion: text("prompt_version").notNull(),
  modelConfigJson: text("model_config_json").notNull(),
  status: text("status").notNull(),
  createdAt: integer("created_at").notNull(),
  activatedAt: integer("activated_at"),
  manifestSha256: text("manifest_sha256").notNull(),
});

export type ContentReleaseRow = typeof contentRelease.$inferSelect;

export const releaseUnit = sqliteTable(
  "release_unit",
  {
    releaseId: text("release_id").notNull(),
    unitKey: text("unit_key").notNull(),
    status: text("status").notNull(),
    words: integer("words").notNull().default(0),
    senses: integer("senses").notNull().default(0),
    phrases: integer("phrases").notNull().default(0),
    examples: integer("examples").notNull().default(0),
    explanations: integer("explanations").notNull().default(0),
    cards: integer("cards").notNull().default(0),
    qaSummary: text("qa_summary"),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.unitKey] }),
    foreignKey({ name: "release_unit_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    index("release_unit_release_idx").on(t.releaseId),
  ],
);

export type ReleaseUnitRow = typeof releaseUnit.$inferSelect;

/** Singleton row (id = 1): the unique active release pointer (spec 11.3). */
export const appMeta = sqliteTable("app_meta", {
  id: integer("id").primaryKey(),
  activeReleaseId: text("active_release_id").references(() => contentRelease.releaseId, { onDelete: "restrict" }),
  configVersion: integer("config_version").notNull().default(1),
});

export type AppMetaRow = typeof appMeta.$inferSelect;

/**
 * Typed, release-aware stable-key migration edges (spec 5.5/6.2). Strictly
 * one-to-one per release via the two unique indexes; `canonicalKey` is the
 * stable root user state references (spec 6.4).
 */
export const contentKeyAlias = sqliteTable(
  "content_key_alias",
  {
    releaseId: text("release_id").notNull(),
    fromKey: text("from_key").notNull(),
    toKey: text("to_key").notNull(),
    edgeType: text("edge_type").notNull(),
    canonicalKey: text("canonical_key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.releaseId, t.fromKey, t.toKey] }),
    foreignKey({ name: "content_key_alias_release_fk", columns: [t.releaseId], foreignColumns: [contentRelease.releaseId] }).onDelete("cascade"),
    uniqueIndex("content_key_alias_from_uq").on(t.releaseId, t.fromKey),
    uniqueIndex("content_key_alias_to_uq").on(t.releaseId, t.toKey),
  ],
);

export type ContentKeyAliasRow = typeof contentKeyAlias.$inferSelect;
