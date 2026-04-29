# 04 - Auto-Split Overflow

> Proposed implementation brief for a fresh, cheap AI context.
> Depends on brief 02. Can optionally use brief 03 output.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

You add optional targeted auto-splitting for tasks that do not fit cheap implementer context.

## Required Skills

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `plan-writing`

Use `code-audit` only as a checklist if needed. Do not run a full audit.

## Read First

- `CLAUDE.md`
- `docs/TASK-CONTRACT.md`
- deterministic estimate implementation from brief 02,
- existing plan/brief review flow,
- existing task parsing/writing code.

## Primary Write Scope

Own split-related files:

- task split service under `src/engine/orchestrator/` or existing task compilation area,
- integration with plan/brief review so user sees changed tasks,
- tests around targeted splitting.

Ask coordinator before editing planner estimate review, worktree code, or task execution.

## Requirements

Auto-split must:

- be off by default,
- only target overflow/high-risk tasks,
- preserve task intent,
- preserve acceptance criteria,
- preserve dependencies when possible,
- produce reviewable task changes before execution,
- avoid splitting into silly tiny tasks,
- avoid rewriting the whole plan.

If splitting cannot be done safely, return a user-visible reason and keep the original plan.

## Split Heuristics

Start simple:

- split by file ownership,
- split by independent acceptance criteria,
- split setup/core/UI/tests only when those are real separate responsibilities,
- do not split a task that is already tiny,
- do not create more child tasks than a configured or hard-coded safe limit.

The output should include parent task id and child task ids so trace/explain can show why it happened.

## Tests

Add behavior tests for:

- overflowing task gets split when enabled,
- non-overflowing task does not get split,
- acceptance criteria survive,
- dependencies are preserved or explicitly rewritten,
- unsafe split is rejected,
- feature is off by default.

## Validation

Run targeted split/task compiler tests, then:

```bash
npm run typecheck
npm run lint
```

## Expected Report

Include changed files, split behavior, validation results, skipped commands with reasons, remaining risks, and git guardrail confirmation.
