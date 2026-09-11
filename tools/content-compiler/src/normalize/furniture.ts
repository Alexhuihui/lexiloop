/**
 * Page-furniture partitioning (spec 5.4).
 *
 * The textbook raster repeats decoration on every page: chapter tabs on the
 * left edge, running headers at the top, and quote banners above the footer
 * band. Furniture carries no vocabulary content and must be dropped before
 * segmentation. Footer-band and sidebar blocks are removed positionally;
 * header-band blocks only when the same text repeats on enough distinct
 * pages (a one-off line inside the header band is content until proven
 * repeated).
 */
import type { Bbox } from "./reading-order";

export interface FurnitureConfig {
  /** Blocks fully above this y are header-band candidates. */
  header_y_max: number;
  /** Blocks starting below this y are footer-band furniture. */
  footer_y_min: number;
  /** Blocks ending left of this x are sidebar furniture. */
  sidebar_x_max: number;
  /** Distinct pages a header text must repeat on to count as furniture. */
  min_header_repeat_pages: number;
}

/** Default bands for the llcy-2024 raster (see config/watermarks). */
export const DEFAULT_FURNITURE_CONFIG: FurnitureConfig = {
  header_y_max: 0.06,
  footer_y_min: 0.93,
  sidebar_x_max: 0.055,
  min_header_repeat_pages: 3,
};

/** Minimal block shape the partition needs (any richer block type works). */
export interface FurnitureBlock {
  page: number;
  bbox: Bbox;
  text: string;
}

export interface FurniturePartition<T extends FurnitureBlock> {
  /** Vocabulary-content blocks, in input order. */
  content: T[];
  /** Header/footer/sidebar blocks, in input order. */
  furniture: T[];
}

function isHeaderCandidate(block: FurnitureBlock, config: FurnitureConfig): boolean {
  return block.bbox[3] <= config.header_y_max;
}

function isFooter(block: FurnitureBlock, config: FurnitureConfig): boolean {
  return block.bbox[1] >= config.footer_y_min;
}

function isSidebar(block: FurnitureBlock, config: FurnitureConfig): boolean {
  return block.bbox[2] <= config.sidebar_x_max;
}

/**
 * Split blocks into content and page furniture. Generic over the block type
 * so callers keep their concrete shape. Header-band blocks become furniture
 * only when their normalized text appears in the band on at least
 * `min_header_repeat_pages` distinct pages; footer and sidebar blocks are
 * always furniture.
 */
export function partitionPageFurniture<T extends FurnitureBlock>(
  blocks: readonly T[],
  config: FurnitureConfig,
): FurniturePartition<T> {
  const headerRepeatPages = new Map<string, Set<number>>();
  for (const block of blocks) {
    if (!isHeaderCandidate(block, config)) continue;
    const pages = headerRepeatPages.get(block.text) ?? new Set<number>();
    pages.add(block.page);
    headerRepeatPages.set(block.text, pages);
  }

  const content: T[] = [];
  const furniture: T[] = [];
  for (const block of blocks) {
    const repeatedHeader =
      isHeaderCandidate(block, config) &&
      (headerRepeatPages.get(block.text)?.size ?? 0) >= config.min_header_repeat_pages;
    if (isFooter(block, config) || isSidebar(block, config) || repeatedHeader) {
      furniture.push(block);
    } else {
      content.push(block);
    }
  }
  return { content, furniture };
}
