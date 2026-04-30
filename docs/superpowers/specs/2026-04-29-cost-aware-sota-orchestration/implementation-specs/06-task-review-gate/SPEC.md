# 06 - Task Review Gate

> Self-contained implementation spec for one fresh AI context.
> This is one of seven implementation contexts for the cost-aware SOTA orchestration pack.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Add optional per-task review so a user can pause after task completion, inspect what happened, and choose continue/recover.

Default remains fast: no pause after every task.

## Required Skills

Use these skills:

- `react-senior-guide`
- `react-anti-patterns`
- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`

Use `code-audit` only as a checklist. Do not run the full audit unless the user explicitly asks.

## Read First

1. `CLAUDE.md`
2. `docs/STORES.md`
3. `docs/HOOKS.md`
4. `docs/TESTING.md`
5. `src/engine/orchestrator/task-loop.ts`
6. `src/features/workflow/hooks/use-workflow-runner.ts`
7. existing workflow store/action files
8. existing slash/recovery command code
9. workflow/task-loop tests.

## Owned Files

Primary ownership:

- config/schema file for `taskReview`,
- orchestrator task-loop review callback contracts,
- workflow runner integration,
- workflow review component if needed,
- task review tests.

Do not edit:

- summary cost math,
- deterministic estimate service,
- profile doctor policy,
- planner prompt code.

## Functional Requirements

### TRG-001 - Config

Add:

```text
taskReview: "none" | "failed" | "every"
```

Default:

```text
none
```

Use existing config style. If config supports nested workflow settings, place it there. If not, choose the smallest compatible addition.

### TRG-002 - Mode Behavior

`none`:

- do not pause after successful tasks.

`failed`:

- pause after validation failure,
- pause after recovery-required task state.

`every`:

- pause after every task completion,
- include successful tasks.

### TRG-003 - Review Data

Review should show:

- task id/title,
- status,
- files touched,
- validation result,
- evidence path or summary,
- cost/routing metadata when available,
- available commands.

### TRG-004 - Commands

Minimum commands:

- continue,
- redo,
- edit/notes,
- revise plan,
- abort.

Reuse existing `/redo-task`, `/revise-plan`, and recovery logic where possible. Do not create duplicate recovery systems.

### TRG-005 - Headless Behavior

If running headless/non-interactive:

- either emit machine-readable review-needed state,
- or reject `taskReview: "every"` with a clear error.

Do not hang waiting for interactive input in headless mode.

## React/TUI Rules

- Do not add React Context.
- Use existing external store/action patterns.
- Do not add derived-state effects.
- Do not add `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Keep hooks shallow.
- Test rendered behavior, not hook internals.

## Implementation Steps

1. Inspect task-loop lifecycle points after a task completes.
2. Add a review-needed callback/result shape.
3. Add config parsing/default.
4. Wire workflow runner to enter task review mode.
5. Render a compact review view or reuse an existing recovery/review component.
6. Route commands to existing recovery paths.
7. Add behavior tests.

## Test Requirements

Required behavior tests:

- default `none` does not pause,
- `every` pauses after successful task,
- `failed` pauses after failed validation,
- continue resumes next task,
- redo uses existing redo path,
- revise plan uses existing revise path,
- abort stops safely,
- rendered review includes task metadata.

Do not add tiny hook wrapper tests.

## Validation

Run targeted workflow/task-loop tests.

Then run:

```bash
npm run typecheck
npm run lint
```

## Anti-Slop Checks

Before finishing:

- no new React Context,
- no duplicated recovery system,
- no default pause-every-task behavior,
- no memoization,
- no hook implementation tests,
- no broad workflow refactor.

## Agent Prompt

```text
Implement spec 06 Task Review Gate from docs/superpowers/specs/2026-04-29-cost-aware-sota-orchestration/implementation-specs/06-task-review-gate/SPEC.md.
You are not alone in the codebase. Do not revert edits made by others.
Own only the files listed in the spec unless a narrow adjacent edit is necessary.
Do not run git add, git stage, git commit, or git stash.
Keep task review opt-in. Follow repo React rules. Use behavior tests only.
Report changed files, validation, skipped validation, risks, and git confirmation.
```
