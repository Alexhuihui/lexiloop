import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { importProofreadMarkdown } from "../src/proofread-markdown";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceFile = arg("--source");
const pagesDir = arg("--pages-dir");
if (!sourceFile || !pagesDir) {
  process.stderr.write("usage: tsx import-proofread-markdown.ts --source <merged.md> --pages-dir <dir> [--images-dir <dir>] [--private-root <dir>]\n");
  process.exit(2);
}

const result = await importProofreadMarkdown({
  sourceFile,
  pagesDir,
  ...(arg("--images-dir") ? { imagesDir: arg("--images-dir")! } : {}),
  privateRoot: arg("--private-root") ?? path.join(root, ".lexiloop-private"),
  cardsConfigPath: path.join(root, "tools/content-compiler/config/cards/v1.json"),
});
process.stdout.write(`${JSON.stringify(result.report, null, 2)}\nwork_dir=${result.workDir}\n`);
