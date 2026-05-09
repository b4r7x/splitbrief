# Agent Brief 03 - Palette And Help Features

## Goal

Move global overlays out of generic/shared or workflow-owned locations:

- Command palette -> `src/features/palette`
- Help overlay -> `src/features/help`

## Write Scope

- `src/features/workflow/components/command-palette-overlay.tsx`
- `src/features/workflow/components/command-palette-overlay.test.tsx`
- `src/engine/palette-aggregate.ts`
- `src/engine/palette-aggregate.test.ts`
- `src/stores/ui/palette-mru.ts`
- `src/stores/ui/palette-mru.test.ts`
- `src/components/overlays/help-overlay.tsx`
- `src/app.tsx`
- Active docs mentioning these paths

## Move Map

| Current | Target |
|---|---|
| `src/features/workflow/components/command-palette-overlay.tsx` | `src/features/palette/overlay.tsx` |
| `src/features/workflow/components/command-palette-overlay.test.tsx` | `src/features/palette/overlay.test.tsx` |
| `src/engine/palette-aggregate.ts` | `src/features/palette/results.ts` |
| `src/engine/palette-aggregate.test.ts` | `src/features/palette/results.test.ts` |
| `src/stores/ui/palette-mru.ts` | `src/stores/ui/command-palette-mru.ts` |
| `src/stores/ui/palette-mru.test.ts` | `src/stores/ui/command-palette-mru.test.ts` |
| `src/components/overlays/help-overlay.tsx` | `src/features/help/overlay.tsx` |

## Required Symbol Names

- `CommandPaletteOverlay` can remain exported from `features/palette/overlay.tsx`.
- `buildPaletteResults` can remain if it is still the clearest domain name.
- `PaletteResult` can remain.
- `paletteMruStore` should become `commandPaletteMruStore`.
- `HelpOverlay` can remain.

## Behavior Must Stay The Same

- `Ctrl+K` opens the palette.
- Palette source ranking and MRU behavior are unchanged.
- Palette still dispatches runtime command lines.
- `Ctrl+/` and `/help` open the help overlay.
- Help overlay still lists runtime commands and shortcuts for the current screen.

## Validation

Run:

```bash
npm run typecheck
npm test -- src/features/palette src/features/help src/stores/ui/command-palette-mru.test.ts src/app/keys.test.tsx
rg -n "workflow/components/command-palette-overlay|engine/palette-aggregate|components/overlays/help-overlay|palette-mru" src docs --glob '!docs/superpowers/specs/**'
```

