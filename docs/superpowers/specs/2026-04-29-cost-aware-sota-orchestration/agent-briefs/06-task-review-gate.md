# 06 - Task Review Gate

> Proposed implementation brief for a fresh, cheap AI context.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

You add optional per-task review. This lets the user pause after each task, inspect result/evidence/cost, then continue or recover.

## Required Skills

- `react-senior-guide`
- `react-anti-patterns`
- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`

Use `code-audit` only as a checklist if needed. Do not run a full audit.

## Read First

- `CLAUDE.md`
- `docs/STORES.md`
- `docs/HOOKS.md`
- `docs/TESTING.md`
- existing workflow store/action patterns,
- `src/engine/orchestrator/task-loop.ts`
- `src/features/workflow/hooks/use-workflow-runner.ts`
- existing slash/recovery command code.

## Primary Write Scope

Own task-review files:

- config/schema for `taskReview`,
- orchestrator task-loop review callback contracts,
- workflow runner integration,
- new or existing workflow review component,
- task review tests.

Ask coordinator before editing cost summary, estimate review, or readiness doctor files.

## Requirements

Config:

```text
taskReview: "none" | "failed" | "every"
```

Default:

```text
none
```

Behavior:

- `none`: no per-task pause after successful tasks,
- `failed`: pause after failed validation or recovery-required state,
- `every`: pause after every task completion,
- final review still exists,
- headless mode must be explicit and machine-readable or reject unsupported interactive review.

Review screen/output should show:

- task id/title,
- status,
- files touched,
- validation result,
- evidence path or summary,
- cost/routing metadata if available,
- commands: continue, redo, edit/notes, revise plan, abort.

## React/TUI Rules

- Do not add React Context.
- Keep state in existing external store/action patterns.
- Do not add derived-state effects.
- Do not add `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Keep hooks shallow.
- Test user-visible behavior, not hook internals.

## Tests

Add behavior tests for:

- default mode does not pause,
- `every` pauses after success,
- `failed` pauses after failure,
- continue resumes next task,
- redo/revise/abort use existing recovery paths,
- rendered review includes key task metadata.

Do not add tests for tiny hook wrappers.

## Validation

Run targeted workflow/task-loop tests, then:

```bash
npm run typecheck
npm run lint
```

## Expected Report

Include changed files, task review UX behavior, validation results, skipped commands with reasons, remaining risks, and git guardrail confirmation.
