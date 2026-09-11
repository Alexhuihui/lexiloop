/**
 * Deterministic reading order for OCR blocks (spec 5.4).
 *
 * The source raster is a 180°-flat two-page spread: one rendered image holds
 * the left book page (left half) and the right book page (right half), and
 * unit-title banners span the full width. Blocks are therefore ordered per
 * page: full-width banners first (a unit title precedes its columns), then
 * the left column top-to-bottom, then the right column top-to-bottom. Pages
 * stay in ascending order and the input array is never mutated.
 */

/** Normalized bounding box [x0, y0, x1, y1] with all values in [0, 1]. */
export type Bbox = [number, number, number, number];

/** Minimal block shape the ordering needs; richer block types extend it. */
export interface PositionedBlock {
  /** Stable block key, e.g. `p12.b3`. */
  key: string;
  /** 1-based PDF page number. */
  page: number;
  bbox: Bbox;
  text: string;
}

/** Page center: blocks spanning it are full-width banners. */
const PAGE_CENTER = 0.5;

type Column = 0 | 1 | 2; // full-width banner | left column | right column

function columnOf([x0, , x1]: Bbox): Column {
  if (x0 < PAGE_CENTER && x1 > PAGE_CENTER) return 0;
  if (x1 <= PAGE_CENTER) return 1;
  return 2;
}

/**
 * Return the blocks in deterministic reading order. Generic: the input element
 * type is preserved so richer block types (e.g. `NormalizeInputBlock`) flow
 * through unchanged. Pure: the input array is copied, never sorted in place;
 * ties break on `key` (when present) and JavaScript's stable sort keeps the
 * rest deterministic.
 */
export function assignReadingOrder<T extends { page: number; bbox: Bbox }>(
  blocks: readonly T[],
): T[] {
  const keyOf = (block: T): string => {
    const key = (block as { key?: unknown }).key;
    return typeof key === "string" ? key : "";
  };
  return [...blocks].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    const columnA = columnOf(a.bbox);
    const columnB = columnOf(b.bbox);
    if (columnA !== columnB) return columnA - columnB;
    if (a.bbox[1] !== b.bbox[1]) return a.bbox[1] - b.bbox[1];
    if (a.bbox[0] !== b.bbox[0]) return a.bbox[0] - b.bbox[0];
    const keyA = keyOf(a);
    const keyB = keyOf(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
}
