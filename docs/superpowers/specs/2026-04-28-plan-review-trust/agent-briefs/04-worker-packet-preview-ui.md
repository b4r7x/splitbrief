# Worker Brief 04: Worker Packet Preview UI

Use only for a future source implementation pass; do not execute during docs-only pack maintenance.

## Mission

Integrate the Worker Packet Preview into rich Plan Editor as an optional read-only selected-task panel.

## Owned Files

- `src/features/workflow/components/plan-editor.tsx`
- `src/features/workflow/hooks/use-plan-editor-keys.ts` if key handling must be extended
- `src/stores/workflow/plan-editor.ts` only if component-local state is not viable
- Component/UI tests for the touched behavior

## Read First

- `CLAUDE.md`
- `docs/HOOKS.md`
- `docs/TESTING.md`
- `docs/superpowers/specs/2026-04-28-plan-review-trust/decisions.md`
- `docs/superpowers/specs/2026-04-28-plan-review-trust/verification.md`
- `src/features/workflow/worker-packet-preview.ts`
- `src/features/workflow/components/plan-editor.tsx`
- `src/features/workflow/hooks/use-plan-editor-keys.ts`
- `src/stores/workflow/plan-editor.ts`

## Constraints

- Node.js 22+, TypeScript ESM with `.js` imports.
- No classes, no barrels.
- No `useMemo`, `useCallback`, `React.memo`, or `forwardRef`.
- Do not run `git add`, `git stage`, `git commit`, or `git stash`.
- No renderHook tests for trivial wrappers.
- Keep UI compact and terminal-safe.

## What To Change

- Add a non-conflicting preview toggle key, preferably `p`.
- Show selected-task packet preview when open.
- Include:
  - worker/cost/write mode line,
  - fit/tokens/context line,
  - current-code mode line,
  - redaction/truncation notice when applicable,
  - system preamble and task prompt excerpts.
- Ensure cursor movement updates the selected task preview.
- Collapse or hide preview when height is too small.
- Update footer help text carefully for narrow and wide modes.

## What Not To Change

- Do not alter task save, approve, discard, split, merge, reorder, or external-editor behavior.
- Do not add simple Brief Review preview in v1.
- Do not create dashboard cards or kanban columns.
- Do not persist preview state unless necessary.

## Validation

Run changed UI tests, then:

```bash
npm run typecheck
npm run lint
```

If this is the final stable workflow UI/routing integration slice, also run `npm test`; otherwise state why full-suite validation was skipped or deferred.

Manual checks must follow `docs/superpowers/specs/2026-04-28-plan-review-trust/verification.md`: use a disposable fixture workflow, stubbed planner/implementer runners, no real credentials, no network, and no writes to the user's working checkout. Do not call real models or spend tokens.

- `p` opens and closes preview.
- Preview changes with selected task.
- Preview is read-only.
- Narrow and short terminals remain readable.

## Expected Final Report

Include:

- Files changed.
- Tests run and results.
- Validation skipped, with explicit reason.
- Remaining risks or follow-up work.
- Confirmation that you did not run `git add`, `git stage`, `git commit`, or `git stash`.
