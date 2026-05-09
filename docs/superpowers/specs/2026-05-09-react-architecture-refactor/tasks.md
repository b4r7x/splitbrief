# Tasks

## Phase 0 - Preparation

- [ ] Read `AGENTS.md` and `CLAUDE.md`.
- [ ] Read this spec pack in the README reading order.
- [ ] Run `git status --short` and note existing dirty files. Do not revert user work.
- [ ] Run baseline validation if practical: `npm run typecheck`, `npm run lint`, and targeted tests listed in `verification.md`.
- [ ] Confirm no `index.ts` files exist under `src`.

## Phase 1 - Composer Move

- [ ] Create `src/components/composer/`.
- [ ] Move `input-bar.tsx` to `composer.tsx`.
- [ ] Rename exported `InputBar` to `Composer`; rename `InputBarProps` to `ComposerProps`.
- [ ] Rename prop `onSlashCommand` to `onRuntimeCommand`.
- [ ] Move `attachment-chips.tsx` to `attachments.tsx`.
- [ ] Move `use-input-bar-history.ts` to `use-history.ts`.
- [ ] Move `history-navigation.ts` to `history.ts`.
- [ ] Move `suggestion-panel-layout.ts` to `completion/layout.ts`.
- [ ] Move command completion files to `completion/command/`.
- [ ] Move file reference completion files to `completion/reference/`.
- [ ] Rename exported hook/component names to `useCommandCompletion`, `CommandCompletionMenu`, `useReferenceCompletion`, `ReferenceCompletionMenu`, and `findReferenceToken`.
- [ ] Update imports in home, workflow, summary, tests, and docs.
- [ ] Update path fixtures in reference completion tests.
- [ ] Run Phase 1 validation from `verification.md`.

## Phase 2 - Runtime Commands Move

- [ ] Create `src/core/runtime/commands/`.
- [ ] Move `types.ts`, `catalog.ts`, `dispatch.ts`, and `fuzzy.ts` from `src/core/slash-commands`.
- [ ] Rename `catalog.ts` to `registry.ts`.
- [ ] Rename `fuzzy.ts` to `lookup.ts`.
- [ ] Rename command types/functions:
  - `SlashCommandDef` -> `RuntimeCommandDef`
  - `CommandContext` -> `RuntimeCommandContext`
  - `createCommands` -> `createRuntimeCommands`
  - `executeSlashCommand` -> `executeRuntimeCommand`
  - `findCommand` -> `findRuntimeCommand`
  - `fuzzyMatchCommand` -> `suggestRuntimeCommand`
  - `lookupCommand` -> `lookupRuntimeCommand`
- [ ] Move `keybindings.ts` to `src/core/keybindings/registry.ts`.
- [ ] Update all production imports and test imports.
- [ ] Keep user-facing command names like `/help`, `/mode`, `/handoff` unchanged.
- [ ] Run Phase 2 validation from `verification.md`.

## Phase 3 - Palette And Help Features

- [ ] Create `src/features/palette/`.
- [ ] Move `features/workflow/components/command-palette-overlay.tsx` to `features/palette/overlay.tsx`.
- [ ] Move its test to `features/palette/overlay.test.tsx`.
- [ ] Move `engine/palette-aggregate.ts` to `features/palette/results.ts`.
- [ ] Move its test to `features/palette/results.test.ts`.
- [ ] Move palette source assembly out of `overlay.tsx` into `features/palette/sources.ts` if it is still inline after the file move.
- [ ] Rename `stores/ui/palette-mru.ts` to `stores/ui/command-palette-mru.ts`.
- [ ] Move `components/overlays/help-overlay.tsx` to `features/help/overlay.tsx`.
- [ ] Update `app.tsx`, tests, and active docs.
- [ ] Run Phase 3 validation from `verification.md`.

## Phase 4 - App Shell, Runners, And Shared Cleanup

- [ ] Move `src/hooks/use-app-keys.ts` to `src/app/keys.ts`.
- [ ] Move `src/hooks/use-app-keys.test.tsx` to `src/app/keys.test.tsx`.
- [ ] Move `src/hooks/navigate-index.ts` to `src/utils/indexing.ts` or `src/components/pickers/navigation.ts`; choose the location that avoids layer inversion after checking imports.
- [ ] Update `use-static-selector.ts`, `use-filterable-list.ts`, and tests.
- [ ] Move `features/settings/use-edit-buffer.ts` to `features/settings/hooks/buffer.ts`.
- [ ] Move `features/settings/use-settings-editor.ts` to `features/settings/hooks/editor.ts`.
- [ ] Rename `features/tool-picker` to `features/runners`.
- [ ] Preserve current exported component names unless renaming is low-risk and all imports/tests are updated.
- [ ] Update setup render-prop docs that mention `tool-picker`.
- [ ] Run Phase 4 validation from `verification.md`.

## Phase 5 - Docs And Final Sweep

- [ ] Update active docs listed in `spec.md` FR-015.
- [ ] Do not rewrite archival `docs/superpowers/specs/**` except this pack.
- [ ] Search for old source paths in `src` and active docs.
- [ ] Confirm no barrels were introduced.
- [ ] Run full validation from `verification.md`.
- [ ] Prepare final implementation report for reviewer.

