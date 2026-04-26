# 00 — Coordinator

> Use this only when coordinating the full plan-editor-screen spec.
> If assigned one brief, implement only that brief.
> Do **not** run `git add`, `git stage`, or `git commit`.

## Execution Order

```text
01 Plan Editor Store
  └─ 02 Plan Editor Actions (can run in parallel with 01)
       └─ 03 Plan Editor Component (depends on 01 + 02)
            └─ 04 Keystroke Bindings (depends on 03)
                 └─ 05 Save and Commit (depends on 01 + 03; includes engine re-parse change)
```

Recommended order:

1. `01-plan-editor-store.md` — store first; all other briefs import from it.
2. `02-plan-editor-actions.md` — pure functions, no React/Ink dependency. Can start as soon as 01 types are available.
3. `03-plan-editor-component.md` — TUI component; depends on store (01) and actions (02).
4. `04-keystroke-bindings.md` — input hook and help overlay; depends on component (03) being wired.
5. `05-save-and-commit.md` — atomic save + engine re-parse; depends on store (01) and component (03). Also contains the one targeted engine change to `runBriefsApprovalLoop`.

Briefs 01 and 02 may be dispatched in parallel.

## Shared Files To Read

- `CLAUDE.md`
- `docs/WORKFLOW.md`
- `docs/TASK-CONTRACT.md`
- `docs/STORES.md`
- `docs/HOOKS.md`
- `src/core/schemas/task.ts`
- `src/core/paths.ts`
- `src/stores/create-store.ts`
- `src/stores/navigation/router.ts` (for `OverlayType` union)
- `src/stores/ui/overlay.ts`
- `src/stores/workflow/review.ts` (store pattern reference)
- `src/engine/spec/parser.ts` (parseTasks)
- `src/engine/spec/brief-quality.ts` (evaluateBriefQuality)
- `src/engine/orchestrator/planning/shared.ts` (runBriefsApprovalLoop — brief 05 touches this)
- `src/features/workflow/screen.tsx` (mount point)
- `src/features/workflow/components/brief-review-view.tsx` (coexisting view)
- `src/features/workflow/components/cost-drilldown-overlay.tsx` (overlay pattern)
- `src/features/workflow/hooks/use-workflow-keys.ts` (input hook pattern)

## Shared Invariants

- Do not stage or commit.
- No new runtime dependencies.
- No classes anywhere in `src/`.
- No barrels (`find src -name 'index.ts'` must return nothing after your change).
- Use ESM `.js` import suffixes in every import statement.
- Engine code (`src/engine/`) must not import React, Ink, or anything under `src/features/`, `src/components/`, or `src/hooks/`.
- Pure action functions and keystroke handlers must be tested without mounting React components.
- Do not assert private helper calls. Assert returned state, written artifacts, or rendered output.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.

## Config Change (All Briefs Must Respect)

Brief 03 adds `workflow.briefReview: 'simple' | 'rich'` (default `'simple'`) to the config schema. All briefs must treat `config.workflow.briefReview` as the primary gate for mounting the rich editor.

## Verification

After each brief:

```bash
npm run typecheck
npm run lint
npm test
```

For final handoff:

```bash
npm run test-ci
```
