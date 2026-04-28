# 06 - Plan Review v2 TUI

> Historical note (2026-04-28): this brief was used during implementation. The current status is recorded in `../README.md`, `../tasks.md`, `../verification.md`, and `docs/COST-AWARE-IMPLEMENTER-HANDOFF.md`.
> Original fresh-context brief retained for audit; do not implement as pending work unless intentionally re-running this spec.
> For the spawned worker assigned this brief: GPT-5.5, medium reasoning.
> Do not run `git add`, `git stage`, `git commit`, or `git stash`.

## Identity

Extend the existing plan editor/review surface so users can see execution-relevant metadata before approving implementation.

## Intent

The TUI should answer: what will run, which worker will run it, will it fit, what files are touched, what validation proves success, and what checkpoint protects the user?

## Scope

**In bounds:**

- `src/stores/workflow/plan-editor.ts`
- `src/features/workflow/components/plan-editor.tsx`
- `src/features/workflow/components/brief-review-view.tsx`
- `src/features/workflow/hooks/use-plan-editor-keys.ts`
- `src/features/workflow/hooks/use-plan-editor-save.ts`
- routing/context metadata display types.
- Tests for rendered output and public store behavior.

**Out of bounds:**

- No routing algorithm changes.
- No engine-layer imports from UI.
- No kanban layout.
- No long-lived plan archive UI.

## Required Behavior

- Show per-task:
  - task ID/title/status,
  - file,
  - selected worker/profile,
  - context fit,
  - validation count/status,
  - risk or quality signal,
  - conflict/stale marker.
- Selected task detail should show:
  - scope,
  - constraints,
  - tests,
  - escalation rules,
  - checkpoint/conflict note when present.
- Keep existing edit actions:
  - edit,
  - split,
  - merge,
  - delete,
  - reorder,
  - save/approve.
- Add a concise cost/context panel or overlay.
- Avoid visible instructional prose that explains the app; labels should be terse.

## React/Ink Constraints

- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Use stores/selectors rather than context.
- Define stable dimensions for fixed-format task rows and labels.
- Do not scale font size with viewport width.

## Validation

Tests should assert:

- task row renders worker/context fit,
- overflow task is visibly blocked or marked,
- conflict marker renders with affected file/task,
- save still writes `tasks.md` and re-runs quality gate,
- narrow terminal layout does not overlap key labels.

Run:

```bash
npm test -- src/features/workflow/components/plan-editor/actions.test.ts src/features/workflow/hooks/use-plan-editor-save.test.ts src/features/workflow/hooks/use-plan-editor-keys.test.ts
npm run typecheck
npm run lint
```

## Evidence

- Plan Review v2 is still an execution review surface, not kanban.
- Users can see context/routing before approving implementation.

## Expected Final Report

Include:

- files changed;
- tests run and results;
- validation skipped, with explicit reason;
- remaining risks or follow-up work;
- confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
