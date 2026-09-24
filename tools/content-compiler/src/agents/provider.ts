/**
 * Semantic agent provider abstraction (spec 5.6).
 *
 * A provider is the only seam between the compiler and the agents that
 * generate, independently review, and repair unit content. The application
 * never holds an LLM key: production wiring uses the filesystem provider
 * (`filesystem-provider.ts`), which drops a work packet into a private queue
 * so a Codex supervisor can dispatch one fresh agent per packet, and test
 * wiring injects stub providers that return strict results directly.
 */
import { z } from "zod";
import { AgentWorkPacket } from "@lexiloop/content-schema";

/** The strict packet value type (the schema export is a value-only const). */
type AgentWorkPacketT = z.output<typeof AgentWorkPacket>;

/** How far a unit's review/repair state machine has progressed (round 0 = initial review). */
export type AgentDispatchRole = "generation" | "review" | "repair";

/**
 * Compile-side dispatch metadata wrapping the strict packet: where the
 * versioned prompt lives, which schema the answer must satisfy, which
 * generated fields are requested, and where the agent writes its result.
 */
export interface WorkOrderMeta {
  packet_id: string;
  role: AgentDispatchRole;
  /** Unit scope: the packet's evidence and its answer never leave this unit. */
  unit_key: string;
  /** 0 = initial generation/review; 1..MAX_REPAIR_ROUNDS = repair cycles. */
  round: number;
  prompt_version: string;
  /** Repo-relative versioned prompt the supervisor must dispatch with. */
  prompt_path: string;
  /** Work-dir-relative path the agent writes its strict result JSON to. */
  output_path: string;
  /** Name of the shared `@lexiloop/content-schema` contract for the answer. */
  schema_ref: string;
  /** The generated fields this role must produce or adjudicate. */
  requested_fields: string[];
  /** JSON Schema equivalent of the strict answer contract (draft 2020-12). */
  schema: Record<string, unknown>;
}

/** Everything an agent needs: the order metadata plus the strict packet. */
export interface AgentDispatchRequest {
  order: WorkOrderMeta;
  packet: AgentWorkPacketT;
  /** SHA-256 of the canonical packet JSON; results must echo it verbatim. */
  packetHash: string;
}

/**
 * Dispatches one work packet to an agent. Implementations either return the
 * raw result JSON for the packet or throw `AgentDispatchPendingError` when
 * the packet awaits an externally-dispatched agent (fail closed: never block,
 * never guess, never synthesize content inside the compiler).
 */
export interface SemanticAgentProvider {
  dispatch(request: AgentDispatchRequest): Promise<unknown>;
}

/**
 * Raised when a packet has been queued but its result has not been ingested
 * yet. The stage ledger stops with SEMANTIC_PACKETS_PENDING and the runbook's
 * dispatch/resume cycle continues the compile once the agent's answer lands.
 */
export class AgentDispatchPendingError extends Error {
  readonly code = "AGENT_RESULT_PENDING";
  readonly packetId: string;

  constructor(packetId: string, message: string) {
    super(message);
    this.name = "AgentDispatchPendingError";
    this.packetId = packetId;
  }
}
