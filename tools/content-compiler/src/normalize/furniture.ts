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
  // Footer slogans can begin just above 0.93 because OCR boxes hug the
  // glyphs rather than the printed footer band.
  footer_y_min: 0.925,
  // Calibrated on the real raster: the left-rail chapter tab's number block
  // ends as far right as x1 ~= 0.078 when the word and chapter number are
  // detected separately. Body text starts at x0 ~= 0.10, so 0.08 is safe.
  sidebar_x_max: 0.08,
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
  // The book places the one-character exam marker at the same left edge as
  // the decorative chapter rail. It is semantic content: removing it also
  // prevents the following source sentence from being recognized as an
  // example. The rail itself contains chapter numbers, never this marker.
  const text = block.text.normalize("NFKC").trim();
  return block.bbox[2] <= config.sidebar_x_max && text !== "真";
}

function isBottomBrandBanner(block: FurnitureBlock): boolean {
  if (block.bbox[0] < 0.5 || block.bbox[1] < 0.8) return false;
  const text = block.text.normalize("NFKC").replace(/\s+/gu, "");
  return /^(?:考研人|相关词家园)/u.test(text);
}

function isKnownPromoWatermark(block: FurnitureBlock): boolean {
  const [x0, y0, x1, y1] = block.bbox;
  const inTopPromo = x1 >= 0.2 && x0 <= 0.725 && y1 >= 0.03 && y0 <= 0.1;
  const inBottomPromo = x1 >= 0.46 && x0 <= 0.94 && y1 >= 0.76 && y0 <= 0.925;
  if (!inTopPromo && !inBottomPromo) return false;
  const text = block.text.normalize("NFKC").replace(/\s+/gu, "");
  if (/(?:微信|公众号|神灯|考研资源|客服|QQ群|KYFT\d*|获取更多)/iu.test(text)) return true;
  return inBottomPromo && /^(?:老石|的精神)$/u.test(text);
}

function isBottomContactStrip(block: FurnitureBlock): boolean {
  const [x0, y0, x1, y1] = block.bbox;
  // The repeated four-part contact strip sits above the printed slogan. Its
  // pale glyphs are often recognized as unrelated garbage, so text matching
  // alone cannot remove it. Body text ends above this thin fixed band; the
  // slogan beneath it begins at y ~= .923.
  return y0 >= 0.895 && y0 <= 0.922 && y1 - y0 <= 0.026 && x0 >= 0.15 && x1 <= 0.85;
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
    if (
      isFooter(block, config) ||
      isSidebar(block, config) ||
      isBottomBrandBanner(block) ||
      isKnownPromoWatermark(block) ||
      isBottomContactStrip(block) ||
      repeatedHeader
    ) {
      furniture.push(block);
    } else {
      content.push(block);
    }
  }
  return { content, furniture };
}
