# Implementation Plan: Recovery Flow

**Date:** 2026-04-28
**Status:** v1 implemented as of 2026-04-29. This plan now documents shipped behavior plus deferred route-bigger and planner split/rebase execution.
**Spec:** [`spec.md`](./spec.md)

## Summary

Add a small, durable recovery decision layer over the existing task loop. The layer should convert unsafe execution stops into a `RecoveryIssue`, persist it in the session, show a compact TUI prompt, apply the selected action, and resume safely.

This is not a replacement for retry, escalation, budget checks, validation, approval gates, or user-edit conflict detection. It is the product surface that coordinates those pieces.

## Technical Context

- Node.js 22+, TypeScript 6.x, ESM only.
- Ink 6 + React 19 TUI.
- Vitest 4 and Biome 2.
- Durable state in `.diptych/sessions/<id>/state.json`.
- Event log in `.diptych/sessions/<id>/session.jsonl`.
- Task execution in `src/engine/orchestrator/task-loop.ts` and `task-step.ts`.
- Retry/escalation in `src/engine/orchestrator/escalation/*`.
- User-edit conflict model in `src/engine/orchestrator/user-edit-conflicts.ts`.
- TUI callbacks in `src/features/workflow/hooks/use-workflow-runner.ts`.

## Source Touch Areas

The v1 implementation touches these modules:

```text
src/core/schemas/
  enums.ts
  workflow.ts
  recovery.ts              # new, if separate schema is cleaner

src/core/state/
  machine.ts
  selectors.ts             # only if recovery selectors are useful
  persistence.ts            # only if migration/defaulting is needed

src/engine/orchestrator/
  recovery.ts              # new recovery issue/action helpers
  task-loop.ts
  task-step.ts
  budget.ts
  events.ts
  types.ts
  user-edit-conflicts.ts
  escalation/*

src/features/workflow/
  recovery-prompt.ts       # new formatter/parser
  user-edit-conflict-prompt.ts
  hooks/use-workflow-runner.ts
  components/*             # only if a richer prompt component is needed

src/stores/workflow/
  lifecycle.ts             # only if pending recovery needs store exposure
  events.ts                # only if event rendering needs derived helpers
```

Do not add source files outside these areas unless implementation discovers a concrete need and the coordinator updates the plan.

## Execution Sequencing

Same-checkout writes must be sequential. Parallel implementation is allowed only in isolated worktrees or equivalent sandboxes; disjoint ownership may help the coordinator order work, but it does not authorize concurrent writes in one checkout.

## Phase 1 - Recovery Domain And State

Define the durable data contract:

- `RecoveryReason`,
- `RecoveryAction`,
- `RecoveryIssue`,
- optional `pendingRecovery` on `WorkflowState`,
- state-machine actions to set, clear, pause, and apply recovery,
- event payloads for prompt, selected action, failure, and resolution.

Preferred design: keep the current workflow `phase` as the location where the issue happened and store recovery as an overlay. Add a new phase only if implementation proves the overlay makes resume or rendering materially worse.

Verification:

- schema parses old state without recovery,
- schema parses new state with pending recovery,
- state transition tests prove recovery can be set, paused, cleared, and resumed.

## Phase 2 - Recovery Issue Builders

Add pure helpers that build recovery issues from existing engine signals:

- validation results,
- implementation errors,
- context routing failures,
- user-edit conflicts,
- approval/promotion conflicts,
- budget pause or budget exceeded,
- dependency-blocked task state.

The builder layer should also filter valid actions. `continue` is valid for budget pauses below max budget, but not for `budget-exceeded`; exceeded budget should expose pause/abort unless a separate explicit raise-budget-and-continue flow is designed.

Verification:

- each reason builds user-visible details and available actions,
- `budget-exceeded` does not include ordinary `continue`,
- issue builders are deterministic and do not write files.

## Phase 3 - Orchestrator Stop Points

Integrate recovery issue creation at safe points:

- before dispatch when routing cannot select a worker,
- after retry exhaustion,
- before full escalation when user choice is required,
- after failed escalation,
- when user edits block apply or promotion,
- at budget pause/exceeded task boundaries.

Verification:

- no implementer is called after a context-overflow issue,
- no user-edited file is overwritten after a conflict issue,
- successful runs do not create recovery issues.

## Phase 4 - Recovery Action Application

Implement deterministic action handlers:

- `retry-same-worker`: rerun only the current task in a fresh worker context. With unchanged routing/config this uses the same selected profile; strict profile pinning across config changes is not part of v1.
- `route-bigger-worker`: deferred in v1. It is typed and can be offered, but selecting it returns `route-bigger-not-ready` and preserves `pendingRecovery`.
- `planner-split-rebase`: deferred in v1. It is typed and labelled as proposal-gated, but proposal generation, parse/quality gates, diff/summary review, approve/edit/reject, and resume-after-proposal are not implemented yet.
- `continue`: clear only a safe budget pause below max or unrelated-edit issue and continue.
- `skip-current-task`: mark skipped and record evidence.
- `pause-run`: persist issue and stop without clearing active session.
- `abort-workflow`: record issue/action and end intentionally.

Interactive planner split/rebase must require approve, edit, or reject of the proposed Task Brief change before execution resumes. Headless mode must exit non-zero unless an explicit policy exists.

Action handlers should not stage or commit. They should reuse existing checkpoint, evidence, validation, and task-status helpers.

## Phase 5 - TUI Prompt And Input

Add a compact formatter/parser for recovery prompts and wire it through `use-workflow-runner`.

The prompt should render:

- reason and task ID,
- important file paths or validation summary,
- selected worker/profile when relevant,
- spend/context details when relevant,
- recommended action,
- valid keyboard actions.

Prefer a text prompt first. A richer Ink component can follow only if existing input mode makes the text prompt too limited.

## Phase 6 - Resume, Headless, And Artifacts

Ensure durable behavior:

- pending recovery is saved before stopping,
- resume replays the recovery prompt before new worker calls,
- JSON/headless mode emits machine-readable issue/action data and exits non-zero unless an explicit policy exists,
- evidence and summary record recovery outcomes,
- `session.jsonl` captures prompt and selected action events.

## Phase 7 - Tests And Documentation Sync

Add behavior tests around:

- state schema/defaulting,
- context overflow,
- validation retry exhaustion,
- user-edit conflicts,
- budget pause,
- budget exceeded without ordinary continue,
- skip/dependency behavior,
- pause/resume,
- planner split/rebase proposal review,
- headless JSON output,
- TUI prompt formatting and parsing.

After source implementation, update product docs such as `docs/WORKFLOW.md` and `docs/FEATURES.md` to describe the shipped behavior. Keep this Superpowers pack as the design record.

## Deferred

- Full-screen recovery dashboard.
- Cross-session recovery queues.
- Kanban-style task board.
- Plan archive or saved-plan library.
- Rich isolated-worktree parallel recovery workflow.
- Automatic merge of overlapping worker outputs.
- MCP write tools for recovery actions.
