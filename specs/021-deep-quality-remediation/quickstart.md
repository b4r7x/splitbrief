# Quickstart: Deep Code Quality Remediation

**Feature**: 021-deep-quality-remediation

## What This Changes

This is a pure internal refactoring. No user-facing behavior changes, no config format changes, no new commands.

## Verification

After implementation, verify:

```bash
# Build must pass
npm run build

# All tests must pass
npm test

# Start a workflow and open help overlay — workflow must continue
npm run dev -- start "test feature"
# Press ? to open help, then Esc to close — workflow should not be interrupted

# Resume must work identically to start
npm run dev -- resume
```

## Key Changes for Contributors

1. **Overlays no longer unmount screens** — router renders overlays as siblings with `display="none"` on the screen.
2. **highlight.ts moved** from `src/engine/` to `src/utils/` — update imports if you reference it.
3. **cli.ts split** into `src/cli.ts` + `src/cli/picker.ts` + `src/cli/render.ts`.
4. **config.ts split** — validation logic now in `src/config-validation.ts`.
5. **New shared hook**: `useFilterableList` in `src/hooks/use-filterable-list.ts` — use it for any filterable list UI.
6. **Event types are now type-checked** — adding a new TuiEvent type requires handling it in event-card.tsx (compiler enforced).
7. **Theme access standardized** — always use `useAppContext()`, never pass `theme` as a prop.

## Files Deleted

None — this is restructuring, not deletion. Files are split/moved but all functionality is preserved.

## New Files

| File | Purpose |
| ---- | ------- |
| `src/cli/picker.ts` | Interactive planner/implementer selection (extracted from cli.ts) |
| `src/cli/render.ts` | Fullscreen rendering helper (extracted from cli.ts) |
| `src/config-validation.ts` | Config field validation (extracted from config.ts) |
| `src/engine/spec/token-budget.ts` | Token estimation and budgeting (extracted from formatter.ts) |
| `src/hooks/use-filterable-list.ts` | Shared filterable list keyboard interaction hook |
