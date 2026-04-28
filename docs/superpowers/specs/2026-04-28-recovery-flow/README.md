# Recovery Flow - 2026-04-28

> **Status:** implementation specification only. No source code changes are included in this pack.
> **Owned scope for this pack:** `docs/superpowers/specs/2026-04-28-recovery-flow/**`.
> **Product scope:** clear recovery decisions for failed, blocked, conflicted, context-overflowed, validation-failed, budget-paused, and budget-exceeded runs.

## Problem

Diptych already has useful safety pieces: bounded retries, hint/full escalation, context-aware routing, user-edit conflict detection, budget pause gates, durable sessions, validation, evidence, and resume. The missing product layer is a consistent recovery flow that tells the user why execution stopped and what the safe next action is.

The user should not have to infer whether a failure means "retry", "use a stronger worker", "ask the planner to split or rebase", "skip", "pause", or "abort".

## Scope

This spec defines a single recoverable decision surface for task execution stops:

- implementation errors,
- validation failures and retry exhaustion,
- context overflow or no capable worker,
- user-edit and apply/promotion conflicts,
- budget pause or budget exceeded,
- blocked dependencies and skipped tasks.

Recovery is part of the current workflow session. It is not a separate plan-management product.

## Non-Goals

- Do not build kanban.
- Do not build a plan archive.
- Do not build MCP write tools.
- Do not build a full multi-agent manager.
- Do not support parallel writes in one checkout.
- Do not create automatic git commits or staging behavior.
- Do not replace underlying runner tools; runners keep their own tool calls.

Same-checkout source writes must be sequential. Parallel implementation is allowed only in isolated worktrees or equivalent sandboxes; disjoint file ownership may guide sequencing, but it does not make concurrent writes safe in one checkout.

## Reading Order

| Step | File | Purpose |
|---|---|---|
| 1 | [`spec.md`](./spec.md) | Product behavior, recovery states, UX copy shape, acceptance criteria. |
| 2 | [`implementation-plan.md`](./implementation-plan.md) | Phased source plan for future implementation. |
| 3 | [`decisions.md`](./decisions.md) | Explicit tradeoffs and product boundary decisions. |
| 4 | [`tasks.md`](./tasks.md) | Ordered future implementation checklist. |
| 5 | [`verification.md`](./verification.md) | Future validation scenarios and commands. |
| 6 | [`agent-briefs/00-coordinator.md`](./agent-briefs/00-coordinator.md) | Coordinator prompt for a fresh AI context. |
| 7 | [`agent-briefs/01-recovery-state.md`](./agent-briefs/01-recovery-state.md) | Source brief for schema and durable state. |
| 8 | [`agent-briefs/02-issue-builders.md`](./agent-briefs/02-issue-builders.md) | Source brief for pure recovery issue builders. |
| 9 | [`agent-briefs/03-orchestrator-stop-points.md`](./agent-briefs/03-orchestrator-stop-points.md) | Source brief for engine stop-point wiring. |
| 10 | [`agent-briefs/04-action-handlers.md`](./agent-briefs/04-action-handlers.md) | Source brief for recovery action handlers. |
| 11 | [`agent-briefs/05-tui-actions.md`](./agent-briefs/05-tui-actions.md) | Source brief for TUI prompts and user actions. |
| 12 | [`agent-briefs/06-tests-and-validation.md`](./agent-briefs/06-tests-and-validation.md) | Source brief for test coverage, docs sync, and verification. |

## Core Direction

Recovery Flow keeps diptych focused on:

```text
expensive planner -> self-contained Task Briefs -> cheap implementer -> validate -> recover safely when blocked
```

It adds an explicit user decision point when the current run cannot safely continue. It does not add worker swarms, background fan-out, saved-plan libraries, or cross-plan project management.
