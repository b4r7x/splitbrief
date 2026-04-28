# Cost-Aware Implementer Pool + Plan Review v2 - 2026-04-28

> **Status:** implemented and verified with targeted validation.
> **Scope:** keep diptych focused as an expensive-planner to cheap-implementer orchestrator; add implementer-pool planning, context-aware task routing, stronger plan review, user-edit conflict handling, durable session artifacts, and cleanup guidance.
> **Out of scope:** separate plan archive/plan-management system, kanban, cross-plan dependencies, same-checkout parallel writes, MCP write tools, generic agent swarms, automatic git staging/commits.

## Current State

This pack has been implemented. Implementer profiles, cheapest-capable routing, sequential fresh-context task dispatch, user-edit conflict handling, stale `currentCode` cleanup, task-loop stopped status handling, task-aware cost accounting, Plan Review/TUI metadata, and the read-only MCP/tool boundary are present in the codebase.

Validation passed in the final implementation pass for `npm run typecheck`, `npm run lint`, `git diff --check`, and a targeted Vitest pack of 25 files / 412 tests. Full `npm test` and `npm run test-ci` were not rerun in the final pass because broad helper, sandbox, and git behavior made them unsuitable as final confirmation for this pack.

## Why Superpowers, Not A Full Spec Kit Run

This remains a **superpowers spec pack** and post-implementation record. It was better than a full Spec Kit run for this task because the goal was to hand off bounded implementation briefs to separate AI contexts, not to execute a single linear implementation in one chat.

This pack still follows the Spec Kit thinking path:

```text
spec.md -> implementation-plan.md -> tasks.md -> analyze.md -> cleanup.md -> agent-briefs/*
```

The agent briefs were used as bounded implementation slices for separate AI contexts.

## Product Direction

Diptych remains:

```text
expensive planner -> self-contained Task Briefs -> cheap implementer workers -> checkpoint/validate/review
```

The implementer now supports an optional **pool of profiles**, but it is still one product role. This is not a multi-agent manager. A pool lets diptych choose the cheapest capable worker for each task and keep every worker call under its context limit.

Durable workflow sessions are core. Resume, session history, previous-session browsing/filtering/search, and artifacts such as `spec.md`, `plan.md`, `tasks.md`, `summary.json`, `review.md`, evidence, and drift are part of the product surface.

Those sessions are execution records, not a separate plan archive. This pack does not add saved-plan libraries, kanban, cross-plan orchestration, plan cloning, or plan-management workflows.

The canonical direction document is:

- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`

Read it before implementing any brief in this pack.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md` | Product direction and non-goals. |
| 2 | `README.md` | This pack overview and execution order. |
| 3 | `spec.md` | User stories, requirements, edge cases, success criteria. |
| 4 | `implementation-plan.md` | Historical technical plan and file ownership map. |
| 5 | `tasks.md` | Speckit-style implementation task list. |
| 6 | `analyze.md` | Analyze pass and plan fixes applied after analysis. |
| 7 | `cleanup.md` | What to clean, demote, defer, or leave alone. |
| 8 | `decisions.md` | ADR-style decisions for product and architecture boundaries. |
| 9 | `agent-briefs/00-coordinator.md` | Historical dispatch order used for implementation agents. |
| 10 | `agent-briefs/01-*.md` through `07-*.md` | Historical fresh-context implementation briefs. |

## Change Set

| # | Brief | Goal |
|---|---|---|
| 01 | Direction Docs Cleanup | Align docs with cost-aware planner-to-cheap-implementer identity. |
| 02 | Implementer Pool Schema | Add backwards-compatible implementer profiles and selection metadata. |
| 03 | Context Sizing + Routing | Estimate task prompt size and choose cheapest capable worker. |
| 04 | Scheduler + Checkpoints | Keep execution sequential in v1, but dispatch each task with fresh context and durable routing evidence. |
| 05 | User Edit Conflict Flow | Replace generic external-change prompts with task/file-aware conflict choices. |
| 06 | Plan Review v2 TUI | Show task fit, routing, risk, files, checkpoints, and edit actions before execution. |
| 07 | Tool/MCP Boundary + Test Cleanup | Keep tool calls inside runners, MCP read-only, and tests behavior-focused. |

## Implementation Agent Assignment

Historical assignment for this implementation:

The main/coordinator context could keep the user's chosen model and reasoning level, including `xhigh`.

Spawned implementation agents that received one concrete brief from `agent-briefs/` used:

```text
model: GPT-5.5
reasoning: medium
```

Each agent brief repeated this assignment so it survived copy/paste into a fresh context. The `medium` reasoning level applied only to those spawned implementation agents, not to the main coordinator context.

If the environment provided a `parallel-agents` or equivalent superpowers skill, it was suitable for dispatch planning. Same-checkout dispatch must remain sequential. Parallel agents may be used only for isolated-worktree execution or for read-only/dispatch planning; synthesize results in the coordinator.

## Historical Dependencies

These were the required references before implementation:

- `CLAUDE.md`
- `docs/WORKFLOW.md`
- `docs/TASK-CONTRACT.md`
- `docs/CONFIGURATION.md`
- `docs/STORES.md`
- `docs/TESTING.md`
- `docs/WORKTREES.md`
- `docs/superpowers/specs/2026-04-22-task-brief-evidence-contract/README.md`
- `docs/superpowers/specs/2026-04-26-plan-editor-screen/README.md`
- `docs/superpowers/specs/2026-04-26-snapshots-undo/README.md`
- `docs/superpowers/specs/2026-04-26-cost-telemetry-tui/README.md`
- `docs/superpowers/specs/2026-04-26-mcp-resources-server/README.md`

## Global Done Criteria

- Diptych still reads as a cost-aware planner-to-implementer orchestrator.
- Existing single `implementer` config continues to work.
- Optional implementer profiles can be selected per task.
- Each task is dispatched with a fresh context.
- Context-fit failures are visible before execution and block or re-route safely.
- Same-directory and same-checkout parallel writes are not introduced.
- User edits are detected by file and mapped to affected tasks.
- TUI surfaces plan review, routing, context fit, checkpoint, and conflict state without becoming kanban.
- MCP remains read-only; write tools are outside this roadmap.
- Documentation states that tool calls belong to underlying runners, while diptych owns deterministic guardrails.
- Tests focus on behavior, artifacts, files, public state, and rendered output.

## Global Invariants

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert user changes.
- No new runtime dependencies unless an agent brief explicitly justifies one. This pack currently requires none.
- No classes.
- No barrels.
- ESM imports use `.js` suffixes.
- Engine code must not import React, Ink, `src/features/`, `src/components/`, or `src/hooks/`.
- React code must not add `useMemo`, `useCallback`, `React.memo`, `forwardRef`, or derived-state effects.
- You are not alone in the codebase. Do not revert edits made by other agents; adapt to them.

## Verification

Final implementation pass:

```bash
npm run typecheck
npm run lint
git diff --check
```

Targeted Vitest validation passed for 25 files / 412 tests.

Deferred final-suite commands:

```bash
npm test
npm run test-ci
```

These were not rerun in the final pass because broad helper, sandbox, and git behavior made them unsuitable as final confirmation for this pack.
