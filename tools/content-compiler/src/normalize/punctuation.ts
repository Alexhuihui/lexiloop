/**
 * Unicode / full-width text normalization (spec 5.4).
 *
 * OCR output from the scanned textbook mixes half- and full-width forms,
 * ideographic spaces, and decomposed code points. Normalization is
 * deterministic and conservative: Latin letters, digits, and "layout"
 * punctuation fold to their ASCII forms, while CJK sentence punctuation
 * (，；：！？。) is kept verbatim — folding it would corrupt Chinese glosses.
 * Composing NFC afterwards merges any decomposed sequences.
 */

/**
 * Full-width forms kept as-is: standard CJK sentence punctuation from the
 * FF01–FF5E block. Everything else in the block (letters, digits, brackets,
 * parentheses, the middle dot) is ASCII-compatible and gets folded.
 */
const CJK_PUNCT_KEPT = new Set<string>(
  ["！", "，", "；", "：", "？", "。", "『", "』", "「", "」", "《", "》", "〈", "〉"].map((ch) => ch),
);

/** Map one full-width code point to its ASCII counterpart, or null. */
function foldFullWidth(ch: string): string | null {
  const code = ch.codePointAt(0);
  if (code === undefined) return null;
  // Full-width ASCII variants: U+FF01–U+FF5E map to U+0021–U+007E.
  if (code >= 0xff01 && code <= 0xff5e) {
    if (CJK_PUNCT_KEPT.has(ch)) return null;
    return String.fromCodePoint(code - 0xfee0);
  }
  // Full-width space U+3000 collapses with other whitespace below.
  return null;
}

/**
 * Deterministic text normalization: fold full-width Latin/digits/brackets to
 * half-width, keep CJK sentence punctuation, compose NFC, and collapse
 * whitespace runs (including U+3000 ideographic spaces) to single spaces.
 */
export function normalizeUnicodeText(text: string): string {
  let folded = "";
  for (const ch of text) {
    folded += foldFullWidth(ch) ?? ch;
  }
  return folded.normalize("NFC").replace(/[\s\u3000]+/g, " ").trim();
}
