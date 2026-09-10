import { spawnSync } from "node:child_process";
import process from "node:process";

interface ToolCheck {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Actionable message when the tool is missing; absence aborts the check. */
  readonly prerequisite?: string;
}

const FFMPEG_PREREQUISITE =
  "ffmpeg is missing. ffmpeg-python is only a Python wrapper and does not " +
  "install the system binaries; audio tasks cannot run without them. " +
  "Install ffmpeg (Debian/Ubuntu: `sudo apt install ffmpeg`, macOS: `brew install ffmpeg`) " +
  "and re-run `pnpm toolchain:check`.";

const checks: readonly ToolCheck[] = [
  { label: "Node", command: process.execPath, args: ["--version"] },
  { label: "pnpm", command: "pnpm", args: ["--version"] },
  { label: "Python", command: "python3", args: ["--version"] },
  { label: "uv", command: "uv", args: ["--version"] },
  { label: "ffmpeg", command: "ffmpeg", args: ["-version"], prerequisite: FFMPEG_PREREQUISITE },
  { label: "ffprobe", command: "ffprobe", args: ["-version"], prerequisite: FFMPEG_PREREQUISITE },
];

function firstVersionLine(result: ReturnType<typeof spawnSync>): string {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const line = output
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return line ?? "";
}

let failed = false;

for (const check of checks) {
  // Always spawn with an argument array (no shell string) so paths and
  // versions never pass through shell interpolation.
  const result = spawnSync(check.command, [...check.args], { encoding: "utf8" });

  if (result.error !== undefined || result.status !== 0) {
    failed = true;
    console.error(`[toolchain] ${check.label}: not available`);
    if (check.prerequisite !== undefined) {
      console.error(`[toolchain] ${check.prerequisite}`);
    }
    continue;
  }

  console.log(firstVersionLine(result));
}

if (failed) {
  process.exit(1);
}
