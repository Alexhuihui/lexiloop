/**
 * Deterministic reading order for OCR blocks (spec 5.4).
 *
 * The source raster uses two text columns with occasional lines spanning
 * both. A spanning line is a vertical separator: material above it is read
 * in column order, then the line, then material below it in column order.
 * This keeps a mid-page entry summary beside its headword instead of moving
 * every center-crossing box to the top of the page.
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

/** Page center and conservative bounds for a genuinely spanning line. */
const PAGE_CENTER = 0.5;
const FULL_LEFT_MAX = 0.4;
const FULL_RIGHT_MIN = 0.6;
const FULL_MIN_WIDTH = 0.45;
// OCR boxes at the inside edge of the left page often overshoot the gutter by
// one or two percent. Their left edge still identifies the printed column.
const LEFT_COLUMN_START_MAX = 0.489;

type Column = 0 | 1 | 2; // full-width banner | left column | right column

function columnOf([x0, , x1]: Bbox): Column {
  if (x0 <= FULL_LEFT_MAX && x1 >= FULL_RIGHT_MIN && x1 - x0 >= FULL_MIN_WIDTH) return 0;
  // Tiny markers at x ~= .50 belong to the right column even though their
  // short box ends before the usual gutter cutoff.
  if (x0 >= 0.49 && x1 - x0 <= 0.08) return 2;
  if (x1 <= 0.55) return 1;
  // Right-column text can start slightly left of the gutter. A box that both
  // starts there and extends beyond the left-column cutoff belongs on the
  // right; this also covers short Chinese gloss tails beside a long example.
  if (x0 >= 0.45 && x1 > 0.55) return 2;
  if (x1 <= PAGE_CENTER || x0 <= LEFT_COLUMN_START_MAX) return 1;
  return 2;
}

function verticalCenter([, y0, , y1]: Bbox): number {
  return (y0 + y1) / 2;
}

function textOf<T>(block: T): string {
  const text = (block as { text?: unknown }).text;
  return typeof text === "string" ? text.normalize("NFKC").trim() : "";
}

function columnOfBlock<T extends { bbox: Bbox }>(block: T): Column {
  const [x0, , x1] = block.bbox;
  // The circular 真 glyph is narrower than the gutter. Its printed column is
  // determined by the side of the gutter where it starts.
  if (textOf(block) === "真" && x0 >= 0.45 && x1 - x0 <= 0.08) return 2;
  return columnOf(block.bbox);
}

function isEntryBadge<T extends { bbox: Bbox }>(block: T): boolean {
  const [x0, , x1] = block.bbox;
  return x0 <= 0.25 && x1 <= 0.32 && /^\d{3}$/u.test(textOf(block).replace(/\s+/gu, ""));
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
  const sortWithinColumns = (items: readonly T[]): T[] => [...items].sort((a, b) => {
    const columnA = columnOfBlock(a) === 1 ? 1 : 2;
    const columnB = columnOfBlock(b) === 1 ? 1 : 2;
    if (columnA !== columnB) return columnA - columnB;
    const overlap = Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]);
    const minHeight = Math.min(a.bbox[3] - a.bbox[1], b.bbox[3] - b.bbox[1]);
    if (overlap >= minHeight * 0.45 || Math.abs(verticalCenter(a.bbox) - verticalCenter(b.bbox)) <= 0.006) {
      if (a.bbox[0] !== b.bbox[0]) return a.bbox[0] - b.bbox[0];
    }
    if (a.bbox[1] !== b.bbox[1]) return a.bbox[1] - b.bbox[1];
    if (a.bbox[0] !== b.bbox[0]) return a.bbox[0] - b.bbox[0];
    const keyA = keyOf(a);
    const keyB = keyOf(b);
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  const orderColumnRegion = (items: readonly T[]): T[] => {
    const spanning = items
      .filter((block) => columnOfBlock(block) === 0)
      .sort((a, b) => verticalCenter(a.bbox) - verticalCenter(b.bbox));
    const columnBlocks = items.filter((block) => columnOfBlock(block) !== 0);
    const region: T[] = [];
    const attached = new Set<T>();
    let lowerBound = Number.NEGATIVE_INFINITY;
    for (const separator of spanning) {
      const upperBound = verticalCenter(separator.bbox);
      const headerBlocks = columnBlocks
        .filter((block) => {
          if (attached.has(block)) return false;
          const center = verticalCenter(block.bbox);
          const gap = separator.bbox[1] - block.bbox[3];
          return center >= lowerBound && center < upperBound && gap >= -0.01 && gap <= 0.04;
        })
        .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
      for (const block of headerBlocks) attached.add(block);
      region.push(
        ...sortWithinColumns(
          columnBlocks.filter((block) => {
            const center = verticalCenter(block.bbox);
            return !attached.has(block) && center >= lowerBound && center < upperBound;
          }),
        ),
        ...headerBlocks,
        separator,
      );
      lowerBound = upperBound;
    }
    region.push(
      ...sortWithinColumns(
        columnBlocks.filter(
          (block) => !attached.has(block) && verticalCenter(block.bbox) >= lowerBound,
        ),
      ),
    );
    return region;
  };
  const pages = new Map<number, T[]>();
  for (const block of blocks) {
    const page = pages.get(block.page) ?? [];
    page.push(block);
    pages.set(block.page, page);
  }
  const ordered: T[] = [];
  for (const pageNumber of [...pages.keys()].sort((a, b) => a - b)) {
    const page = pages.get(pageNumber)!;
    const badges = page.filter(isEntryBadge).sort((a, b) => a.bbox[1] - b.bbox[1]);
    const consumed = new Set<T>();
    let lowerBound = Number.NEGATIVE_INFINITY;
    for (const badge of badges) {
      const headerStart = badge.bbox[1] - 0.005;
      const headerEnd = badge.bbox[3] + 0.05;
      const before = page.filter((block) => {
        if (consumed.has(block) || block === badge) return false;
        return verticalCenter(block.bbox) >= lowerBound && verticalCenter(block.bbox) < headerStart;
      });
      for (const block of before) consumed.add(block);
      ordered.push(...orderColumnRegion(before));

      const header = page
        .filter((block) => {
          if (consumed.has(block)) return false;
          const center = verticalCenter(block.bbox);
          return center >= headerStart && center <= headerEnd;
        })
        .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
      for (const block of header) consumed.add(block);
      ordered.push(...header);
      lowerBound = headerEnd;
    }
    ordered.push(
      ...orderColumnRegion(
        page.filter(
          (block) => !consumed.has(block) && verticalCenter(block.bbox) >= lowerBound,
        ),
      ),
    );
  }
  return ordered;
}
