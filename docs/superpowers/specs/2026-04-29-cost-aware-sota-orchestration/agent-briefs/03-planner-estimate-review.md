# 03 - Planner Estimate Review

> Proposed implementation brief for a fresh, cheap AI context.
> Depends on brief 02.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

You add optional smarter-model review of the deterministic estimate. This is not the default path.

## Required Skills

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `prompt-engineering` or `senior-prompt-engineer` if available.

Use `code-audit` only as a checklist if needed. Do not run a full audit.

## Read First

- `CLAUDE.md`
- deterministic estimate implementation from brief 02,
- existing planner/spec prompt modules,
- existing config/schema patterns,
- existing review packet code.

## Primary Write Scope

Own planner-estimate review files:

- estimate review packet builder under `src/engine/orchestrator/` if needed,
- planner prompt/module under existing prompt patterns,
- config/schema flags for opt-in planner estimate review,
- tests for opt-in behavior and packet shape.

Ask coordinator before editing auto-split mutation or task loop execution.

## Requirements

Planner estimate review must be:

- off by default,
- explicitly opt-in by config/CLI/TUI path,
- based on compact estimate packet, not full repo context,
- safe to fail without blocking deterministic estimate,
- visible to user as an extra planner call.

Planner review output should classify:

- `ok`,
- `split-suggested`,
- `risk`,
- `needs-user-decision`.

The planner may suggest splitting or stronger implementer use, but it must not silently reassign models. The user decides.

## Prompt Rules

Prompt should ask for:

- cost risk,
- context overflow risk,
- cheap implementer failure risk,
- concrete task ids affected,
- short reason,
- recommended user choice.

Prompt should not ask for broad code review or a new full plan.

## Tests

Add behavior tests proving:

- planner review is off by default,
- opt-in triggers planner packet creation,
- compact packet omits huge bodies when not needed,
- planner failure falls back to deterministic estimate,
- review classification is parsed/validated.

Do not snapshot huge prompts unless the repo already uses that pattern.

## Validation

Run targeted planner estimate tests, then:

```bash
npm run typecheck
npm run lint
```

## Expected Report

Include changed files, opt-in behavior, validation results, skipped commands with reasons, remaining risks, and git guardrail confirmation.
