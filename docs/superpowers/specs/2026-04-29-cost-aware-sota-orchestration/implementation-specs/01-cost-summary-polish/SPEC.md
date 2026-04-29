# 01 - Cost Summary Polish

> Self-contained implementation spec for one fresh AI context.
> This is one of seven implementation contexts for the cost-aware SOTA orchestration pack.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Goal

Make the end-of-run cost summary obvious and trustworthy.

The user should finish a run and immediately understand:

- how much the planner cost,
- how much implementers cost,
- total actual cost,
- what the run would have cost if the planner implemented every task,
- how much was saved,
- what percentage was saved,
- which tasks used cheap/local implementers.

## Required Skills

Use these skills:

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `react-senior-guide` if touching React/Ink components.

Use `code-audit` only as a checklist. Do not run the full audit unless the user explicitly asks.

## Read First

Read only what you need, in this order:

1. `CLAUDE.md`
2. `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
3. `docs/TESTING.md`
4. `src/engine/orchestrator/summary.ts`
5. `src/core/schemas/summary.ts`
6. `src/features/summary/components/summary-cost-breakdown.tsx`
7. Summary/review-packet tests found with `rg "CostBreakdown|estimatedCostSavings|summary-cost" src`

## Owned Files

Primary ownership:

- `src/engine/orchestrator/summary.ts`
- `src/core/schemas/summary.ts`
- `src/features/summary/components/summary-cost-breakdown.tsx`
- `src/features/summary/screen.tsx`
- directly related summary/review-packet tests.

Do not edit:

- readiness/doctor files,
- planner estimate review files,
- task loop,
- plan editor,
- worktree code.

If you need an adjacent file, keep it narrow and report it.

## Current Assumptions

Current code likely already has:

- `CostBreakdownSchema`,
- `estimatedCostSavings`,
- actual planner/implementer cost fields,
- task breakdown cost metadata,
- summary TUI component.

Your job is probably polish/completion, not inventing the whole feature.

## Functional Requirements

### CS-001 - Summary Has Complete Cost Breakdown

The summary data should support these visible concepts:

- actual planner cost,
- actual implementer cost,
- total actual cost,
- all-planner baseline or hypothetical cost,
- savings amount,
- savings percentage,
- local/cheap completion rate,
- provider-level costs when available.

### CS-002 - Unknown Cost Is Not Zero

If price is unknown, show it as unknown/unavailable.

Do not render unknown pricing as `$0.00`. That lies to the user.

### CS-003 - Task-Level Evidence Survives

Each task summary should preserve enough metadata to answer:

- which implementer/profile ran it,
- was the task local/cheap/planner/escalated,
- what was the estimated or actual task cost,
- why savings may be unknown.

### CS-004 - React Component Is Dumb

Cost math belongs in engine/core.

React/Ink should only render prepared values.

## Implementation Steps

1. Inspect existing summary schemas and builders.
2. Identify whether any required field is missing or hidden.
3. Add missing schema fields only if needed.
4. Keep cost calculation in `src/engine/orchestrator/summary.ts` or existing pricing helpers.
5. Update rendered summary copy so unknown values are explicit.
6. Add/adjust tests around public summary behavior.
7. Run focused validation.

## UI Copy Rules

Keep labels short:

- `Actual cost`
- `All-planner baseline`
- `Saved`
- `Local/cheap rate`
- `Unknown price`

Avoid marketing text. This is a CLI/TUI product surface, not a landing page.

## Test Requirements

Test behavior, not internals.

Required cases:

- known planner and implementer cost computes savings,
- unknown implementer price renders unknown,
- all-planner baseline is visible when available,
- local/cheap completion rate is shown when available,
- rendered output has the user-facing labels.

Do not add tests that only check private helper calls.

## Validation

Run targeted tests for changed summary files.

Then run:

```bash
npm run typecheck
npm run lint
```

If broader tests are skipped, report why.

## Anti-Slop Checks

Before finishing:

- no second cost model,
- no fake zero cost,
- no new React Context,
- no memoization,
- no classes,
- no broad refactor,
- no tiny hook wrapper tests.

## Agent Prompt

Use this prompt when assigning the context:

```text
Implement spec 01 Cost Summary Polish from docs/superpowers/specs/2026-04-29-cost-aware-sota-orchestration/implementation-specs/01-cost-summary-polish/SPEC.md.
You are not alone in the codebase. Do not revert edits made by others.
Own only the files listed in the spec unless a narrow adjacent edit is necessary.
Do not run git add, git stage, git commit, or git stash.
Use behavior tests only. Report changed files, validation, skipped validation, risks, and git confirmation.
```
