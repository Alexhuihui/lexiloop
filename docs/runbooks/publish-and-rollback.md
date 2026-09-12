# Runbook: publishing and rolling back content releases

How to take a fully-compiled work directory from immutable bundle (spec 5.9)
to ACTIVE release — and back — without ever touching user learning state
(spec 6.4/11.3/17).

Everything below runs from the repo root. `<source-hash>` is the SHA-256 of
the source PDF; bundles live under the git-ignored
`.lexiloop-private/releases/<release-id>/` and are never committed. Real
audio files stay in `.lexiloop-private/work/<source-hash>/`.

## The lifecycle

```text
compile (`pnpm compiler run`)          13/13 stages PASSED in the ledger
  -> release package                   immutable bundle (manifest.json is the root of trust)
  -> release verify                    re-hash every manifest-declared file
  -> release stage                     audio -> private R2 (content-addressed, idempotent),
                                       D1 import of an INACTIVE release (IMPORTING; app_meta untouched)
  -> release smoke                     pre-activation checks; IMPORTING -> VALIDATING -> READY
                                       (any failure -> FAILED, pointer unchanged)
  -> release activate [--aliases ...]  THE ONLY pointer writer; READY -> ACTIVE,
                                       previous ACTIVE -> RETIRED (retained for rollback)
  -> release rollback                  re-activate a RETIRED release; presents the older keys again
```

Statuses only ever move forward along
`DRAFT -> IMPORTING -> VALIDATING -> READY -> ACTIVE -> RETIRED | FAILED`.
There is no `--force` flag and no manual status override: a release that
fails verification or smoke stays inactive and the previous release stays
ACTIVE.

## Packaging and verification

```bash
pnpm compiler release package --source-hash <source-hash> \
  [--previous-release <release-id>] [--metadata release-meta.json]
pnpm compiler release verify --bundle .lexiloop-private/releases/<release-id>
```

`release package` runs the same `RELEASE_PACKAGE` stage as the pipeline and
therefore refuses to run unless all 13 stage ledger entries are PASSED with
matching upstream provenance and the packaged artifacts (normalized content,
cards, audio manifest, inspection) still hash to the recorded ledger outputs
(a stale or hand-edited work directory is refused with RELEASE_INPUT_STALE),
every target Unit's
deterministic validation report is PASSED (a BLOCKED unit can never enter a
release), and 100% of the audio manifest's assets exist with matching hashes
and gate results. The bundle contains exactly:

```text
manifest.json               SHA-256 + byte size of every other file
d1/001-content.sql          release-scoped content rows (deterministic order)
d1/002-cards.sql            card definitions
d1/003-search.sql           FTS integrity pass (index is trigger-synced)
r2/audio-manifest.jsonl     the validated audio artifact, verbatim
qa/unit-status.json         sanitized per-unit status (no source text)
qa/validation-summary.json  finding statistics (codes/severities only)
rollback.json               rollback metadata + compatibility demands
```

Provenance inside the bundle keeps only private hash references
(`source_raw_ref_hash`, page, bbox) — the full OCR/source text never leaves
`.lexiloop-private/`. Packaging is deterministic: the same compiled inputs
produce byte-identical bundles and the same content-derived release id.

`release verify` re-hashes every file the manifest declares. Run it after any
copy/move of a bundle; staging re-verifies automatically and refuses a broken
bundle.

## Staging, smoke, activation, rollback

```bash
tsx scripts/publish-release.ts \
  --bundle .lexiloop-private/releases/<release-id> \
  --db .lexiloop-private/d1/rehearsal.sqlite \
  --r2-dir .lexiloop-private/r2 \
  [--aliases aliases.json] [--no-activate]
```

The script wires a D1-shaped SQLite database and a content-addressed
directory R2 store and runs verify -> stage -> smoke -> activate in one
fail-closed pass. What is faithful about the rehearsal: the exact D1 schema
and migrations, the activation semantics (activation composes ONE atomic
statement batch on BOTH drivers — `batch()` on real D1, a single transaction
on the local SQLite driver), and the content-addressed R2 object semantics.
What is NOT faithful: nothing here touches the remote Cloudflare bindings —
there is no `--remote` path yet. Wiring these commands to the real D1/R2
resources is future work (Task 19's Cloudflare step); until then the
rehearsal runs entirely against local files.
`--no-activate` stops after READY (the old release remains ACTIVE);
`--rollback <release-id>` re-activates a RETIRED release instead.

The same steps are available individually through the CLI with injected
dependencies (`release stage|smoke|activate|rollback` fail closed without
D1/R2 wiring):

```bash
pnpm compiler release stage --bundle <bundle-dir>     # IMPORTING; app_meta untouched
pnpm compiler release smoke --release <release-id>    # VALIDATING -> READY | FAILED
pnpm compiler release activate --release <release-id> [--aliases aliases.json]
pnpm compiler release rollback --release <retired-release-id>
```

Guarantees:

- **Alias conflicts are caught at activation.** Declared edges are validated
  against the union of already-stored migrations, so a second activation that
  would make any key ambiguous (one-to-many/many-to-one across releases,
  cycles, drifting canonical roots) fails with the alias rejection — never
  post-activation.
- **Inactive import.** `stage` never writes `app_meta`; the release is
  readable/verifiable in D1 while the previous release keeps serving.
- **Pre-activation checks (spec 17).** `smoke` verifies release_unit totals
  against content rows, zero orphan foreign keys, FTS/content parity, and
  that every audio asset is gate-passed and present in R2. Any failure marks
  the release FAILED.
- **Atomic activation.** `activate` imports validated alias edges and
  switches `active_release_id` as ONE statement batch — `batch()` on D1
  (its only atomic primitive: D1 rejects interactive
  BEGIN TRANSACTION/COMMIT/SAVEPOINT), one transaction on the local driver;
  any failure leaves user state, statuses, and the pointer unchanged. Only
  READY may activate.
- **User state is never rewritten.** Activation and rollback touch only
  release rows and the `app_meta` pointer — never `word_progress`,
  `card_state`, or `review_log`. Pinned sessions keep presenting old keys;
  grading/undo resolve them to the same canonical state.

## Alias migration (spec 5.5/6.4)

Stable keys change only through explicit, typed alias edges
`{ entity_type: "word" | "card", from_release_id, from_key, to_release_id,
to_key, canonical_key }`. Prepare them in a JSON file:

```json
{ "version": 1, "edges": [ {
    "entity_type": "word",
    "from_release_id": "<new-release-id>", "from_key": "<new-key>",
    "to_release_id": "<old-release-id>", "to_key": "<old-key>",
    "canonical_key": "<root-key-user-state-references>"
} ] }
```

Activation validates the whole set before anything is written and rejects:
malformed/duplicate/self edges (`ALIAS_EDGE_INVALID`, `ALIAS_DUPLICATE_EDGE`,
`ALIAS_SELF_REFERENCE`), fan-out/fan-in (`ALIAS_ONE_TO_MANY`,
`ALIAS_MANY_TO_ONE`), cycles (`ALIAS_CYCLE`), a canonical root that is not
the component sink (`ALIAS_CANONICAL_MISMATCH`), mismatched entity types
(`ALIAS_TYPE_CONFLICT`), endpoints missing from their declared releases
(`ALIAS_END_MISSING`), and existing user state under any component key other
than the canonical root (`ALIAS_STATE_COLLISION`) — that state would collapse
into one root.

Resolution is bidirectional and release-aware: whether an old release
presents a renamed key or a new release merges into an older canonical root,
`(release_id, presented_key)` resolves to the single canonical key user state
is keyed by. Rollback needs no new edges — the older release simply presents
the older keys again, resolving to the same canonical roots.

## When something fails

- **verify fails** (`BUNDLE_VERIFY_FAILED`): the bundle changed after
  packaging. Never hand-edit bundle files; re-run `release package`.
- **smoke fails** (`SMOKE_FAILED`): the failing check names are printed
  (`check FAIL <name>`). The release is FAILED and the old release is still
  ACTIVE. Fix the compile (re-run the pipeline) and re-package; a FAILED
  release is never re-admitted.
- **activate fails** (`RELEASE_NOT_READY`, `ALIAS_*`, `ACTIVATION_FAILED`):
  nothing was activated. Fix the reported condition and re-run; re-activation
  after a rollback re-imports identical alias edges idempotently.
- **Rollback**: `release rollback --release <retired-id>` (or
  `--rollback` on the script). The retired release becomes ACTIVE again, the
  undone one becomes RETIRED, and both presentations keep resolving to the
  same canonical user state.
