/**
 * The synthetic E2E content fixture (plan Task 18 step 1): TWO content
 * releases plus a third probe release, built from pure stable-key rules so
 * every consumer — the harness seeder, the specs, and verify-release —
 * derives byte-identical keys without a database or credentials.
 *
 * Shape:
 * - `rel-e2e-v1` — seven words in one unit (two tiers), two cards per word
 *   (WORD_MEANING + PHRASE), one exam example, word audio for three words.
 *   Seeded as the ACTIVE release.
 * - `rel-e2e-v2` — the same unit re-keyed for ONE word (harbour -> harbor,
 *   the rename that exercises `content_key_alias` end to end) plus one
 *   brand-new word (compass) and a visibly re-titled unit. Seeded READY.
 * - `rel-e2e-v3-collide` — one word, READY. Never activated normally: it
 *   carries the alias edge set whose activation must FAIL with
 *   ALIAS_STATE_COLLISION once a user holds progress under the drift key.
 *
 * This module is deliberately PURE: deterministic key derivation only, no
 * I/O, no credentials. Synthetic account credentials are generated per run
 * by the harness server and live in the harness's temp state file only.
 */
import { contentCardKey, stableKey, type AliasEdge } from "@lexiloop/domain";

export const BOOK_KEY = "e2e-textbook";
export const BOOK_TITLE = "E2E Synthetic Reader";
export const UNIT_KEY = "u01";

export const RELEASE_V1 = "rel-e2e-v1";
export const RELEASE_V2 = "rel-e2e-v2";
export const RELEASE_V3_COLLIDE = "rel-e2e-v3-collide";

/** Unit title per release — the user-visible marker of a release switch. */
export const UNIT_TITLE_V1 = "Unit 1 · At Sea";
export const UNIT_TITLE_V2 = "Unit 1 · At Sea（第二版）";

export type Tier = "CORE" | "EXT";

export interface SyntheticWordSpec {
  /** v1 semantic slug (the normalized headword). */
  slug: string;
  /** v2 slug when this word is re-keyed in the second release. */
  v2Slug?: string;
  /** True when the word exists ONLY in v2 (source-order continues there). */
  v2Only?: boolean;
  sourceOrder: number;
  tier: Tier;
  phonetic: string;
  gloss: string;
  phrase: { text: string; gloss: string };
  /** Word-level synthetic audio exists for this word (per release spelling). */
  audio?: boolean;
}

/** The synthetic textbook vocabulary (fixture data only — no real content). */
export const SYNTHETIC_WORDS: readonly SyntheticWordSpec[] = [
  {
    slug: "anchor",
    sourceOrder: 1,
    tier: "CORE",
    phonetic: "/ˈæŋkə/",
    gloss: "锚；抛锚",
    phrase: { text: "drop anchor", gloss: "抛锚" },
    audio: true,
  },
  {
    slug: "harbour",
    v2Slug: "harbor",
    sourceOrder: 2,
    tier: "CORE",
    phonetic: "/ˈhɑːbə/",
    gloss: "港口",
    phrase: { text: "in harbour", gloss: "在港内" },
    audio: true,
  },
  {
    slug: "voyage",
    sourceOrder: 3,
    tier: "CORE",
    phonetic: "/ˈvɔɪɪdʒ/",
    gloss: "航行",
    phrase: { text: "set out on a voyage", gloss: "启航" },
  },
  {
    slug: "tide",
    sourceOrder: 4,
    tier: "EXT",
    phonetic: "/taɪd/",
    gloss: "潮；潮汐",
    phrase: { text: "turn the tide", gloss: "扭转局势" },
    audio: true,
  },
  {
    slug: "collision",
    sourceOrder: 5,
    tier: "EXT",
    phonetic: "/kəˈlɪʒn/",
    gloss: "碰撞",
    phrase: { text: "in collision with", gloss: "与……相撞" },
  },
  {
    slug: "beacon",
    sourceOrder: 6,
    tier: "EXT",
    phonetic: "/ˈbiːkən/",
    gloss: "灯塔",
    phrase: { text: "like a beacon", gloss: "如同灯塔" },
  },
  {
    slug: "drift",
    sourceOrder: 7,
    tier: "EXT",
    phonetic: "/drɪft/",
    gloss: "漂流",
    phrase: { text: "drift apart", gloss: "渐行渐远" },
  },
  {
    slug: "compass",
    v2Only: true,
    sourceOrder: 8,
    tier: "EXT",
    phonetic: "/ˈkʌmpəs/",
    gloss: "罗盘",
    phrase: { text: "moral compass", gloss: "道德罗盘" },
  },
];

/** The v3 probe word the collision activation would collapse drift into. */
export const COLLIDE_WORD = { slug: "delta", sourceOrder: 1, gloss: "三角洲" } as const;

/** All slugs a release presents for one word spec (v1 and/or v2). */
function slugsOf(spec: SyntheticWordSpec): Array<{ releaseId: string; slug: string }> {
  const out: Array<{ releaseId: string; slug: string }> = [];
  if (!spec.v2Only) {
    out.push({ releaseId: RELEASE_V1, slug: spec.slug });
  }
  out.push({ releaseId: RELEASE_V2, slug: spec.v2Slug ?? spec.slug });
  return out;
}

/** One word's full key set in one release (stable keys, spec 5.5). */
export interface WordKeys {
  releaseId: string;
  slug: string;
  headword: string;
  tier: Tier;
  sourceOrder: number;
  gloss: string;
  wordKey: string;
  senseKey: string;
  phraseKey: string;
  cardKeys: { WORD_MEANING: string; PHRASE: string };
}

/** Derives every stable key for one word spec in one of its releases. */
function wordKeysFor(spec: SyntheticWordSpec, releaseId: string, slug: string): WordKeys {
  const ordinal = spec.sourceOrder;
  const wordKey = stableKey({ book: BOOK_KEY, unit: UNIT_KEY, type: "word", ordinal, slug });
  const senseKey = stableKey({ book: BOOK_KEY, unit: UNIT_KEY, type: "sense", ordinal, slug: `${slug}:s1` });
  const phraseKey = stableKey({ book: BOOK_KEY, unit: UNIT_KEY, type: "phrase", ordinal, slug: `${slug}:p1` });
  const base = { bookKey: BOOK_KEY, unitKey: UNIT_KEY, wordSourceOrder: ordinal };
  return {
    releaseId,
    slug,
    headword: slug,
    tier: spec.tier,
    sourceOrder: ordinal,
    gloss: spec.gloss,
    wordKey,
    senseKey,
    phraseKey,
    cardKeys: {
      WORD_MEANING: contentCardKey({ ...base, cardType: "WORD_MEANING", targetEntityKey: senseKey }),
      PHRASE: contentCardKey({ ...base, cardType: "PHRASE", targetEntityKey: phraseKey }),
    },
  };
}

export interface SyntheticWordKeys {
  spec: SyntheticWordSpec;
  /** Key sets in presentation order: v1 first (when present), then v2. */
  perRelease: WordKeys[];
}

export const SYNTHETIC_WORD_KEYS: readonly SyntheticWordKeys[] = SYNTHETIC_WORDS.map((spec) => ({
  spec,
  perRelease: slugsOf(spec).map(({ releaseId, slug }) => wordKeysFor(spec, releaseId, slug)),
}));

function keysInRelease(releaseId: string): WordKeys[] {
  return SYNTHETIC_WORD_KEYS.flatMap((word) => word.perRelease.filter((k) => k.releaseId === releaseId));
}

/** Every word key set of release v1 (seven words). */
export const V1_WORDS: readonly WordKeys[] = keysInRelease(RELEASE_V1);
/** Every word key set of release v2 (harbor re-keyed, compass added). */
export const V2_WORDS: readonly WordKeys[] = keysInRelease(RELEASE_V2);

function findWord(releaseId: string, slug: string): WordKeys {
  const found = keysInRelease(releaseId).find((k) => k.slug === slug);
  if (!found) {
    throw new Error(`fixture bug: no ${slug} keys in ${releaseId}`);
  }
  return found;
}

/** v1 presentation of the renamed word (the old key). */
export const HARBOUR_V1 = findWord(RELEASE_V1, "harbour");
/** v2 presentation of the renamed word (the new, canonical key). */
export const HARBOR_V2 = findWord(RELEASE_V2, "harbor");
/** The word whose progress row makes the v3 collision activation fail. */
export const DRIFT_V1 = findWord(RELEASE_V1, "drift");
/** The v2-only word (proves new-release-only content reaches the group). */
export const COMPASS_V2 = findWord(RELEASE_V2, "compass");
/** The anchor word (presented first in every learning queue). */
export const ANCHOR_V1 = findWord(RELEASE_V1, "anchor");

export const DELTA_V3_WORD_KEY = stableKey({
  book: BOOK_KEY,
  unit: UNIT_KEY,
  type: "word",
  ordinal: COLLIDE_WORD.sourceOrder,
  slug: COLLIDE_WORD.slug,
});

/** The v3 probe release's full (healthy) key set for its one word. */
export const COLLIDE_V3: WordKeys = (() => {
  const ordinal = COLLIDE_WORD.sourceOrder;
  const senseKey = stableKey({
    book: BOOK_KEY,
    unit: UNIT_KEY,
    type: "sense",
    ordinal,
    slug: `${COLLIDE_WORD.slug}:s1`,
  });
  const phraseKey = stableKey({
    book: BOOK_KEY,
    unit: UNIT_KEY,
    type: "phrase",
    ordinal,
    slug: `${COLLIDE_WORD.slug}:p1`,
  });
  const base = { bookKey: BOOK_KEY, unitKey: UNIT_KEY, wordSourceOrder: ordinal };
  return {
    releaseId: RELEASE_V3_COLLIDE,
    slug: COLLIDE_WORD.slug,
    headword: COLLIDE_WORD.slug,
    tier: "EXT",
    sourceOrder: ordinal,
    gloss: COLLIDE_WORD.gloss,
    wordKey: DELTA_V3_WORD_KEY,
    senseKey,
    phraseKey,
    cardKeys: {
      WORD_MEANING: contentCardKey({ ...base, cardType: "WORD_MEANING", targetEntityKey: senseKey }),
      PHRASE: contentCardKey({ ...base, cardType: "PHRASE", targetEntityKey: phraseKey }),
    },
  };
})();

/** The anchor word's example key (identical derivation in v1 and v2). */
export const ANCHOR_EXAMPLE_KEY = stableKey({
  book: BOOK_KEY,
  unit: UNIT_KEY,
  type: "example",
  ordinal: 1,
  slug: "anchor:e1",
});

/**
 * The rename alias batch `rel-e2e-v2` is activated with: the word edge plus
 * both of its card edges. Stored under the DECLARING release of each edge
 * (from_release_id = v1), canonical roots are the v2 keys — old presented
 * keys and new presented keys resolve to the same user state (spec 6.4).
 */
export const V2_ALIAS_EDGES: readonly AliasEdge[] = [
  {
    entity_type: "word",
    from_release_id: RELEASE_V1,
    from_key: HARBOUR_V1.wordKey,
    to_release_id: RELEASE_V2,
    to_key: HARBOR_V2.wordKey,
    canonical_key: HARBOR_V2.wordKey,
  },
  {
    entity_type: "card",
    from_release_id: RELEASE_V1,
    from_key: HARBOUR_V1.cardKeys.WORD_MEANING,
    to_release_id: RELEASE_V2,
    to_key: HARBOR_V2.cardKeys.WORD_MEANING,
    canonical_key: HARBOR_V2.cardKeys.WORD_MEANING,
  },
  {
    entity_type: "card",
    from_release_id: RELEASE_V1,
    from_key: HARBOUR_V1.cardKeys.PHRASE,
    to_release_id: RELEASE_V2,
    to_key: HARBOR_V2.cardKeys.PHRASE,
    canonical_key: HARBOR_V2.cardKeys.PHRASE,
  },
];

/**
 * The alias batch whose activation MUST FAIL once a user holds progress
 * under the drift key: it would collapse that existing progress into the
 * delta root (ALIAS_STATE_COLLISION, fail-closed spec 6.4).
 */
export const V3_COLLIDE_EDGES: readonly AliasEdge[] = [
  {
    entity_type: "word",
    from_release_id: RELEASE_V1,
    from_key: DRIFT_V1.wordKey,
    to_release_id: RELEASE_V3_COLLIDE,
    to_key: DELTA_V3_WORD_KEY,
    canonical_key: DELTA_V3_WORD_KEY,
  },
];

/** The exam example seeded for the anchor word (v1 and v2). */
export const ANCHOR_EXAMPLE = {
  origin: "exam" as const,
  sourceRef: "2024 E2E 卷",
  text: "The ship dropped anchor in the bay.",
  targetStart: 20,
  targetEnd: 26,
};
