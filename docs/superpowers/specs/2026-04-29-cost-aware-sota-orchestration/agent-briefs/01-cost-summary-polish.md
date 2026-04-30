# 01 - Cost Summary Polish

> Proposed implementation brief for a fresh, cheap AI context.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

You improve the post-run cost summary and cost evidence. This is a trust feature: users should see whether diptych saved money.

## Required Skills

- `code-quality`
- `clean-code`
- `anti-slop`
- `test-behavior-not-implementation`
- `react-senior-guide` if editing React/Ink components.

Use `code-audit` only as a checklist if needed. Do not run a full audit.

## Read First

- `CLAUDE.md`
- `docs/TESTING.md`
- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `src/engine/orchestrator/summary.ts`
- `src/core/schemas/summary.ts`
- `src/features/summary/components/summary-cost-breakdown.tsx`
- related summary/review-packet tests.

## Primary Write Scope

Own these files if changes are needed:

- `src/engine/orchestrator/summary.ts`
- `src/core/schemas/summary.ts`
- `src/features/summary/components/summary-cost-breakdown.tsx`
- `src/features/summary/screen.tsx`
- summary-related tests.

Ask the coordinator before editing readiness, estimate, task loop, or plan editor files.

## Requirements

Post-run output should clearly show:

- actual planner cost,
- actual implementer cost,
- total actual cost,
- all-planner baseline,
- savings amount,
- savings percentage,
- local/cheap completion rate,
- per-task cost/routing evidence when available.

Unknown values must be explicit, not silently rendered as zero.

## Implementation Notes

- Prefer extending existing `CostBreakdownSchema` and summary builders.
- Keep cost math in engine/core, not React components.
- TUI component should render already-computed values.
- Do not add a new cost model if pricing helpers already exist.
- Do not add memoization.

## Tests

Add or update behavior tests that prove:

- cost breakdown is computed correctly,
- unknown pricing stays visible,
- rendered summary includes savings/baseline when available,
- task-level metadata survives into summary/review artifacts if touched.

Do not test private helper call counts.

## Validation

Run targeted tests for changed summary files, then:

```bash
npm run typecheck
npm run lint
```

Run broader tests only if the changed surface warrants it or the coordinator requests it.

## Expected Report

Include changed files, behavior implemented, validation results, skipped commands with reasons, remaining risks, and git guardrail confirmation.
