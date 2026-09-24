/**
 * Filesystem agent provider (spec 5.6).
 *
 * Production wiring: dispatching a work packet means writing it (order +
 * strict packet + hash) into the private semantic queue, where a Codex
 * supervisor picks it up and starts one fresh agent per packet with the
 * packet's versioned prompt and JSON Schema. No LLM key ever lives in this
 * application — the supervisor's agents read the packet, write their strict
 * result JSON to the packet's `output_path`, and the supervisor ingests it
 * via `agents semantic ingest`.
 *
 * Until that result has been ingested, dispatch throws
 * `AgentDispatchPendingError`, which the production stages translate into a
 * SEMANTIC_PACKETS_PENDING stage failure: the compile always stops instead of
 * guessing. Once the result is in the queue, dispatch returns it and the
 * state machine re-validates it end to end.
 */
import { AgentDispatchPendingError, type SemanticAgentProvider } from "./provider";
import {
  findSemanticResult,
  enqueueOrders,
  type WorkOrder,
} from "./work-packets";

export interface FilesystemProviderOptions {
  /** The per-source semantic queue directory (`<work-dir>/agent-queue/semantic`). */
  queueDir: string;
  /** Source content hash results must echo (tamper detection). */
  sourceHash: string;
}

/**
 * A packet-aware wrapper around `AgentDispatchPendingError`: carries the
 * packet id and the exact resume command so the failure message is actionable
 * for the supervisor.
 */
export function createFilesystemProvider(options: FilesystemProviderOptions): SemanticAgentProvider {
  const { queueDir, sourceHash } = options;
  return {
    async dispatch(request) {
      const order: WorkOrder = {
        order: request.order,
        packet: request.packet,
        packetHash: request.packetHash,
      };
      // Idempotent upsert: re-running a stage never duplicates agent work.
      await enqueueOrders(queueDir, [order]);
      const existing = await findSemanticResult(queueDir, request.order.packet_id);
      if (existing) return existing;
      throw new AgentDispatchPendingError(
        request.order.packet_id,
        `packet ${request.order.packet_id} (${request.order.role}, unit ${request.order.unit_key}) awaits an ` +
          `external agent; dispatch it with ${request.order.prompt_path} and ingest its JSON from ` +
          `${request.order.output_path}, then run ` +
          `"pnpm compiler agents semantic ingest --source-hash ${sourceHash} --result <path>"`,
      );
    },
  };
}
