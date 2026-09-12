/**
 * Deterministic PWA icon generation (plan Task 15).
 *
 * Rasterizes the repo-native LexiLoop mark
 * (`apps/web/public/icons/lexiloop.svg`) into the three committed icons:
 *
 * - icon-192.png / icon-512.png: `purpose: any`, rounded-corner background.
 * - maskable-512.png: `purpose: maskable`, kept full-bleed (the source art
 *   already confines the mark to the central 80% safe zone, so the platform
 *   can crop it to any mask).
 *
 * The same input SVG always produces byte-identical outputs (libvips PNG
 * encoding carries no timestamps), so the committed PNGs can be regenerated
 * at any time with `pnpm tsx scripts/generate-pwa-icons.ts` and a clean diff.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceSvgPath = join(repoRoot, "apps", "web", "public", "icons", "lexiloop.svg");
const outputDir = join(repoRoot, "apps", "web", "public", "icons");

interface IconTarget {
  file: string;
  size: number;
  /** `any` icons get rounded corners; the maskable icon stays full-bleed. */
  rounded: boolean;
}

const TARGETS: readonly IconTarget[] = [
  { file: "icon-192.png", size: 192, rounded: true },
  { file: "icon-512.png", size: 512, rounded: true },
  { file: "maskable-512.png", size: 512, rounded: false },
];

async function generateIcon(svg: Buffer, target: IconTarget): Promise<void> {
  const raster = sharp(svg, { density: 300 })
    .resize(target.size, target.size, { fit: "fill" })
    .png();

  if (target.rounded) {
    const radius = Math.round(target.size * 0.18);
    const mask = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${target.size}" height="${target.size}">` +
        `<rect width="${target.size}" height="${target.size}" rx="${radius}" ry="${radius}" fill="#ffffff"/>` +
        `</svg>`,
    );
    await raster
      .composite([{ input: mask, blend: "dest-in" }])
      .toFile(join(outputDir, target.file));
  } else {
    await raster.toFile(join(outputDir, target.file));
  }
  console.log(`generated ${target.file} (${target.size}x${target.size})`);
}

const svg = readFileSync(sourceSvgPath);
for (const target of TARGETS) {
  await generateIcon(svg, target);
}
