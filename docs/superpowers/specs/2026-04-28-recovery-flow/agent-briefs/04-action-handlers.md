# 04 - Worker Brief: Recovery Action Handlers

Guard: Use this brief only for a future source implementation pass; do not execute it during docs-only pack maintenance.

You are implementing deterministic recovery action handlers for diptych / tiny-spec.

Run this brief after `01-recovery-state.md`, `02-issue-builders.md`, and `03-orchestrator-stop-points.md` have landed. Do not build TUI rendering here; expose typed callbacks/results for brief 05.

## Mission

Apply selected recovery actions safely while preserving user edits, durable session history, task evidence, and sequential same-checkout execution.

## Required Reading

- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/spec.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/decisions.md`
- recovery schema/state from brief 01
- issue builders from brief 02
- stop-point wiring from brief 03
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/escalation/*`
- `src/engine/orchestrator/user-edit-conflicts.ts`
- current planner Task Brief parsing and quality-gate modules

## Write Ownership

You may edit only these source areas:

- `src/engine/orchestrator/recovery.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/budget.ts`
- `src/engine/orchestrator/events.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/escalation/*`
- planner Task Brief parsing/quality-gate files only if needed for proposal review integration
- tests colocated with the files above

Do not edit TUI files in this brief except for type import fixes requested by TypeScript. If interactive input is needed, expose a typed request and stop for brief 05.

## Required Behavior

- `retry-same-worker`: rerun only the current task in a fresh worker context with the same implementer profile.
- `route-bigger-worker`: select the cheapest larger capable profile and rerun only the current task.
- `planner-split-rebase`: call planner only at a safe point, parse and quality-gate returned Task Brief text, then prepare a proposed Task Brief diff or summary.
- Interactive planner split/rebase must require approve, edit, or reject before execution resumes.
- Headless planner split/rebase must exit non-zero unless an explicit non-interactive policy exists.
- `continue`: clear only safe budget pauses below max or other explicitly safe non-blocking issues.
- `skip-current-task`: mark skipped, record evidence, and preserve dependency behavior.
- `pause-run`: persist the issue and stop without clearing the active session.
- `abort-workflow`: record the issue/action and end intentionally through the normal workflow shutdown path.
- Do not silently continue for `budget-exceeded`; valid v1 actions are pause or abort unless a separate raise-budget-and-continue flow exists.
- Do not overwrite user edits made after a relevant checkpoint.

## Planner Proposal Requirements

- The planner may produce only parseable revised Task Brief content in the existing Task Brief format. Free-form instructions are not enough to resume implementation.
- Show or persist enough proposed diff/summary data for a user or explicit policy to decide.
- Approve applies the proposed Task Brief transport through existing gates.
- Edit lets the user modify the proposed Task Brief before gates and execution resume.
- Reject leaves the original recovery issue pending or returns to the recovery prompt.

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

- No TUI prompt rendering.
- No kanban, plan archive, MCP write tools, full multi-agent manager, or same-checkout parallel writes.
- No automatic merge of overlapping worker outputs.

## Validation Commands

Run targeted tests relevant to files you touched, then:

```bash
npm run typecheck
npm run lint
```

Useful targeted tests may include:

```bash
npm test -- src/engine/orchestrator/recovery.test.ts src/engine/orchestrator/task-loop.test.ts src/engine/orchestrator/task-step.test.ts
```

## Expected Final Report

Report:

- files changed,
- action handlers implemented,
- planner proposal behavior implemented or deferred,
- tests run and results,
- skipped validation and why,
- risks or remaining work for TUI or validation briefs,
- confirmation that no staging, commits, or stash operations were run.
