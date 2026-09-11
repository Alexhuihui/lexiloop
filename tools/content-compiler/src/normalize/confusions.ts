/**
 * OCR confusion detection (spec 5.4).
 *
 * Certain OCR glyph confusions are systematic: `l ↔ 1` and `O ↔ 0` put digits
 * inside phonetics and headwords where only letters are legal, and `rn` reads
 * as `m` in print. Confusions are FLAGGED, never rewritten in place — every
 * flag on a critical field becomes evidence for a visual-agent packet.
 */

/** Text field kinds whose confusion patterns differ. */
export type ConfusionField = "headword" | "phonetic" | "gloss" | "other";

/** Evidence code: a digit appears where the field's alphabet has none. */
export const OCR_CONFUSION_DIGIT_IN_PHONETIC = "OCR_CONFUSION_DIGIT_IN_PHONETIC";
export const OCR_CONFUSION_DIGIT_IN_HEADWORD = "OCR_CONFUSION_DIGIT_IN_HEADWORD";
/** Evidence code: `rn` may actually be a printed `m` (too common to gate on). */
export const OCR_CONFUSION_RN_M = "OCR_CONFUSION_RN_M";

/**
 * Return the confusion evidence codes for a piece of OCR text. Phonetic
 * strings (slashed or bracketed) must contain no digits at all; headwords are
 * checked for embedded digits as well as the `rn`→`m` print confusion.
 */
export function flagOcrConfusions(text: string, field: ConfusionField): string[] {
  const codes: string[] = [];
  const digits = /\d/u;
  if (field === "phonetic" && digits.test(text)) {
    codes.push(OCR_CONFUSION_DIGIT_IN_PHONETIC);
  }
  if (field === "headword") {
    if (digits.test(text)) codes.push(OCR_CONFUSION_DIGIT_IN_HEADWORD);
    if (/rn/u.test(text)) codes.push(OCR_CONFUSION_RN_M);
  }
  return codes;
}
