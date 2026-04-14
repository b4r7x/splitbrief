# 009 — Migration and Docs Finalization

## Problem

After specs 001–008 land, any user with an existing `.diptych/current/` directory (or even older `.tiny-spec/current/` from before the rename) can no longer use diptych — the new code paths read `.diptych/sessions/<id>/` and `.diptych/active` and will not find anything.

In addition, the state schema version bumps to 3 (from 004's renaming and from 005's `awaitingContinue` addition). Old `state.json` files produced by pre-redesign diptych cannot be loaded by the new code.

Finally, the docs (`README.md`, `CHANGELOG` if any, `CLAUDE.md`, `AGENTS.md`) and any inline comments may still reference deprecated paths or symbols introduced during the rename. A cleanup pass is needed.

## Goal

Provide a one-shot migration path for existing on-disk state, a clear upgrade story for users, and a final pass across all docs + changelog to ensure the post-redesign reality is accurately reflected everywhere. This spec ships last.

## User stories

- **As an existing user who had `.diptych/current/` from a pre-redesign version**, I run `diptych migrate` (or simply `diptych start` / `diptych resume`) and my old state is moved to the new folder layout without data loss.
- **As a new user reading the README**, every command and path shown matches what the current code does.
- **As an AI agent reading `docs/WORKFLOW.md` Part 2**, "Still open" questions reflect only what remains genuinely open, not what specs 001–008 already resolved.

## Functional requirements

**FR-001.** New CLI command `diptych migrate`:
  1. Detect `.diptych/current/` (or legacy `.tiny-spec/current/`). If absent, exit with "nothing to migrate".
  2. Read `.diptych/current/state.json`, derive a session-id from the state's `feature` field + the original `startedAt` date.
  3. Create `.diptych/sessions/<derived-id>/`.
  4. Move the `state.json`, any `events.jsonl`, and `spec.md`/`plan.md`/`tasks.md` into the session folder.
  5. If `events.jsonl` exists and state-version allows, rename to `session.jsonl` and migrate entries (add `kind: 'event'` to each existing line — today's lines lack that discriminator).
  6. Migrate `state.json` to the new schema:
     - rename `sessionId` field to `plannerSessionId`.
     - add `awaitingContinue: false`.
     - add `messageQueue: []`.
     - bump `stateVersion` to current.
  7. Create or update `.diptych/active` to point at the new session folder.
  8. Remove the now-empty `.diptych/current/` directory.
  9. Print a summary: `Migrated <session-id>. Run 'diptych resume' to continue.`

**FR-002.** `diptych start` and `diptych resume` auto-trigger migration on first run if they detect a stale `.diptych/current/`. One-time only; subsequent runs skip.

**FR-003.** Legacy flat summary files `.diptych/sessions/<uuid>.json` (from pre-redesign) are *not* migrated to folders. They are readable for historical reference; `diptych sessions` (if built) can list them alongside new-format sessions. Not in scope for this spec to render them.

**FR-004.** `docs/WORKFLOW.md` Part 2 "Still open" is reviewed and trimmed. Items resolved by specs 001–008 are removed. Remaining items are: whatever genuinely remains uncertain after implementation (e.g., transcript compaction, long-session handling — these go to `docs/FUTURE.md` if they belong there).

**FR-005.** `README.md` is updated end-to-end:
  - Session folder layout example (new `.diptych/sessions/<id>/`).
  - Interaction model (Ctrl-C, queue, continue).
  - Any config examples showing `workflow.persistTranscript`.
  - Capability matrix mention with link to docs.
  - New slash commands (`/revise-spec`, `/revise-plan`, `/redo-task`, `/queue show`, `/queue clear`).

**FR-006.** `CHANGELOG.md` entry added (file may not exist — create if needed). Bullets describing breaking changes (state schema v3, storage layout), new features (queue, rewind commands, mid-stream injection on Claude Code), and migration path.

**FR-007.** `CLAUDE.md` updated: the "Project structure" tree matches current reality. Any bullet in "Quick Context" referencing the old storage model updated.

**FR-008.** `AGENTS.md` reviewed. If it points at concepts that changed (session storage, event logging), update.

**FR-009.** `.claude/skills/tiny-spec-dev.md` / `.claude/commands/tiny-spec-dev.md` reviewed. If any reference old paths / commands, update. Consider renaming the skill file to `diptych-dev.md` for consistency.

**FR-010.** Grep sweep across `src/` and `docs/`:
  - Residual `tiny-spec` references (from incomplete rename) → fixed.
  - Residual `current/` references → fixed.
  - Residual `events.jsonl` references → fixed.
  - Residual `sessionId` (on WorkflowState) that should be `plannerSessionId` → fixed.

**FR-011.** `docs/FUTURE.md` reviewed. Ensure every entry still belongs there (nothing accidentally implemented in 001–008). If a FUTURE entry was actually covered, move it out.

## Success criteria

- A fresh clone + fresh pre-redesign `.diptych/current/` fixture can be migrated via `diptych migrate` to the new layout without data loss.
- `diptych start` works on a pristine install.
- `grep -rn "tiny-spec\\|\\.tiny-spec\\b\\|events\\.jsonl\\|/current/" src/ docs/ README.md CLAUDE.md AGENTS.md` returns zero meaningful matches (only intentional references in `CHANGELOG.md` and migration code).
- README examples run without errors.
- All tests pass including new migration tests.
- `docs/WORKFLOW.md` Part 2 contains only genuinely open items.

## Non-goals

- Reverse migration (new layout → old layout). One-way.
- Migration for pre-v1 states older than the rename. If state-version is something we no longer support, print a clear "please start fresh" error.
- Renaming GitHub repo (`tiny-spec` → `diptych`). Out of scope for code; owner handles manually.
- Deleting old session folders or garbage collection.
- Re-running all tests by hand to verify doc accuracy. Tests plus spot-checks suffice.
