# APAC Grade Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut high-frequency grading latency and move only LexiLoop's Worker, D1, and R2 resources to APAC with a verified rollback path.

**Architecture:** Authentication resolves its session and user in one joined database read and rate-limits the audit touch. Grading loads idempotency/session data concurrently, loads cards plus one reusable alias snapshot concurrently, batches card-state reads, and commits through the existing atomic batch. Production uses blue/green resource bindings: new APAC D1/R2 resources are populated and verified before the Worker switches, while old WNAM resources remain untouched.

**Tech Stack:** TypeScript 6, Hono, Drizzle ORM, Cloudflare Workers/D1/R2, Vitest, Playwright, Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-09-24-apac-grade-latency.md`

## Global Constraints

- Migrate only `lexiloop`, `lexiloop-audio`, and `lexiloop-worker`; do not modify any other project resource.
- Use a one-shot full D1 import as explicitly approved by the user, but record usage and preserve the source as rollback.
- Never commit real production IDs, credentials, cookies, CSRF tokens, object keys, or textbook content.
- Preserve grading idempotency, alias correctness, atomic introduction, and undo behavior.
- Push and deploy only after fresh verification on the exact integrated commit.

## Review Focus

- A revoked/expired/disabled/version-mismatched auth session must not become valid because of the joined lookup; Task 1 runs all auth reason tests.
- Touch throttling must handle `null`, just-under-five-minutes, exactly-five-minutes, and clock skew; Task 1 adds direct middleware coverage.
- Concurrent duplicate grades must still collapse to one event when reads are parallelized; Task 2 runs the repeated concurrency suite.
- A release alias published after an older session was created must still resolve from a fresh snapshot; Task 2 retains the activation/rollback integration test.
- A partial APAC copy must never receive production traffic; Task 4 requires counts, FK, hashes/bytes, login, and grade/undo evidence before binding cutover.

---

### Task 1: Collapse and throttle authentication database work

**Files:**
- Modify: `packages/db/src/repositories/users.ts`
- Modify: `apps/worker/src/auth/session.ts`
- Modify: `apps/worker/src/middleware/auth.ts`
- Modify: `packages/db/test/driver.test.ts`
- Modify: `apps/worker/test/auth.test.ts`

**Interfaces:**
- Produces: `AuthSessionRepository.resolveByTokenHash(tokenHash): Promise<{ session: AuthSessionRow; user: AppUserRow } | undefined>`.
- Produces: `AUTH_SESSION_TOUCH_INTERVAL_MS = 300_000` and throttled middleware touch semantics.
- Consumes: existing `resolveSession` result reasons and `AuthenticatedPrincipal` shape without changing API responses.

- [ ] **Step 1: Write the failing repository test**

Add a test that creates a user and auth session, calls `resolveByTokenHash`, and expects both rows from one API. The test must fail because the method does not exist.

```ts
const principal = await fx.authSessions.resolveByTokenHash("hash-alice");
expect(principal?.session.sessionId).toBe(fx.aliceAuthSessionId);
expect(principal?.user.userId).toBe(fx.alice.userId);
```

- [ ] **Step 2: Verify the repository test is red**

Run: `pnpm vitest run packages/db/test/driver.test.ts`

Expected: FAIL at compile/collection because `resolveByTokenHash` is missing.

- [ ] **Step 3: Implement the joined auth lookup and use it in `resolveSession`**

Implement a single Drizzle join from `auth_session.user_id` to `app_user.user_id`, return `{ session, user }`, and preserve the existing validation order after a missing join maps to `INVALID`.

- [ ] **Step 4: Write the failing touch-throttle tests**

Add cases proving a second authenticated request before five minutes leaves
`last_used_at` unchanged, exactly five minutes updates it, and a backwards
clock does not rewrite it.

```ts
fx.clock.now = T0 + 5 * 60 * 1000;
await authenticatedMe(token);
fx.clock.now += 5 * 60 * 1000 - 1;
await authenticatedMe(token);
expect(lastUsedAt()).toBe(T0 + 5 * 60 * 1000);
fx.clock.now += 1;
await authenticatedMe(token);
expect(lastUsedAt()).toBe(T0 + 10 * 60 * 1000);
```

- [ ] **Step 5: Verify the throttle tests are red**

Run: `pnpm vitest run apps/worker/test/auth.test.ts`

Expected: FAIL because middleware currently touches on every request.

- [ ] **Step 6: Implement minimal throttling**

Touch only when `lastUsedAt === null` or `now - lastUsedAt >= 300_000`.

- [ ] **Step 7: Verify and commit**

Run: `pnpm vitest run packages/db/test/driver.test.ts apps/worker/test/auth.test.ts`

Expected: PASS.

Commit: `Optimize authenticated session resolution`

---

### Task 2: Batch and parallelize grading reads

**Files:**
- Modify: `packages/db/src/repositories/alias-repository.ts`
- Modify: `packages/db/src/repositories/study.ts`
- Modify: `apps/worker/src/study/service.ts`
- Modify: `apps/worker/src/study/grade.ts`
- Modify: `packages/db/test/driver.test.ts`
- Modify: `packages/db/test/isolation.test.ts`
- Modify: `apps/worker/test/study.test.ts`

**Interfaces:**
- Produces: `AliasRepository.snapshot(releaseId)` whose resolver reuses one real alias-table read for any number of keys.
- Produces: `CardStateRepository.getMany(ctx, keys)` and `ReviewLogRepository.getMany(ctx, eventIds)`.
- Produces: `StudyService.resolvePresentedMany(session, presentedKeys)` returning ordered resolved cards plus the reusable alias snapshot.
- Consumes: Task 1's lower-cost authenticated middleware; grading response contracts remain unchanged.

- [ ] **Step 1: Write failing repository tests**

Add real SQLite tests for one alias snapshot resolving multiple keys, batched
card-state lookup preserving canonical keys, and batched review-log lookup
scoped to the authenticated user. Each test calls a missing method.

```ts
const snapshot = await aliases.snapshot("r-driver-2");
await expect(snapshot.resolveMany(["word-1", "word-2"])).resolves.toEqual(
  new Map([["word-1", "word-1"], ["word-2", "word-2"]]),
);
expect((await fx.cardStates.getMany(fx.alice, [fx.aliceCardKey, fx.bobCardKey]))
  .map((row) => row.contentCardKey)).toEqual([fx.aliceCardKey]);
expect((await fx.reviewLogs.getMany(fx.alice, [fx.bobEventId, fx.aliceEventId]))
  .map((row) => row.eventId)).toEqual([fx.aliceEventId]);
```

- [ ] **Step 2: Verify repository tests are red**

Run: `pnpm vitest run packages/db/test/driver.test.ts packages/db/test/isolation.test.ts`

Expected: FAIL because `snapshot`/`getMany` methods are absent.

- [ ] **Step 3: Implement the repository batch APIs**

Load all alias edges once into the existing validated walk, use one indexed
`IN` query for at most 50 card states/events, deduplicate inputs, and return
empty arrays for empty inputs.

- [ ] **Step 4: Write a failing grade orchestration test**

Extend the grade integration test to verify batch replay is correctly ordered
when event IDs are supplied out of database row order, and add a service test
that resolves two cards using one shared alias snapshot.

```ts
const service = new StudyService(fx.db, () => T0);
const session = await service.requireSession(fx.bob, created.body.session_id);
const resolved = await service.resolvePresentedMany(session, ["k-wm-1", "k-wm-2"]);
expect(resolved.items.map((item) => item.canonicalCardKey)).toEqual(["k-wm-1", "k-wm-2"]);
expect(resolved.items.every((item) => item.localWordKey === "w1")).toBe(true);
```

- [ ] **Step 5: Verify the grade test is red**

Run: `pnpm vitest run apps/worker/test/study.test.ts`

Expected: FAIL until grouped resolution and ordered batched replay are wired.

- [ ] **Step 6: Implement parallel grade preparation**

Start idempotency/session reads together without changing replay semantics;
load all presented definitions and one alias snapshot together; then load all
card states, active-card definitions, and word progress together. Reorder
batched repository results by request key. Keep the existing atomic write and
unique-event race fallback.

- [ ] **Step 7: Verify concurrency, aliases, undo, and full TypeScript tests**

Run: `pnpm vitest run apps/worker/test/study.test.ts apps/worker/test/review-concurrency.test.ts --repeat=10`

Expected: PASS on every repeat.

Run: `pnpm test`

Expected: all tests PASS.

Commit: `Reduce grading database round trips`

---

### Task 3: Track APAC placement and rollback operations

**Files:**
- Modify: `infra/wrangler/wrangler.toml.example`
- Create: `docs/runbooks/apac-resource-migration.md`
- Modify: `docs/runbooks/production-release.md`

**Interfaces:**
- Produces: tracked placement policy and exact source/target verification and rollback commands.
- Consumes: production-specific database ID, bucket name, and placement region only through git-ignored configuration.

- [ ] **Step 1: Add the documented placement policy**

Add `[placement] region = "gcp:asia-east1"` to the template as the mainland-
China-adjacent default, and document that production may select a closer
supported Asia cloud region after checking the new D1 `served_by_colo` value.

- [ ] **Step 2: Write the migration runbook**

Document preflight quotas, source export, APAC D1/R2 creation, one-shot import,
table/FK/object validation, binding cutover, placement verification, smoke,
latency sampling, and rollback. Commands must use shell placeholders, never
real IDs or credentials.

- [ ] **Step 3: Verify docs and config**

Run: `rg -n "lexiloop-apac|lexiloop-audio-apac|placement|foreign_key_check|rollback" docs/runbooks/apac-resource-migration.md infra/wrangler/wrangler.toml.example`

Expected: every required gate is present and no real production UUID appears.

Commit: `Document APAC production migration`

---

### Task 4: Verify, integrate, migrate, deploy, and measure production

**Files:**
- Modify locally only: git-ignored `infra/wrangler/wrangler.toml`
- Create locally only: private D1 export, R2 copy inventory, and benchmark logs

**Interfaces:**
- Consumes: Tasks 1-3 and the existing private production credentials.
- Produces: local `main` milestone, pushed `main`, APAC resource bindings, deployed Worker version, rollback IDs, and measured production evidence.

- [ ] **Step 1: Run pre-integration verification**

Run: `pnpm verify`

Expected: lint, typecheck, Vitest, and Python tests all PASS.

Run the production build and critical Playwright journeys from the documented
harness; both must PASS before resource creation or cutover.

- [ ] **Step 2: Review and integrate**

Review the full branch diff against the spec, fix Important findings through
RED/GREEN tests, merge into local `main`, and rerun the full suite on `main`.

- [ ] **Step 3: Create and populate APAC resources**

Record source usage/bookmark/counts; export `lexiloop`; create
`lexiloop-apac --location=apac`; import the complete export once. Create
`lexiloop-audio-apac --location=apac` and copy only the source bucket.

- [ ] **Step 4: Validate before cutover**

Compare every D1 table count, run `PRAGMA foreign_key_check`, verify the active
release and critical user-state counts, and compare R2 object count plus total
bytes. Any mismatch stops the cutover.

- [ ] **Step 5: Switch Worker placement and bindings**

Update only the ignored LexiLoop Wrangler config to the new D1 ID, new R2
bucket, and chosen APAC placement region. Build, deploy, and capture the Worker
version. Leave old resources intact.

- [ ] **Step 6: Smoke and benchmark**

Verify security headers, login, session creation, content, cached audio, one
grade plus undo, and logout. Tail structured logs to confirm placement and D1
region. Record five grade/undo timings and compute medians.

- [ ] **Step 7: Push milestone**

Push the verified local `main` commit. Report commit, Worker version, source and
target regions, quota deltas, row/object validation, test totals, and latency
before/after without exposing private data.
