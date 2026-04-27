# 05 - User Edit Conflict Flow

> Historical note (2026-04-28): this brief was used during implementation. The current status is recorded in `../README.md`, `../tasks.md`, `../verification.md`, and `docs/COST-AWARE-IMPLEMENTER-HANDOFF.md`.
> Original fresh-context brief retained for audit; do not implement as pending work unless intentionally re-running this spec.
> For the spawned worker assigned this brief: GPT-5.5, medium reasoning.
> Never stage or commit.

## Identity

Replace generic external-change handling with structured task/file conflict handling.

## Intent

Manual user edits are source-of-truth changes. Diptych must not overwrite them silently and should tell the user exactly which task/file is affected.

## Scope

**In bounds:**

- `src/lib/git.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/tiered-approval.ts`
- `src/engine/orchestrator/types.ts`
- `src/engine/orchestrator/events.ts`
- workflow TUI prompt/overlay files needed to render the conflict.
- Tests for conflict classification and apply/promotion blocking.

**Out of bounds:**

- No routing schema changes.
- No plan editor redesign.
- No destructive git reset/checkout outside existing safe helpers/tests.

## Required Behavior

- Classify external changes as:
  - unrelated,
  - current-task conflict,
  - future-task stale input,
  - dependency-file conflict,
  - changed-during-approval/promotion.
- Include affected file paths and affected task IDs in the event/callback payload.
- Continue automatically only when safe and configured to do so.
- Block apply/promotion if the target file changed after the checkpoint.
- Offer clear actions to the UI:
  - continue unrelated,
  - pause,
  - regenerate/rebase affected task,
  - skip current task,
  - abort workflow.

## Validation

Tests should cover:

- unrelated dirty file does not block current task,
- current task file blocks,
- future task file marks future task stale,
- dirty-at-start file modified by user during approval blocks rollback/promotion,
- direct file-writing agent staging path preserves user edits.

Run:

```bash
npm test -- src/engine/orchestrator/tiered-approval.test.ts src/engine/orchestrator/task-step.test.ts src/engine/orchestrator/task-loop.test.ts
npm run typecheck
npm run lint
```

## Evidence

- User edit conflicts are observable in events/TUI.
- Tests prove user edits are not overwritten.
