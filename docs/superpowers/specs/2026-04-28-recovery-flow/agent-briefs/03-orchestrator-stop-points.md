# 03 - Worker Brief: Orchestrator Stop Points

Guard: Use this brief only for a future source implementation pass; do not execute it during docs-only pack maintenance.

You are wiring recovery issue creation into safe orchestrator stop points for diptych / tiny-spec.

Run this brief after `01-recovery-state.md` and `02-issue-builders.md` have landed. Do not implement user-selected action handlers beyond preserving the pending issue and stopping safely.

## Mission

Make the engine stop with a persisted `RecoveryIssue` whenever execution cannot safely proceed, instead of silently advancing, overwriting user edits, or calling an implementer that cannot fit the task.

## Required Reading

- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/spec.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/decisions.md`
- recovery schema/state files from brief 01
- recovery issue builders from brief 02
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/budget.ts`
- `src/engine/orchestrator/escalation/*`
- `src/engine/orchestrator/user-edit-conflicts.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/events.ts`

## Write Ownership

You may edit only these source areas:

- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/budget.ts`
- `src/engine/orchestrator/events.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/user-edit-conflicts.ts`
- `src/engine/orchestrator/escalation/*`
- recovery builder files from brief 02 only for gaps discovered while wiring stop points
- tests colocated with the files above

Do not edit TUI files in this brief. Do not implement planner split/rebase, skip, retry, route-bigger, pause, or abort handlers beyond creating and preserving pending recovery.

## Required Behavior

- Create a recovery issue before worker dispatch when no implementer profile can safely fit the task.
- Create a recovery issue after retry exhaustion or failed escalation instead of silently failing or advancing the run.
- Create a recovery issue when user edits make apply, promotion, rollback, or planner rebase unsafe.
- Create a recovery issue at budget pause and budget exceeded boundaries.
- Persist pending recovery before stopping work or exiting headless/JSON mode.
- On resume, ensure pending recovery is visible before any new planner or implementer call.
- Keep successful task runs unchanged.
- Do not overwrite user edits while creating or persisting recovery.

## Budget Rules

- `budget-paused` below max may offer `continue`, `pause-run`, and `abort-workflow`.
- `budget-exceeded` must not offer ordinary `continue`.
- Do not silently continue beyond max budget. A raise-budget-and-continue path is out of scope unless separately designed.

## Constraints

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert other agents' edits.
- Same-checkout writes must be sequential.
- TypeScript ESM imports must use `.js` suffixes.
- Zero classes.
- No barrel files.
- Engine code must not import React, Ink, `src/features/`, `src/components/`, or `src/hooks/`.
- Tests must verify behavior and artifacts, not private helper call order; avoid trivial hook tests.

## Non-Goals

- No TUI prompt implementation.
- No full action handler implementation.
- No kanban, plan archive, MCP write tools, full multi-agent manager, or same-checkout parallel writes.

## Validation Commands

Run targeted tests relevant to files you touched, then:

```bash
npm run typecheck
npm run lint
```

Useful targeted tests may include:

```bash
npm test -- src/engine/orchestrator/task-loop.test.ts src/engine/orchestrator/task-step.test.ts
```

## Expected Final Report

Report:

- files changed,
- stop points wired,
- tests run and results,
- skipped validation and why,
- risks or remaining work for action handlers, TUI, or validation briefs,
- confirmation that no staging, commits, or stash operations were run.
