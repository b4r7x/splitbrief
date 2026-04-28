# Worker Brief 03: Start, TUI, and Headless Integration

**Guard:** Use this only for a future source implementation pass; do not execute it during docs-only pack maintenance.

Integrate readiness into `diptych start` before token spend.

## Project Constraints

- Node.js 22+, TypeScript 6.x, ESM only.
- Use `.js` suffixes in local imports.
- No classes, no barrels, no memoization.
- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, or imperative handles.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert edits made by others.

## Required Reading

- `CLAUDE.md`
- `src/cli/commands/start.ts`
- `src/cli/setup.ts`
- `src/cli/headless.ts`
- relevant workflow screen/TUI files after locating them with `rg`
- `docs/WORKFLOW.md` start, persistence, and cost display sections
- `docs/superpowers/specs/2026-04-28-run-readiness-doctor/decisions.md`

## Owned Files

Owned files:

- `src/cli/commands/start.ts`
- `src/cli/headless.ts` if needed for JSON output
- new `src/features/workflow/components/readiness-panel.tsx`
- new `src/features/workflow/components/readiness-panel.test.tsx`
- existing `src/cli/commands/start.test.ts`
- existing `src/cli/headless.test.ts`

Coordinate before touching:

- shared readiness core files from Worker 01
- `src/cli/setup.ts`
- `src/stores/navigation/router.ts` only if a pre-workflow route/state handoff is required
- `src/features/workflow/screen.tsx` only if the panel is hosted inside the workflow screen

## What To Change

- Compute readiness before planner/implementer calls.
- Prefer computing readiness before `beginSession()` where feasible. If `start` creates a session first, the only intended readiness write is a compact event/artifact in that active execution session before model calls.
- Preserve existing flag validation ordering for `--detach`, `--json`, and worktree paths.
- Show compact readiness in interactive mode.
- Allow continue on warnings and stop on blockers.
- Emit structured readiness in headless JSON mode before workflow events that spend tokens.
- Keep stubbed test seams available so ordering can be verified without real models or network access.
- Keep missing-config setup behavior compatible with current `setupWorkflow`.

## What Not To Change

- Do not turn readiness into a full setup wizard.
- Do not create plan archive/history behavior.
- Do not alter resume semantics.
- Do not add same-checkout parallel writes.
- Do not run validation commands from readiness.
- Do not use real `diptych start` workflows as verification for this brief.

## Validation

Run targeted tests for start/headless integration and any TUI component tests:

```bash
npx vitest run src/cli/commands/start.test.ts src/cli/headless.test.ts src/features/workflow/components/readiness-panel.test.tsx
```

Stubbed fixture coverage should verify readiness appears before any planner/implementer invocation. Optional manual smoke must use a throwaway fixture or temporary worktree with stubbed `shell` planner and implementer commands, no real model credentials, no network access, and cleanup scoped to that fixture. If a worktree smoke is used, use a distinct worktree value such as `readiness-smoke-wt` and a distinct feature such as `stubbed readiness worktree smoke`.

## Expected Final Report

Include:

- files changed;
- tests run and results;
- skipped validation and reason;
- risks or follow-up work;
- confirmation that no `git add`, `git stage`, `git commit`, or `git stash` was run.
