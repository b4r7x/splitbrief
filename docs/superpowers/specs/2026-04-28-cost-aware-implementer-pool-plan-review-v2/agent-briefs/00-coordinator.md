# 00 - Coordinator

> Historical note (2026-04-28): this brief records the implementation dispatch plan that was used. Do not treat it as pending current work unless intentionally re-running this spec.
> Original coordinator instructions are retained for audit.
> If intentionally re-running this spec, use this only when coordinating the full spec pack.
> Guard: use this only as a historical record or future isolated-worktree planning input; do not execute it during docs-only pack maintenance.
> Coordinator/main context: keep the user's chosen model and reasoning level, including xhigh.
> Spawned implementation agents: GPT-5.5, medium reasoning.
> Do **not** run `git add`, `git stage`, `git commit`, or `git stash`.
> Do not run same-checkout parallel writes. If this historical plan is ever re-run, execute same-checkout work sequentially, or use isolated worktrees/equivalent sandboxes with explicit ownership.

## Execution Order

```text
01 Direction Docs Cleanup (historically independent; same-checkout reruns must still be sequential)

02 Implementer Pool Schema
  -> 03 Context Sizing + Routing
      -> 04 Scheduler + Checkpoints
          -> 06 Plan Review v2 TUI

05 User Edit Conflict Flow (can start after current snapshot/staging helpers are understood only in an isolated worktree; same-checkout reruns must be sequential)

07 Tool/MCP Boundary + Test Cleanup (historically parallelizable only with isolated worktrees; final pass after code settles)
```

Historical recommended order for a safe rerun:

1. Run brief 01 first, or in an isolated worktree separate from 02.
2. Run brief 02 before 03.
3. Run brief 03 before 04 and 06.
4. Run brief 05 after 02/03 in the same checkout, or in an isolated worktree if work must overlap.
5. Run brief 06 after routing metadata shape is stable.
6. Run brief 07 as final docs/test cleanup.

## Historical Subagent Guidance

When this spec was implemented, a `parallel-agents` or equivalent superpowers skill was suitable before spawning implementation workers. These were the dispatch rules:

- Spawn workers only for concrete briefs from this folder.
- Give each worker one brief and one bounded write scope.
- Same-checkout dispatch must be sequential even when briefs have separate file ownership.
- Parallel dispatch is allowed only with isolated worktrees or equivalent sandboxes.
- Do not duplicate the same task across workers.
- Keep synthesis in the coordinator context.
- Implementation workers should use GPT-5.5 with medium reasoning.

## Shared Files To Read

- `CLAUDE.md`
- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/WORKFLOW.md`
- `docs/TASK-CONTRACT.md`
- `docs/CONFIGURATION.md`
- `docs/STORES.md`
- `docs/TESTING.md`
- `src/core/schemas/config.ts`
- `src/core/schemas/implementer-config.ts`
- `src/core/schemas/task.ts`
- `src/engine/spec/formatter.ts`
- `src/engine/spec/token-budget.ts`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/tiered-approval.ts`
- `src/engine/implementers/types.ts`
- `src/features/workflow/components/plan-editor.tsx`
- `src/stores/workflow/plan-editor.ts`

## Global Invariants

- You are not alone in the codebase. Other agents may edit nearby files. Do not revert their work.
- Keep file ownership narrow.
- No classes.
- No barrels.
- ESM `.js` imports.
- Engine code must not import React, Ink, `src/features/`, `src/components/`, or `src/hooks/`.
- React code must not add `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Tests assert behavior, artifacts, rendered output, public store state, or filesystem effects.
- Do not add same-checkout parallel writes.
- Do not add MCP tools/mutations.
- Do not stage or commit.

## Historical Verification Plan

The original per-brief target was:

```bash
npm run typecheck
npm run lint
npm test
```

The original final-suite target was:

```bash
npm run test-ci
```

The final recorded verification for this pack is in `../verification.md`; broad `npm test` / `npm run test-ci` were not used as final-pass proof.

## Expected Final Report

Include:

- files changed;
- validation run and results, or validation skipped with explicit reason;
- remaining risks or follow-up work;
- confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`;
- confirmation that you did not run same-checkout parallel writes.
