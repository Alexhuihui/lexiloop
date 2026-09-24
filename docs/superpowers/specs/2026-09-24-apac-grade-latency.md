# APAC Grade Latency Design

## Goal

Reduce the production latency of `POST /api/reviews/grade` and the grouped
`POST /api/reviews/grade-batch` path while keeping grading authoritative,
idempotent, alias-aware, undoable, and atomic. Move only LexiLoop's Cloudflare
resources closer to users in mainland China.

## Approved scope

- Optimize authenticated request resolution so one joined read returns the
  session and user, and avoid writing `last_used_at` more than once per five
  minutes for a continuously active session.
- Batch and parallelize independent grade reads. A grade must still validate
  the current session position, pinned-release card, current alias graph,
  FSRS state, word progress, and active word cards before one atomic write.
- Optimize both single-card and grouped same-word grading.
- Create a new `lexiloop-apac` D1 database with an APAC location hint and
  migrate the current LexiLoop database in one full import. The user explicitly
  approved a one-shot import instead of a multi-day staged import.
- Create `lexiloop-audio-apac`, copy only `lexiloop-audio`, validate every
  LexiLoop object, and switch only LexiLoop's `AUDIO` binding.
- Place only `lexiloop-worker` in an explicit Asia cloud region selected after
  observing the new D1 database's serving location.
- Keep the old WNAM D1 database and R2 bucket unchanged as rollback targets.
- Commit, merge to local `main`, push `main`, deploy production, and run online
  smoke and repeated latency measurements.

## Constraints

- Cloudflare Free limits are account-wide: 5 million D1 rows read/day,
  100,000 D1 rows written/day, 10 GB-month R2 Standard storage, 1 million R2
  Class A operations/month, and 10 million R2 Class B operations/month.
- Record D1 usage before and after import. Fail closed if Cloudflare reports a
  quota error; do not delete the source database.
- Do not expose credentials, cookies, CSRF tokens, private object keys, or
  textbook content in Git, logs, or the final report.
- Production configuration remains git-ignored. Tracked configuration contains
  placeholders or non-secret placement policy only.
- No optimistic client-side success: the rating control may show immediate
  pressed/pending feedback, but the next card appears only after the server
  confirms the atomic grade.

## Acceptance

- Auth validity semantics remain unchanged for missing, revoked, expired,
  disabled, and session-version-mismatched sessions.
- A fresh authenticated request touches `last_used_at`; another request within
  five minutes does not write it again; a request at or after five minutes does.
- Single and batch grade tests retain queue validation, alias activation and
  rollback behavior, replay behavior, first-introduction transition, and undo.
- The full automated suite, typecheck, lint, Python tests, production build,
  and Playwright critical journeys pass.
- APAC D1 table counts, foreign-key check, active release, users, progress,
  sessions, reviews, and FTS counts match the source at the cutover snapshot.
- APAC R2 object count and total bytes match the source.
- Alice can log in after cutover; one fresh grade and its undo succeed; audio
  returns the expected immutable caching headers.
- Production logs confirm the Worker placement and APAC D1 serving region.
- Five fresh grade/undo samples are recorded. The target is Worker grade p50
  below 1 second and client-observed grade p50 below 2 seconds; actual measured
  values are reported without hiding a miss.

