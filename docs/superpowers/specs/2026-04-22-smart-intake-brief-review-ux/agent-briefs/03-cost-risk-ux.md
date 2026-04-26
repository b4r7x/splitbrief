# 03 — Cost/Risk UX

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Goal

Make workflow and summary surfaces explain the cost-aware compiler model without verbose copy.

The user should see:

- mode,
- risk/advisor result,
- Task Brief quality score, rendering `quality n/a` when no report exists,
- predicted vs actual cost, rendering `prediction n/a` when no prediction exists,
- local vs escalated execution,
- evidence/drift warning counts, rendering nothing only when the artifact does not exist for old sessions.

## Read First

- `CLAUDE.md`
- `docs/VISION.md`
- `docs/WORKFLOW.md`
- `src/engine/orchestrator/cost-prediction.ts`
- `src/engine/orchestrator/summary.ts`
- `src/features/workflow/components/cost-footer.tsx`
- `src/features/workflow/components/cost-display.tsx`
- `src/features/workflow/components/sidebar.tsx`
- `src/features/summary/screen.tsx`
- `src/features/summary/components/summary-cost-breakdown.tsx`

## Files To Touch

- `src/engine/orchestrator/summary.ts`
- `src/core/schemas/summary.ts`
- `src/features/workflow/components/cost-footer.tsx`
- `src/features/workflow/components/sidebar.tsx`
- `src/features/workflow/components/event-cards/cost-prediction-card.tsx`
- `src/features/summary/screen.tsx`
- `src/features/summary/components/summary-cost-breakdown.tsx`
- tests for touched components/helpers
- docs: `docs/WORKFLOW.md`

Do not touch parser/formatter or provider pricing unless a bug blocks rendering.

## UI Principles

- Dense rows, no explanatory panels.
- Do not say "full" mode.
- Do not hide unpriced usage; label it as unpriced/subscription/local.
- Show savings only when the underlying pricing data supports it.
- Use existing theme and layout patterns.

## Suggested Copy

Footer examples:

- `Task 2/5 · mode standard · risk normal · $0.14 expected`
- `Task 1/1 · mode instant · local`
- `queue: 2 · advisor: consider quick`

Summary examples:

- `Planner compiled 5 briefs · Implementer completed 4 locally · 1 escalated`
- `Evidence: 5/5 tasks have validation proof`
- `Drift: 1 warning`

## Tests

- mode/risk label formats correctly.
- unpriced usage does not show fake savings.
- small terminal layout does not overflow expected widths.
- summary copy uses Task Brief/compiler language.

## Acceptance Criteria

- Cost/risk posture is visible without raw logs.
- Copy aligns with cost-aware task compiler model.
- UI remains compact.
- `npm run test-ci` passes.

## Verification Commands

```bash
npm test -- src/engine/orchestrator/summary.test.ts src/features/workflow/components/cost-footer.test.ts
npm run typecheck
npm run lint
npm test
```
