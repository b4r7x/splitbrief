# 00 - Coordinator

> Coordinate the remediation. Do not implement every brief in one agent unless explicitly instructed. Never stage, commit, or stash.

## Parallel Work Plan

Run these as independent workers with disjoint ownership:

1. Worker A: `01-approval-detach-ipc.md`
2. Worker B: `02-snapshots-worktrees.md`
3. Worker C: `03-mcp-handoff.md`
4. Worker D: `04-cost-telemetry.md`
5. Worker E: `06-cross-cutting-hardening.md`
6. Worker F: `05-planning-editor-docs-tests.md` after A-D APIs settle

Workers are not alone in the codebase. They must not revert edits from other workers and must adapt to changes made in parallel.

## Collision Map

| Area | Owner | Others Must Avoid |
|---|---|---|
| `src/engine/orchestrator/tiered-approval.ts` | 01 | 05 can add tests/docs only after 01 lands. |
| `src/engine/orchestrator/task-step.ts` | 01 | 02 may touch snapshot context only with minimal shared helper. |
| `src/engine/orchestrator/escalation/step.ts` | 01 | 04 may touch token accounting only with focused edits. |
| `src/engine/ipc/*`, `src/cli/commands/{attach,detach,ps,start}.ts` | 01 | 06 touches only worktree ordering/name validation in `start.ts`. |
| `src/engine/snapshots/*`, `src/engine/git/worktree.ts` | 02 | 01 must not change snapshot storage internals. |
| `src/engine/mcp/*`, `src/engine/handoff/*` | 03 | 05 docs only. |
| `src/engine/orchestrator/budget.ts`, `src/stores/workflow/tokens.ts`, cost UI | 04 | Others avoid cost math. |
| docs and behavior-test cleanup | 05 | Runs after final behavior is known. |
| `src/lib/git.ts`, lockfile parsing, path safety helpers | 06 | Coordinate helper API with 01/02/03. |

## Required Final Verification

```bash
npm run typecheck
npm run lint
npm test
npm run test-ci
```

Also run targeted tests from every brief before the full suite.

