# Agent Brief 04 - App Shell, Runners, And Docs

## Goal

Clean up remaining naming and ownership mismatches that make the React structure feel less intentional.

## Write Scope

- `src/hooks/use-app-keys.ts` and test
- `src/hooks/navigate-index.ts`
- `src/features/settings/use-edit-buffer.ts`
- `src/features/settings/use-settings-editor.ts`
- `src/features/tool-picker/**`
- `src/app.tsx`
- Active docs

## Required Moves

| Current | Target |
|---|---|
| `src/hooks/use-app-keys.ts` | `src/app/keys.ts` |
| `src/hooks/use-app-keys.test.tsx` | `src/app/keys.test.tsx` |
| `src/hooks/navigate-index.ts` | `src/utils/indexing.ts` or `src/components/pickers/navigation.ts` |
| `src/features/settings/use-edit-buffer.ts` | `src/features/settings/hooks/buffer.ts` |
| `src/features/settings/use-settings-editor.ts` | `src/features/settings/hooks/editor.ts` |
| `src/features/tool-picker/**` | `src/features/runners/**` |

## Naming Guidance

- Keep exported hook names such as `useAppKeys` if changing them adds no value.
- For settings hooks, exported names may remain `useEditBuffer` and `useSettingsEditor`.
- For runner picker, folder rename is enough. Keep `ToolModelPicker` if a broader symbol rename creates too much churn.
- If moving `navigate-index.ts` to `components/pickers/navigation.ts` would cause `src/hooks` to import from `src/components`, use `src/utils/indexing.ts` instead.

## Docs To Update

Update active docs that mention old paths:

- `CLAUDE.md`
- `docs/ARCHITECTURE.md`
- `docs/STRUCTURE.md`
- `docs/LAYERS.md`
- `docs/TYPES.md`
- `docs/HOOKS.md`
- `docs/SUBSYSTEMS.md`
- `docs/SLASH-COMMANDS-REFERENCE.md`
- `docs/NO-BARRELS.md`
- `docs/GETTING-STARTED.md`
- `docs/USAGE-EXAMPLES.md`

Do not rewrite old specs under `docs/superpowers/specs/**`.

## Validation

Run:

```bash
npm run typecheck
npm test -- src/app/keys.test.tsx src/hooks src/features/settings src/features/runners src/features/setup/screen.test.tsx
rg -n "hooks/use-app-keys|navigate-index|features/tool-picker|src/features/tool-picker|tool-picker/" src docs --glob '!docs/superpowers/specs/**'
```

