# 02 - Worker Brief: Recovery Issue Builders

Guard: Use this brief only for a future source implementation pass; do not execute it during docs-only pack maintenance.

You are implementing pure recovery issue builders for diptych / tiny-spec.

Run this brief after `01-recovery-state.md` has landed. Do not wire orchestrator stop points or TUI input here; later briefs own that work.

## Mission

Convert existing engine signals into deterministic `RecoveryIssue` values with safe action lists, recommendations, and user-visible details.

## Required Reading

- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/spec.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/implementation-plan.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/decisions.md`
- recovery schema/state files added by brief 01
- `src/engine/orchestrator/budget.ts`
- `src/engine/orchestrator/escalation/escalation.ts`
- `src/engine/orchestrator/user-edit-conflicts.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/events.ts`

## Write Ownership

You may edit only these source areas:

- recovery schema files from brief 01 only for type gaps discovered by this brief
- `src/engine/orchestrator/recovery.ts` if you create it
- `src/engine/orchestrator/types.ts` only for recovery-facing type exports
- `src/engine/orchestrator/events.ts` only for recovery event payload types
- tests colocated with the files above

Do not edit `task-loop.ts`, `task-step.ts`, TUI files, docs outside this spec pack, or action handlers in this brief.

## Required Behavior

- Build recovery issues for:
  - implementation errors,
  - validation failure and retry exhaustion,
  - context overflow or no capable implementer,
  - user-edit conflict,
  - approval or promotion conflict,
  - budget pause,
  - budget exceeded,
  - dependency-blocked tasks.
- Include reason, phase, task ID when applicable, affected files/tasks, validation or error summary, attempts, selected implementer profile when known, cost/context facts when relevant, valid actions, and recommendation.
- Filter unavailable actions or include disabled reasons in a deterministic way.
- Make `continue` available for `budget-paused` only when spend is below `workflow.maxBudget`.
- Do not include ordinary `continue` for `budget-exceeded`; v1 options are pause or abort unless a separate raise-budget-and-continue flow exists.
- Keep builders pure: no filesystem writes, no worker calls, no planner calls.

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

- No orchestrator stop-point wiring.
- No action handler execution.
- No TUI prompt rendering.
- No kanban, plan archive, MCP write tools, full multi-agent manager, or same-checkout parallel writes.

## Validation Commands

Run targeted tests relevant to files you touched, then:

```bash
npm run typecheck
npm run lint
```

If you add builder tests, run them explicitly, for example:

```bash
npm test -- src/engine/orchestrator/recovery.test.ts
```

## Expected Final Report

Report:

- files changed,
- recovery issue builders added or updated,
- tests run and results,
- skipped validation and why,
- risks or remaining work for orchestrator stop points, actions, TUI, or validation briefs,
- confirmation that no staging, commits, or stash operations were run.
