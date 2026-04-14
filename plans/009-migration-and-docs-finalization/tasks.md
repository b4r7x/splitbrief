# 009 — Migration and Docs Finalization — Tasks

## Phase 1 — Migration module

### T001 — Create `src/cli/commands/migrate.ts`

Commander subcommand `migrate`. Handler performs detection + migration per `spec.md` FR-001.

Colocated test (`migrate.test.ts`) using a fixture directory under `testing/fixtures/legacy-diptych-current/` that contains a pre-redesign state.

### T002 — Register `migrate` in CLI

**File:** `src/cli.ts`

Add `registerMigrateCommand(program)` call alongside other subcommand registrations.

### T003 — Auto-trigger `maybeMigrate` in start + resume

**Files:** `src/cli/commands/start.ts`, `src/cli/commands/resume.ts`

Call `maybeMigrate(projectDir)` before the existing logic. `maybeMigrate` is a thin wrapper around the migration function that no-ops if nothing to migrate.

### T004 — `deriveSessionId` helper

**File:** `src/cli/commands/migrate.ts` private helper

Generates an id from legacy state's `feature` + `startedAt`. Handles collision with `-migrated` suffix. Unit test covers normal and collision cases.

### T005 — `migrateState` helper

**File:** same module

Transforms legacy `WorkflowState` shape to current. Adds `awaitingContinue`, `messageQueue`, renames `sessionId` → `plannerSessionId`, bumps `stateVersion`.

### T006 — `migrateEvents` helper

**File:** same module

Transforms `events.jsonl` → `session.jsonl`. Adds `kind: 'event'` to lines missing it. Handles corrupt lines with a warning log.

### T007 — Migration fixture + full test

**File:** `testing/fixtures/legacy-diptych-current/`

Checked-in fixture: valid pre-redesign state plus events log. Test runs full migration, asserts:
- New session folder created.
- `state.json` has correct new shape.
- `session.jsonl` has transformed entries.
- `.diptych/active` points at new session-id.
- `.diptych/current/` is removed.

## Phase 2 — Documentation sweep

### T008 — README overhaul

**File:** `README.md`

Per `plan.md` → "README overhaul". Six numbered bullet points. Run each through a test-usability check: copy-paste an example command and verify it works on a smoke install.

### T009 — CHANGELOG entry

**File:** `CHANGELOG.md` (create if absent)

Template per `plan.md`. Fill in the `[Unreleased]` block with concrete bullets.

### T010 — Update `CLAUDE.md`

Review the entire file. Confirm:
- Project structure tree matches the current `src/` layout (should already be mostly right from the rename agent).
- Quick Context bullets reference the new session storage model.
- No residual `current/` / `events.jsonl` / `tiny-spec`.

### T011 — Update `AGENTS.md`

Shorter file. Confirm the same.

### T012 — Update `.specify/memory/constitution.md`

If this file references old storage model or old concepts, update. Likely minimal changes; it's a high-level principles doc.

### T013 — Update `docs/FUTURE.md`

Verify every FUTURE entry is still future. If any were implemented in 001–008, remove.

### T014 — Optional: rename skill files

**Files:** `.claude/skills/tiny-spec-dev.md` → `.claude/skills/diptych-dev.md`; same for `.claude/commands/`.

Propose this as an optional step — consult with the user before renaming because skills may be referenced by name elsewhere. If approved, do the rename + update any discovery logic that looks for the old filename.

## Phase 3 — Open-questions cleanup

### T015 — Trim `docs/WORKFLOW.md` Part 2

Per `plan.md` → "docs/WORKFLOW.md Part 2 cleanup". Delete or move each entry. Result: Part 2 should be either empty or contain only ≤3 genuinely open questions.

### T016 — Verify Part 3 "See also" links work

**File:** `docs/WORKFLOW.md` Part 3

Confirm every link points to an existing file. Update FUTURE.md link if sections were added.

## Phase 4 — Grep sweep

### T017 — Run grep sweep

Run the grep commands from `plan.md` → "Grep sweep". For each match, either fix in place or confirm it's a deliberate reference in historical content (CHANGELOG, migration code).

### T018 — Final test suite

`npm test` — all 700+ tests pass.

### T019 — Manual smoke

Sanity checks:

- `diptych init` → new user flow.
- `diptych start "add email validator"` → session created, new layout.
- Mid-run: queue a message, continue.
- Ctrl-C once → awaiting-continue. Type → enqueued. Enter → continue.
- Ctrl-C twice → exit.
- `diptych resume` → picks up.
- `/revise-spec` / `/revise-plan` / `/redo-task 1` — all work.
- `diptych migrate` on a legacy fixture — migrates cleanly.

## Phase 5 — Doc Sync (meta)

### T020 — Record the completion

This final spec ships. Summary of the whole roadmap:

- 001 Capability matrix ✓
- 002 Session storage restructure ✓
- 003 Session jsonl log ✓
- 004 Persist planner session id ✓
- 005 Abort + continuation ✓
- 006 Soft rewind commands ✓
- 007 Queue mid-phase ✓
- 008 Clarifications via queue ✓
- 009 Migration + docs finalization (this spec) ✓

After this spec, `plans/README.md` is updated (optionally) with a pointer to historical commit hashes or tags per spec.
