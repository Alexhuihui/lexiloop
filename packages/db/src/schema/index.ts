import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  audioAsset,
  book,
  cardDefinition,
  contentAudioLink,
  example,
  explanation,
  lexicalRelation,
  phrase,
  sense,
  unit,
  word,
} from "./content";
import { appMeta, contentKeyAlias, contentRelease, releaseUnit } from "./releases";
import { cardState, reviewLog, studySession, wordProgress } from "./study";
import { appUser, authSession, userSettings } from "./users";

export * from "./releases";
export * from "./content";
export * from "./users";
export * from "./study";

/** All Drizzle tables in one record, for `drizzle(client, { schema })`. */
export const schema = {
  contentRelease,
  releaseUnit,
  appMeta,
  contentKeyAlias,
  book,
  unit,
  word,
  sense,
  phrase,
  example,
  explanation,
  lexicalRelation,
  cardDefinition,
  audioAsset,
  contentAudioLink,
  appUser,
  authSession,
  userSettings,
  wordProgress,
  cardState,
  reviewLog,
  studySession,
};

/**
 * Drizzle database handle type. The sync better-sqlite3 driver is used by
 * local tests and tools; the D1 worker binds the same table definitions and
 * composes critical write paths with D1 `batch()` (spec 6.1).
 */
export type LexiloopDatabase = BetterSQLite3Database<typeof schema>;
