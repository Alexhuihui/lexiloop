/** Exact, deterministic stable-key migration between two release bundles. */
import type { AliasEdge } from "@lexiloop/domain";

export interface SnapshotWord {
  wordKey: string;
  unitKey: string;
  headword: string;
}

export interface SnapshotCard {
  cardKey: string;
  cardType: string;
  targetKey: string;
  wordKey: string;
}

export interface ReleaseSnapshot {
  releaseId: string;
  words: SnapshotWord[];
  cards: SnapshotCard[];
}

export interface CurrentContinuityInput {
  releaseId: string;
  words: ReadonlyArray<{ word_key: string; unit_key: string; headword: string }>;
  cards: ReadonlyArray<{
    content_card_key: string;
    card_type: string;
    target_entity_key: string;
    word_key: string;
  }>;
}

interface ContinuityCounts {
  preserved: number;
  aliased: number;
  added: number;
  removed: number;
}

export interface KeyContinuityResult {
  report: {
    version: 1;
    previous_release_id: string;
    release_id: string;
    match_policy: "exact-unit-and-normalized-headword";
    words: ContinuityCounts;
    cards: ContinuityCounts;
  };
  aliasFile: { version: 1; edges: AliasEdge[] };
}

export class KeyContinuityError extends Error {
  readonly code = "KEY_CONTINUITY_INVALID";
}

function parseSqlValues(body: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < body.length) {
    while (body[index] === " " || body[index] === "\t") index += 1;
    if (body[index] === "'") {
      index += 1;
      let value = "";
      let closed = false;
      while (index < body.length) {
        if (body[index] !== "'") {
          value += body[index]!;
          index += 1;
          continue;
        }
        if (body[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) throw new KeyContinuityError("unterminated SQL string in previous release bundle");
      values.push(value);
    } else {
      const comma = body.indexOf(",", index);
      const end = comma === -1 ? body.length : comma;
      values.push(body.slice(index, end).trim());
      index = end;
    }
    while (body[index] === " " || body[index] === "\t") index += 1;
    if (body[index] === ",") index += 1;
  }
  return values;
}

function rowsFor(sql: string, table: string): Array<Record<string, string>> {
  const prefix = `INSERT INTO ${table} (`;
  const rows: Array<Record<string, string>> = [];
  for (const line of sql.split(/\r?\n/u)) {
    if (!line.startsWith(prefix)) continue;
    const match = line.match(/^INSERT INTO [^(]+ \(([^)]+)\) VALUES \((.*)\);$/u);
    if (!match) throw new KeyContinuityError(`cannot parse ${table} INSERT from previous release bundle`);
    const columns = match[1]!.split(",").map((column) => column.trim());
    const values = parseSqlValues(match[2]!);
    if (columns.length !== values.length) {
      throw new KeyContinuityError(
        `${table} INSERT has ${columns.length} columns but ${values.length} values`,
      );
    }
    rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index]!])));
  }
  return rows;
}

/** Read only the stable-key data from our own immutable SQL bundle format. */
export function parseReleaseSnapshot(contentSql: string, cardsSql: string): ReleaseSnapshot {
  const wordRows = rowsFor(contentSql, "word");
  const cardRows = rowsFor(cardsSql, "card_definition");
  if (wordRows.length === 0) throw new KeyContinuityError("previous release bundle contains no words");
  const releaseIds = new Set([
    ...wordRows.map((row) => row["release_id"]),
    ...cardRows.map((row) => row["release_id"]),
  ]);
  if (releaseIds.size !== 1 || releaseIds.has(undefined)) {
    throw new KeyContinuityError("previous release SQL does not describe exactly one release");
  }
  return {
    releaseId: [...releaseIds][0]!,
    words: wordRows.map((row) => ({
      wordKey: row["word_key"]!,
      unitKey: row["unit_key"]!,
      headword: row["headword"]!,
    })),
    cards: cardRows.map((row) => ({
      cardKey: row["content_card_key"]!,
      cardType: row["card_type"]!,
      targetKey: row["target_entity_key"]!,
      wordKey: row["word_key"]!,
    })),
  };
}

function normalizedHeadword(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function wordIdentity(unitKey: string, headword: string): string {
  return `${unitKey}\u0000${normalizedHeadword(headword)}`;
}

function uniqueIndex<T>(values: readonly T[], identity: (value: T) => string): Map<string, T> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = identity(value);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(value);
    else grouped.set(key, [value]);
  }
  return new Map(
    [...grouped].filter(([, bucket]) => bucket.length === 1).map(([key, bucket]) => [key, bucket[0]!] as const),
  );
}

function targetOrdinal(cardType: string, targetKey: string, wordKey: string): string | null {
  if (cardType === "SENSE_DISCRIMINATION" && targetKey === wordKey) return "word";
  const match = targetKey.match(/\.(\d+)$/u);
  return match?.[1] ?? null;
}

/**
 * Match only exact logical identities. There is deliberately no fuzzy or
 * positional headword matching: unmatched rows are reported as added/removed
 * and never receive an alias that could redirect user state incorrectly.
 */
export function buildKeyContinuity(
  previous: ReleaseSnapshot,
  current: CurrentContinuityInput,
): KeyContinuityResult {
  const previousWords = uniqueIndex(previous.words, (word) => wordIdentity(word.unitKey, word.headword));
  const currentWords = uniqueIndex(current.words, (word) => wordIdentity(word.unit_key, word.headword));
  const previousIdentityByKey = new Map(
    previous.words.map((word) => [word.wordKey, wordIdentity(word.unitKey, word.headword)] as const),
  );
  const currentIdentityByKey = new Map(
    current.words.map((word) => [word.word_key, wordIdentity(word.unit_key, word.headword)] as const),
  );

  const edges: AliasEdge[] = [];
  let preservedWords = 0;
  let aliasedWords = 0;
  for (const [identity, oldWord] of previousWords) {
    const newWord = currentWords.get(identity);
    if (!newWord) continue;
    if (oldWord.wordKey === newWord.word_key) preservedWords += 1;
    else {
      aliasedWords += 1;
      edges.push({
        entity_type: "word",
        from_release_id: previous.releaseId,
        from_key: oldWord.wordKey,
        to_release_id: current.releaseId,
        to_key: newWord.word_key,
        canonical_key: newWord.word_key,
      });
    }
  }

  const oldCardIdentity = (card: SnapshotCard): string => {
    const word = previousIdentityByKey.get(card.wordKey);
    const ordinal = targetOrdinal(card.cardType, card.targetKey, card.wordKey);
    return word && ordinal ? `${word}\u0000${card.cardType}\u0000${ordinal}` : `unmatched-old\u0000${card.cardKey}`;
  };
  const newCardIdentity = (card: CurrentContinuityInput["cards"][number]): string => {
    const word = currentIdentityByKey.get(card.word_key);
    const ordinal = targetOrdinal(card.card_type, card.target_entity_key, card.word_key);
    return word && ordinal ? `${word}\u0000${card.card_type}\u0000${ordinal}` : `unmatched-new\u0000${card.content_card_key}`;
  };
  const previousCards = uniqueIndex(previous.cards, oldCardIdentity);
  const currentCards = uniqueIndex(current.cards, newCardIdentity);
  let preservedCards = 0;
  let aliasedCards = 0;
  for (const [identity, oldCard] of previousCards) {
    const newCard = currentCards.get(identity);
    if (!newCard) continue;
    if (oldCard.cardKey === newCard.content_card_key) preservedCards += 1;
    else {
      aliasedCards += 1;
      edges.push({
        entity_type: "card",
        from_release_id: previous.releaseId,
        from_key: oldCard.cardKey,
        to_release_id: current.releaseId,
        to_key: newCard.content_card_key,
        canonical_key: newCard.content_card_key,
      });
    }
  }

  const matchedWords = preservedWords + aliasedWords;
  const matchedCards = preservedCards + aliasedCards;
  edges.sort((a, b) =>
    a.entity_type.localeCompare(b.entity_type) ||
    a.from_key.localeCompare(b.from_key) ||
    a.to_key.localeCompare(b.to_key),
  );
  return {
    report: {
      version: 1,
      previous_release_id: previous.releaseId,
      release_id: current.releaseId,
      match_policy: "exact-unit-and-normalized-headword",
      words: {
        preserved: preservedWords,
        aliased: aliasedWords,
        added: current.words.length - matchedWords,
        removed: previous.words.length - matchedWords,
      },
      cards: {
        preserved: preservedCards,
        aliased: aliasedCards,
        added: current.cards.length - matchedCards,
        removed: previous.cards.length - matchedCards,
      },
    },
    aliasFile: { version: 1, edges },
  };
}
