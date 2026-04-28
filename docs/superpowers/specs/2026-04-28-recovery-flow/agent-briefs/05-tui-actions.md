# 05 - Worker Brief: Recovery TUI Actions

Guard: Use this brief only for a future source implementation pass; do not execute it during docs-only pack maintenance.

You are implementing the TUI-facing recovery prompt and action parsing for diptych / tiny-spec.

Run this brief after `01-recovery-state.md` through `04-action-handlers.md` have landed. Do not redesign the workflow screen unless the existing input mode cannot present the required choices.

## Mission

Show clear, compact recovery prompts in the workflow TUI and convert user input into typed recovery actions.

## Required Reading

- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/WORKFLOW.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/spec.md`
- `docs/superpowers/specs/2026-04-28-recovery-flow/decisions.md`
- recovery types, events, stop points, and action callbacks added by briefs 01 through 04
- `src/features/workflow/hooks/use-workflow-runner.ts`
- `src/features/workflow/user-edit-conflict-prompt.ts`
- current input mode hooks under `src/features/workflow/hooks/`

## Write Ownership

You may edit only these source areas:

- `src/features/workflow/recovery-prompt.ts` if you create it
- `src/features/workflow/recovery-prompt.test.ts` if you create it
- `src/features/workflow/user-edit-conflict-prompt.ts`
- `src/features/workflow/hooks/use-workflow-runner.ts`
- `src/features/workflow/hooks/*` only if required for recovery input mode
- `src/features/workflow/components/*` only if required to render recovery state already exposed by the store
- tests colocated with these files

Do not edit engine files except for small type import fixes requested by TypeScript. If engine behavior is missing, stop and report it to the coordinator instead of inventing a parallel TUI-only state.

## Required Behavior

- Format a recovery prompt that answers:
  - what stopped,
  - which task/file is affected,
  - what evidence or validation failed,
  - which worker/profile was involved when known,
  - what action is recommended,
  - which key selects each available action.
- Parse user input into typed recovery actions.
- Hide or disable unavailable actions.
- Preserve existing user-edit conflict safety while routing it through recovery copy where possible.
- Preserve budget pause semantics while routing it through recovery copy where possible.
- Ensure `budget-exceeded` does not show ordinary `continue`.
- Show planner split/rebase proposals with approve, edit, and reject choices before execution resumes.
- On resume, show pending recovery before any new worker call.

## Copy Shape

Use compact text similar to:

```text
Recovery needed: T003 validation failed after 3 attempts
Last check: npm test -- auth failed
Worker: local-qwen

[r] retry same worker
[b] route to bigger worker: cheap-cloud
[p] ask planner to split/rebase
[s] skip task
[space] pause
[a] abort
```

Budget exceeded must omit `[c] continue`; planner proposals must show approve/edit/reject. Do not add visible tutorial text, marketing copy, or long explanations inside the app.

## Constraints

- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not revert other agents' edits.
- Same-checkout writes must be sequential.
- TypeScript ESM imports must use `.js` suffixes.
- Zero classes.
- No barrel files.
- Do not add `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Prefer existing external stores and input mode patterns, using `useSyncExternalStore` instead of expanding React Context.
- Tests should assert rendered/prompted text and parsed actions, not hook internals or trivial hook behavior.

## Non-Goals

- No kanban.
- No plan archive.
- No multi-agent manager UI.
- No full-screen recovery dashboard in v1.
- No MCP write tools.
- No same-checkout parallel writes.

## Validation Commands

Run targeted TUI tests relevant to files you touched, then:

```bash
npm run typecheck
npm run lint
```

If you add prompt tests, run:

```bash
npm test -- src/features/workflow/recovery-prompt.test.ts
```

## Expected Final Report

Report:

- files changed,
- prompt examples covered,
- actions parsed,
- resume or planner proposal behavior touched or confirmed,
- tests run and results,
- skipped validation and why,
- risks or source behavior still needed from earlier briefs,
- confirmation that no staging, commits, or stash operations were run.
