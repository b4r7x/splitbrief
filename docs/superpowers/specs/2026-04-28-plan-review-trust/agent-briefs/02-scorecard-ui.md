# Worker Brief 02: Scorecard UI

Use only for a future source implementation pass; do not execute during docs-only pack maintenance.

## Mission

Render the scorecard in simple Brief Review and rich Plan Editor.

## Owned Files

- `src/features/workflow/components/brief-review-view.tsx`
- `src/features/workflow/components/plan-editor.tsx`
- Component tests only if they already exist or coordinator asks you to add them.

## Read First

- `CLAUDE.md`
- `docs/HOOKS.md`
- `docs/TESTING.md`
- `docs/superpowers/specs/2026-04-28-plan-review-trust/spec.md`
- `docs/superpowers/specs/2026-04-28-plan-review-trust/verification.md`
- `src/features/workflow/plan-review-scorecard.ts`
- `src/features/workflow/components/brief-review-view.tsx`
- `src/features/workflow/components/plan-editor.tsx`

## Constraints

- Node.js 22+, TypeScript ESM with `.js` imports.
- No classes, no barrels.
- No `useMemo`, `useCallback`, or `React.memo`.
- No `forwardRef`.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Keep Ink layout dense and text-first.

## What To Change

- Use the scorecard helper with current tasks, quality report, and `planEditorStore.reviewMetadata`.
- Render stable compact labels:
  - `ready N`
  - `routing pending N`
  - `split/overflow N`
  - `risky/tight N`
  - `stale/conflict N`
  - `missing checks N`
- Place scorecard near the existing quality and routing summary.
- Use existing theme colors.
- Keep narrow terminals readable.

## What Not To Change

- Do not remove existing task rows, review lines, quality display, or footer commands.
- Do not add cards, columns, kanban, archive UI, or assignment UI.
- Do not create a new store.
- Do not change approval/edit/save behavior.

## Validation

Run targeted tests for changed components if present, then:

```bash
npm run typecheck
npm run lint
```

If this is the final stable workflow UI/routing integration slice, also run `npm test`; otherwise state why full-suite validation was skipped or deferred.

Manual checks must follow `docs/superpowers/specs/2026-04-28-plan-review-trust/verification.md`: use a disposable fixture workflow, stubbed planner/implementer runners, no real credentials, no network, and no writes to the user's working checkout. Do not call real models or spend tokens.

- Scorecard appears in simple review.
- Scorecard appears in rich editor.
- Counts respond to metadata and missing checks.
- Unknown or pending context fit appears as `routing pending`, not ready.

## Expected Final Report

Include:

- Files changed.
- Tests run and results.
- Validation skipped, with explicit reason.
- Remaining risks or follow-up work.
- Confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
