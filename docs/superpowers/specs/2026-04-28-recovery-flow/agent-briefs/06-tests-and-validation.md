# 06 - Worker Brief: Recovery Tests And Validation

Guard: Use this brief only for a future source implementation pass; do not execute it during docs-only pack maintenance.

You are responsible for integration tests, docs sync, and final validation for Recovery Flow in diptych / tiny-spec.

Run this brief after `01-recovery-state.md` through `05-tui-actions.md` have landed. This brief is sequential by design; do not run it in parallel with source-writing briefs in the same checkout.

## Mission

Prove that Recovery Flow works from the user's perspective: safe stops create durable issues, prompts show the right actions, selected actions do the right thing, planner proposals are reviewed, budget max is respected, and user edits are not overwritten.

## Required Reading

- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/WORKFLOW.md`
- `docs/FEATURES.md`
- `docs/TESTING.md` if present
- `docs/superpowers/specs/2026-04-28-recovery-flow/spec.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/verification.md`
- all prior recovery worker briefs and final reports
- existing tests near `src/engine/orchestrator/task-loop.test.ts`
- existing tests near `src/engine/orchestrator/task-step.test.ts`

## Discovery Step

Start from an empty context by inspecting:

- `git diff --name-only` to find files changed by prior recovery briefs,
- new or modified tests in those changed paths,
- source files named in prior worker final reports,
- source files named by the prior briefs' write ownership sections.

If a prior final report is missing or incomplete, reconstruct the touched files from `git diff --name-only` before editing tests.

## Write Ownership

You may edit only these areas:

- recovery-related tests under `src/core/**`
- recovery-related tests under `src/engine/orchestrator/**`
- recovery-related tests under `src/features/workflow/**`
- `docs/WORKFLOW.md`
- `docs/FEATURES.md`
- `docs/TESTING.md` if recovery testing policy needs documenting
- `docs/superpowers/specs/2026-04-28-recovery-flow/tasks.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/verification.md`

If a test exposes a source bug, make the smallest source fix necessary and report the file in your final response. Do not refactor unrelated code.

## Required Test Coverage

Cover these behaviors:

- context overflow creates a recovery issue and does not call an implementer,
- validation retry exhaustion creates a recovery issue,
- retry same worker reruns only the current task in a fresh context,
- route bigger uses a capable larger profile when available,
- user-edit conflict blocks overwrite and lists affected files/tasks,
- budget pause below max shows spend and supports continue/pause/abort,
- budget exceeded does not offer ordinary continue and does not silently proceed,
- planner split/rebase produces a proposed Task Brief diff or summary and requires approve/edit/reject in interactive mode,
- headless planner split/rebase exits non-zero unless an explicit policy exists,
- pause persists the issue and resume shows it again,
- skip records evidence and affects dependent tasks safely,
- headless mode exits non-zero with machine-readable available actions.

Prefer behavior, artifacts, filesystem effects, events, and rendered text over implementation details.

## Constraints

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert other agents' edits.
- Same-checkout writes must be sequential.
- TypeScript ESM imports must use `.js` suffixes.
- Zero classes.
- No barrel files.
- Do not add `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer external stores with `useSyncExternalStore`; do not bloat React Context.
- Do not add skip-only tests such as `describe.skip`, `it.skip`, or `test.skip`.
- Do not weaken existing tests to make recovery pass.
- Tests must verify behavior and artifacts, not private helper call order; avoid trivial hook tests.

## Non-Goals

- No kanban docs.
- No plan archive docs.
- No MCP write tools.
- No same-checkout parallel writes.
- No broad testing cleanup unrelated to Recovery Flow.

## Validation Commands

Run targeted tests first:

```bash
npm test -- src/core/schemas/recovery.test.ts
npm test -- src/core/state/machine.test.ts
npm test -- src/engine/orchestrator/recovery.test.ts
npm test -- src/engine/orchestrator/task-loop.test.ts
npm test -- src/engine/orchestrator/task-step.test.ts
npm test -- src/features/workflow/recovery-prompt.test.ts
```

Then run final validation:

```bash
npm run typecheck
npm run lint
npm test
```

If any command cannot be run, document the exact blocker and the narrower command that did run.

## Expected Final Report

Report:

- files changed,
- tests added or updated,
- docs updated,
- tests run and results,
- commands run and outcomes,
- skipped validation and why,
- scenarios verified,
- source fixes made because tests exposed bugs,
- remaining risks or deferred cases,
- confirmation that no staging, commits, or stash operations were run.
