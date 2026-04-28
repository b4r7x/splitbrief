# 04 - Scheduler, Checkpoints, And Execution

> Historical note (2026-04-28): this brief was used during implementation. The current status is recorded in `../README.md`, `../tasks.md`, `../verification.md`, and `docs/COST-AWARE-IMPLEMENTER-HANDOFF.md`.
> Original fresh-context brief retained for audit; do not implement as pending work unless intentionally re-running this spec.
> For the spawned worker assigned this brief: GPT-5.5, medium reasoning.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

Integrate routing into the existing sequential task loop. This brief owns execution integration, not TUI rendering or config schema.

## Intent

Every task should be routed before dispatch and executed as a fresh implementer call. Same-checkout parallelism stays out of scope; any future parallel execution requires isolated worktrees or equivalent sandboxes.

## Scope

**In bounds:**

- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/events.ts`
- summary/evidence/tokens schemas if routing metadata must persist.
- Tests for task-loop/task-step routing behavior.

**Out of bounds:**

- No parallel fan-out.
- No Plan Review TUI.
- No MCP changes.
- No broad retry redesign unless required for selected profile reuse.

## Required Behavior

- Before each task, route it against available implementer profiles.
- If no profile fits, pause/block with a clear error and suggested planner split/escalation path.
- Instantiate or select the concrete implementer for that task.
- Record selected profile/tool/model in task events and token breakdowns.
- Keep retries tied to the selected profile unless a later routing step explicitly selects another.
- Preserve pre-task and post-task checkpoint behavior.
- Preserve validation, evidence, drift-chain, and escalation behavior.

## Important Constraint

Do not turn this into a concurrent scheduler. The loop may be refactored to make future parallelism easier, but only one task may write the checkout at a time.

## Validation

Tests should cover:

- single implementer path unchanged,
- profile-selected task publishes selected profile,
- task too large for all profiles blocks before implementer call,
- multi-task workflow uses separate dispatches,
- retry does not receive unrelated prior task transcript,
- budget pause still happens at task boundary.

Run:

```bash
npm test -- src/engine/orchestrator/task-loop.test.ts src/engine/orchestrator/task-step.test.ts
npm run typecheck
npm run lint
```

## Evidence

- Routing is visible in events/artifacts.
- Existing workflow tests still pass.
- No same-checkout parallel writes are introduced.

## Expected Final Report

Include:

- files changed;
- tests run and results;
- validation skipped, with explicit reason;
- remaining risks or follow-up work;
- confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
