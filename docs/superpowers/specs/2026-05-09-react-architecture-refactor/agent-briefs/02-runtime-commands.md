# Agent Brief 02 - Runtime Commands

## Goal

Move command infrastructure away from `slash` naming. `/` remains user syntax, but source should model app runtime commands.

## Write Scope

- `src/core/slash-commands/**` -> `src/core/runtime/commands/**`
- `src/core/keybindings/registry.ts`
- Imports in app, CLI, engine, features, composer, overlays, and tests
- Active docs mentioning old command paths

## Move Map

| Current | Target |
|---|---|
| `src/core/slash-commands/types.ts` | `src/core/runtime/commands/types.ts` |
| `src/core/slash-commands/catalog.ts` | `src/core/runtime/commands/registry.ts` |
| `src/core/slash-commands/catalog.test.ts` | Split or move to `src/core/runtime/commands/registry.test.ts` and `dispatch.test.ts` |
| `src/core/slash-commands/dispatch.ts` | `src/core/runtime/commands/dispatch.ts` |
| `src/core/slash-commands/fuzzy.ts` | `src/core/runtime/commands/lookup.ts` |
| `src/core/slash-commands/fuzzy.test.ts` | `src/core/runtime/commands/lookup.test.ts` |
| `src/core/slash-commands/keybindings.ts` | `src/core/keybindings/registry.ts` |

## Required Symbol Renames

- `SlashCommandDef` -> `RuntimeCommandDef`
- `CommandContext` -> `RuntimeCommandContext`
- `CommandPaletteItem` -> `RuntimeCommandPaletteItem` or keep `CommandPaletteItem` only if changing it causes unnecessary noise
- `createCommands` -> `createRuntimeCommands`
- `executeSlashCommand` -> `executeRuntimeCommand`
- `findCommand` -> `findRuntimeCommand`
- `fuzzyMatchCommand` -> `suggestRuntimeCommand`
- `lookupCommand` -> `lookupRuntimeCommand`

## Required Behavior

- All command strings stay the same: `/help`, `/mode`, `/refresh`, etc.
- Palette actions still dispatch the same runtime command lines.
- RPC command dispatch still works.
- Help overlay still lists commands and shortcuts.
- Phase/screen guards still apply in both completion and dispatch paths.

## Implementation Notes

- Do not create a compatibility `src/core/slash-commands` directory.
- If command completion still duplicates availability filtering, keep behavior first. A small `filterRuntimeCommands` helper is allowed only if it reduces duplication without changing behavior.
- Keep tests focused on lookup/dispatch behavior, not old file names.

## Validation

Run:

```bash
npm run typecheck
npm test -- src/core/runtime/commands src/components/composer src/features/palette src/cli/rpc/run.test.ts src/components/overlays src/features/help
rg -n "core/slash-commands|SlashCommand|executeSlashCommand|createCommands|lookupCommand|fuzzyMatchCommand" src docs --glob '!docs/superpowers/specs/**'
```

