# 00 — Coordinator

> Use this when coordinating the Smart Intake -> Mode Advisor -> Brief Review UX spec.
> Do **not** stage or commit.

## Execution Order

```text
01 Smart Intake & Mode Advisor
  ├─ 03 Cost/Risk UX
  └─ 02 Brief Review Gate
        └─ 03 Cost/Risk UX refinement
```

Recommended:

1. `01-smart-intake-mode-advisor.md`
2. `02-brief-review-gate.md`
3. `03-cost-risk-ux.md`

## Shared Files To Read

- `CLAUDE.md`
- `docs/WORKFLOW.md`
- `docs/STORES.md`
- `docs/HOOKS.md`
- `src/engine/orchestrator/planning/mode-advisor.ts`
- `src/engine/orchestrator/planning/run.ts`
- `src/features/workflow/screen.tsx`
- `src/features/workflow/components/input-footer.tsx`
- `src/features/workflow/components/sidebar.tsx`
- `src/features/workflow/components/event-cards/event-card.tsx`

## Shared UI Rules

- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`, or `useImperativeHandle`.
- Use external stores or existing input modes.
- No nested cards.
- Text must fit small terminal widths.
- Engine code remains React-free.

## Verification

```bash
npm run typecheck
npm run lint
npm test
```
