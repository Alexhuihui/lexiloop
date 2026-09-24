# LexiLoop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private, mobile-first postgraduate-English vocabulary PWA whose offline Content Compiler converts the supplied scanned textbook into agent-reviewed, versioned D1/R2 content and whose runtime provides deterministic textbook-order learning plus server-authoritative FSRS review for multiple preseeded users.

**Architecture:** Use one pnpm monorepo containing a React/Vite PWA, a Hono Cloudflare Worker, shared TypeScript contracts, and a TypeScript Content Compiler orchestrator. Python workers handle PDF image extraction, watermark cleanup, PaddleOCR, and deterministic audio inspection; all semantic content generation and review is performed by isolated agents through versioned work packets, with no human approval path. One D1 stores release-scoped content and user state in separate tables, while private R2 stores content-addressed audio and backups.

**Tech Stack:** TypeScript, pnpm, React, Vite, Tailwind CSS, Hono, Cloudflare Workers/D1/R2, Drizzle ORM, Zod, ts-fsrs, Vitest, Playwright, Python 3.12, uv, PyMuPDF, Pillow, OpenCV, PaddleOCR PP-StructureV3, ffmpeg/ffprobe, Xiaomi MiMo TTS.

---

**Approved spec:** `docs/superpowers/specs/2026-09-10-lexiloop-design.md`

**Execution worktree:** `/home/alex/workspace/lexiloop/.worktrees/implementation-plan`

## Execution protocol

- Execute tasks in order; later tasks assume earlier commits exist.
- Use `@superpowers:test-driven-development` for every implementation task.
- Use `@superpowers:systematic-debugging` for any unexpected failure.
- Before each task commit, use `@superpowers:verification-before-completion` and run the exact task verification commands.
- With subagent-driven execution, each task is implemented by a fresh implementation agent, followed by a specification-compliance agent and a code-quality agent. Reviewer agents must inspect the diff and fresh test output; no human content review is introduced.
- Content compilation uses a separate generation agent and independent review agent per Unit. A deterministic validator enforces schemas and invariants. Only the repair agent may revise rejected generated fields, for at most three rounds. No CLI flag, database update, or deployment command may bypass `BLOCKED` Unit status.
- Never add the source PDF, cleaned page images, OCR text, release SQL, real textbook audio, backups, `.env`, or `.dev.vars` to Git.

## Target file map

```text
apps/web/
  src/app/                    routing, providers, navigation
  src/features/auth/          login and session bootstrap
  src/features/today/         due/new/supplemental-card summary
  src/features/learn/         textbook-order learning and quick recall
  src/features/review/        FSRS reveal/rating/undo flow
  src/features/dictionary/    search and word detail
  src/features/stats/         learning statistics
  src/lib/                    API client, cache policy, keyboard, audio
  e2e/                        Playwright journeys
apps/worker/
  src/auth/                   password hashing, auth sessions, CSRF
  src/content/                release-scoped content/search/audio routes
  src/study/                  sessions, queues, grade and undo
  src/stats/                  aggregate queries
  src/releases/               activation and retention checks
  src/backups/                application-level export
packages/content-schema/src/  source/generated entities, agent packets, manifests
packages/db/src/              Drizzle schema, migrations, repositories
packages/domain/src/          stable keys, card rules, queues, release policy
packages/fsrs/src/            ts-fsrs adapter and serialization
tools/content-compiler/src/   stage ledger, orchestration, agents, TTS, packaging
tools/content-compiler/python/lexiloop_media/
                              PDF/image/OCR/audio workers
tools/content-compiler/config/ watermark, OCR, cards, TTS configuration
infra/migrations/             one-D1 SQL migrations
infra/wrangler/               development/production templates
scripts/                      seed users, publish, restore drill
tests/fixtures/               synthetic/authorized fixtures only
docs/runbooks/                compile, publish, rollback, backup procedures
```

## Phase 1 — Foundation and shared contracts

### Task 1: Bootstrap the monorepo and quality gates

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `eslint.config.mjs`
- Create: `pyproject.toml`
- Create: `.env.example`
- Create: `infra/wrangler/wrangler.toml.example`
- Create: `scripts/check-toolchain.ts`
- Create: `tests/smoke/workspace.test.ts`
- Modify: `.gitignore`

- [ ] **Step 1: Write the workspace smoke test**

```ts
// tests/smoke/workspace.test.ts
import { access } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace", () => {
  it.each([
    "apps/web/package.json",
    "apps/worker/package.json",
    "packages/content-schema/package.json",
    "packages/db/package.json",
    "packages/domain/package.json",
    "packages/fsrs/package.json",
    "tools/content-compiler/package.json",
  ])("contains %s", async (path) => {
    await expect(access(path)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails because package files do not exist**

Run: `corepack enable && pnpm dlx vitest@latest run tests/smoke/workspace.test.ts`

Expected: FAIL with `ENOENT` for the first missing workspace package.

- [ ] **Step 3: Create the minimal workspace**

Root scripts must be:

```json
{
  "name": "lexiloop",
  "private": true,
  "packageManager": "pnpm@11.15.1",
  "scripts": {
    "compiler": "pnpm --filter @lexiloop/content-compiler exec tsx src/cli.ts",
    "toolchain:check": "tsx scripts/check-toolchain.ts",
    "typecheck": "pnpm -r typecheck",
    "test": "vitest run",
    "test:python": "uv run pytest",
    "lint": "eslint .",
    "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm test:python"
  }
}
```

Create the seven workspace package files with these exact names: `@lexiloop/web`, `@lexiloop/worker`, `@lexiloop/content-schema`, `@lexiloop/db`, `@lexiloop/domain`, `@lexiloop/fsrs`, and `@lexiloop/content-compiler`. Each is `private: true`, `type: module`, and has a `typecheck` script. The Compiler package has a `cli` script using the pinned `tsx` binary and depends on the shared schema/domain packages; the root `compiler` script is the canonical entry point used throughout this plan. Add `packages/*`, `apps/*`, and `tools/*` to `pnpm-workspace.yaml`. Configure TypeScript strict mode, `noUncheckedIndexedAccess`, and project-relative path aliases.

Install dependencies with exact resolved versions (`-E`) so `package.json` and `pnpm-lock.yaml` pin the implementation baseline:

```bash
pnpm add -DwE @eslint/js@latest @types/node@latest eslint@latest typescript@latest typescript-eslint@latest vitest@latest tsx@latest wrangler@latest @cloudflare/workers-types@latest @cloudflare/vitest-pool-workers@latest better-sqlite3@latest @types/better-sqlite3@latest @playwright/test@latest sharp@latest
pnpm --filter @lexiloop/content-schema add -E zod@latest
pnpm --filter @lexiloop/domain add -E zod@latest '@lexiloop/content-schema@workspace:*'
pnpm --filter @lexiloop/db add -E drizzle-orm@latest '@lexiloop/content-schema@workspace:*'
pnpm --filter @lexiloop/fsrs add -E ts-fsrs@latest zod@latest
pnpm --filter @lexiloop/content-compiler add -E commander@latest dotenv@latest zod@latest '@lexiloop/content-schema@workspace:*' '@lexiloop/domain@workspace:*' '@lexiloop/db@workspace:*'
pnpm --filter @lexiloop/worker add -E hono@latest @hono/zod-validator@latest zod@latest '@lexiloop/content-schema@workspace:*' '@lexiloop/domain@workspace:*' '@lexiloop/db@workspace:*' '@lexiloop/fsrs@workspace:*'
pnpm --filter @lexiloop/web add -E react@latest react-dom@latest react-router-dom@latest @tanstack/react-query@latest
pnpm --filter @lexiloop/web add -DE vite@latest @vitejs/plugin-react@latest tailwindcss@latest @tailwindcss/vite@latest @types/react@latest @types/react-dom@latest @testing-library/react@latest @testing-library/user-event@latest happy-dom@latest vitest-axe@latest
```

Add Python 3.12, pytest, Pillow, PyMuPDF, OpenCV headless, pydantic, soundfile, and ffmpeg-python to `pyproject.toml`; keep PaddleOCR in an optional `ocr` dependency group so ordinary unit tests remain light. Lock them in `uv.lock`.

`scripts/check-toolchain.ts` must use argument-array process spawning to verify Node, pnpm, Python/uv, `ffmpeg -version`, and `ffprobe -version`, then print version lines only. `ffmpeg-python` is a wrapper and does not install the system binaries; if either command is absent, stop with an actionable install prerequisite before any audio task.

`infra/wrangler/wrangler.toml.example` defines one `DB` D1 binding, one private `AUDIO` R2 binding, a login rate limiter, and a UTC daily backup cron. It uses clearly named environment-specific ID markers only; real production values live in an ignored copied config or Cloudflare bindings.

`.env.example` contains names only:

```dotenv
MIMO_API_KEY=
SESSION_IDLE_HOURS=168
CLOUDFLARE_ACCOUNT_ID=
D1_DATABASE_ID=
R2_BUCKET_NAME=
```

Add `.worktrees/`, `.env*` exceptions, `.lexiloop-private/`, PDFs, release artifacts, Wrangler state, Node/Python build outputs, and Playwright results to `.gitignore`.

- [ ] **Step 4: Install dependencies and run baseline gates**

Run: `pnpm install && uv sync && pnpm toolchain:check && pnpm test tests/smoke/workspace.test.ts && pnpm typecheck && pnpm test:python`

Expected: workspace smoke test PASS, all package typechecks exit 0, pytest reports 0 failures.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.workspace.ts eslint.config.mjs pyproject.toml uv.lock .env.example .gitignore apps packages tools tests infra/wrangler/wrangler.toml.example scripts/check-toolchain.ts
git commit -m "chore: bootstrap LexiLoop workspace"
```

### Task 2: Define shared content, agent, and release schemas

**Files:**
- Create: `packages/content-schema/src/source.ts`
- Create: `packages/content-schema/src/generated.ts`
- Create: `packages/content-schema/src/cards.ts`
- Create: `packages/content-schema/src/agents.ts`
- Create: `packages/content-schema/src/release.ts`
- Create: `packages/content-schema/src/index.ts`
- Create: `packages/content-schema/test/schemas.test.ts`
- Create: `packages/domain/src/stable-key.ts`
- Create: `packages/domain/test/stable-key.test.ts`

- [ ] **Step 1: Write failing schema and stable-key tests**

```ts
it("rejects generated content that mutates source fields", () => {
  expect(() => AgentGenerationOutput.parse({
    sourcePatch: { headword: "changed" },
    generated: {},
  })).toThrow();
});

it("generates the same card key across releases", () => {
  const a = stableKey({ book: "llcy-2024", unit: "u01", type: "word", ordinal: 3, slug: "abandon" });
  const b = stableKey({ book: "llcy-2024", unit: "u01", type: "word", ordinal: 3, slug: "abandon" });
  expect(a).toBe(b);
  expect(a).not.toContain("release");
});
```

- [ ] **Step 2: Run the focused tests and verify missing exports fail**

Run: `pnpm vitest run packages/content-schema/test packages/domain/test/stable-key.test.ts`

Expected: FAIL with unresolved `AgentGenerationOutput` and `stableKey`.

- [ ] **Step 3: Implement strict Zod contracts**

Define strict schemas for `SourceBlock`, `Book`, `Unit`, `Word`, `Sense`, `Phrase`, `Example`, `Explanation`, `LexicalRelation`, `CardDefinition`, `AudioAsset`, `AgentWorkPacket`, `AgentGenerationOutput`, `AgentReviewOutput`, `RepairOutput`, `UnitValidationReport`, and `ReleaseManifest`. Source entities must require PDF SHA-256, page number, normalized bbox, raw private-reference hash, normalized text, and confidence. Generated entities must carry input hash, prompt version, model/run identifier, and cannot contain source-field keys.

Implement stable keys as SHA-256 over canonical JSON with sorted keys and normalized Unicode; reject missing edition, Unit, type, ordinal, or semantic slug. Add fixtures proving key stability, Unicode normalization, and release independence.

- [ ] **Step 4: Run focused and package tests**

Run: `pnpm vitest run packages/content-schema packages/domain && pnpm --filter @lexiloop/content-schema typecheck && pnpm --filter @lexiloop/domain typecheck`

Expected: PASS with 0 failures and 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/content-schema packages/domain
git commit -m "feat: define content and release contracts"
```

### Task 3: Create the single-D1 schema and repositories

**Files:**
- Create: `packages/db/src/schema/releases.ts`
- Create: `packages/db/src/schema/content.ts`
- Create: `packages/db/src/schema/users.ts`
- Create: `packages/db/src/schema/study.ts`
- Create: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/repositories/*.ts`
- Create: `infra/migrations/0001_initial.sql`
- Create: `infra/migrations/0002_content_search_fts.sql`
- Create: `packages/db/test/migrations.test.ts`
- Create: `packages/db/test/isolation.test.ts`

- [ ] **Step 1: Write failing migration tests against a temporary SQLite database**

The test must apply every SQL migration and assert all spec tables exist in one database, `content_search_fts` is an FTS5 virtual table, duplicate usernames/card states/review event IDs fail, and a user-scoped repository cannot return another user's rows.

```ts
expect(tableNames).toEqual(expect.arrayContaining([
  "content_release", "release_unit", "app_meta", "book", "unit", "word",
  "sense", "phrase", "example", "explanation", "lexical_relation",
  "card_definition", "audio_asset", "content_audio_link", "content_key_alias",
  "app_user", "auth_session", "user_settings", "word_progress", "card_state",
  "review_log", "study_session", "content_search_fts",
]));
```

- [ ] **Step 2: Verify the tests fail before migrations exist**

Run: `pnpm vitest run packages/db/test/migrations.test.ts packages/db/test/isolation.test.ts`

Expected: FAIL because migration files/tables do not exist.

- [ ] **Step 3: Implement schema, migrations, and typed repositories**

Use composite `(release_id, logical_key)` content primary keys and all indexes listed in spec §6.3. `content_key_alias` stores typed, release-aware one-to-one edges and their stable canonical root key. User state remains keyed by that canonical content key; `study_session` queues additionally retain the exact presented key and release. `review_log` stores both canonical state key and presented key/release so historical evidence remains immutable. Store timestamps as UTC epoch milliseconds. Store FSRS state and queue snapshots as versioned JSON validated at repository boundaries. Add `CHECK` constraints for statuses/rating values and foreign keys for release-scoped content. Repositories that access personal data accept an authenticated context `{ userId }`; do not expose generic unscoped list methods.

- [ ] **Step 4: Run migration, isolation, and type tests**

Run: `pnpm vitest run packages/db && pnpm --filter @lexiloop/db typecheck`

Expected: PASS, including cross-user isolation and FTS rebuild fixture.

- [ ] **Step 5: Commit**

```bash
git add packages/db infra/migrations
git commit -m "feat: add single-D1 schema and repositories"
```

## Phase 2 — Content Compiler

### Task 4: Implement the resumable compiler stage ledger

**Files:**
- Create: `tools/content-compiler/src/ledger.ts`
- Create: `tools/content-compiler/src/stage.ts`
- Create: `tools/content-compiler/src/pipeline.ts`
- Create: `tools/content-compiler/src/stage-registry.ts`
- Create: `tools/content-compiler/src/logging.ts`
- Create: `tools/content-compiler/src/cli.ts`
- Create: `tools/content-compiler/test/pipeline.test.ts`

- [ ] **Step 1: Write failing resume and invalidation tests**

```ts
it("resumes after the last matching passed stage", async () => {
  const calls: string[] = [];
  await runPipeline(fixtureStages(calls), ledger);
  await runPipeline(fixtureStages(calls), ledger);
  expect(calls).toEqual(["source", "images", "ocr"]);
});

it("reruns a stage and dependents when its input hash changes", async () => {
  // First run passes all stages; second run changes watermark config hash.
  expect(rerunCalls).toEqual(["watermark", "ocr", "normalize"]);
});

it("declares the complete production stage order", () => {
  expect(PRODUCTION_STAGE_NAMES).toEqual([
    "SOURCE_FINGERPRINT", "IMAGE_EXTRACT", "WATERMARK_CLEAN", "LAYOUT_OCR",
    "STRUCTURE_NORMALIZE", "AGENT_ENRICH", "AGENT_REVIEW",
    "DETERMINISTIC_VALIDATE", "REPAIR_LOOP", "CARD_GENERATE",
    "TTS_SYNTHESIZE", "AUDIO_VALIDATE", "RELEASE_PACKAGE",
  ]);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm vitest run tools/content-compiler/test/pipeline.test.ts`

Expected: FAIL because the ledger and pipeline are missing.

- [ ] **Step 3: Implement the stage protocol**

Implement `Stage<Input, Output>` with name, config version, input hashing, output validation, and `run`. Persist JSON ledger entries atomically under `.lexiloop-private/work/<source-hash>/ledger/`. Status transitions are `PENDING → RUNNING → PASSED|FAILED|BLOCKED`; stale `RUNNING` becomes resumable `FAILED` on next invocation. Retry only errors marked `retryable`, with capped exponential backoff and jitter.

Build one Commander root in `cli.ts`, export `buildCli(deps)`, and register `plan`, `run`, `resume`, and `status` here. Later tasks must extend this same function with `media`, `agents`, `tts`, and `release` command groups. The package `cli` script and root `pnpm compiler` script execute this file through the pinned `tsx` dependency.

Declare all 13 production stage names and dependencies now in `stage-registry.ts`. Each starts with an unimplemented handler that fails closed; Tasks 5–10 replace handlers with tested implementations. `run --through` can only traverse contiguous registered stages, and `RELEASE_PACKAGE` refuses to run unless every predecessor has a matching `PASSED` ledger entry.

Add Compiler JSON logging with `compile_run_id`, `release_id`, `unit_key`, stage, duration, attempt, retry/error code, and input/output hashes. Redact configured secrets and full source text. Tests capture logs and fail if forbidden fields or raw content appear.

- [ ] **Step 4: Verify deterministic resume behavior**

Run: `pnpm vitest run tools/content-compiler/test/pipeline.test.ts && pnpm --filter @lexiloop/content-compiler typecheck`

Expected: PASS; a repeated fixture run performs no stage work.

- [ ] **Step 5: Commit**

```bash
git add tools/content-compiler/src tools/content-compiler/test
git commit -m "feat: add resumable content compiler pipeline"
```

### Task 5: Extract page images and clean watermark regions without producing a PDF

**Files:**
- Create: `tools/content-compiler/python/lexiloop_media/pdf_images.py`
- Create: `tools/content-compiler/python/lexiloop_media/watermarks.py`
- Create: `tools/content-compiler/python/lexiloop_media/cli.py`
- Modify: `tools/content-compiler/src/cli.ts`
- Modify: `tools/content-compiler/src/stage-registry.ts`
- Create: `tools/content-compiler/config/watermarks/llcy-2024.json`
- Create: `tools/content-compiler/python/tests/test_pdf_images.py`
- Create: `tools/content-compiler/python/tests/test_watermarks.py`
- Create: `tests/fixtures/media/make_fixture.py`

- [ ] **Step 1: Generate a synthetic two-page scan fixture and write failing tests**

The fixture must contain body text plus repeated top/bottom fake-watermark text. Tests assert page count/order, image hashes, normalized mask bounds, watermark removal, preservation of body-region pixels, and absence of any PDF writer/output path.

```py
def test_cleanup_changes_only_declared_regions(scan_page, rule):
    cleaned, mask = clean_watermarks(scan_page, rule)
    assert np.array_equal(cleaned[body_slice], scan_page[body_slice])
    assert changed_pixels_outside(mask, scan_page, cleaned) == 0
```

- [ ] **Step 2: Verify the tests fail**

Run: `uv run pytest tools/content-compiler/python/tests/test_pdf_images.py tools/content-compiler/python/tests/test_watermarks.py -v`

Expected: FAIL because extraction and cleanup functions are missing.

- [ ] **Step 3: Implement original-image extraction and versioned masks**

Use PyMuPDF to extract a page's dominant embedded image without re-encoding when possible; otherwise render once at a configured DPI. Emit `pages.jsonl` with PDF hash, page index, dimensions, image hash, extraction method, and file path. Implement normalized rectangular/polygon masks, repeated-region evidence, inpainting/background fill selected by rule, and a changed-pixel boundary assertion. Never expose an API that writes a PDF.

Register `media extract`, `media clean`, and `media qa-packets` in the existing TypeScript root CLI. The commands invoke the versioned Python module with argument arrays rather than shell-concatenated strings and validate its JSONL output before advancing the ledger.

Replace the `IMAGE_EXTRACT` and `WATERMARK_CLEAN` fail-closed handlers in `stage-registry.ts`; add tests proving later stages cannot start when either media handler fails.

`llcy-2024.json` must include a rule version and normalized candidate regions but no copied textbook content. Calibrate numeric regions from local page inspection during execution, then run the agent visual-QA task before accepting the config.

- [ ] **Step 4: Run media tests and a safe smoke extraction of pages 1, 8, 32, and 100**

Run: `uv run pytest tools/content-compiler/python/tests/test_pdf_images.py tools/content-compiler/python/tests/test_watermarks.py -v`

Run privately: `pnpm compiler media extract --source "$LEXILOOP_SOURCE_PDF" --pages 1,8,32,100 --private-root .lexiloop-private`

Expected: tests PASS; four original and four cleaned images exist under `.lexiloop-private`; no cleaned PDF exists; changed pixels are confined to masks.

- [ ] **Step 5: Dispatch visual-QA agents and commit code/config only**

Create a deterministic QA packet for all anomalous pages plus a hash-stratified sample of ordinary pages. Dispatch a visual reviewer agent with original/cleaned pairs. If it returns `REPAIR`, update only the mask config and rerun Steps 4–5; after the initial review, allow at most three repair + fresh-review cycles, then mark affected Unit `BLOCKED`. Do not request human review.

```bash
git add tools/content-compiler/python tools/content-compiler/src/cli.ts tools/content-compiler/src/stage-registry.ts tools/content-compiler/config/watermarks tests/fixtures/media
git commit -m "feat: extract scans and clean watermark regions"
```

### Task 6: Add layout OCR, provenance, and deterministic normalization

**Files:**
- Create: `tools/content-compiler/python/lexiloop_media/ocr.py`
- Create: `tools/content-compiler/src/ocr-adapter.ts`
- Create: `tools/content-compiler/src/agents/visual-ocr.ts`
- Modify: `packages/content-schema/src/agents.ts`
- Modify: `tools/content-compiler/src/cli.ts`
- Modify: `tools/content-compiler/src/stage-registry.ts`
- Create: `tools/content-compiler/src/normalize/*.ts`
- Create: `tools/content-compiler/config/ocr/pp-structure-v3.json`
- Create: `tools/content-compiler/test/normalize.test.ts`
- Create: `tools/content-compiler/test/agents/visual-ocr.test.ts`
- Create: `tools/content-compiler/python/tests/test_ocr_contract.py`

- [ ] **Step 1: Write failing contract and normalization tests**

Cover cross-column reading order, hyphenated line joins, repeated header/footer removal, cross-page entries, Unicode/full-width punctuation, OCR confusion flags, source page/bbox retention, and rejection of low-confidence critical fields without a visual-agent decision. Also test visual packet creation, strict response ingestion, source-hash mismatch, `PASS`, corrected `REPAIR`, explicit `BLOCK`, three repair rounds, and resume after the last resolved packet.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `uv run pytest tools/content-compiler/python/tests/test_ocr_contract.py -v && pnpm vitest run tools/content-compiler/test/normalize.test.ts`

Expected: at least one command FAIL because adapters are missing.

- [ ] **Step 3: Implement PaddleOCR adapter and versioned JSONL boundary**

Python emits strict `SourceBlock` JSONL; TypeScript validates every line before normalization. Record model/config version, page/image hash, bbox, role, text, confidence, and private raw-text reference hash. The TypeScript normalizer emits book/Unit/word/sense/phrase/example records without generated explanations. Critical low-confidence fields create visual-agent packets; no contextual guessing is allowed.

Add `VisualOcrPacket` and `VisualOcrResult` to the shared agent schemas. A result contains packet/source hashes, a distinct `agent_run_id`, `PASS | REPAIR | BLOCK`, corrected normalized text/bbox when repairing, evidence codes, and no source mutation. `agents visual-ocr ingest` validates the response, stores corrections as separate provenance records, and resumes normalization only when every packet is resolved. Up to three repair-agent rounds follow the initial visual review; unresolved packets block the owning Unit. Register `agents visual-ocr packets|ingest|status` in `cli.ts`.

Replace the `LAYOUT_OCR` and `STRUCTURE_NORMALIZE` handlers in `stage-registry.ts`. Both must emit and verify output hashes before the ledger advances.

- [ ] **Step 4: Run unit tests and a one-Unit private OCR smoke test**

Run: `uv sync --extra ocr && uv run pytest tools/content-compiler/python/tests -v && pnpm vitest run tools/content-compiler/test/normalize.test.ts`

Expected: unit tests PASS; private smoke output validates against `packages/content-schema` and retains page/bbox for every source entity.

- [ ] **Step 5: Commit**

```bash
git add packages/content-schema/src/agents.ts tools/content-compiler/python tools/content-compiler/src/cli.ts tools/content-compiler/src/stage-registry.ts tools/content-compiler/src/ocr-adapter.ts tools/content-compiler/src/agents/visual-ocr.ts tools/content-compiler/src/normalize tools/content-compiler/config/ocr tools/content-compiler/test
git commit -m "feat: add provenance-preserving OCR normalization"
```

### Task 7: Implement generation, independent review, repair, and fail-closed Unit gates

**Files:**
- Create: `tools/content-compiler/src/agents/provider.ts`
- Create: `tools/content-compiler/src/agents/filesystem-provider.ts`
- Create: `tools/content-compiler/src/agents/work-packets.ts`
- Create: `tools/content-compiler/src/agents/review-loop.ts`
- Create: `tools/content-compiler/src/validate/unit-validator.ts`
- Modify: `tools/content-compiler/src/cli.ts`
- Modify: `tools/content-compiler/src/stage-registry.ts`
- Create: `tools/content-compiler/prompts/generate.md`
- Create: `tools/content-compiler/prompts/review.md`
- Create: `tools/content-compiler/prompts/repair.md`
- Create: `tools/content-compiler/test/agents/review-loop.test.ts`
- Create: `docs/runbooks/content-agent-compile.md`

- [ ] **Step 1: Write failing fail-closed tests**

Test immediate pass, repair then pass, repeated repair, three-round block, source-field mutation, generation/reviewer run-ID reuse, invalid structured output, dangling source citations, and inability to package a `BLOCKED` target Unit.

```ts
it("blocks after three rejected repair rounds", async () => {
  const result = await reviewUnit(unit, providerAlwaysReturningRepair);
  expect(result.status).toBe("BLOCKED");
  expect(result.repairAttempts).toHaveLength(3);
});
```

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run tools/content-compiler/test/agents/review-loop.test.ts`

Expected: FAIL because review loop is missing.

- [ ] **Step 3: Implement agent work packets and deterministic validator**

Each packet includes source evidence references, immutable source hashes, requested generated fields, JSON Schema, prompt version, Unit scope, and output path. Generation output cannot include reasoning or source patches. Review output is field-level `PASS | REPAIR | BLOCK` with issue codes and source evidence. Repair output maps every issue code to a revised field. Require different `agent_run_id` values for generation and review.

The filesystem provider writes packets to a private queue and validates returned JSON; it lets a Codex supervisor dispatch fresh generation/review/repair agents without embedding an LLM key in the application. The runbook must give exact dispatch/resume commands and state that agents—not humans—resolve every review decision. The limit is one initial generation/review followed by at most three repair-agent + fresh-review cycles; a fourth repair is impossible and the Unit becomes `BLOCKED`.

Extend `buildCli()` with `agents semantic packets|ingest|status` and `agents resume`. `ingest` must validate packet/source hashes and role/run separation before the stage ledger can continue.

Replace `AGENT_ENRICH`, `AGENT_REVIEW`, `DETERMINISTIC_VALIDATE`, and `REPAIR_LOOP` handlers in the production registry. `CARD_GENERATE` must remain unreachable unless every target Unit exits these handlers as `PASSED`.

- [ ] **Step 4: Verify the three-round state machine and immutable source fields**

Run: `pnpm vitest run tools/content-compiler/test/agents packages/content-schema/test && pnpm --filter @lexiloop/content-compiler typecheck`

Expected: PASS; blocked fixtures cannot advance to card/audio/package stages.

- [ ] **Step 5: Commit**

```bash
git add tools/content-compiler/src/cli.ts tools/content-compiler/src/stage-registry.ts tools/content-compiler/src/agents tools/content-compiler/src/validate tools/content-compiler/prompts tools/content-compiler/test/agents docs/runbooks/content-agent-compile.md
git commit -m "feat: add agent-only content review gates"
```

### Task 8: Generate the four deterministic card types and introduction queues

**Files:**
- Create: `packages/domain/src/cards/generator.ts`
- Create: `packages/domain/src/cards/introduction.ts`
- Create: `packages/domain/src/cards/types.ts`
- Create: `packages/domain/test/cards/generator.test.ts`
- Create: `packages/domain/test/cards/introduction.test.ts`
- Create: `tools/content-compiler/config/cards/v1.json`
- Modify: `tools/content-compiler/src/cli.ts`
- Modify: `tools/content-compiler/src/stage-registry.ts`

- [ ] **Step 1: Write failing card-count, key, and ordering tests**

Fixtures must prove all eligible `WORD_MEANING`, `CONTEXT_MEANING`, `PHRASE`, and `SENSE_DISCRIMINATION` cards are generated, every learnable word has at least one card, reruns are byte-identical, and queue sorting is exactly `card_type_rank → word.source_order → target_entity_key → content_card_key`.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm vitest run packages/domain/test/cards`

Expected: FAIL because generator/queue modules do not exist.

- [ ] **Step 3: Implement rule-driven generation**

Read only schema-validated content and versioned `v1.json`. Generate stable `content_card_key` values independent of release. Reject a Unit if any learnable word has zero cards. Implement `buildInitialQueue(words, cardDefinitions)` and `buildSupplementalQueue(introducedWords, cardStates, activeDefinitions)`; do not add FSRS scheduling here.

Register `cards generate` in `buildCli()` and replace the fail-closed `CARD_GENERATE` handler. Its output hash covers card config plus every validated Unit input. Add an integration test that runs the registry through `CARD_GENERATE`, then proves `TTS_SYNTHESIZE`/`RELEASE_PACKAGE` cannot skip or bypass it.

- [ ] **Step 4: Verify card contracts**

Run: `pnpm vitest run packages/domain/test/cards packages/content-schema/test && pnpm --filter @lexiloop/domain typecheck`

Expected: PASS and snapshot output is byte-identical across two runs.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/cards packages/domain/test/cards tools/content-compiler/src/cli.ts tools/content-compiler/src/stage-registry.ts tools/content-compiler/config/cards
git commit -m "feat: generate deterministic learning cards"
```

### Task 9: Integrate replaceable MiMo TTS and deterministic audio validation

**Files:**
- Create: `tools/content-compiler/src/tts/provider.ts`
- Create: `tools/content-compiler/src/tts/mimo.ts`
- Create: `tools/content-compiler/src/tts/cache.ts`
- Create: `tools/content-compiler/src/tts/plan.ts`
- Modify: `tools/content-compiler/src/cli.ts`
- Modify: `tools/content-compiler/src/stage-registry.ts`
- Create: `tools/content-compiler/python/lexiloop_media/audio.py`
- Create: `tools/content-compiler/config/tts/mimo-v2.5.json`
- Create: `tools/content-compiler/test/tts/mimo.test.ts`
- Create: `tools/content-compiler/python/tests/test_audio.py`

- [ ] **Step 1: Write failing provider, cache, and media tests**

Mock MiMo HTTP responses. Verify assistant-role target text, auth header redaction, retries only for retryable status codes, word+every-example coverage, cache key inputs, duplicate-text reuse, and support for both `MIMO_API_KEY` and the existing local legacy key name `mimo-key` without logging either value. Python tests cover valid WAV, corrupt container, all-silence, excessive head/tail silence, clipping, duration bounds, and text-hash mismatch.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run tools/content-compiler/test/tts && uv run pytest tools/content-compiler/python/tests/test_audio.py -v`

Expected: FAIL because TTS/audio modules are missing.

- [ ] **Step 3: Implement TTS planning, synthesis, and deterministic validation**

Implement `TtsProvider` and MiMo v2.5 provider following the official request/response contract. Normalize text without changing English wording. Cache by hash of Provider/model/voice/text/config version and store no key in artifacts. `tts plan` reports characters, request count, cache hits/misses, and output bytes before any paid/network call. `tts synthesize` requires explicit `--execute` and writes private files only.

Python `inspect_audio` uses ffprobe/soundfile for decoding, duration, channel/rate/container, RMS silence windows, peak, clipping ratio, and hash checks. It must contain no ASR dependency, command, field, or optional hook.

Register `tts plan`, `tts synthesize`, and `tts validate` in the existing root CLI. `synthesize` remains inert without `--execute`; all three commands update the shared stage ledger.

Replace `TTS_SYNTHESIZE` and `AUDIO_VALIDATE` handlers in the production registry. Both require a matching `CARD_GENERATE` output hash; audio validation produces the only input accepted by `RELEASE_PACKAGE`.

- [ ] **Step 4: Run unit tests, then a two-item MiMo smoke synthesis using the private key**

Run: `pnpm vitest run tools/content-compiler/test/tts && uv run pytest tools/content-compiler/python/tests/test_audio.py -v`

Run privately after reviewing `tts plan`: `pnpm compiler tts synthesize --limit 2 --execute`

Expected: tests PASS; two audio files pass deterministic inspection; logs contain no secret; no ASR/network endpoint other than TTS is contacted.

- [ ] **Step 5: Commit code/config only**

```bash
git add tools/content-compiler/src/cli.ts tools/content-compiler/src/stage-registry.ts tools/content-compiler/src/tts tools/content-compiler/python/lexiloop_media/audio.py tools/content-compiler/python/tests/test_audio.py tools/content-compiler/config/tts tools/content-compiler/test/tts
git commit -m "feat: add cached MiMo TTS compilation"
```

### Task 10: Package immutable releases and publish inactive D1/R2 data

**Files:**
- Create: `tools/content-compiler/src/release/package.ts`
- Create: `tools/content-compiler/src/release/validate.ts`
- Create: `tools/content-compiler/src/release/publish.ts`
- Create: `tools/content-compiler/src/release/aliases.ts`
- Create: `packages/domain/src/releases/aliases.ts`
- Create: `packages/domain/test/releases/aliases.test.ts`
- Create: `packages/db/src/repositories/alias-repository.ts`
- Modify: `tools/content-compiler/src/cli.ts`
- Modify: `tools/content-compiler/src/stage-registry.ts`
- Create: `tools/content-compiler/test/release/package.test.ts`
- Create: `scripts/publish-release.ts`
- Create: `docs/runbooks/publish-and-rollback.md`

- [ ] **Step 1: Write failing bundle and fail-closed publish tests**

Assert exact bundle layout, SHA-256 manifest verification, deterministic SQL ordering, exclusion of full private OCR/source text, rejection of missing audio, rejection of `BLOCKED` target Units, idempotent R2 upload by hash, inactive D1 import, pre-activation row/FK/FTS/audio checks, explicit word/card alias validation, one-to-many/many-to-one/cycle/type/target/conflicting-canonical-state rejection, bidirectional version-aware canonical resolution, immutable user state/review logs during activation and rollback, and atomic active-release switch.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run tools/content-compiler/test/release`

Expected: FAIL because package/publish functions are missing.

- [ ] **Step 3: Implement package, validate, stage, and activate commands**

Create `release package`, `release verify`, `release stage`, `release smoke`, `release activate`, and `release rollback`. `stage` uploads content-addressed audio to private R2 and imports a new D1 release with status `IMPORTING`; it never changes `app_meta`. `smoke` moves it through `VALIDATING` to `READY`. Only `activate` may update the active pointer, and only for `READY`. No `--force` or manual status override exists.

Define aliases as typed, release-aware one-to-one edges `{ entity_type: "word" | "card", from_release_id, from_key, to_release_id, to_key, canonical_key }`. Both ends must exist in their declared releases, types must match, and the graph must be acyclic with one canonical root. Reject one-to-many, many-to-one, multiple canonical roots, or existing user state under two different roots that would collapse.

Activation and rollback never rewrite `word_progress`, `card_state`, or `review_log`. The alias repository resolves `(release_id, presented_key)` to the canonical key in either direction. Old pinned Sessions therefore keep presenting old keys while grading/undo reads and writes the same canonical state as the active release; rollback simply presents the older key again. `review_log` records canonical state key plus the exact presented key/release. Reporting groups by canonical key and can still display historical content through the presented release when retained. The activation batch imports validated alias edges and switches `active_release_id`; a failure leaves state and pointer unchanged.

Register every release command in the same `buildCli()` root and add a CLI wiring test that invokes each subcommand with injected fake D1/R2 dependencies.

Replace the final `RELEASE_PACKAGE` registry handler and add one whole-pipeline fixture test asserting the exact 13-stage order, predecessor hashes, resume behavior, and refusal to package if any stage is missing, failed, blocked, or stale.

- [ ] **Step 4: Verify local release lifecycle**

Run: `pnpm vitest run tools/content-compiler/test/release packages/db/test && pnpm --filter @lexiloop/content-compiler typecheck`

Expected: PASS; an intentionally broken bundle leaves the old release active.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/releases packages/domain/test/releases packages/db/src/repositories/alias-repository.ts tools/content-compiler/src/cli.ts tools/content-compiler/src/stage-registry.ts tools/content-compiler/src/release tools/content-compiler/test/release scripts/publish-release.ts docs/runbooks/publish-and-rollback.md
git commit -m "feat: package and stage immutable content releases"
```

## Phase 3 — Worker runtime

### Task 11: Implement preseeded users and stateful authentication

**Files:**
- Create: `apps/worker/src/app.ts`
- Create: `apps/worker/src/auth/password.ts`
- Create: `apps/worker/src/auth/session.ts`
- Create: `apps/worker/src/auth/csrf.ts`
- Create: `apps/worker/src/auth/routes.ts`
- Create: `apps/worker/src/middleware/auth.ts`
- Create: `apps/worker/src/middleware/security-headers.ts`
- Create: `apps/worker/src/observability/logger.ts`
- Create: `apps/worker/src/observability/request-context.ts`
- Create: `apps/worker/test/auth.test.ts`
- Create: `scripts/seed-users.ts`

- [ ] **Step 1: Write failing auth and isolation tests**

Cover correct/wrong password, random per-user salt, opaque 256-bit token, only token hash stored, secure Cookie attributes, expiry, logout revocation, `session_version` invalidation, disabled accounts, CSRF/Origin rejection, login rate-limit response, rejection/ignoring of client-supplied `user_id`, CSP/HSTS/content-type/referrer/permissions security headers on success and error responses, request ID propagation, and structured-log redaction.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run apps/worker/test/auth.test.ts`

Expected: FAIL because Worker app/auth routes are missing.

- [ ] **Step 3: Implement PBKDF2 and stateful `auth_session`**

Use Web Crypto PBKDF2-SHA256 with versioned iteration parameters. Generate the token with `crypto.getRandomValues`, store only SHA-256 hash, and compare verifier bytes in constant time. Set `HttpOnly; Secure; SameSite=Strict; Path=/`. Persist revoke/expiry and check account status/session version on every authenticated request. Wire the Cloudflare rate-limit binding behind an injectable test adapter.

Install global security-header middleware before routes. Use a restrictive CSP compatible with the built PWA (`default-src 'self'`; explicit script/style/connect/media/img directives), `X-Content-Type-Options: nosniff`, strict referrer and permissions policies, and production HSTS. Test header behavior rather than relying on deployment defaults.

Install request-context/logging middleware at the outer boundary. Emit JSON with request ID, route template, status, duration, release ID when known, D1 rows read/written, R2 operation count, and stable error code. Metrics are derived from these structured events. Redact passwords, auth/CSRF headers, cookies, TTS keys, full textbook strings, and private object keys; test both normal and thrown-error paths.

`seed-users` reads usernames/passwords from a private input path or environment, never command-line arguments, and prints only user IDs/status. It performs upserts that rotate salt/verifier and increment `session_version`.

- [ ] **Step 4: Run auth/security tests**

Run: `pnpm vitest run apps/worker/test/auth.test.ts packages/db/test/isolation.test.ts && pnpm --filter @lexiloop/worker typecheck`

Expected: PASS; no log snapshot contains password, token, Cookie, verifier, or CSRF secret.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src apps/worker/test/auth.test.ts scripts/seed-users.ts
git commit -m "feat: add preseeded stateful authentication"
```

### Task 12: Add release-scoped content, search, progress, and private audio APIs

**Files:**
- Create: `apps/worker/src/content/routes.ts`
- Create: `apps/worker/src/content/service.ts`
- Create: `apps/worker/src/content/search.ts`
- Create: `apps/worker/src/content/audio.ts`
- Create: `apps/worker/src/progress/routes.ts`
- Create: `apps/worker/src/http/cache.ts`
- Create: `apps/worker/test/content.test.ts`
- Create: `apps/worker/test/audio.test.ts`

- [ ] **Step 1: Write failing API/cache/account tests**

Cover `/bootstrap`, Unit, word detail, exact/prefix/Chinese/phrase/example search priority, progress endpoint separation, missing release, pinned-session content lookup, R2 authorization, ETag/range behavior, object/release association, and cache headers. Assert `/api/content/*` contains no familiarity/due/user fields and personal routes return `Cache-Control: private, no-store`.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run apps/worker/test/content.test.ts apps/worker/test/audio.test.ts`

Expected: FAIL with missing routes.

- [ ] **Step 3: Implement content-only responses and user-scoped progress**

Normal content uses `active_release_id`; requests made through a valid `study_session` use its pinned release. Search combines exact and prefix indexes with FTS5 and deterministic ranking. Audio is streamed only after verifying authenticated access and association with active/retained release. Keep R2 private. Personal progress stays in `/api/progress/*`, `/api/study/*`, and `/api/stats/*` only.

- [ ] **Step 4: Run API tests and query-plan checks**

Run: `pnpm vitest run apps/worker/test/content.test.ts apps/worker/test/audio.test.ts && pnpm --filter @lexiloop/worker typecheck`

Expected: PASS; representative search/due queries use intended indexes in `EXPLAIN QUERY PLAN` assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/content apps/worker/src/progress apps/worker/src/http apps/worker/test/content.test.ts apps/worker/test/audio.test.ts
git commit -m "feat: expose private release-scoped content APIs"
```

### Task 13: Implement server-authoritative FSRS, study queues, grade, and undo

**Files:**
- Create: `packages/fsrs/src/adapter.ts`
- Create: `packages/fsrs/src/serialization.ts`
- Create: `packages/fsrs/test/fixtures.test.ts`
- Create: `packages/domain/src/study/queue.ts`
- Create: `apps/worker/src/study/routes.ts`
- Create: `apps/worker/src/study/service.ts`
- Create: `apps/worker/src/study/familiarity.ts`
- Create: `apps/worker/src/study/grade.ts`
- Create: `apps/worker/src/study/undo.ts`
- Create: `apps/worker/test/study.test.ts`
- Create: `apps/worker/test/review-concurrency.test.ts`

- [ ] **Step 1: Write failing FSRS and transactional behavior tests**

Use locked ts-fsrs vectors for all ratings, UTC/timezone/DST fixtures, new textbook-order queue, supplemental-card queue, due queue, 24-hour pinned release, queue resume, `PATCH /api/study/sessions/:id`, idempotent `WORD_PRESENTED`, `UNSEEN → IN_PROGRESS`, three-value familiarity persistence without FSRS writes, unique review `event_id`, concurrent duplicate grade, first-grade state creation, last-card `INTRODUCED` transition, later review, undo restore, first-grade undo deletion, word-stage rollback, rejection of non-latest/expired-session undo, and alias-aware grading/undo while the active release changes and rolls back.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run packages/fsrs apps/worker/test/study.test.ts apps/worker/test/review-concurrency.test.ts`

Expected: FAIL because FSRS/study services are missing.

- [ ] **Step 3: Implement authoritative queue and atomic write batches**

Create Session queue snapshots with pinned `release_id` and presented content keys. Initial card order exactly matches spec §5.7; due review is ordered by due then canonical stable key. Before familiarity, grade, or undo, resolve `(session.release_id, presented_key)` through the alias repository to the canonical word/card key. Grade validates current queue position and calls the FSRS adapter on the Worker only. One D1 batch inserts append-only `review_log` with both canonical and presented keys, upserts/deletes canonical `card_state` as appropriate, advances/rewinds `study_session`, and updates canonical `word_progress` transition fields. Replayed `event_id` returns the prior result. Activation or rollback during a Session changes neither its queue nor the canonical state it addresses.

Implement `PATCH /api/study/sessions/:id` with a strict discriminated body:

```ts
type StudyPatch =
  | { event_id: string; action: "WORD_PRESENTED"; word_key: string }
  | { event_id: string; action: "FAMILIARITY_SET"; word_key: string; familiarity: "VERY_UNFAMILIAR" | "SOMEWHAT_FAMILIAR" | "FAMILIAR" };
```

Validate that the word is the current item in the pinned queue. `WORD_PRESENTED` atomically creates/updates `word_progress`, sets `first_seen_at` once, and moves only `UNSEEN → IN_PROGRESS`. `FAMILIARITY_SET` stores the choice and `last_seen_at` but never creates `card_state` or invokes FSRS. Record processed patch event IDs in the Session snapshot so retrying the same patch is idempotent.

- [ ] **Step 4: Run FSRS, concurrency, and isolation tests repeatedly**

Run: `pnpm vitest run packages/fsrs apps/worker/test/study.test.ts apps/worker/test/review-concurrency.test.ts --repeat=10`

Expected: 10 runs PASS with deterministic state and no duplicate log/state rows.

- [ ] **Step 5: Commit**

```bash
git add packages/fsrs packages/domain/src/study apps/worker/src/study apps/worker/test/study.test.ts apps/worker/test/review-concurrency.test.ts
git commit -m "feat: add authoritative FSRS study workflow"
```

### Task 14: Add statistics, release retention, backups, and restore drills

**Files:**
- Create: `apps/worker/src/stats/routes.ts`
- Create: `apps/worker/src/stats/queries.ts`
- Create: `apps/worker/src/releases/retention.ts`
- Create: `apps/worker/src/backups/export.ts`
- Create: `apps/worker/src/scheduled.ts`
- Modify: `apps/worker/src/app.ts`
- Create: `scripts/backup-user-data.ts`
- Create: `scripts/restore-drill.ts`
- Create: `apps/worker/test/stats.test.ts`
- Create: `apps/worker/test/retention.test.ts`
- Create: `apps/worker/test/backup.test.ts`
- Create: `docs/runbooks/backup-and-restore.md`
- Modify: `infra/wrangler/wrangler.toml.example`

- [ ] **Step 1: Write failing stats/retention/restore tests**

Cover learned word/card counts, retention estimate, streak in user timezone, 30-day due forecast, lapses/difficult words, Unit coverage+retention, exclusion of undone reviews, previous-release 14-day minimum, unexpired Session pin, R2 zero-reference 7-day grace, compressed JSONL export, scheduled daily invocation, FTS exclusion/rebuild, required-release inventory in the backup manifest, rejection when any referenced release bundle is absent, import of every required bundle before user data, row/FK/hash validation, and dry-run deletion output.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run apps/worker/test/stats.test.ts apps/worker/test/retention.test.ts apps/worker/test/backup.test.ts`

Expected: FAIL because services/scripts are missing.

- [ ] **Step 3: Implement queries and operational scripts**

Keep backup rows to user/settings/progress/card/review/Session tables; upload gzip JSONL and a manifest to private R2. The manifest lists every content release required by active/previous pointers, unexpired and backed-up study Sessions, `introduced_release_id`, presented review releases, and alias lineages. Immutable release bundles remain in private release storage even after their D1 rows age out. Export in bounded pages and stream compression so the small V1 dataset remains within Worker limits. Wire the same exporter to a Worker `scheduled()` handler and the Wrangler cron `0 19 * * *` (03:00 Asia/Shanghai); retain the local script for on-demand use and restore drills.

Restore only to an explicit newly-created temporary database. Require `--release-bundle-dir <directory containing every immutable bundle named in the backup manifest>` plus `--backup <user-data.jsonl.gz>`. Apply migrations, verify the exact required-release set and every bundle hash, import all required releases/aliases, import user data, restore active/previous pointers, rebuild FTS, then verify counts/FKs/hashes and canonical alias resolution. Missing or extra ambiguous bundles fail before user rows are written. Cleanup commands default to dry-run and require exact release IDs—never broad paths, globs, or unresolved variables.

- [ ] **Step 4: Run tests and local restore drill fixture**

Run: `pnpm vitest run apps/worker/test/stats.test.ts apps/worker/test/retention.test.ts apps/worker/test/backup.test.ts`

Run: `pnpm tsx scripts/restore-drill.ts --release-bundle-dir tests/fixtures/releases/retained-set --backup tests/fixtures/backup/minimal.jsonl.gz --temporary-db .lexiloop-private/restore-drill.sqlite`

Expected: PASS; FTS is rebuilt and all verification counts match.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/app.ts apps/worker/src/stats apps/worker/src/releases apps/worker/src/backups apps/worker/src/scheduled.ts apps/worker/test scripts/backup-user-data.ts scripts/restore-drill.ts docs/runbooks/backup-and-restore.md infra/wrangler/wrangler.toml.example
git commit -m "feat: add stats retention and recovery tooling"
```

## Phase 4 — PWA user experience

### Task 15: Build the app shell, login, responsive navigation, and safe API client

**Files:**
- Create: `apps/web/index.html`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/app/router.tsx`
- Create: `apps/web/src/app/AppShell.tsx`
- Create: `apps/web/src/features/auth/LoginPage.tsx`
- Create: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/query-cache.ts`
- Create: `apps/web/src/styles/index.css`
- Create: `apps/web/public/manifest.webmanifest`
- Create: `apps/web/public/icons/icon-192.png`
- Create: `apps/web/public/icons/icon-512.png`
- Create: `apps/web/public/icons/maskable-512.png`
- Create: `scripts/generate-pwa-icons.ts`
- Create: `apps/web/src/app/AppShell.test.tsx`
- Create: `apps/web/src/features/auth/LoginPage.test.tsx`

- [ ] **Step 1: Write failing responsive/auth/cache tests**

Assert unauthenticated redirect, login errors, mobile bottom navigation, desktop left navigation, five destinations, auth-expiry route preservation, CSRF attachment, no retry for writes, bounded retry for reads, no storage/caching of personal API responses, a linked valid web-app manifest, 192/512/maskable icons, theme color, and standalone display mode.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run apps/web/src/app/AppShell.test.tsx apps/web/src/features/auth/LoginPage.test.tsx`

Expected: FAIL because React app files are missing.

- [ ] **Step 3: Implement the mobile-first shell**

Use `@frontend-design` for the visual system, then implement accessible landmarks, high-contrast focus states, 44px touch targets, reduced-motion support, and typography optimized for English/Chinese reading. Routes are `/today`, `/learn`, `/review`, `/dictionary`, `/stats`. Keep personal state only in memory/query cache; on logout clear query cache, personal IndexedDB/localStorage, and send a Service Worker cache-clear message.

Link `manifest.webmanifest` from `index.html`. Generate the three PNG icons deterministically from a repo-native LexiLoop SVG/source asset using `scripts/generate-pwa-icons.ts`, commit the outputs, and test their dimensions/manifest purpose fields. Do not call ImageGen for runtime-required assets.

- [ ] **Step 4: Run component tests and accessibility smoke check**

Run: `pnpm vitest run apps/web/src/app apps/web/src/features/auth && pnpm --filter @lexiloop/web typecheck`

Expected: PASS with no axe violations in rendered shell/login fixtures.

- [ ] **Step 5: Commit**

```bash
git add apps/web scripts/generate-pwa-icons.ts
git commit -m "feat: build private responsive PWA shell"
```

### Task 16: Implement Today and the complete new-word learning flow

**Files:**
- Create: `apps/web/src/features/today/TodayPage.tsx`
- Create: `apps/web/src/features/learn/LearnSetupPage.tsx`
- Create: `apps/web/src/features/learn/WordStudyCard.tsx`
- Create: `apps/web/src/features/learn/QuickRecall.tsx`
- Create: `apps/web/src/features/learn/useStudySession.ts`
- Create: `apps/web/src/features/learn/*.test.tsx`

- [ ] **Step 1: Write failing journey-level component tests**

Cover separate due/new/supplemental counts, recommend-but-don't-force due review, Unit/tier/start selection, expected word+card counts, textbook order, full content/audio, three familiarity choices without FSRS write, group completion, deterministic multi-card quick recall, reveal before rating, interrupted Session resume, and last-card word introduction.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run apps/web/src/features/today apps/web/src/features/learn`

Expected: FAIL because feature components are missing.

- [ ] **Step 3: Implement the learning state machine**

Represent UI states explicitly: `SETUP → STUDY_WORDS → QUICK_RECALL_QUESTION → QUICK_RECALL_REVEALED → COMPLETE`. Persist only through Worker Session APIs. Disable navigation to the next card while a grade request is pending; replay the same `event_id` after network failure. Show content and audio failures without discarding position.

When a word becomes visible, send one stable `WORD_PRESENTED` patch event and wait for acknowledgement before enabling familiarity controls. A familiarity choice sends `FAMILIARITY_SET`; it may be changed while the word remains current, but it never calls the grade endpoint. Use the same event ID when retrying a failed patch.

- [ ] **Step 4: Run component tests**

Run: `pnpm vitest run apps/web/src/features/today apps/web/src/features/learn && pnpm --filter @lexiloop/web typecheck`

Expected: PASS for mobile and desktop viewport fixtures.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/features/today apps/web/src/features/learn
git commit -m "feat: add textbook-order learning workflow"
```

### Task 17: Implement review, dictionary, statistics, keyboard, and PWA policy

**Files:**
- Create: `apps/web/src/features/review/ReviewPage.tsx`
- Create: `apps/web/src/features/review/ReviewCard.tsx`
- Create: `apps/web/src/features/review/useReviewSession.ts`
- Create: `apps/web/src/features/dictionary/SearchPage.tsx`
- Create: `apps/web/src/features/dictionary/WordDetailPage.tsx`
- Create: `apps/web/src/features/stats/StatsPage.tsx`
- Create: `apps/web/src/lib/keyboard.ts`
- Create: `apps/web/src/lib/audio.ts`
- Create: `apps/web/src/sw.ts`
- Create: `apps/web/src/features/{review,dictionary,stats}/*.test.tsx`
- Create: `apps/web/src/sw.test.ts`

- [ ] **Step 1: Write failing feature and Service Worker tests**

Cover context cloze, reveal, four ratings, latest-only undo, full-entry round trip, Space/1–4/Z/S shortcuts, exact/prefix/Chinese/phrase/example search rendering, highlighted matches, all spec statistics, audio fallback, active release change, static-shell precache only, personal route `no-store`, no offline教材 rendering, and logout cache deletion.

- [ ] **Step 2: Verify tests fail**

Run: `pnpm vitest run apps/web/src/features/review apps/web/src/features/dictionary apps/web/src/features/stats apps/web/src/sw.test.ts`

Expected: FAIL because features/Service Worker are missing.

- [ ] **Step 3: Implement remaining UX and strict cache routing**

Register keyboard shortcuts only when focus is not inside an editable control. Keep explanations collapsible. Cache static build assets; optionally cache content/audio only under release-scoped caches during an authenticated session, clear them on logout, and never answer an offline教材 navigation from cache. Do not cache auth/progress/study/review/stats responses.

- [ ] **Step 4: Run feature, a11y, and build checks**

Run: `pnpm vitest run apps/web && pnpm --filter @lexiloop/web typecheck && pnpm --filter @lexiloop/web build`

Expected: all tests PASS and Vite production build exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat: complete review search stats and PWA flows"
```

## Phase 5 — System verification and private release

### Task 18: Add full-stack E2E, security, and failure-path verification

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/auth.spec.ts`
- Create: `apps/web/e2e/learning.spec.ts`
- Create: `apps/web/e2e/review.spec.ts`
- Create: `apps/web/e2e/content-upgrade.spec.ts`
- Create: `apps/web/e2e/account-isolation.spec.ts`
- Create: `apps/web/e2e/network-recovery.spec.ts`
- Create: `tests/security/secret-scan.test.ts`
- Create: `scripts/verify-release.ts`

- [ ] **Step 1: Write E2E tests against a synthetic local release**

Seed two users and two synthetic content releases/audio sets. Test login/logout/revocation, account isolation, mobile learning, desktop shortcuts, quick recall and first rating, due review/undo, refresh resume, duplicate grade under network retry, auth expiry recovery, search/stats, release activation during a pinned old Session, continued old-key grading and undo through canonical aliases, new-release access to the same FSRS state, alias-conflict activation failure, rollback to old presented keys with unchanged canonical state, R2 denial, logout cache clearing, PWA installability, and security headers on HTML/API/error responses.

- [ ] **Step 2: Run E2E tests and verify at least one fails before fixtures/harness are complete**

Run: `pnpm exec playwright test`

Expected: FAIL on missing local Worker/web test harness or fixture seed.

- [ ] **Step 3: Implement deterministic local harness and release verifier**

Start Wrangler with one local D1 and local R2, seed synthetic release/users, run Vite against Worker, and tear down only explicitly-created temporary paths. `verify-release.ts` runs schema/FK/key/audio/capacity/API/E2E checks and returns nonzero for any gate; it has no bypass flag.

- [ ] **Step 4: Run every automated gate fresh**

Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:python && pnpm exec playwright test && pnpm --filter @lexiloop/web build`

Expected: all commands exit 0; Playwright reports 0 failed; secret scan confirms no `.env`, key-shaped value, PDF, private OCR, real audio, or textbook fixture is tracked.

- [ ] **Step 5: Request implementation code review and commit**

Use `@superpowers:requesting-code-review` with the approved spec, this plan, full diff, and fresh verification output. Resolve blocking findings with `@superpowers:receiving-code-review`, rerun Step 4, then:

```bash
git add apps/web/e2e apps/web/playwright.config.ts tests/security scripts/verify-release.ts
git commit -m "test: verify LexiLoop end-to-end behavior"
```

### Task 19: Compile the private textbook, seed accounts, and deploy V1

**Files:**
- Modify privately: `.env` (never commit)
- Create privately: `.lexiloop-private/**` (never commit)
- Modify: `infra/wrangler/wrangler.toml.example`
- Create: `docs/runbooks/production-release.md`
- Create: `docs/releases/v1-validation-summary.md` (metrics/hashes only; no textbook text)

- [ ] **Step 1: Run a no-network compile plan and source safety checks**

Run: `pnpm compiler plan --source "$LEXILOOP_SOURCE_PDF" --private-root .lexiloop-private`

Expected: reports the PDF SHA-256, 440-page expectation check, stage/config versions, estimated OCR/TTS work, and no external call. Stop if the source hash/page count differs from the approved source inventory.

- [ ] **Step 2: Run the private compiler through OCR and structure normalization**

Run: `pnpm compiler run --through structure-normalize --source "$LEXILOOP_SOURCE_PDF" --private-root .lexiloop-private`

Expected: every source entity has page/bbox provenance; no cleaned PDF is produced; known watermark text count is zero. Any image/OCR anomaly becomes an agent work packet.

- [ ] **Step 3: Resolve visual OCR packets entirely through agents**

Run `pnpm compiler agents visual-ocr status`. For every pending packet, dispatch a fresh visual agent with the cleaned page image, bbox, OCR candidates, and strict response schema. Ingest results with `pnpm compiler agents visual-ocr ingest --result <private-json>`, then resume normalization. Initial review may be followed by at most three repair-agent rounds; unresolved packets make the Unit `BLOCKED`. Continue only when pending visual packets are zero.

- [ ] **Step 4: Dispatch generation, independent review, and repair agents by Unit**

Use fresh agents and the packet protocol from `docs/runbooks/content-agent-compile.md`. A generation agent cannot review its own Unit output. Resume the compiler after each batch. Repair loops stop at three; any unresolved Unit is `BLOCKED`. There is no human review/approve action and no force-pass path.

Run: `pnpm compiler status --private-root .lexiloop-private`

Expected before packaging: every target Unit is `PASSED`, zero pending packets, zero blocked Units, immutable source hashes unchanged.

- [ ] **Step 5: Plan and execute MiMo TTS, then package the release**

Run: `pnpm compiler tts plan --private-root .lexiloop-private`

Inspect only counts/cache estimates, then run: `pnpm compiler tts synthesize --private-root .lexiloop-private --execute && pnpm compiler release package --private-root .lexiloop-private`

Expected: every word and example has an audio link; all files pass deterministic format/decode/duration/silence/clipping/hash checks; no ASR call occurs; bundle hashes verify.

- [ ] **Step 6: Create Cloudflare resources and apply the one-D1 migrations**

Use `@cloudflare-deploy`. Create exactly one D1 database and one private R2 bucket. Store IDs in untracked production configuration and secrets via Wrangler. Apply migrations first to preview/local and then production only after local verification.

Expected: one D1 contains all table groups, R2 has no public access, Worker bindings use least privilege.

- [ ] **Step 7: Seed multiple accounts without exposing credentials**

Run from a private input file: `pnpm tsx scripts/seed-users.ts --input "$LEXILOOP_PRIVATE_USERS_FILE" --remote`

Expected: configured users exist with unique salts/verifiers; output includes IDs/status only; login works for a test account; no credential enters shell history, logs, or Git.

- [ ] **Step 8: Stage, smoke-test, and atomically activate the release**

Run: `pnpm compiler release stage --bundle "$LEXILOOP_RELEASE_BUNDLE" --remote`

Run: `pnpm compiler release smoke --release-id "$LEXILOOP_RELEASE_ID" --remote`

Run only after all gates return `READY`: `pnpm compiler release activate --release-id "$LEXILOOP_RELEASE_ID" --remote`

Expected: active pointer changes once and a post-activation bootstrap returns the new release. If this is the first production release, `previous_release_id` is explicitly null and production rollback is reported as unavailable until a second real release; the two-release synthetic E2E in Task 18 is the required V1 rollback exercise. If a real previous release already exists, it remains retained and a production pointer rollback smoke check is required.

- [ ] **Step 9: Deploy Worker/PWA and run production-safe smoke tests**

Run the documented Wrangler deploy commands, then execute read-only/login/synthetic-user journeys against production. Verify security headers, private R2 behavior, mobile/desktop paths, account isolation, one grade plus undo with a designated test user, and structured logs without content/secrets.

Expected: all V1 hard gates pass; backup job writes a private R2 object; a restore drill succeeds in a temporary local database.

- [ ] **Step 10: Write the redacted validation summary and run final verification**

Record release ID, hashes, Unit/card/audio counts, automated Agent review counts/rounds, test totals, capacity metrics, deployment IDs, nullable production rollback target, Task 18 local two-release rollback evidence, and backup/restore result. Do not include textbook excerpts, credentials, user data, or private object keys.

Run: `pnpm verify && pnpm exec playwright test && pnpm tsx scripts/verify-release.ts --release-id "$LEXILOOP_RELEASE_ID" --remote && git status --short`

Expected: all automated checks exit 0; Git status contains only the redacted docs/config intended for commit; no private file is tracked.

- [ ] **Step 11: Request final agent reviews and commit**

Dispatch separate agents for spec compliance, security/account isolation, compiler provenance/gates, and UX/E2E evidence. Resolve every blocking issue, rerun Step 10, then:

```bash
git add infra/wrangler/wrangler.toml.example docs/runbooks/production-release.md docs/releases/v1-validation-summary.md
git commit -m "docs: record private V1 release validation"
```

## Final completion gate

- [ ] Every task commit exists in order and contains only its scoped files.
- [ ] `pnpm verify`, Playwright, production release verification, and secret scan pass from a clean checkout.
- [ ] Independent Agent review reports are approved; no human content approval was used.
- [ ] All target Units are `PASSED`; no watermark text, source PDF, cleaned image, OCR text, real audio, release bundle, backup, or secret is tracked.
- [ ] Exactly one production D1 and one private R2 bucket are bound.
- [ ] Multiple preseeded accounts are isolated; Session revocation and CSRF/rate-limit tests pass.
- [ ] Existing study Sessions stay pinned through activation; stable card keys preserve user FSRS history.
- [ ] Every word and example has validated TTS audio; the system contains no ASR integration.
- [ ] Two-release rollback has been exercised locally and application-level backup restore has passed; production rollback is additionally exercised only when a prior real release exists, otherwise the null rollback target is documented.
- [ ] Use `@superpowers:finishing-a-development-branch` to choose merge/PR/cleanup only after fresh verification evidence.
