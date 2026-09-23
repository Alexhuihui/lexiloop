/** Deterministic ownership checks for normalized textbook source content. */
import type { NormalizeOutput } from "./segmentation";

type SourceContent = Pick<NormalizeOutput, "words" | "senses" | "phrases" | "examples">;

export interface ContentOwnershipFinding {
  code:
    | "EXAMPLE_HEADWORD_MISMATCH"
    | "PHRASE_HEADWORD_MISMATCH"
    | "SENSE_CONTENT_CONTAMINATION";
  entityKey: string;
  wordKey: string;
  message: string;
}

function englishTokens(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[a-z]+/gu) ?? [];
}

function variants(headword: string): Set<string> {
  const values = new Set<string>();
  let previous = "";
  for (const rawAlternative of headword.normalize("NFKC").toLowerCase().split("/")) {
    const alternative = rawAlternative.startsWith("-") && previous.length > rawAlternative.length - 1
      ? `${previous.slice(0, -(rawAlternative.length - 1))}${rawAlternative.slice(1)}`
      : rawAlternative;
    if (!rawAlternative.startsWith("-")) previous = rawAlternative;
    const withoutOptional = alternative.replace(/\([a-z]+\)/gu, "");
    const withOptional = alternative.replace(/[()]/gu, "");
    for (const base of new Set([withoutOptional, withOptional].map((value) => englishTokens(value).join("")))) {
      if (base.length === 0) continue;
      values.add(base);
      values.add(`${base}s`);
      values.add(`${base}es`);
      values.add(`${base}ed`);
      values.add(`${base}ing`);
      if (base.endsWith("e")) {
        values.add(`${base.slice(0, -1)}ing`);
        values.add(`${base}d`);
      }
      if (base.endsWith("y") && base.length > 1) {
        values.add(`${base.slice(0, -1)}ies`);
        values.add(`${base.slice(0, -1)}ied`);
      }
      if (/[^aeiou][aeiou][^aeiouwxy]$/u.test(base)) {
        const last = base.slice(-1);
        values.add(`${base}${last}ed`);
        values.add(`${base}${last}ing`);
      }
    }
  }
  const irregulars: Readonly<Record<string, readonly string[]>> = {
    bear: ["bore", "born", "borne"],
    hypothesis: ["hypotheses"],
    mean: ["meant"],
  };
  for (const form of irregulars[headword.normalize("NFKC").toLowerCase()] ?? []) {
    values.add(form);
  }
  return values;
}

export function textContainsHeadword(text: string, headword: string): boolean {
  // Printed line breaks can divide a word at a hyphen; the OCR adapter keeps
  // the break until this ownership check so we join only that narrow case.
  const tokens = englishTokens(
    text
      .replace(/([a-z])-[\s\n]+([a-z])/giu, "$1$2")
      .replace(/([a-z]{3,})['’]s(?=[a-z]{3,})/giu, "$1's "),
  );
  const afterHeadword = /^(?:the|that|this|these|those|and|for|from|with|into|of|to|in|on|at|by|as|is|are|was|were|have|has|had|all|more|not|it|its|our|their)/u;
  const beforeHeadword = /(?:the|this|that|these|those|and|for|from|with|into|very|extremely|really|their|your|our|are|was|were|have|has|had|can|will|would)$/u;
  function hasGluedBoundary(token: string, variant: string): boolean {
    let offset = token.indexOf(variant);
    while (offset >= 0) {
      const before = token.slice(0, offset);
      const after = token.slice(offset + variant.length);
      if ((before.length === 0 || beforeHeadword.test(before) || (variant.length >= 4 && afterHeadword.test(after))) &&
          (after.length === 0 || afterHeadword.test(after)) &&
          (before.length > 0 || after.length > 0)) return true;
      offset = token.indexOf(variant, offset + 1);
    }
    return false;
  }
  return [...variants(headword)].some((variant) =>
    variant.length > 0 &&
    tokens.some(
      (token) =>
        token === variant ||
        // Short words require an OCR-glued function-word boundary. For longer
        // words, source OCR commonly joins unrestricted neighboring words
        // (for example "administrativecosts"). The long-word allowance does
        // not apply to art/party, rate/corporate, or sure/insure.
        (variant.length >= 5 && token.includes(variant)) ||
        (variant.length >= 3 && hasGluedBoundary(token, variant)),
    ),
  );
}

export function findContentOwnershipFindings(content: SourceContent): ContentOwnershipFinding[] {
  const findings: ContentOwnershipFinding[] = [];
  const words = new Map(content.words.map((word) => [word.word_key, word]));
  for (const example of content.examples) {
    const word = words.get(example.word_key);
    if (word && !textContainsHeadword(example.text, word.headword)) {
      findings.push({
        code: "EXAMPLE_HEADWORD_MISMATCH",
        entityKey: example.example_key,
        wordKey: word.word_key,
        message: `example does not contain its assigned headword "${word.headword}"`,
      });
    }
  }
  for (const phrase of content.phrases) {
    const word = words.get(phrase.word_key);
    if (word && !textContainsHeadword(phrase.text, word.headword)) {
      findings.push({
        code: "PHRASE_HEADWORD_MISMATCH",
        entityKey: phrase.phrase_key,
        wordKey: word.word_key,
        message: `phrase does not contain its assigned headword "${word.headword}"`,
      });
    }
  }
  for (const sense of content.senses) {
    const asciiWords = englishTokens(sense.gloss);
    if (sense.gloss.length > 160 || asciiWords.length >= 6) {
      findings.push({
        code: "SENSE_CONTENT_CONTAMINATION",
        entityKey: sense.sense_key,
        wordKey: sense.word_key,
        message: "sense gloss contains sentence-like content from another OCR region",
      });
    }
  }
  return findings;
}
