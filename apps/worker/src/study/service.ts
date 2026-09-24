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

import { and, asc, eq, sql } from "drizzle-orm";
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
  createAtomicBatchRunner,
  cardState,
  schema,
  unit,
  word,
  wordProgress,
  type AtomicBatchRunner,
  type AliasSnapshot,
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
 * D1 batch; any statement failure rolls back the whole unit). Owned by the
 * db package (`createAtomicBatchRunner`) so release activation composes the
 * exact same primitive; re-exported here for the study surface.
 */
export { createAtomicBatchRunner } from "@lexiloop/db";
export type { AtomicBatchRunner } from "@lexiloop/db";

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

export interface ResolvedPresentedCard {
  card: CardDefinitionRow;
  canonicalCardKey: string;
  canonicalWordKey: string;
  localWordKey: string;
}

export interface ResolvedPresentedCards {
  items: ResolvedPresentedCard[];
  aliases: AliasSnapshot;
}

function sessionViewFromDefinitions(
  record: StudySessionRecord,
  definitionsByKey: ReadonlyMap<string, CardDefinitionRow>,
): SessionView {
  const unitKeys = new Set<string>();
  const wordKeys = new Set<string>();
  for (const entry of record.queue.cards) {
    const definition = definitionsByKey.get(entry.presented_card_key);
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

async function toSessionView(service: StudyService, record: StudySessionRecord): Promise<SessionView> {
  // The snapshot stores card keys only; the pinned release's definitions
  // recover the group's words and units (spec 6.4: pinned-release reads).
  const definitions = await service.content.getCards(
    record.releaseId,
    record.queue.cards.map((card) => card.presented_card_key),
  );
  return sessionViewFromDefinitions(record, new Map(definitions.map((row) => [row.contentCardKey, row])));
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
    const keysByRelease = new Map<string, Set<string>>();
    for (const record of records) {
      const keys = keysByRelease.get(record.releaseId) ?? new Set<string>();
      for (const entry of record.queue.cards) keys.add(entry.presented_card_key);
      keysByRelease.set(record.releaseId, keys);
    }
    const definitionsByRelease = new Map<string, Map<string, CardDefinitionRow>>();
    for (const [releaseId, keys] of keysByRelease) {
      const definitions = await this.content.getCards(releaseId, [...keys]);
      definitionsByRelease.set(releaseId, new Map(definitions.map((row) => [row.contentCardKey, row])));
    }
    return records.map((record) => sessionViewFromDefinitions(record, definitionsByRelease.get(record.releaseId)!));
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
    const candidates = await this.textbookOrderedWords(releaseId);
    // User state is keyed by the canonical ROOT (spec 6.4): resolve the whole
    // teaching order through the alias repository first, so a renamed word
    // whose root already carries progress is never re-taught as unseen.
    const rootByKey = await this.aliases.resolveMany({
      releaseId,
      keys: candidates.map((row) => row.wordKey),
    });
    const stages = await this.progressStages(ctx);
    const words: Array<{ word_key: string; source_order: number }> = [];
    for (const row of candidates) {
      const root = rootByKey.get(row.wordKey);
      const stage = root === undefined ? undefined : stages.get(root);
      if (stage !== undefined && stage !== "UNSEEN" && stage !== "IN_PROGRESS") continue;
      words.push({ word_key: row.wordKey, source_order: row.sourceOrder });
      if (words.length === limit) break;
    }
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
   * INTRODUCED progress lives under canonical roots, so the candidate words
   * are resolved through the alias repository before matching (a renamed
   * word's not-yet-graded cards must still surface here).
   */
  private async supplementalCards(ctx: UserContext, releaseId: string): Promise<StudyQueueCard[]> {
    const introducedRoots = new Set<string>();
    for (const [wordKey, stage] of await this.progressStages(ctx)) {
      if (stage === "INTRODUCED") introducedRoots.add(wordKey);
    }
    const candidates = await this.textbookOrderedWords(releaseId);
    const rootByKey = await this.aliases.resolveMany({
      releaseId,
      keys: candidates.map((row) => row.wordKey),
    });
    const words: Array<{ word_key: string; source_order: number }> = [];
    for (const row of candidates) {
      const root = rootByKey.get(row.wordKey);
      if (root === undefined || !introducedRoots.has(root)) continue;
      words.push({ word_key: row.wordKey, source_order: row.sourceOrder });
    }
    if (words.length === 0) {
      return [];
    }
    const definitions = await this.definitionsOf(releaseId, words.map((word) => word.word_key));
    // card_state rows are keyed canonically too: resolve each definition's
    // local card key to its root before the graded check, so a card already
    // graded under another presentation is not re-introduced.
    const canonicalByCard = await this.aliases.resolveMany({
      releaseId,
      keys: definitions.map((definition) => definition.contentCardKey),
    });
    const gradedCanonical = new Set(
      definitions.length === 0 ? [] : (
        await builder(this.db)
          .select({ contentCardKey: cardState.contentCardKey })
          .from(cardState)
          .where(eq(cardState.userId, ctx.userId))
      ).map((row) => row.contentCardKey),
    );
    const entries = buildSupplementalQueue(
      words,
      definitions
        .filter((definition) => gradedCanonical.has(canonicalByCard.get(definition.contentCardKey)!))
        .map((definition) => ({ content_card_key: definition.contentCardKey })),
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
    const presentable = await this.content.getCards(releaseId, candidates.map((c) => c.content_card_key));
    const presentableKeys = new Set(presentable.filter((row) => row.status === "ACTIVE").map((row) => row.contentCardKey));
    return dueQueueCards(
      candidates.filter((candidate) => presentableKeys.has(candidate.content_card_key)),
      now,
    );
  }

  private definitionsOf(releaseId: string, wordKeys: readonly string[]): Promise<CardDefinitionRow[]> {
    return this.content.listCardsForWords(releaseId, wordKeys);
  }

  /** The release's words in the binding textbook order (unit, tier, source, key). */
  private async textbookOrderedWords(releaseId: string): Promise<Array<{ wordKey: string; sourceOrder: number }>> {
    return await builder(this.db)
      .select({ wordKey: word.wordKey, sourceOrder: word.sourceOrder })
      .from(word)
      .leftJoin(unit, and(eq(unit.releaseId, word.releaseId), eq(unit.unitKey, word.unitKey)))
      .where(eq(word.releaseId, releaseId))
      .orderBy(asc(unit.unitOrder), asc(word.tier), asc(word.sourceOrder), asc(word.wordKey));
  }

  /** The user's word_progress stages, keyed by (canonical) word key. */
  private async progressStages(ctx: UserContext): Promise<Map<string, string>> {
    const rows = await builder(this.db)
      .select({ wordKey: wordProgress.wordKey, stage: wordProgress.stage })
      .from(wordProgress)
      .where(eq(wordProgress.userId, ctx.userId));
    return new Map(rows.map((row) => [row.wordKey, row.stage]));
  }

  /** Resolves every presented key to its canonical state key (spec 6.4). */
  private async withCanonicalKeys(
    releaseId: string,
    entries: readonly IntroductionQueueEntry[],
  ): Promise<StudyQueueCard[]> {
    const canonicalByKey = await this.aliases.resolveMany({
      releaseId,
      keys: entries.map((entry) => entry.content_card_key),
    });
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
    const resolved = await this.resolvePresentedMany(session, [presentedCardKey]);
    return resolved.items[0]!;
  }

  /** Resolves several cards from one definition query and one fresh alias
   * snapshot while preserving the caller's order. */
  async resolvePresentedMany(
    session: StudySessionRecord,
    presentedCardKeys: readonly string[],
  ): Promise<ResolvedPresentedCards> {
    const [cards, aliases] = await Promise.all([
      this.content.getCards(session.releaseId, presentedCardKeys),
      this.aliases.snapshot(session.releaseId),
    ]);
    const byKey = new Map(cards.map((card) => [card.contentCardKey, card]));
    const items = await Promise.all(presentedCardKeys.map(async (presentedCardKey) => {
      const card = byKey.get(presentedCardKey);
      if (!card) {
        throw new StudyHttpError(400, "STUDY_CARD_INVALID", "Card does not exist in the session's pinned release");
      }
      const [canonicalCardKey, canonicalWordKey] = await Promise.all([
        aliases.resolve(presentedCardKey),
        aliases.resolve(card.wordKey),
      ]);
      return { card, canonicalCardKey, canonicalWordKey, localWordKey: card.wordKey };
    }));
    return { items, aliases };
  }

  /**
   * Canonical keys of a word's ACTIVE cards in a release: the definition
   * keys are release-local, so each resolves through the alias repository
   * before comparison with (canonically keyed) card_state rows.
   */
  async canonicalCardKeys(
    releaseId: string,
    localWordKey: string,
    aliasSnapshot?: AliasSnapshot,
  ): Promise<string[]> {
    const [rows, aliases] = await Promise.all([
      this.definitionsOf(releaseId, [localWordKey]),
      aliasSnapshot ? Promise.resolve(aliasSnapshot) : this.aliases.snapshot(releaseId),
    ]);
    const activeKeys = rows.filter((row) => row.status === "ACTIVE").map((row) => row.contentCardKey);
    const roots = await aliases.resolveMany(activeKeys);
    const keys = new Set(activeKeys.map((key) => roots.get(key)!));
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
