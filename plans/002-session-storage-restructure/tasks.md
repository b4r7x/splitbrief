# 002 — Session Storage Restructure — Tasks

Atomic tasks in execution order. Do not commit or stage.

## Phase 1 — New modules

### T001 — Create `src/core/sessions/id.ts`

Export `generateSessionId(projectDir, feature, now?)` and private `slugify` + `findUniqueId` helpers per `plan.md` → Data model → "Session-id generation". Include unit tests (colocated `id.test.ts`) for:

- `"Add email validator"` → `2026-04-14-add-email-validator` (fixed date)
- Collision produces `-2`, `-3` suffix
- Non-alphanumeric characters (Polish diacritics, emojis) reduced to `-`
- Slug truncated at 50 chars
- Throws if 999 collisions exhausted

### T002 — Create `src/core/sessions/active.ts`

Export `readActive`, `writeActive`, `clearActive`, `isSessionLive` per `plan.md`. Use `src/utils/fs.ts` helpers (`writeSecureFile`, secure mode) for consistency. Colocated tests:

- `writeActive` + `readActive` round-trip
- `readActive` on missing file returns `null`
- `isSessionLive` returns `false` for non-existent session, `false` for session in `complete` phase, `true` for session in `implementing` phase

## Phase 2 — Paths rewrite

### T003 — Rewrite `src/core/paths.ts`

Remove `CURRENT_DIR` constant and anything under it. Add `ACTIVE_FILE` constant, `diptychDir`, `activeFile`, `sessionsRoot`, `sessionDir` functions per `plan.md`. Keep `STATE_FILE`, `EVENTS_FILE`, `SPEC_FILE`, `PLAN_FILE`, `TASKS_FILE` constants — they stay file-name-only.

### T004 — Rewrite `src/core/paths-io.ts`

- Delete `currentDir(projectDir)` and any reference to it.
- Add `ensureSessionDir(projectDir, sessionId)` that `mkdir -p` with secure mode.
- Every helper that today takes `projectDir` and uses `currentDir` now takes `projectDir, sessionId` and uses `sessionDir`.
- Keep `ensureTinySpecDir` if it still exists from old name — rename to `ensureDiptychDir` if not yet done.

### T005 — Update `src/core/state/persistence.ts`

`saveState`, `loadState`, `appendEvent` now take `sessionId: string`. Resolve paths through `sessionDir(projectDir, sessionId)`. All callers fail to typecheck — update them in subsequent tasks.

### T006 — Update `src/core/sessions/io.ts`

- Delete `getSessionDir('project', projectDir)` helper that returns `.diptych/sessions/` root — replace with direct use of `sessionsRoot`.
- Rename `saveSession(dir, session)` → `saveSummary(projectDir, sessionId, summary)`. Writes `sessions/<id>/summary.json`.
- Keep `loadSessions(projectDir)` for listing but update it to read subfolders (each with `summary.json`) instead of flat `*.json` files.

## Phase 3 — Engine + CLI wiring

### T007 — Add `sessionId` to `WorkflowContext`

**File:** `src/engine/orchestrator/run.ts`

Extend the type (lines 26-35) with `sessionId: string`. Thread it through: `initializeWorkflow` receives `sessionId` as an argument (no longer derives it), passes it into `WorkflowContext`.

### T008 — Thread `sessionId` through orchestrator event emission

**Files:** `src/engine/orchestrator/events.ts`, `src/engine/orchestrator/helpers.ts`, and any other module calling `appendEvent(projectDir, ...)`.

Change the signature so callers pass `sessionId` alongside `projectDir`. The `WorkflowContext` is the source; read from there.

### T009 — Update `src/cli/commands/start.ts`

Add the lock check + session creation flow per `plan.md`. Fail early if an active session is live. On success, write `.diptych/active`, create `sessionDir`, pass `sessionId` through to `runWorkflow`.

### T010 — Update `src/cli/commands/resume.ts`

Per `plan.md`: read `.diptych/active`, fail if absent; load state from `sessions/<active>/state.json`; keep remaining flow.

### T011 — Update `src/cli/commands/status.ts`

Read `.diptych/active`. If absent, print "no active session" and exit 0. Otherwise, load state, print phase/progress/tokens. Do not take the lock.

### T012 — Update `src/cli/commands/spec.ts`

Same session creation as `start` (FR-004 applies). Exit after planning phases write artifacts.

## Phase 4 — End-of-run + cleanup

### T013 — Write `summary.json` into session folder

**File:** `src/engine/orchestrator/run.ts`

In `saveFinalSession` (currently ~lines 219-234), change the saved path from `sessions/<uuid>.json` (flat file) to `sessions/<sessionId>/summary.json`. Use the new `saveSummary` helper (T006).

### T014 — Clear `.diptych/active` on run end

**File:** `src/engine/orchestrator/run.ts` and `src/engine/orchestrator/final-review.ts` `shutdownWorkflow`

After writing the summary, call `clearActive(projectDir)`. Do this for all three outcomes: complete, interrupted, failed.

### T015 — Delete archive module

**Files:** `src/utils/fs.ts` (archive helpers), any CLI command that references archive.

Search for `archive` / `ARCHIVE` in `src/` and delete the archiving logic. Archive was `copy current → archive/`; with sessions folder per session, nothing needs archiving. If any CLI-visible command referenced archive listing, remove that too and note in the spec 009 task list.

## Phase 5 — Test updates

### T016 — Update tests using `.diptych/current/`

Grep test files for `current/` or `currentDir` usage. Every test fixture must migrate to `sessions/<id>/`. Introduce a test helper `makeTestSession(projectDir, feature?)` in `testing/` that creates a session folder with a known id and returns `{ projectDir, sessionId }`.

### T017 — Update tests using flat `sessions/*.json` summaries

Similarly grep for `sessions/.*\\.json` patterns in tests. Update to `sessions/<id>/summary.json`.

### T018 — Add concurrency-lock test

**File:** `src/cli/commands/start.test.ts` (or equivalent)

Test case: given a fake session in `implementing` phase with `.diptych/active` set, calling the start handler throws a `cliError` containing "already running".

### T019 — Run full test suite

`npm test`. Expect all tests to pass. If tests fail for reasons other than the rename (e.g., pre-existing issues noted by the rename agent), document them as known issues in the spec and move on; do NOT fix unrelated tests in this spec.

## Phase 6 — Doc Sync

### T020 — Update `docs/CONCEPTS.md` §"Artifacts on disk"

Confirm the on-disk layout diagram matches the implemented code. The `session.jsonl` line may still be a placeholder — that's added by spec 003. Add a note "`session.jsonl` introduced by spec 003" if helpful.

### T021 — Update `docs/ARCHITECTURE.md` §"Persistence" and §"Entry points"

Confirm the tables match the implemented behaviour. Specifically:

- Entry points table describes `.diptych/active` lock correctly.
- Persistence table lists `state.json`, `summary.json`, `spec.md`/`plan.md`/`tasks.md` under `.diptych/sessions/<id>/` — same as the code.
- "Concurrency model" paragraph is unchanged (still accurate).

### T022 — Update `docs/WORKFLOW.md` §1.4 Persistence timing

Table currently lists write targets using new session folder paths — verify implementation matches. If a row was added in `plan.md` but skipped in code, fix that code.
