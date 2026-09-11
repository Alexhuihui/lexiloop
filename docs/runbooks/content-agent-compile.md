# Runbook: agent-driven content compile

How to drive a source PDF through the content compiler's externally
dispatched agent queues (visual OCR review, spec 5.4; semantic content
gates, spec 5.6).

**Agents — not humans — resolve every review decision.** There is no human
review path anywhere in the pipeline: no CLI flag, database update, or
deployment command can bypass a `BLOCKED` Unit or an unanswered packet. The
operator's job is strictly mechanical: run the pipeline, dispatch one fresh
agent per pending packet with the packet's prompt, ingest the agent's result
JSON, and resume. A Unit that exhausts its review/repair budget is `BLOCKED`
permanently and can never enter a release.

Everything below runs from the repo root. `<source-hash>` is the SHA-256 of
the source PDF (`sha256sum <pdf>`); per-source state lives under the
git-ignored `.lexiloop-private/work/<source-hash>/` directory. Raw source
content (PDF, page images, OCR text, agent packets/outputs for real Units)
must never be committed.

## The loop

Each `resume` advances the resumable stage pipeline. Agent-gated stages
(`AGENT_ENRICH`, `AGENT_REVIEW`, `DETERMINISTIC_VALIDATE`, `REPAIR_LOOP`)
enqueue packets, then fail closed with `SEMANTIC_PACKETS_PENDING` until the
dispatched agents' results are ingested — so the compile proceeds as:

```text
resume → agents dispatch → ingest → resume → ... (until COMPLETED or BLOCKED)
```

```bash
pnpm compiler agents resume --source-hash <source-hash>
pnpm compiler agents semantic packets --source-hash <source-hash>
# dispatch one fresh agent per pending packet (see "Dispatching an agent")
pnpm compiler agents semantic ingest --source-hash <source-hash> --result <result.json>
```

`run` and `resume` are synonyms; both resume from stages whose inputs are
unchanged. `agents resume` is the same resumable pipeline under the `agents`
group.

## Dispatching a semantic agent (generation / review / repair)

1. List the queue and pick one pending packet:

   ```bash
   pnpm compiler agents semantic packets --source-hash <source-hash>
   ```

   Each line shows the packet id, status (`pending`/`resolved`), role
   (`generation`/`review`/`repair`), round, unit, the answer schema, the
   versioned prompt, and the output path. One packet = one fresh agent: never
   batch two packets into one agent, and never reuse an `agent_run_id`.

2. Dispatch a fresh agent with:

   - the prompt for the role:
     `tools/content-compiler/prompts/generate.md` (generation),
     `tools/content-compiler/prompts/review.md` (review),
     `tools/content-compiler/prompts/repair.md` (repair);
   - the packet JSON: `.lexiloop-private/work/<source-hash>/agent-queue/semantic/packets.jsonl`
     (locate the row by `order.packet_id`; `packet_hash` is the canonical
     packet hash the agent must echo);
   - the answer schema named by `order.schema_ref`
     (`@lexiloop/content-schema`: `AgentGenerationOutput`, `AgentReviewOutput`,
     or `RepairOutput`), also embedded as JSON Schema in `order.schema`;
   - the instruction to write its strict result JSON to the packet's
     `order.output_path` (`.lexiloop-private/work/<source-hash>/agent-queue/semantic/outbox/<packet_id>.json`).

3. Ingest the result. Ingestion fails closed on any violation — unknown
   packet (`PACKET_NOT_FOUND`), tampered packet (`PACKET_HASH_MISMATCH`),
   wrong source (`SOURCE_HASH_MISMATCH`), malformed output
   (`RESULT_INVALID`), reused agent run (`AGENT_RUN_NOT_DISTINCT`), a review
   answering a stale generation (`REVIEW_TARGET_MISMATCH`), or a repair
   mapping that does not cover exactly the flagged issues
   (`REPAIR_INCOMPLETE` / `REPAIR_OUT_OF_SCOPE`):

   ```bash
   pnpm compiler agents semantic ingest --source-hash <source-hash> \
     --result .lexiloop-private/work/<source-hash>/agent-queue/semantic/outbox/<packet_id>.json
   ```

4. Check the queue and resume:

   ```bash
   pnpm compiler agents semantic status --source-hash <source-hash>
   pnpm compiler agents resume --source-hash <source-hash>
   ```

The state machine per Unit: one generation + one independent review +
deterministic validation, then at most **three** repair-agent + fresh-review
cycles. A fourth repair is impossible; `REPAIR_LOOP` then fails with
`UNIT_BLOCKED` and the Unit's ledger entry becomes `BLOCKED`. A release may
contain other fully-passed Units, but every Unit declared in its scope must
be `PASSED` — no partial publishing of a Unit.

## Visual OCR review queue (spec 5.4)

Critical fields the normalizer cannot accept deterministically become visual
OCR packets; same loop, different queue:

```bash
pnpm compiler agents visual-ocr packets --source-hash <source-hash>
pnpm compiler agents visual-ocr ingest --source-hash <source-hash> --result <result.json>
pnpm compiler agents visual-ocr status --source-hash <source-hash>
```

Each packet carries the page number, page image hash, bbox, current text,
and evidence codes the agent needs to crop and adjudicate the exact region.
Corrections are stored as separate provenance records; raw OCR evidence is
never mutated.

## Reading state and recovering

```bash
pnpm compiler status --source-hash <source-hash>    # per-stage ledger state
pnpm compiler plan --source-hash <source-hash>      # dry run: what would run
pnpm compiler agents semantic status --source-hash <source-hash>
```

- A stage failed with `SEMANTIC_PACKETS_PENDING` is normal mid-loop: resolve
  the pending packets, then resume.
- `BLOCKED` is terminal. Investigate the packet queue and the validation
  report (`.lexiloop-private/work/<source-hash>/validation/<unit_key>.json`);
  there is no command that clears the status. Fixing requires re-compiling
  the source from scratch.
- Never edit `packets.jsonl` / `results.jsonl` by hand; ingestion validates
  hashes and will reject tampering, and manual edits corrupt the queue
  (`QUEUE_CORRUPT` fails the run closed).
- A crashed run leaves a stale `RUNNING` ledger entry that the next resume
  recovers automatically; a per-source advisory work lock (`compile.lock`)
  prevents two concurrent compile runs and is never broken automatically —
  after verifying no compiler process is writing, delete the lock file
  manually and re-run.
