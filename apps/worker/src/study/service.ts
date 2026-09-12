/**
 * Study sessions (spec 5.7/6.4/8.3): fixed-release session queues with the
 * authoritative order, plus the atomic write primitive shared by grading,
 * patching, and undo.
 *
 * The session pins its release at creation (spec 6.4): content validity and
 * alias resolution always run against `session.releaseId`, never the active
 * pointer, so an activation or rollback mid-session changes neither the
 * frozen queue nor the canonical state grades address. All personal data is
 * user-scoped through `UserContext` (spec 6.3).
 */

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { SQL } from "drizzle-orm";
import {
  AliasRepository,
  CardStateRepository,
  ContentRepository,
  ReleaseRepository,
  ReviewLogRepository,
  StudySessionRepository,
  UserSettingsRepository,
  WordProgressRepository,
  cardDefinition,
  cardState,
  schema,
  unit,
  word,
  wordProgress,
  type CardDefinitionRow,
  type LexiloopDatabase,
  type StudySessionMode,
  type StudySessionRecord,
  type UserContext,
} from "@lexiloop/db";
import {
  buildInitialQueue,
  buildSupplementalQueue,
  dueQueueCards,
  queueCardsFromEntries,
  queueSnapshot,
  sessionExpiry,
  withPatchEventId,
  type DueCard,
  type IntroductionQueueEntry,
  type StudyQueueCard,
  type StudyQueueSnapshot,
} from "@lexiloop/domain";
import type { CardTypeName } from "@lexiloop/domain";

/** Error with a stable HTTP status and machine-readable code. */
export class StudyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StudyHttpError";
  }
}

/**
 * One atomic write unit for the study workflow (spec 8.3: one grade = one
 * D1 batch; any statement failure rolls back the whole unit). Statements are
 * prebuilt drizzle `SQL` — all decisions are made BEFORE the unit runs, and
 * conditional flips are expressed as guarded UPDATE statements.
 *
 * - D1 (production): drizzle's `batch()` — `db.run(sql)` yields the deferred
 *   statement objects `batch()` prepares, executed as one implicit
 *   transaction.
 * - better-sqlite3 (tests/scripts): one interactive `transaction()`.
 */
export interface AtomicBatchRunner {
  run(statements: readonly SQL[]): Promise<void>;
}

export function createAtomicBatchRunner(db: LexiloopDatabase): AtomicBatchRunner {
  const asyncHandle = db as unknown as {
    batch?: (queries: readonly unknown[]) => Promise<unknown>;
    run: (query: SQL) => unknown;
  };
  if (typeof asyncHandle.batch === "function") {
    return {
      async run(statements) {
        await asyncHandle.batch!(statements.map((statement) => asyncHandle.run(statement)));
      },
    };
  }
  // The documented cast pattern (see ReleaseRepository.setActive): the sync
  // driver has no batch, so the unit runs inside one transaction callback.
  const syncHandle = db as unknown as BetterSQLite3Database<typeof schema>;
  return {
    async run(statements) {
      syncHandle.transaction((tx) => {
        for (const statement of statements) {
          tx.run(statement);
        }
      });
    },
  };
}

/** API view of a study session (personal data: `private, no-store`). */
export interface SessionView {
  session_id: string;
  mode: StudySessionMode;
  release_id: string;
  position: number;
  created_at: number;
  expires_at: number;
  cards: StudyQueueCard[];
  /** Presented key of the item at the current position; null when done. */
  current_card_key: string | null;
  /** Distinct release-local unit keys of the snapshot's cards (sorted).
   *  Derived at read time from the card definitions; no new storage. */
  unit_keys: string[];
  /** Distinct release-local word keys of the snapshot's cards (sorted).
   *  Lets a resuming client verify the session matches its study selection. */
  word_keys: string[];
}

async function toSessionView(service: StudyService, record: StudySessionRecord): Promise<SessionView> {
  // The snapshot stores card keys only; the pinned release's definitions
  // recover the group's words and units (spec 6.4: pinned-release reads).
  const definitions = await Promise.all(
    record.queue.cards.map((card) => service.content.getCard(record.releaseId, card.presented_card_key)),
  );
  const unitKeys = new Set<string>();
  const wordKeys = new Set<string>();
  for (const definition of definitions) {
    if (!definition) {
      continue;
    }
    unitKeys.add(definition.unitKey);
    wordKeys.add(definition.wordKey);
  }
  return {
    session_id: record.sessionId,
    mode: record.mode,
    release_id: record.releaseId,
    position: record.position,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    cards: record.queue.cards.map((card) => ({
      canonical_card_key: card.canonical_card_key,
      presented_card_key: card.presented_card_key,
    })),
    current_card_key: record.queue.cards[record.position]?.presented_card_key ?? null,
    unit_keys: [...unitKeys].sort(),
    word_keys: [...wordKeys].sort(),
  };
}

/** Group size when the user has no settings row (the schema default). */
const DEFAULT_NEW_WORDS_PER_GROUP = 10;

/** Upper bound of one REVIEW session's queue (due-ordered, spec 6.3). */
const DUE_QUEUE_LIMIT = 100;

/**
 * Study workflow service. Route handlers stay thin; grading, patching, and
 * undo live in sibling modules that operate on this service.
 */
export class StudyService {
  readonly aliases: AliasRepository;
  readonly content: ContentRepository;
  readonly cardStates: CardStateRepository;
  readonly reviewLogs: ReviewLogRepository;
  readonly sessions: StudySessionRepository;
  readonly words: WordProgressRepository;
  readonly atomic: AtomicBatchRunner;

  constructor(
    private readonly db: LexiloopDatabase,
    private readonly clock: () => number,
  ) {
    this.aliases = new AliasRepository(db);
    this.content = new ContentRepository(db);
    this.cardStates = new CardStateRepository(db);
    this.reviewLogs = new ReviewLogRepository(db);
    this.sessions = new StudySessionRepository(db);
    this.words = new WordProgressRepository(db);
    this.atomic = createAtomicBatchRunner(db);
  }

  now(): number {
    return this.clock();
  }

  /** Loads the caller's session, failing closed on unknown/expired (spec 6.4). */
  async requireSession(ctx: UserContext, sessionId: string): Promise<StudySessionRecord> {
    const session = await this.sessions.get(ctx, sessionId);
    if (!session || session.expiresAt <= this.now()) {
      throw new StudyHttpError(400, "STUDY_SESSION_INVALID", "Study session is unknown, expired, or not yours");
    }
    return session;
  }

  async listSessions(ctx: UserContext): Promise<SessionView[]> {
    const records = await this.sessions.listActive(ctx, this.now());
    return await Promise.all(records.map((record) => toSessionView(this, record)));
  }

  async getSession(ctx: UserContext, sessionId: string): Promise<SessionView> {
    return await toSessionView(this, await this.requireSession(ctx, sessionId));
  }

  /** The queue item at the session's current position. */
  currentCard(session: StudySessionRecord): StudyQueueCard | undefined {
    return session.queue.cards[session.position];
  }

  /**
   * Creates a session of `mode`: builds the queue from the ACTIVE release
   * and pins it (spec 6.4). Queue building REUSES the Task 8 deterministic
   * builders; canonical keys are resolved through the alias repository at
   * snapshot time and re-resolved at every mutation.
   */
  async createSession(ctx: UserContext, mode: StudySessionMode): Promise<SessionView> {
    const active = await new ReleaseRepository(this.db).getActive();
    if (!active) {
      throw new StudyHttpError(404, "STUDY_NO_ACTIVE_RELEASE", "No active content release is configured");
    }
    const now = this.now();
    const releaseId = active.releaseId;
    const cards =
      mode === "NEW_WORDS"
        ? await this.newWordsCards(ctx, releaseId)
        : mode === "QUICK_TEST"
          ? await this.supplementalCards(ctx, releaseId)
          : await this.reviewCards(ctx, releaseId, now);
    if (cards.length === 0) {
      throw new StudyHttpError(409, "STUDY_QUEUE_EMPTY", "No cards are queued for this session mode");
    }
    const record = await this.sessions.create(ctx, {
      sessionId: crypto.randomUUID(),
      mode,
      releaseId,
      // Structural twin of the db envelope; validated again at the boundary.
      queueSnapshot: queueSnapshot(releaseId, cards),
      createdAt: now,
      expiresAt: sessionExpiry(now),
    });
    return await toSessionView(this, record);
  }

  /**
   * NEW_WORDS queue: the next group of UNSEEN/IN_PROGRESS words in textbook
   * order (unit order, tier, source order — the teaching order), whose
   * active cards enter the quick-recall queue under the binding 5.7 sort.
   */
  private async newWordsCards(ctx: UserContext, releaseId: string): Promise<StudyQueueCard[]> {
    const settings = await new UserSettingsRepository(this.db).get(ctx);
    const limit = settings?.newWordsPerGroup ?? DEFAULT_NEW_WORDS_PER_GROUP;
    const groupRows = await builder(this.db)
      .select({ wordKey: word.wordKey, sourceOrder: word.sourceOrder })
      .from(word)
      .leftJoin(unit, and(eq(unit.releaseId, word.releaseId), eq(unit.unitKey, word.unitKey)))
      .leftJoin(wordProgress, and(eq(wordProgress.userId, ctx.userId), eq(wordProgress.wordKey, word.wordKey)))
      .where(
        and(
          eq(word.releaseId, releaseId),
          or(isNull(wordProgress.stage), inArray(wordProgress.stage, ["UNSEEN", "IN_PROGRESS"])),
        ),
      )
      .orderBy(asc(unit.unitOrder), asc(word.tier), asc(word.sourceOrder), asc(word.wordKey))
      .limit(limit);
    const words = groupRows.map((row) => ({ word_key: row.wordKey, source_order: row.sourceOrder }));
    const definitions = words.length === 0 ? [] : await this.definitionsOf(releaseId, words.map((w) => w.word_key));
    const entries = buildInitialQueue(
      words,
      definitions.map(toQueueDefinition),
    );
    return await this.withCanonicalKeys(releaseId, entries);
  }

  /**
   * QUICK_TEST queue: the supplemental "cards to introduce" (待引入卡) —
   * cards of already-INTRODUCED words without a card_state, in the 5.7 order.
   */
  private async supplementalCards(ctx: UserContext, releaseId: string): Promise<StudyQueueCard[]> {
    const introduced = await builder(this.db)
      .select({ wordKey: wordProgress.wordKey, sourceOrder: word.sourceOrder })
      .from(wordProgress)
      .innerJoin(word, and(eq(word.releaseId, releaseId), eq(word.wordKey, wordProgress.wordKey)))
      .where(and(eq(wordProgress.userId, ctx.userId), eq(wordProgress.stage, "INTRODUCED")));
    if (introduced.length === 0) {
      return [];
    }
    const words = introduced.map((row) => ({ word_key: row.wordKey, source_order: row.sourceOrder }));
    const definitions = await this.definitionsOf(releaseId, words.map((w) => w.word_key));
    const stateRows =
      definitions.length === 0
        ? []
        : await builder(this.db)
            .select({ contentCardKey: cardState.contentCardKey })
            .from(cardState)
            .where(
              and(
                eq(cardState.userId, ctx.userId),
                inArray(cardState.contentCardKey, definitions.map((d) => d.contentCardKey)),
              ),
            );
    const entries = buildSupplementalQueue(
      words,
      stateRows.map((row) => ({ content_card_key: row.contentCardKey })),
      definitions.map(toQueueDefinition),
    );
    return await this.withCanonicalKeys(releaseId, entries);
  }

  /**
   * REVIEW queue: the user's due cards that the pinned release can present
   (ACTIVE definitions), ordered by due then canonical stable key (spec 6.3).
   */
  private async reviewCards(ctx: UserContext, releaseId: string, now: number): Promise<StudyQueueCard[]> {
    const due = await this.cardStates.getDue(ctx, now, DUE_QUEUE_LIMIT);
    if (due.length === 0) {
      return [];
    }
    const candidates: DueCard[] = due.map((record) => ({
      content_card_key: record.contentCardKey,
      due: record.state.due_at,
    }));
    const presentable = await builder(this.db)
      .select({ contentCardKey: cardDefinition.contentCardKey })
      .from(cardDefinition)
      .where(
        and(
          eq(cardDefinition.releaseId, releaseId),
          inArray(cardDefinition.contentCardKey, candidates.map((c) => c.content_card_key)),
          eq(cardDefinition.status, "ACTIVE"),
        ),
      );
    const presentableKeys = new Set(presentable.map((row) => row.contentCardKey));
    return dueQueueCards(
      candidates.filter((candidate) => presentableKeys.has(candidate.content_card_key)),
      now,
    );
  }

  private definitionsOf(releaseId: string, wordKeys: readonly string[]): Promise<CardDefinitionRow[]> {
    return this.db
      .select()
      .from(cardDefinition)
      .where(and(eq(cardDefinition.releaseId, releaseId), inArray(cardDefinition.wordKey, [...wordKeys])));
  }

  /** Resolves every presented key to its canonical state key (spec 6.4). */
  private async withCanonicalKeys(
    releaseId: string,
    entries: readonly IntroductionQueueEntry[],
  ): Promise<StudyQueueCard[]> {
    const canonicalByKey = new Map<string, string>();
    for (const entry of entries) {
      canonicalByKey.set(entry.content_card_key, await this.aliases.resolve({ releaseId, key: entry.content_card_key }));
    }
    return queueCardsFromEntries(entries, (presented) => canonicalByKey.get(presented)!);
  }

  /**
   * Validates a presented card in the session's pinned release and resolves
   * it to its canonical card and word keys (spec 8.3: alias resolution
   * happens BEFORE any familiarity, grade, or undo write).
   */
  async resolvePresented(
    session: StudySessionRecord,
    presentedCardKey: string,
  ): Promise<{ card: CardDefinitionRow; canonicalCardKey: string; canonicalWordKey: string; localWordKey: string }> {
    const card = await this.content.getCard(session.releaseId, presentedCardKey);
    if (!card) {
      throw new StudyHttpError(400, "STUDY_CARD_INVALID", "Card does not exist in the session's pinned release");
    }
    const canonicalCardKey = await this.aliases.resolve({ releaseId: session.releaseId, key: presentedCardKey });
    const canonicalWordKey = await this.aliases.resolve({ releaseId: session.releaseId, key: card.wordKey });
    return { card, canonicalCardKey, canonicalWordKey, localWordKey: card.wordKey };
  }

  /**
   * Canonical keys of a word's ACTIVE cards in a release: the definition
   * keys are release-local, so each resolves through the alias repository
   * before comparison with (canonically keyed) card_state rows.
   */
  async canonicalCardKeys(releaseId: string, localWordKey: string): Promise<string[]> {
    const rows = await this.definitionsOf(releaseId, [localWordKey]);
    const keys = new Set<string>();
    for (const row of rows) {
      if (row.status !== "ACTIVE") continue;
      keys.add(await this.aliases.resolve({ releaseId, key: row.contentCardKey }));
    }
    return [...keys];
  }

  /**
   * Rewrites a session's queue snapshot (patch event bookkeeping). The
   * rewritten snapshot must still describe the pinned release — the caller
   * passes the session it just validated.
   */
  async appendPatchEventId(session: StudySessionRecord, eventId: string): Promise<SQL> {
    const next = withPatchEventId(session.queue as StudyQueueSnapshot, eventId);
    return sqlUpdateQueueSnapshot(session.sessionId, next);
  }
}

/** Maps a release row onto the queue-builder definition shape. */
function toQueueDefinition(row: CardDefinitionRow): {
  content_card_key: string;
  card_type: CardTypeName;
  target_entity_key: string;
  word_key: string;
  status: "ACTIVE" | "DEPRECATED";
} {
  // Compiled releases persist validated card types/statuses (spec 5.6); the
  // builder only reads the fixed rank of the type and drops non-ACTIVE rows.
  return {
    content_card_key: row.contentCardKey,
    card_type: row.cardType as CardTypeName,
    target_entity_key: row.targetEntityKey,
    word_key: row.wordKey,
    status: row.status as "ACTIVE" | "DEPRECATED",
  };
}

/**
 * Builder-typed handle for query factories: the union handle cannot express
 * drizzle's field-select overloads at the type level (the same documented
 * cast the content service uses); both drivers share the builder runtime and
 * every statement runs behind `await`.
 */
function builder(db: LexiloopDatabase): BetterSQLite3Database<typeof schema> {
  return db as BetterSQLite3Database<typeof schema>;
}

/** Snapshot rewrite statement for the patch bookkeeping batch. */
function sqlUpdateQueueSnapshot(sessionId: string, snapshot: StudyQueueSnapshot): SQL {
  return sql`UPDATE study_session SET queue_snapshot = ${JSON.stringify(snapshot)} WHERE session_id = ${sessionId}`;
}
