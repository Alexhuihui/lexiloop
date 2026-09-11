/**
 * Semantic agent work packets and packet queue (spec 5.6).
 *
 * The queue lives in the private work directory under `agent-queue/semantic/`
 * as two JSONL files (same layout as the visual-OCR queue):
 *
 * - `packets.jsonl` — the immutable work orders (upsert by packet_id);
 * - `results.jsonl` — one strict agent result per ingested packet.
 *
 * A packet carries the unit's read-only source evidence (whose entities embed
 * the immutable source hashes), the prompt version, the unit scope, the
 * requested generated fields, the JSON Schema of the expected answer, and the
 * output path the dispatched agent writes to. Generation output cannot carry
 * reasoning or source patches — the shared `AgentGenerationOutput` strict
 * contract rejects every unknown key at this boundary.
 *
 * Ingestion validates every result before the stage ledger may continue:
 * the packet must exist, the packet/source hashes must match, the packet must
 * be unresolved, the agent run must be distinct across the whole queue, review
 * results must answer the unit's current generation run, and repair results
 * must answer the latest review with a mapping covering exactly the flagged
 * issues. Raw source evidence is never mutated — a repair is a new record.
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentGenerationOutput,
  AgentReviewOutput,
  AgentRole,
  AgentWorkPacket,
  Example,
  LogicalKey,
  Phrase,
  RepairOutput,
  Sense,
  Sha256Hex,
  SourceSnapshot,
  Unit,
  Word,
} from "@lexiloop/content-schema";
import { z } from "zod";
import { MediaOutputInvalidError, readJsonl } from "../media";
import { hashJson, hashString } from "../stage";
import { EXPLANATION_FIELDS, flaggedFields } from "../validate/unit-validator";
import type { WorkOrderMeta } from "./provider";

/** Value types of the strict contracts (the schema exports are value-only). */
type AgentGenerationOutputT = z.output<typeof AgentGenerationOutput>;
type AgentReviewOutputT = z.output<typeof AgentReviewOutput>;
type AgentWorkPacketT = z.output<typeof AgentWorkPacket>;
type SourceSnapshotT = z.output<typeof SourceSnapshot>;

/** Directory name inside the per-source work directory (visual-ocr sibling). */
export const SEMANTIC_QUEUE_DIR = path.join("agent-queue", "semantic");
export const PACKETS_FILE = "packets.jsonl";
export const RESULTS_FILE = "results.jsonl";

/** Versioned prompt carried by every emitted packet. */
export const SEMANTIC_PROMPT_VERSION = "semantic-v1";

/** Repo-relative versioned prompts the Codex supervisor dispatches with. */
export const GENERATION_PROMPT_PATH = "tools/content-compiler/prompts/generate.md";
export const REVIEW_PROMPT_PATH = "tools/content-compiler/prompts/review.md";
export const REPAIR_PROMPT_PATH = "tools/content-compiler/prompts/repair.md";

/** Error with a stable machine-readable code (see `code`). */
export class WorkPacketError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "WorkPacketError";
    this.code = code;
  }
}

/** One unit of read-only source evidence handed to every role. */
export interface UnitWorkload {
  unitKey: string;
  source: SourceSnapshotT;
}

/** Dispatch order: the strict packet plus its compile-side metadata. */
export interface WorkOrder {
  order: WorkOrderMeta;
  packet: AgentWorkPacketT;
  /** SHA-256 of the canonical packet JSON; results must echo it verbatim. */
  packetHash: string;
}

// ---------------------------------------------------------------------------
// Strict result envelopes (what an externally-dispatched agent writes back)
// ---------------------------------------------------------------------------

const envelopeBase = {
  packet_id: z.string().min(1),
  /** SHA-256 of the packet this result answers (tamper detection). */
  packet_hash: Sha256Hex,
  source_hash: Sha256Hex,
  /** Must be distinct across the whole queue (no rubber-stamping, spec 5.6). */
  agent_run_id: z.string().min(1),
  model_id: z.string().min(1),
  created_at: z.iso.datetime({ offset: true }),
};

export const SemanticGenerationResultSchema = z.strictObject({
  role: z.literal("generation"),
  ...envelopeBase,
  output: AgentGenerationOutput,
});

export const SemanticReviewResultSchema = z.strictObject({
  role: z.literal("review"),
  ...envelopeBase,
  output: AgentReviewOutput,
});

export const SemanticRepairResultSchema = z.strictObject({
  role: z.literal("repair"),
  ...envelopeBase,
  output: RepairOutput,
});

export const SemanticAgentResultSchema = z.discriminatedUnion("role", [
  SemanticGenerationResultSchema,
  SemanticReviewResultSchema,
  SemanticRepairResultSchema,
]);

export type SemanticGenerationResultT = z.output<typeof SemanticGenerationResultSchema>;
export type SemanticReviewResultT = z.output<typeof SemanticReviewResultSchema>;
export type SemanticRepairResultT = z.output<typeof SemanticRepairResultSchema>;
export type SemanticAgentResultT = z.output<typeof SemanticAgentResultSchema>;

// ---------------------------------------------------------------------------
// Order builders: content-addressed packet ids (stable across re-runs)
// ---------------------------------------------------------------------------

function sha8(value: string): string {
  return hashString(value).slice(0, 8);
}

function schemaRefFor(role: "generation" | "review" | "repair"): string {
  return role === "generation"
    ? "AgentGenerationOutput"
    : role === "review"
      ? "AgentReviewOutput"
      : "RepairOutput";
}

function schemaFor(role: "generation" | "review" | "repair"): Record<string, unknown> {
  const schema =
    role === "generation"
      ? AgentGenerationOutput
      : role === "review"
        ? AgentReviewOutput
        : RepairOutput;
  return z.toJSONSchema(schema) as Record<string, unknown>;
}

function buildOrder(
  role: "generation" | "review" | "repair",
  workload: UnitWorkload,
  body: Record<string, unknown>,
  round: number,
): WorkOrder {
  const packetId = `sem.${role.slice(0, 3)}.${workload.unitKey}.r${round}.${sha8(hashJson(body))}`;
  const packet = AgentWorkPacket.parse({ ...body, packet_id: packetId });
  const promptPath =
    role === "generation"
      ? GENERATION_PROMPT_PATH
      : role === "review"
        ? REVIEW_PROMPT_PATH
        : REPAIR_PROMPT_PATH;
  const requested =
    role === "generation"
      ? [...EXPLANATION_FIELDS]
      : role === "review"
        ? ["unit_verdict", "field_verdicts"]
        : ["repairs"];
  return {
    order: {
      packet_id: packetId,
      role,
      unit_key: workload.unitKey,
      round,
      prompt_version: SEMANTIC_PROMPT_VERSION,
      prompt_path: promptPath,
      output_path: path.join(SEMANTIC_QUEUE_DIR, "outbox", `${packetId}.json`),
      schema_ref: schemaRefFor(role),
      requested_fields: requested,
      schema: schemaFor(role),
    },
    packet,
    packetHash: hashJson(packet),
  };
}

/** Generation packet: the unit's read-only evidence plus requested fields. */
export function buildGenerationOrder(workload: UnitWorkload): WorkOrder {
  return buildOrder(
    "generation",
    workload,
    {
      role: "generation",
      unit_key: workload.unitKey,
      prompt_version: SEMANTIC_PROMPT_VERSION,
      source: workload.source,
    },
    0,
  );
}

/** Review packet: evidence plus the generation output under review. */
export function buildReviewOrder(
  workload: UnitWorkload,
  generation: AgentGenerationOutputT,
  round: number,
): WorkOrder {
  return buildOrder(
    "review",
    workload,
    {
      role: "review",
      unit_key: workload.unitKey,
      prompt_version: SEMANTIC_PROMPT_VERSION,
      source: workload.source,
      generation,
    },
    round,
  );
}

/** Repair packet: evidence plus the generation and the review it answers. */
export function buildRepairOrder(
  workload: UnitWorkload,
  generation: AgentGenerationOutputT,
  review: AgentReviewOutputT,
  round: number,
): WorkOrder {
  return buildOrder(
    "repair",
    workload,
    {
      role: "repair",
      unit_key: workload.unitKey,
      prompt_version: SEMANTIC_PROMPT_VERSION,
      source: workload.source,
      generation,
      review,
    },
    round,
  );
}

// ---------------------------------------------------------------------------
// Queue storage (JSONL, atomic replace for packets, append for results)
// ---------------------------------------------------------------------------

const WorkOrderMetaSchema = z.strictObject({
  packet_id: z.string().min(1),
  role: AgentRole,
  unit_key: LogicalKey,
  round: z.number().int().min(0),
  prompt_version: z.string().min(1),
  prompt_path: z.string().min(1),
  output_path: z.string().min(1),
  schema_ref: z.string().min(1),
  requested_fields: z.array(z.string().min(1)).min(1),
  schema: z.record(z.string(), z.unknown()),
});

const StoredPacketSchema = z.strictObject({
  order: WorkOrderMetaSchema,
  packet: AgentWorkPacket,
  packet_hash: Sha256Hex,
});

export type StoredPacket = z.output<typeof StoredPacketSchema>;

export interface SemanticQueueEntry {
  order: WorkOrderMeta;
  packet: AgentWorkPacketT;
  packetHash: string;
  status: "pending" | "resolved";
  result?: SemanticAgentResultT;
}

function queueFile(queueDir: string, file: string): string {
  return path.join(queueDir, file);
}

/** Parse strict JSONL rows; throws WorkPacketError("QUEUE_CORRUPT"). */
async function readJsonlStrict<Row>(filePath: string, parse: (raw: unknown) => Row): Promise<Row[]> {
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
      throw new WorkPacketError("QUEUE_CORRUPT", `${filePath}: line ${index + 1} is not JSON`);
    }
    rows.push(parse(raw));
  }
  return rows;
}

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
 * Write (or refresh) packets idempotently: an existing packet_id is kept as a
 * single row, so re-running a stage never duplicates agent work.
 */
export async function enqueueOrders(queueDir: string, orders: readonly WorkOrder[]): Promise<void> {
  const stored = await readJsonlStrict(queueFile(queueDir, PACKETS_FILE), (raw) =>
    StoredPacketSchema.parse(raw),
  );
  const byId = new Map(stored.map((entry) => [entry.order.packet_id, entry]));
  for (const order of orders) {
    if (order.order.role !== order.packet.role) {
      throw new WorkPacketError("ROLE_MISMATCH", `order ${order.order.packet_id} role disagrees with packet`);
    }
    byId.set(order.order.packet_id, {
      order: order.order,
      packet: order.packet,
      packet_hash: order.packetHash,
    });
  }
  await writeJsonlAtomic(
    queueFile(queueDir, PACKETS_FILE),
    [...byId.values()].sort((a, b) => (a.order.packet_id < b.order.packet_id ? -1 : 1)),
  );
}

/** Load the queue: packets joined with their results (if any). */
export async function loadSemanticQueue(queueDir: string): Promise<SemanticQueueEntry[]> {
  const stored = await readJsonlStrict(queueFile(queueDir, PACKETS_FILE), (raw) =>
    StoredPacketSchema.parse(raw),
  );
  const results = await readJsonlStrict(queueFile(queueDir, RESULTS_FILE), (raw) =>
    SemanticAgentResultSchema.parse(raw),
  );
  const resultByPacket = new Map(results.map((result) => [result.packet_id, result]));
  return stored.map(({ order, packet, packet_hash }) => {
    const result = resultByPacket.get(order.packet_id);
    if (!result) return { order, packet, packetHash: packet_hash, status: "pending" as const };
    return { order, packet, packetHash: packet_hash, status: "resolved" as const, result };
  });
}

/** The stored result for one packet, or null while it awaits an agent. */
export async function findSemanticResult(
  queueDir: string,
  packetId: string,
): Promise<SemanticAgentResultT | null> {
  const results = await readJsonlStrict(queueFile(queueDir, RESULTS_FILE), (raw) =>
    SemanticAgentResultSchema.parse(raw),
  );
  return results.find((result) => result.packet_id === packetId) ?? null;
}

export interface SemanticQueueStatus {
  total: number;
  pending: number;
  resolved: number;
  by_role: Record<"generation" | "review" | "repair", { total: number; pending: number; resolved: number }>;
}

/** Count packets by queue status, overall and per role. */
export async function semanticQueueStatus(queueDir: string): Promise<SemanticQueueStatus> {
  const entries = await loadSemanticQueue(queueDir);
  const status: SemanticQueueStatus = {
    total: entries.length,
    pending: 0,
    resolved: 0,
    by_role: {
      generation: { total: 0, pending: 0, resolved: 0 },
      review: { total: 0, pending: 0, resolved: 0 },
      repair: { total: 0, pending: 0, resolved: 0 },
    },
  };
  for (const entry of entries) {
    status[entry.status] += 1;
    const role = status.by_role[entry.order.role];
    role.total += 1;
    role[entry.status] += 1;
  }
  return status;
}

/** Unit keys that still have unresolved packets (they cannot proceed). */
export function pendingUnitKeys(entries: readonly SemanticQueueEntry[]): string[] {
  const keys = entries.filter((entry) => entry.status === "pending").map((entry) => entry.order.unit_key);
  return [...new Set(keys)].sort();
}

/**
 * Stable digest over the queue contents. The four agent stages fold this into
 * their input hashes, so ingesting an agent result invalidates the gates and
 * the pipeline naturally re-runs them on the next invocation.
 */
export async function semanticQueueDigest(queueDir: string): Promise<string> {
  const stored = await readJsonlStrict(queueFile(queueDir, PACKETS_FILE), (raw) =>
    StoredPacketSchema.parse(raw),
  );
  const results = await readJsonlStrict(queueFile(queueDir, RESULTS_FILE), (raw) =>
    SemanticAgentResultSchema.parse(raw),
  );
  return hashJson({
    packets: stored
      .map((entry) => [entry.order.packet_id, entry.packet_hash])
      .sort(),
    results: results
      .map((result) => [result.packet_id, result.agent_run_id])
      .sort(),
  });
}

// ---------------------------------------------------------------------------
// Per-unit queue state (for role/run separation checks at ingest)
// ---------------------------------------------------------------------------

interface UnitQueueState {
  generation: SemanticGenerationResultT | null;
  repairs: Array<{ round: number; result: SemanticRepairResultT }>;
  reviews: Array<{ round: number; result: SemanticReviewResultT }>;
}

function emptyUnitState(): UnitQueueState {
  return { generation: null, repairs: [], reviews: [] };
}

async function loadUnitStates(queueDir: string): Promise<Map<string, UnitQueueState>> {
  const stored = await readJsonlStrict(queueFile(queueDir, PACKETS_FILE), (raw) =>
    StoredPacketSchema.parse(raw),
  );
  const results = await readJsonlStrict(queueFile(queueDir, RESULTS_FILE), (raw) =>
    SemanticAgentResultSchema.parse(raw),
  );
  const roundByPacket = new Map(stored.map((entry) => [entry.order.packet_id, entry.order.round]));
  const unitByPacket = new Map(stored.map((entry) => [entry.order.packet_id, entry.order.unit_key]));
  const states = new Map<string, UnitQueueState>();
  for (const result of results) {
    const unitKey = unitByPacket.get(result.packet_id);
    if (!unitKey) continue; // packet rows are never deleted; defensive only
    const state = states.get(unitKey) ?? emptyUnitState();
    states.set(unitKey, state);
    const round = roundByPacket.get(result.packet_id) ?? 0;
    if (result.role === "generation") state.generation = result;
    else if (result.role === "review") state.reviews.push({ round, result });
    else state.repairs.push({ round, result });
  }
  for (const state of states.values()) {
    state.repairs.sort((a, b) => a.round - b.round);
    state.reviews.sort((a, b) => a.round - b.round);
  }
  return states;
}

/** Run id of the generation an incoming review must answer. */
function currentGenerationRunId(state: UnitQueueState): string | null {
  const lastRepair = state.repairs[state.repairs.length - 1];
  return lastRepair ? lastRepair.result.agent_run_id : (state.generation?.agent_run_id ?? null);
}

/** True when every REPAIR/BLOCK verdict carries a structured issue code. */
function verdictsHaveIssueCodes(output: AgentReviewOutputT): boolean {
  return output.field_verdicts.every(
    (verdict) => verdict.verdict === "PASS" || verdict.issue_code !== undefined,
  );
}

/**
 * Validate one agent result and record it. The packet rows are never
 * modified. Throws `WorkPacketError` with a stable code on any violation
 * (fail closed): invalid envelopes, tampered hashes, foreign sources,
 * reused agent runs, review/repair answers detached from the unit's current
 * state, and repair mappings that do not cover exactly the flagged issues.
 */
export async function ingestSemanticResult(
  queueDir: string,
  sourceHash: string,
  result: unknown,
): Promise<SemanticQueueEntry> {
  const parsed = SemanticAgentResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new WorkPacketError("RESULT_INVALID", parsed.error.message);
  }
  const response = parsed.data;
  if (response.role === "review" && !verdictsHaveIssueCodes(response.output)) {
    throw new WorkPacketError(
      "RESULT_INVALID",
      "REPAIR/BLOCK field verdicts require a structured issue_code",
    );
  }

  const stored = await readJsonlStrict(queueFile(queueDir, PACKETS_FILE), (raw) =>
    StoredPacketSchema.parse(raw),
  );
  const entry = stored.find((candidate) => candidate.order.packet_id === response.packet_id);
  if (!entry) {
    throw new WorkPacketError("PACKET_NOT_FOUND", `unknown packet ${response.packet_id}`);
  }
  if (entry.packet_hash !== response.packet_hash) {
    throw new WorkPacketError("PACKET_HASH_MISMATCH", `packet ${response.packet_id} changed`);
  }
  if (response.source_hash !== sourceHash) {
    throw new WorkPacketError("SOURCE_HASH_MISMATCH", `packet ${response.packet_id}`);
  }
  if (entry.order.role !== response.role) {
    throw new WorkPacketError("ROLE_MISMATCH", `packet ${response.packet_id} expects ${entry.order.role}`);
  }

  const states = await loadUnitStates(queueDir);
  const state = states.get(entry.order.unit_key) ?? emptyUnitState();

  // Sequential rounds: review r answers the generation after r repairs, and
  // repair r answers review r-1. Nothing may jump ahead of the state machine.
  if (response.role === "generation" && entry.order.round !== 0) {
    throw new WorkPacketError("ROUND_ORDER_INVALID", "generation packets are round 0");
  }
  if (response.role === "review" && entry.order.round !== state.repairs.length) {
    throw new WorkPacketError(
      "ROUND_ORDER_INVALID",
      `review round ${entry.order.round} does not answer the current state (${state.repairs.length} repair(s) applied)`,
    );
  }
  const lastReview = state.reviews[state.reviews.length - 1];
  if (response.role === "repair" && (!lastReview || entry.order.round !== lastReview.round + 1)) {
    throw new WorkPacketError(
      "ROUND_ORDER_INVALID",
      `repair round ${entry.order.round} has no matching latest review`,
    );
  }

  const results = await readJsonlStrict(queueFile(queueDir, RESULTS_FILE), (raw) =>
    SemanticAgentResultSchema.parse(raw),
  );
  if (results.some((existing) => existing.packet_id === response.packet_id)) {
    throw new WorkPacketError(
      "RESULT_ALREADY_RESOLVED",
      `packet ${response.packet_id} already has a result`,
    );
  }
  if (results.some((existing) => existing.agent_run_id === response.agent_run_id)) {
    throw new WorkPacketError(
      "AGENT_RUN_NOT_DISTINCT",
      `agent_run_id ${response.agent_run_id} already answered a packet`,
    );
  }

  // Role-specific target binding before anything is stored.
  if (response.role === "generation") {
    if (response.output.packet_id !== response.packet_id) {
      throw new WorkPacketError("PACKET_MISMATCH", "generation output names a different packet");
    }
    if (response.output.input_hash !== response.packet_hash) {
      throw new WorkPacketError(
        "INPUT_HASH_MISMATCH",
        "generation output does not answer the dispatched packet (source immutability)",
      );
    }
  } else if (response.role === "review") {
    if (response.output.unit_key !== entry.order.unit_key) {
      throw new WorkPacketError("UNIT_SCOPE_MISMATCH", "review output leaves the packet's unit scope");
    }
    if (response.output.reviewed_agent_run_id !== currentGenerationRunId(state)) {
      throw new WorkPacketError(
        "REVIEW_TARGET_MISMATCH",
        "review does not answer the unit's current generation run",
      );
    }
  } else {
    if (response.output.unit_key !== entry.order.unit_key) {
      throw new WorkPacketError("UNIT_SCOPE_MISMATCH", "repair output leaves the packet's unit scope");
    }
    if (!lastReview || response.output.review_id !== lastReview.result.output.review_id) {
      throw new WorkPacketError("REPAIR_TARGET_MISMATCH", "repair does not answer the latest review");
    }
    // Multiset compare: the mapping must cover exactly the flagged issues —
    // no unmapped flagged issue, no rewrite of fields the reviewer passed.
    const flaggedCounts = new Map<string, number>();
    for (const field of flaggedFields(lastReview.result.output)) {
      const key = `${field.field_path}\u0000${field.issue_code}`;
      flaggedCounts.set(key, (flaggedCounts.get(key) ?? 0) + 1);
    }
    const mappedCounts = new Map<string, number>();
    for (const action of response.output.repairs) {
      const key = `${action.field_path}\u0000${action.issue_code}`;
      mappedCounts.set(key, (mappedCounts.get(key) ?? 0) + 1);
    }
    for (const [key, count] of mappedCounts) {
      if (count > (flaggedCounts.get(key) ?? 0)) {
        throw new WorkPacketError(
          "REPAIR_OUT_OF_SCOPE",
          `repair mapping touches a field the reviewer did not flag: ${key.replace("\u0000", " / ")}`,
        );
      }
    }
    for (const [key, count] of flaggedCounts) {
      if ((mappedCounts.get(key) ?? 0) < count) {
        throw new WorkPacketError(
          "REPAIR_INCOMPLETE",
          `reviewer-flagged issue has no repair mapping: ${key.replace("\u0000", " / ")}`,
        );
      }
    }
  }

  await appendJsonl(queueFile(queueDir, RESULTS_FILE), response);
  return {
    order: entry.order,
    packet: entry.packet,
    packetHash: entry.packet_hash,
    status: "resolved",
    result: response,
  };
}

// ---------------------------------------------------------------------------
// Source evidence: rebuild unit workloads from normalized.jsonl
// ---------------------------------------------------------------------------

const NormalizedRowSchema = z.looseObject({
  entity_type: z.enum(["book", "unit", "word", "sense", "phrase", "example"]),
});

/**
 * Rebuild the per-unit source snapshots from the STRUCTURE_NORMALIZE
 * artifact. Every row is re-validated against the strict shared contracts, so
 * the packets handed to agents always embed immutable, provenance-bearing
 * source hashes.
 */
export async function loadUnitWorkloads(
  workDir: string,
  options: { units?: readonly string[] } = {},
): Promise<UnitWorkload[]> {
  const artifactPath = path.join(workDir, "normalized.jsonl");
  let rows: Array<z.output<typeof NormalizedRowSchema>>;
  try {
    rows = await readJsonl(artifactPath, NormalizedRowSchema);
  } catch (err) {
    if (err instanceof MediaOutputInvalidError) {
      throw new WorkPacketError("AGENT_INPUT_MISSING", err.message);
    }
    throw err;
  }

  const units: Array<z.output<typeof Unit>> = [];
  const words: Array<z.output<typeof Word>> = [];
  const senses: Array<z.output<typeof Sense>> = [];
  const phrases: Array<z.output<typeof Phrase>> = [];
  const examples: Array<z.output<typeof Example>> = [];
  for (const row of rows) {
    // The entity_type discriminator is a JSONL artifact concern: the strict
    // shared contracts reject unknown keys, so it is stripped before parsing.
    const { entity_type, ...entity } = row;
    switch (entity_type) {
      case "book":
        break;
      case "unit":
        units.push(Unit.parse(entity));
        break;
      case "word":
        words.push(Word.parse(entity));
        break;
      case "sense":
        senses.push(Sense.parse(entity));
        break;
      case "phrase":
        phrases.push(Phrase.parse(entity));
        break;
      case "example":
        examples.push(Example.parse(entity));
        break;
    }
  }

  if (units.length === 0) {
    throw new WorkPacketError("AGENT_INPUT_MISSING", `${artifactPath}: no unit records recovered`);
  }

  let selected = units.map((unit) => unit.unit_key);
  if (options.units) {
    const unknown = options.units.filter((unitKey) => !selected.includes(unitKey));
    if (unknown.length > 0) {
      throw new WorkPacketError(
        "UNIT_SCOPE_UNKNOWN",
        `release scope references unknown unit(s): ${unknown.join(",")}`,
      );
    }
    selected = [...options.units];
  }

  const workloads: UnitWorkload[] = [];
  for (const unitKey of [...new Set(selected)].sort()) {
    const unit = units.find((candidate) => candidate.unit_key === unitKey)!;
    const unitWords = words.filter((word) => word.unit_key === unitKey);
    const wordKeys = new Set(unitWords.map((word) => word.word_key));
    workloads.push({
      unitKey,
      source: SourceSnapshot.parse({
        unit,
        words: unitWords,
        senses: senses.filter((sense) => wordKeys.has(sense.word_key)),
        phrases: phrases.filter((phrase) => wordKeys.has(phrase.word_key)),
        examples: examples.filter((example) => wordKeys.has(example.word_key)),
        relations: [],
      }),
    });
  }
  return workloads;
}
