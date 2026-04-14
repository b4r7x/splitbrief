# 009 — Migration and Docs Finalization — Plan

## Migration module

**New file:** `src/cli/commands/migrate.ts`

Registers a `migrate` subcommand on commander. Handler per `spec.md` FR-001.

### Auto-trigger in `start` / `resume`

**Files:** `src/cli/commands/start.ts`, `src/cli/commands/resume.ts`

Before their existing logic, call `maybeMigrate(projectDir)` from the migration module. That function:

1. If `.diptych/current/` exists and `.diptych/active` does not, run full migration.
2. Else: no-op.

### Session-id derivation for legacy state

**File:** `src/cli/commands/migrate.ts` → private helper

```ts
function deriveSessionId(state: LegacyWorkflowState): string {
  const date = new Date(state.startedAt).toISOString().slice(0, 10);
  const slug = slugify(state.feature).slice(0, 50);
  return `${date}-${slug}`;  // collision unlikely for migration — single entry
}
```

If the derived id collides with an existing folder (shouldn't, since we're migrating to a fresh state), suffix `-migrated`.

### State schema upgrade

**File:** `src/cli/commands/migrate.ts` → helper `migrateState(old: LegacyState): CurrentState`

```ts
function migrateState(old: LegacyWorkflowState): WorkflowState {
  return {
    ...old,
    stateVersion: CURRENT_STATE_VERSION,     // bumped
    plannerSessionId: old.sessionId ?? null, // renamed
    awaitingContinue: false,                  // new
    messageQueue: [],                          // new
  };
}
```

Drop the old `sessionId` field to avoid confusion.

### events.jsonl → session.jsonl transform

**File:** same module, helper `migrateEvents(input: path, output: path): void`

Read `events.jsonl` line by line. For each valid JSON line, add `kind: 'event'` if missing. Write to new path. Skip corrupt lines with a warning.

## Documentation finalisation

### README overhaul

**File:** `README.md`

Largely still reflects the old model after the rename agent pass. Needs targeted edits:

1. Update the "Quick start" section with the new session-folder layout example.
2. Add a "Interaction during a run" section showing Ctrl-C, queue, continue flows.
3. Add a "Commands" table entry for `/revise-spec`, `/revise-plan`, `/redo-task`, `/queue show`, `/queue clear`.
4. Add a "Configuration" sub-section showing `workflow.persistTranscript` and `capabilities` override for shell/agent.
5. Add a "Capability matrix" short note linking to `docs/ARCHITECTURE.md`.
6. Verify every `diptych …` command example matches actual CLI.

### CHANGELOG

**New file (if absent):** `CHANGELOG.md`

Entry for version bump. Sample skeleton:

```md
## [Unreleased]

### Breaking

- `.diptych/current/` removed; each session lives in its own folder at `.diptych/sessions/<id>/`. State schema bumped to v3.
- `events.jsonl` renamed to `session.jsonl`; entries now tagged with `kind: "event" | "message"`.
- `sessionId` on `WorkflowState` renamed to `plannerSessionId`.

### Added

- `diptych migrate` command for upgrading pre-v3 state.
- `PlannerCapabilities` struct declares backend features; `shell`/`agent` kinds support config override.
- Ctrl-C interaction model: single-press aborts current turn; double-press exits workflow.
- `workflowStore.messageQueue` for non-destructive mid-phase user messages; parallel native-session injection for Claude Code / agent-sdk.
- Slash commands `/revise-spec`, `/revise-plan`, `/redo-task`, `/queue show`, `/queue clear`.
- `workflow.persistTranscript` config option (default true).

### Fixed

- Clarification answers now reach the live planner session on capable backends (closes long-standing gap where answers only affected the next call).
```

### CLAUDE.md + AGENTS.md

**Files:** `CLAUDE.md`, `AGENTS.md`

- Update "Project structure" tree.
- Confirm "Active technologies" block is accurate.
- Remove or update any reference to old storage paths.

### Skills + commands

**Files:** `.claude/skills/tiny-spec-dev.md`, `.claude/commands/tiny-spec-dev.md`

Rename the file names to `diptych-dev.md` (optional, owner's call — propose in T014). Update content to reflect new layout.

### docs/WORKFLOW.md Part 2 cleanup

**File:** `docs/WORKFLOW.md`

After all specs implemented, reread Part 2 line by line. Delete entries covered by specs 001–008. Keep / move as applicable:

- "Queue prompt format" — covered by 007 (resolved). Delete.
- "Mid-stream injection UX on Claude Code" — partially covered by 007, but visual separator UX may remain open. Move to FUTURE if needed.
- "Transcript compaction" — keep (still open, covered by FUTURE.md).
- "Failure semantics of parallel mid-stream dispatch" — covered by 007 (silent degrade). Delete.
- "`diptych status` for an aborted session" — covered by 005. Delete.

After cleanup, Part 2 should have ≤3 entries or none.

## Grep sweep

Run from repo root:

```
grep -rn "tiny-spec\\b" src/ docs/ README.md CLAUDE.md AGENTS.md .claude/ | grep -v CHANGELOG
grep -rn "\\.tiny-spec\\b" src/ docs/ README.md | grep -v CHANGELOG
grep -rn "events\\.jsonl\\|EVENTS_FILE" src/ docs/
grep -rn "/current/" src/ docs/
grep -rn "\\bsessionId\\b" src/core/types/ | grep -v sessions/
```

Every hit is a bug. Fix in place.

## Dependencies

**Depends on:** 001–008 all merged.

**Consumed by:** nothing. This is the terminal spec.

## Risk

- **Partial migrations on crash.** If `diptych migrate` is interrupted mid-move, state can be inconsistent. Mitigation: migration writes to a temp folder, then atomically renames to final location. If temp exists on startup, retry.
- **Incomplete doc sweeps.** Humans miss things. Add a grep-based CI check (or a pre-commit hook, already exists for git commits but not for this) in a follow-up.
- **Skill file rename.** Renaming `.claude/skills/tiny-spec-dev.md` → `diptych-dev.md` may break references elsewhere (other repo metadata, user machines). Offer this as optional in T014 and gate it on owner's choice.

## Success verification

- Manual: create a fixture `.diptych/current/` with a valid v2 state → run `diptych migrate` → verify new `.diptych/sessions/<id>/` with correct state.json.
- Manual: `diptych start` on an untouched directory with no `.diptych/` → works normally.
- Manual: grep sweep returns zero.
- All tests pass.
- README command examples copy-pastable and working.
