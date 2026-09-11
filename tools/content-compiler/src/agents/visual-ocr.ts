/**
 * Visual-OCR agent packet queue (spec 5.4/5.6).
 *
 * The queue lives in the private work directory under
 * `agent-queue/visual-ocr/` as three JSONL files:
 *
 * - `packets.jsonl` — the immutable review requests (upsert by packet_id);
 * - `results.jsonl` — one strict agent response per ingested packet;
 * - `corrections.jsonl` — separate provenance records for REPAIR verdicts.
 *
 * Ingestion validates every response before it is stored: the packet must
 * exist, the packet hash and source hash must match, the agent run must be
 * distinct across the whole queue, a packet resolves exactly once, and
 * corrections may only ride on REPAIR verdicts. Raw OCR evidence is never
 * mutated — a repair is a new record.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import {
  VisualOcrPacket,
  VisualOcrResult,
  type VisualOcrPacket as VisualOcrPacketT,
  type VisualOcrResult as VisualOcrResultT,
} from "@lexiloop/content-schema";
import { hashJson } from "../stage";
import { MAX_PACKET_ROUND } from "../normalize/quality";

/** How many review rounds a critical field may consume (initial + 2 repairs). */
export { MAX_PACKET_ROUND };

/** Directory name inside the per-source work directory. */
export const VISUAL_OCR_QUEUE_DIR = path.join("agent-queue", "visual-ocr");
export const PACKETS_FILE = "packets.jsonl";
export const RESULTS_FILE = "results.jsonl";
export const CORRECTIONS_FILE = "corrections.jsonl";

/** Versioned prompt carried by every emitted packet. */
export const VISUAL_OCR_PROMPT_VERSION = "visual-ocr-v1";

/** Error with a stable machine-readable code (see `code`). */
export class VisualQueueError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "VisualQueueError";
    this.code = code;
  }
}

export type QueueEntryStatus = "pending" | "resolved" | "blocked";

export interface QueueEntry {
  packet: VisualOcrPacketT;
  /** SHA-256 of the canonical packet JSON; results must echo it. */
  packetHash: string;
  status: QueueEntryStatus;
  result?: VisualOcrResultT;
}

interface StoredPacket {
  packet: VisualOcrPacketT;
  packet_hash: string;
}

/** Stable content hash of a packet (results must echo it verbatim). */
export function hashPacket(packet: VisualOcrPacketT): string {
  return hashJson(packet);
}

function queueFile(queueDir: string, file: string): string {
  return path.join(queueDir, file);
}

/** Parse strict JSONL rows; throws VisualQueueError("QUEUE_CORRUPT"). */
async function readJsonlStrict<Row>(
  filePath: string,
  parse: (raw: unknown) => Row,
): Promise<Row[]> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const rows: Row[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new VisualQueueError("QUEUE_CORRUPT", `${filePath}: line ${index + 1} is not JSON`);
    }
    rows.push(parse(raw));
  }
  return rows;
}

function parseStoredPacket(raw: unknown): StoredPacket {
  const record = raw as { packet?: unknown; packet_hash?: unknown };
  if (typeof record.packet_hash !== "string") {
    throw new VisualQueueError("QUEUE_CORRUPT", "packet row missing packet_hash");
  }
  return {
    packet: VisualOcrPacket.parse(record.packet),
    packet_hash: record.packet_hash,
  };
}

const parseStoredResult = (raw: unknown): VisualOcrResultT => VisualOcrResult.parse(raw);

/** Atomic JSONL replace: temp file in the same directory, renamed over. */
async function writeJsonlAtomic(filePath: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${randomBytes(6).toString("hex")}`,
  );
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  await writeFile(tmp, body.length > 0 ? `${body}\n` : "", "utf8");
  await rename(tmp, filePath);
}

async function appendJsonl(filePath: string, row: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * Write (or refresh) packets idempotently: an existing packet_id is kept as
 * a single row, so re-running normalization never duplicates review work.
 */
export async function enqueuePackets(
  queueDir: string,
  packets: readonly VisualOcrPacketT[],
): Promise<void> {
  const validated = packets.map((packet) => VisualOcrPacket.parse(packet));
  const stored = await readJsonlStrict(
    queueFile(queueDir, PACKETS_FILE),
    parseStoredPacket,
  );
  const byId = new Map(stored.map((entry) => [entry.packet.packet_id, entry]));
  for (const packet of validated) {
    byId.set(packet.packet_id, { packet, packet_hash: hashPacket(packet) });
  }
  await writeJsonlAtomic(queueFile(queueDir, PACKETS_FILE), [...byId.values()]);
}

/** Load the queue: packets joined with their results (if any). */
export async function loadQueue(queueDir: string): Promise<QueueEntry[]> {
  const stored = await readJsonlStrict(queueFile(queueDir, PACKETS_FILE), parseStoredPacket);
  const results = await readJsonlStrict(queueFile(queueDir, RESULTS_FILE), parseStoredResult);
  const resultByPacket = new Map(results.map((result) => [result.packet_id, result]));
  return stored.map(({ packet, packet_hash }) => {
    const result = resultByPacket.get(packet.packet_id);
    if (!result) return { packet, packetHash: packet_hash, status: "pending" as const };
    return {
      packet,
      packetHash: packet_hash,
      status: result.verdict === "BLOCK" ? ("blocked" as const) : ("resolved" as const),
      result,
    };
  });
}

export interface QueueStatus {
  total: number;
  pending: number;
  resolved: number;
  blocked: number;
}

/** Count packets by queue status. */
export async function queueStatus(queueDir: string): Promise<QueueStatus> {
  const entries = await loadQueue(queueDir);
  const status: QueueStatus = { total: entries.length, pending: 0, resolved: 0, blocked: 0 };
  for (const entry of entries) status[entry.status] += 1;
  return status;
}

/**
 * Unit keys that cannot proceed: units owning a BLOCKed packet or a pending
 * packet that already consumed every repair round (spec 5.4: unresolved
 * packets block the owning Unit).
 */
export function unresolvedUnitKeys(entries: readonly QueueEntry[]): string[] {
  const keys = entries
    .filter(
      (entry) =>
        entry.status === "blocked" ||
        (entry.status === "pending" && entry.packet.round >= MAX_PACKET_ROUND),
    )
    .map((entry) => entry.packet.unit_key);
  return [...new Set(keys)].sort();
}

/**
 * Validate one agent response and record it. The packet record is never
 * modified; REPAIR corrections become their own provenance rows in
 * `corrections.jsonl`. Throws `VisualQueueError` with a stable code on any
 * violation (fail closed).
 */
export async function ingestResult(
  queueDir: string,
  sourceHash: string,
  result: unknown,
): Promise<QueueEntry> {
  const parsed = VisualOcrResult.safeParse(result);
  if (!parsed.success) {
    throw new VisualQueueError("RESULT_INVALID", parsed.error.message);
  }
  const response = parsed.data;
  if (response.verdict === "REPAIR" && response.corrected_text === undefined) {
    throw new VisualQueueError("RESULT_INVALID", "REPAIR requires corrected_text");
  }
  if (
    response.verdict !== "REPAIR" &&
    (response.corrected_text !== undefined || response.corrected_bbox !== undefined)
  ) {
    throw new VisualQueueError(
      "RESULT_INVALID",
      `${response.verdict} must not carry corrections`,
    );
  }

  const stored = await readJsonlStrict(queueFile(queueDir, PACKETS_FILE), parseStoredPacket);
  const entry = stored.find((candidate) => candidate.packet.packet_id === response.packet_id);
  if (!entry) {
    throw new VisualQueueError("PACKET_NOT_FOUND", `unknown packet ${response.packet_id}`);
  }
  if (entry.packet_hash !== response.packet_hash) {
    throw new VisualQueueError("PACKET_HASH_MISMATCH", `packet ${response.packet_id} changed`);
  }
  if (response.source_hash !== sourceHash) {
    throw new VisualQueueError("SOURCE_HASH_MISMATCH", `packet ${response.packet_id}`);
  }
  const results = await readJsonlStrict(queueFile(queueDir, RESULTS_FILE), parseStoredResult);
  if (results.some((existing) => existing.packet_id === response.packet_id)) {
    throw new VisualQueueError(
      "RESULT_ALREADY_RESOLVED",
      `packet ${response.packet_id} already has a result`,
    );
  }
  if (results.some((existing) => existing.agent_run_id === response.agent_run_id)) {
    throw new VisualQueueError(
      "AGENT_RUN_NOT_DISTINCT",
      `agent_run_id ${response.agent_run_id} already answered a packet`,
    );
  }

  await appendJsonl(queueFile(queueDir, RESULTS_FILE), response);
  if (response.verdict === "REPAIR") {
    // Separate provenance record: the correction, never a rewrite of evidence.
    await appendJsonl(
      queueFile(queueDir, CORRECTIONS_FILE),
      {
        packet_id: response.packet_id,
        unit_key: entry.packet.unit_key,
        field: entry.packet.field,
        page_number: entry.packet.page_number,
        page_image_sha256: entry.packet.page_image_sha256,
        bbox: entry.packet.bbox,
        original_text: entry.packet.current_text,
        corrected_text: response.corrected_text,
        ...(response.corrected_bbox !== undefined
          ? { corrected_bbox: response.corrected_bbox }
          : {}),
        source_hash: response.source_hash,
        agent_run_id: response.agent_run_id,
        round: entry.packet.round,
        evidence_codes: response.evidence_codes,
        reviewed_at: response.reviewed_at,
      },
    );
  }
  return {
    packet: entry.packet,
    packetHash: entry.packet_hash,
    status: response.verdict === "BLOCK" ? "blocked" : "resolved",
    result: response,
  };
}
