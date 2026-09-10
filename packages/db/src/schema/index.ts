import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { DrizzleD1Database } from "drizzle-orm/d1";
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
 * Drizzle database handle accepted by every repository in this package.
 *
 * Driver-agnostic by construction: both the sync better-sqlite3 driver
 * (compiler, scripts, tests) and the async D1 driver (worker) satisfy the
 * union. All repository statements are executed with `await`, which both
 * drivers support; the single exception is ReleaseRepository.setActive's
 * interactive transaction, isolated there with a documented cast (drizzle's
 * per-driver transaction callbacks cannot be inferred through the union).
 * A tsc-level probe lives in test/driver.test.ts.
 */
export type LexiloopDatabase =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>;
