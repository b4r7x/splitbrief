# Agent Brief 01 - Composer

## Goal

Move the shared bottom input UI from placement/syntax naming to domain naming:

- `input-bar` -> `composer`
- `slash` completion -> `completion/command`
- `at-file` completion -> `completion/reference`

## Write Scope

- `src/components/input-bar/**` -> `src/components/composer/**`
- Imports in `src/features/home`, `src/features/workflow`, `src/features/summary`
- Composer-related tests
- Active docs that mention old composer paths

## Move Map

| Current | Target |
|---|---|
| `src/components/input-bar/input-bar.tsx` | `src/components/composer/composer.tsx` |
| `src/components/input-bar/input-bar.integration.test.tsx` | `src/components/composer/composer.integration.test.tsx` |
| `src/components/input-bar/attachment-chips.tsx` | `src/components/composer/attachments.tsx` |
| `src/components/input-bar/history-navigation.ts` | `src/components/composer/history.ts` |
| `src/components/input-bar/history-navigation.test.ts` | `src/components/composer/history.test.ts` |
| `src/components/input-bar/use-input-bar-history.ts` | `src/components/composer/use-history.ts` |
| `src/components/input-bar/suggestion-panel-layout.ts` | `src/components/composer/completion/layout.ts` |
| `src/components/input-bar/suggestion-panel-layout.test.ts` | `src/components/composer/completion/layout.test.ts` |
| `src/components/input-bar/use-slash-autocomplete.ts` | `src/components/composer/completion/command/hook.ts` |
| `src/components/input-bar/use-slash-autocomplete.test.ts` | `src/components/composer/completion/command/hook.test.ts` |
| `src/components/input-bar/slash-suggestions.tsx` | `src/components/composer/completion/command/menu.tsx` |
| `src/components/input-bar/slash-suggestions.test.tsx` | `src/components/composer/completion/command/menu.test.tsx` |
| `src/components/input-bar/use-at-file-autocomplete.ts` | `src/components/composer/completion/reference/hook.ts` |
| `src/components/input-bar/use-at-file-autocomplete.test.tsx` | `src/components/composer/completion/reference/hook.test.tsx` |
| `src/components/input-bar/at-file-suggestions.tsx` | `src/components/composer/completion/reference/menu.tsx` |
| `src/components/input-bar/at-file-suggestions.test.tsx` | `src/components/composer/completion/reference/menu.test.tsx` |

## Required Symbol Renames

- `InputBar` -> `Composer`
- `InputBarProps` -> `ComposerProps`
- `onSlashCommand` -> `onRuntimeCommand`
- `useSlashAutocomplete` -> `useCommandCompletion`
- `SlashSuggestions` -> `CommandCompletionMenu`
- `useAtFileAutocomplete` -> `useReferenceCompletion`
- `AtFileSuggestions` -> `ReferenceCompletionMenu`
- `findAtToken` -> `findReferenceToken`
- `computeSuggestionOverlayRows` -> `computeCompletionOverlayRows`
- `computeSuggestionsCap` -> `computeCompletionCap`

## Behavior Must Stay The Same

- `/` opens command completion.
- Arrow keys select command suggestions.
- Tab fills command suggestions.
- Enter dispatches command suggestions.
- `@path` opens file reference completion.
- Tab/Enter fills file reference suggestions and leaves cursor behavior intact.
- Suggestions remain overlayed above the composer and opaque.
- Composer height reservation behavior remains unchanged.

## Validation

Run:

```bash
npm run typecheck
npm test -- src/components/composer src/features/home/screen.test.tsx src/features/workflow/screen.test.tsx src/features/summary/screen.test.tsx
rg -n "components/input-bar|InputBar|input-bar/input-bar|useSlashAutocomplete|useAtFileAutocomplete|AtFileSuggestions|SlashSuggestions" src docs --glob '!docs/superpowers/specs/**'
```

