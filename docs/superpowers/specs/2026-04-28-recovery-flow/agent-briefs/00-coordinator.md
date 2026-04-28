# 00 - Coordinator Brief: Recovery Flow

Guard: Use this brief only for a future source implementation pass; do not execute it during docs-only pack maintenance.

You are coordinating implementation of the Recovery Flow spec in diptych / tiny-spec.

This brief is self-contained for an empty AI context. Read the referenced files before making source changes.

## Mission

Implement a simple, durable recovery flow for failed or blocked runs. When a task fails, conflicts, exceeds context, fails validation, pauses on budget, or exceeds budget, the user sees clear safe actions.

## Product Boundaries

- Diptych is a cost-aware planner-to-implementer orchestrator.
- Durable sessions are execution/session history, not a plan archive.
- The implementer pool is one implementer role with routing/escalation, not a swarm UI.
- Do not build kanban.
- Do not build MCP write tools.
- Do not build a full multi-agent manager.
- Do not support parallel writes in one checkout.

## Required Reading

- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/WORKFLOW.md`
- `docs/FEATURES.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/README.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/spec.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/implementation-plan.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/decisions.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/tasks.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/verification.md`
- `src/engine/orchestrator/task-loop.ts`
- `src/engine/orchestrator/task-step.ts`
- `src/engine/orchestrator/escalation/*`
- `src/engine/orchestrator/user-edit-conflicts.ts`
- `src/features/workflow/user-edit-conflict-prompt.ts`
- `src/features/workflow/hooks/use-workflow-runner.ts`

## Write Ownership

Coordinator owns:

- `docs/superpowers/specs/2026-04-28-recovery-flow/**` for implementation notes, status updates, and synthesis.

Do not edit source files as coordinator unless you are explicitly taking over a worker brief. If you do, follow that worker brief's write ownership.

## Execution Model

Run worker briefs sequentially in one checkout:

1. `01-recovery-state.md`
2. `02-issue-builders.md`
3. `03-orchestrator-stop-points.md`
4. `04-action-handlers.md`
5. `05-tui-actions.md`
6. `06-tests-and-validation.md`

Do not dispatch same-checkout parallel writes. Parallel implementation is allowed only in isolated worktrees or equivalent sandboxes. Disjoint ownership may guide sequencing and review order, but it is not permission for concurrent writes in the same checkout.

## Global Constraints

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert edits made by other agents.
- Node 22+.
- TypeScript ESM imports require `.js` suffixes.
- Zero classes.
- No barrel files.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not expand React Context.
- Tests should verify behavior, artifacts, rendered output, public state, and filesystem effects; avoid trivial hook tests.

## Validation Commands

Final implementation should run:

```bash
npm run typecheck
npm run lint
npm test
```

Targeted development commands are listed in `../verification.md` and worker briefs.

## Coordinator Checklist

- [ ] Confirm no worker uses git staging, commits, or stash operations.
- [ ] Confirm same-checkout briefs are executed sequentially, or parallel briefs use isolated worktrees/equivalent sandboxes.
- [ ] Confirm source changes match the spec and decisions.
- [ ] Confirm docs sync happens after behavior is implemented.
- [ ] Confirm final report includes files changed, tests run, and deferred risks.

## Expected Final Report

Report:

- completed worker briefs,
- files changed by each brief,
- tests run and results,
- validation commands and results,
- skipped validation and why,
- recovery scenarios covered,
- known gaps or deferred work,
- confirmation that no staging, commits, or stash operations were run.
