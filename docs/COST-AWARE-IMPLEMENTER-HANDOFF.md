# Cost-Aware Implementer Handoff

> Status: implemented and locally verified with targeted checks.
> Last updated: 2026-04-28.
> Archive note: this handoff records the implementation state on 2026-04-28. Some path inventory below predates later refactors; use current source search before editing.

This is the short handoff for a fresh AI context. Read it with [COST-AWARE-IMPLEMENTER-DIRECTION.md](./COST-AWARE-IMPLEMENTER-DIRECTION.md) before changing the cost-aware implementer code.

## Product Goal

Diptych pays an expensive planner to understand the work, split it into self-contained Task Briefs, and review outcomes. It then routes each brief to the cheapest capable implementer profile that can safely execute it with bounded context, while preserving checkpoints, validation, cost visibility, and user edits.

The implemented shape is:

```text
expensive planner -> Task Briefs -> cheapest capable implementer profile -> checkpoint/validate/review
```

## Current Status

- Implementer profiles, context-aware routing, fresh per-task dispatch metadata, user-edit conflict modeling, cost accounting metadata, and Plan Review v2 routing previews are implemented.
- The final pass was locally verified with targeted checks.
- No known blockers remain for the implemented scope.

## Non-Goals

- No swarm manager.
- No same-checkout parallel writes.
- No plan archive, kanban board, or cross-plan project-management layer.
- No MCP project-write, execution, or implementation-dispatch tools; MCP only exposes the constrained evidence-ledger tools documented in the CLI reference.
- No hidden diptych tool-calling layer. Tools belong to the selected runner; diptych owns deterministic orchestration, state, checkpoints, validation, and evidence.

## Implementation Map

### Implementer Profiles And Routing

- `src/core/schemas/implementer-config.ts` defines implementer write modes, cost tiers, capabilities, and profile config.
- `src/core/schemas/config.ts` wires optional `implementerProfiles` into config while preserving the existing single `implementer`.
- `src/core/config/accessors/implementer-profiles.ts` resolves profiles, default profile selection, derived capabilities, and compatibility with legacy config.
- `src/core/config/load/io.ts`, `src/core/config/load/migrate.ts`, and `src/core/config/load/validate.ts` load, preserve, and validate profile config.
- `src/engine/orchestrator/context-routing/` estimates prompt size, classifies context fit, requires direct writes only for path-like multi-file scopes, and chooses the cheapest capable profile.

### Fresh Task Execution

- `src/engine/orchestrator/task/loop.ts` and `src/engine/orchestrator/task/step.ts` integrate routing before task dispatch and keep execution sequential.
- `src/engine/orchestrator/run/phases.ts` carries routing and task execution through the run phases.
- Each task is treated as its own implementer dispatch with compact routing metadata. The implementer does not receive a single growing plan transcript.

### User Edit Conflicts

- `src/engine/orchestrator/user-edit/conflicts.ts` classifies external edits as unrelated, current-task conflict, future-task stale input, dependency conflict, or changed-during-approval-promotion.
- `src/features/workflow/user-edit-conflict-prompt.ts` formats the prompt and normalizes choices.
- `src/features/workflow/hooks/use-runner.ts` and `src/features/workflow/screen.tsx` surface conflict decisions in the workflow.
- Promotion is blocked when user edits touch files that would otherwise be overwritten.

### Cost Accounting

- `src/engine/orchestrator/tokens.ts`, `src/core/schemas/tokens.ts`, and `src/engine/events/types.ts` carry routing context, selected profile, estimated tokens, context fit, truncation mode, and cost posture.
- `src/engine/orchestrator/budget/check.ts`, `src/engine/orchestrator/summary.ts`, and `src/features/summary/screen.tsx` keep budget and summary surfaces aware of routing/cost metadata.
- `src/engine/providers/pricing-resolver.ts` keeps provider pricing lookup behavior aligned with summary accounting.

### Plan Review And TUI

- `src/features/workflow/components/brief-review-view.tsx` refreshes current code from disk for routing previews and avoids reusing stale `currentCode`.
- `src/features/workflow/components/plan-editor/editor.tsx` renders routing, context fit, cost posture, risk, and file scope metadata.
- `src/stores/workflow/plan-editor.ts` stores the review metadata used by the Plan Review screen.
- `src/features/workflow/components/event-cards/planner-status.tsx` shows task token/routing context in event output.

### Lifecycle And State Safety

- `src/core/state/machine.ts` includes `CLEAR_TASK_CODE` so stale `currentCode` can be removed from a task without affecting other tasks.
- `src/engine/orchestrator/state-ops.ts`, `src/engine/orchestrator/events.ts`, and `src/engine/orchestrator/types.ts` carry routing/conflict state without introducing long-lived plan database behavior.
- Checkpoint and restore semantics remain run-safety features. They are not git history management.

### MCP And Tool Boundary

- `src/cli/commands/mcp.ts` and `src/engine/ipc/protocol.ts` remain boundary code for session visibility and workflow IPC.
- The product boundary is unchanged: MCP project resources are for read-only external visibility; the current write surface is limited to evidence-ledger reporting tools.
- Diptych does not insert its own agent tool-calling layer between the planner/implementer and their native tools.

## Main Tests To Read

- `src/core/schemas/implementer-config.test.ts`
- `src/core/schemas/config.test.ts`
- `src/core/config/accessors/implementer-profiles.test.ts`
- `src/core/config/load/io.test.ts`
- `src/core/config/load/validate.test.ts`
- `src/engine/orchestrator/context-routing/route.test.ts`
- `src/engine/orchestrator/task/` (split `loop-*.test.ts` suites)
- `src/engine/orchestrator/task/step.test.ts`
- `src/engine/orchestrator/run/phases.test.ts`
- `src/engine/orchestrator/user-edit/conflicts.test.ts`
- `src/engine/orchestrator/tokens.test.ts`
- `src/engine/orchestrator/budget/check.test.ts`
- `src/engine/orchestrator/summary-build.test.ts`
- `src/engine/providers/pricing-resolver.test.ts`
- `src/features/workflow/components/brief-review-view.test.ts`
- `src/features/workflow/components/plan-editor/editor.test.ts`
- `src/features/workflow/user-edit-conflict-prompt.test.ts`
- `src/features/workflow/plan-editor-save.test.ts`
- `src/stores/workflow/plan-editor.test.ts`
- `src/features/summary/screen.test.tsx`

## Critical Invariants

- Never run `git add`, `git stage`, `git commit`, `git stash`, `git reset`, or `git checkout` while working in this repository.
- Never overwrite user edits. Pause, rebase/regenerate, skip, or abort when user changes conflict with task output.
- Routing selects only the cheapest capable profile, not simply the first configured profile.
- Direct-write mode is required only for path-like scopes beyond the task's primary file.
- `extracted-code` profiles may write only one file's contents.
- Stale `currentCode` must be cleared or refreshed from disk; it must not be reused after the file changed or disappeared.
- Same-checkout task execution stays sequential.
- MCP remains outside the execution path for implementer writes. Its only mutation surface is evidence-ledger reporting for existing sessions and tasks.

## Validation

Final local verification covered:

```bash
npm run typecheck
npm run lint
git diff --check
```

A targeted Vitest pack passed: 25 files / 412 tests.

The targeted pack covered config/profile schema, profile resolution, routing, fresh task execution integration, user-edit conflict classification and prompts, budget/tokens/summary metadata, pricing, Plan Review rendering, plan-editor state, and summary UI.

Full `npm test` / `test-ci` was not rerun in the final pass because broad helpers, sandbox behavior, and git-related behavior can conflict with this repository's no-stage/no-commit working rules.

## Residual And Future Work

No known blockers remain for the implemented feature. Optional future improvements:

- Add isolated parallel execution only with worktrees or an equivalent ownership boundary.
- Improve planner split/escalation UX when no profile can fit a task.
- Add richer cost forecasts before implementation if pricing data is available.
- Expand Plan Review affordances only where they help execution review, not archive or kanban behavior.
