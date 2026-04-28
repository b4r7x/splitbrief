# Worker Brief 01: Scorecard Model

Use only for a future source implementation pass; do not execute during docs-only pack maintenance.

## Mission

Add a pure scorecard view model for Plan Review readiness.

## Owned Files

- Likely new `src/features/workflow/plan-review-scorecard.ts`
- Likely new `src/features/workflow/plan-review-scorecard.test.ts`

Do not edit UI files unless the coordinator explicitly expands your scope.

## Read First

- `CLAUDE.md`
- `docs/TESTING.md`
- `docs/COST-AWARE-IMPLEMENTER-DIRECTION.md`
- `docs/superpowers/specs/2026-04-28-plan-review-trust/spec.md`
- `src/stores/workflow/plan-editor.ts`
- `src/features/workflow/components/brief-review-view.tsx`

## Constraints

- Node.js 22+, TypeScript ESM with `.js` import suffixes.
- No classes, no barrels.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- Do not use React hooks in this helper.
- Tests must assert returned scorecard behavior, not internal calls.

## What To Change

- Implement a helper that accepts:
  - `tasks: Task[]`
  - `quality: BriefQualityReport | null`
  - `metadata: ReadonlyMap<string, PlanTaskReviewMetadata>`
- Return bucket counts and task ids for:
  - ready
  - routing pending
  - split/overflow
  - risky/tight
  - stale/conflict
  - missing checks
- Make `ready` exclusive. Warning buckets can overlap.
- Add a compact formatter if useful for UI.

## Classification Rules

- Ready requires fresh routing metadata for the current task content, `contextFit === 'fits'`, a selected worker profile, no error issues, no overflow/no worker, no stale/conflict, validation present and not fail, evidence present.
- Routing pending includes missing metadata, stale metadata, pending estimate status, unknown/missing context fit, or metadata tied to an older task checkpoint.
- Split/overflow includes `contextFit === 'overflow'`, no worker due to overflow/no capable profile, `multi_file_task`, `non_atomic_task`.
- Risky/tight includes `contextFit === 'tight'`, high risk, validation warn, or context reduction that signals tight fit.
- Stale/conflict includes `metadata.stale`, `metadata.conflict`, missing/unavailable current code.
- Missing checks includes no tests, no evidence, `missing_validation`, `vague_validation`, or `missing_evidence`.

## What Not To Change

- Do not alter routing behavior.
- Do not alter `planEditorStore`.
- Do not render UI.
- Do not create a project-management status model.

## Validation

Run:

```bash
npx vitest run src/features/workflow/plan-review-scorecard.test.ts
npm run typecheck
```

If this is the final stable workflow UI/routing integration slice, also run `npm test`; otherwise state why full-suite validation was skipped or deferred.

## Expected Final Report

Include:

- Files changed.
- Tests run and results.
- Validation skipped, with explicit reason.
- Remaining risks or follow-up work.
- Confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
