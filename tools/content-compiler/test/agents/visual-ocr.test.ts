/**
 * Visual-OCR agent packet lifecycle (spec 5.4/5.6).
 *
 * The queue lives in the private work directory (`agent-queue/visual-ocr/`).
 * Externally-dispatched visual agents consume packets and return strict
 * results; `ingest` validates every response (packet hash, source hash,
 * distinct agent run, verdict/correction coherence), stores corrections as
 * separate provenance records, and never mutates the raw packet record.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VisualOcrPacket } from "@lexiloop/content-schema";
import {
  MAX_PACKET_ROUND,
  enqueuePackets,
  hashPacket,
  ingestResult,
  loadQueue,
  queueStatus,
  unresolvedUnitKeys,
} from "../../src/agents/visual-ocr";

const SOURCE_HASH = "c3".repeat(32);
const PAGE1_IMAGE = "d4".repeat(32);

let queueDir = "";

beforeEach(async () => {
  queueDir = await mkdtemp(path.join(tmpdir(), "vo-queue-"));
});

afterEach(async () => {
  await rm(queueDir, { recursive: true, force: true });
  queueDir = "";
});

function makePacket(overrides: Partial<VisualOcrPacket> = {}): VisualOcrPacket {
  return VisualOcrPacket.parse({
    role: "visual_ocr",
    packet_id: "vo.headword.p1.r1.deadbeef",
    unit_key: "u1",
    prompt_version: "visual-ocr-v1",
    round: 1,
    field: "headword",
    page_number: 1,
    page_image_sha256: PAGE1_IMAGE,
    bbox: [0.1, 0.42, 0.48, 0.47],
    current_text: "governmental",
    ocr_confidence: 0.55,
    evidence_codes: ["LOW_CONFIDENCE_CRITICAL_FIELD"],
    ...overrides,
  });
}

interface ResultFixture {
  packet_id: string;
  packet_hash: string;
  source_hash: string;
  agent_run_id: string;
  verdict: "PASS" | "REPAIR" | "BLOCK";
  corrected_text?: string;
  corrected_bbox?: [number, number, number, number];
  evidence_codes: string[];
  reviewed_at: string;
}

function resultFixture(packet: VisualOcrPacket, overrides: Partial<ResultFixture> = {}): ResultFixture {
  return {
    packet_id: packet.packet_id,
    packet_hash: hashPacket(packet),
    source_hash: SOURCE_HASH,
    agent_run_id: "agent-run-1",
    verdict: "PASS",
    evidence_codes: ["VISUAL_CONFIRMED"],
    reviewed_at: "2026-09-10T10:00:00.000Z",
    ...overrides,
  };
}

describe("visual-ocr packet lifecycle", () => {
  it("enforces the three-round repair cap (initial review + two re-reviews)", () => {
    expect(MAX_PACKET_ROUND).toBe(3);
  });

  it("writes packets idempotently and reloads them with stable hashes", async () => {
    const packet = makePacket();
    await enqueuePackets(queueDir, [packet]);
    await enqueuePackets(queueDir, [packet]); // upsert by packet_id
    const entries = await loadQueue(queueDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.packetHash).toBe(hashPacket(packet));
    expect(entries[0]!.packet).toEqual(packet);
    expect(entries[0]!.status).toBe("pending");
    expect(entries[0]!.result).toBeUndefined();
  });

  it("ingests a corrected REPAIR as a separate provenance record without mutating the packet", async () => {
    const packet = makePacket();
    await enqueuePackets(queueDir, [packet]);
    const before = await readFile(path.join(queueDir, "packets.jsonl"), "utf8");
    const ingested = await ingestResult(
      queueDir,
      SOURCE_HASH,
      resultFixture(packet, {
        verdict: "REPAIR",
        corrected_text: "governmental",
      }),
    );
    expect(ingested.status).toBe("resolved");
    expect(ingested.result!.corrected_text).toBe("governmental");
    // The raw packet record is immutable.
    expect(await readFile(path.join(queueDir, "packets.jsonl"), "utf8")).toBe(before);
    // The correction is its own provenance record.
    const corrections = await readFile(path.join(queueDir, "corrections.jsonl"), "utf8");
    const record = JSON.parse(corrections.trim().split("\n").pop()!);
    expect(record).toMatchObject({
      packet_id: packet.packet_id,
      unit_key: "u1",
      field: "headword",
      page_number: 1,
      corrected_text: "governmental",
      agent_run_id: "agent-run-1",
      round: 1,
      evidence_codes: ["VISUAL_CONFIRMED"],
    });
    expect(await queueStatus(queueDir)).toEqual({
      total: 1,
      pending: 0,
      resolved: 1,
      blocked: 0,
    });
  });

  it("ingests PASS without corrections and BLOCK as terminal", async () => {
    const passPacket = makePacket();
    const blockPacket = makePacket({
      packet_id: "vo.phonetic.p1.r1.cafebabe",
      field: "phonetic",
      current_text: "/ɡʌvən0ns/",
    });
    await enqueuePackets(queueDir, [passPacket, blockPacket]);
    await ingestResult(queueDir, SOURCE_HASH, resultFixture(passPacket));
    await ingestResult(
      queueDir,
      SOURCE_HASH,
      resultFixture(blockPacket, {
        agent_run_id: "agent-run-2",
        verdict: "BLOCK",
        evidence_codes: ["UNREADABLE_REGION"],
      }),
    );
    const entries = await loadQueue(queueDir);
    expect(entries.map((e) => e.status).sort()).toEqual(["blocked", "resolved"]);
    // BLOCK leaves the owning unit unresolved.
    expect(unresolvedUnitKeys(entries)).toEqual(["u1"]);
    // A BLOCK decision stores no correction record.
    await expect(readFile(path.join(queueDir, "corrections.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects tampered packet hashes, wrong sources, and unknown packets", async () => {
    const packet = makePacket();
    await enqueuePackets(queueDir, [packet]);
    await expect(
      ingestResult(queueDir, SOURCE_HASH, resultFixture(packet, { packet_hash: "0".repeat(64) })),
    ).rejects.toMatchObject({ code: "PACKET_HASH_MISMATCH" });
    await expect(
      ingestResult(queueDir, "f0".repeat(32), resultFixture(packet)),
    ).rejects.toMatchObject({ code: "SOURCE_HASH_MISMATCH" });
    await expect(
      ingestResult(queueDir, SOURCE_HASH, resultFixture(packet, { packet_id: "vo.none.p1.r1.00000000" })),
    ).rejects.toMatchObject({ code: "PACKET_NOT_FOUND" });
  });

  it("requires a distinct agent_run_id across the queue", async () => {
    const first = makePacket();
    const second = makePacket({
      packet_id: "vo.phonetic.p1.r1.cafebabe",
      field: "phonetic",
      current_text: "/ɡʌvən0ns/",
    });
    await enqueuePackets(queueDir, [first, second]);
    await ingestResult(queueDir, SOURCE_HASH, resultFixture(first, { agent_run_id: "run-A" }));
    await expect(
      ingestResult(queueDir, SOURCE_HASH, resultFixture(second, { agent_run_id: "run-A" })),
    ).rejects.toMatchObject({ code: "AGENT_RUN_NOT_DISTINCT" });
  });

  it("rejects REPAIR without a correction and PASS with one (strict schema)", async () => {
    const packet = makePacket();
    await enqueuePackets(queueDir, [packet]);
    await expect(
      ingestResult(queueDir, SOURCE_HASH, resultFixture(packet, { verdict: "REPAIR" })),
    ).rejects.toMatchObject({ code: "RESULT_INVALID" });
    await expect(
      ingestResult(
        queueDir,
        SOURCE_HASH,
        resultFixture(packet, { corrected_text: "not allowed on PASS" }),
      ),
    ).rejects.toMatchObject({ code: "RESULT_INVALID" });
  });

  it("refuses to re-ingest a resolved packet", async () => {
    const packet = makePacket();
    await enqueuePackets(queueDir, [packet]);
    await ingestResult(queueDir, SOURCE_HASH, resultFixture(packet));
    await expect(
      ingestResult(queueDir, SOURCE_HASH, resultFixture(packet, { agent_run_id: "run-B" })),
    ).rejects.toMatchObject({ code: "RESULT_ALREADY_RESOLVED" });
  });

  it("reports pending packets past the round cap as blocking the owning unit", async () => {
    const capPacket = makePacket({ round: MAX_PACKET_ROUND, packet_id: "vo.headword.p1.r3.aaaaaaaa" });
    const earlyPacket = makePacket({ packet_id: "vo.phonetic.p1.r1.bbbbbbbb", field: "phonetic" });
    await enqueuePackets(queueDir, [capPacket, earlyPacket]);
    const entries = await loadQueue(queueDir);
    // Only the cap-exceeded packet blocks; the round-1 packet still has rounds left.
    expect(unresolvedUnitKeys(entries)).toEqual(["u1"]);
    expect(await queueStatus(queueDir)).toEqual({ total: 2, pending: 2, resolved: 0, blocked: 0 });
  });
});
