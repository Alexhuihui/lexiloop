/**
 * Hyphenated line joins (spec 5.4).
 *
 * OCR line breaks split words exactly where a hyphenation occurs in the
 * print: `govern-\nment`. A trailing hyphen (ASCII `-`, U+2010 HYPHEN,
 * U+2011 NON-BREAKING HYPHEN) joins the next line when the continuation
 * starts a lowercase word — the canonical English case. Any other trailing
 * hyphen (before an uppercase word, a digit, CJK, ...) is kept verbatim:
 * compounds like `state-level` and dashed references must survive.
 */

const HYPHEN_CHARS = new Set(["-", "\u2010", "\u2011"]);

export interface JoinResult {
  /** Text with joined lines (remaining line breaks become single spaces). */
  text: string;
  /** Number of hyphenated line breaks that were joined. */
  joinedCount: number;
}

/**
 * Join words broken across lines by hyphenation. Lowercase continuations are
 * joined and the hyphen dropped; every other line break becomes a space.
 */
export function joinHyphenatedLines(text: string): JoinResult {
  const lines = text.split("\n");
  let joinedCount = 0;
  let current = "";
  for (const line of lines) {
    if (current === "") {
      current = line;
      continue;
    }
    const lastChar = current.slice(-1);
    const startsLowercase = /^[\p{Ll}]/u.test(line);
    if (HYPHEN_CHARS.has(lastChar) && startsLowercase) {
      current = current.slice(0, -1) + line;
      joinedCount += 1;
    } else {
      current = `${current} ${line}`;
    }
  }
  return { text: current, joinedCount };
}
