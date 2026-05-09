# Verification

## Baseline Commands

Run before and after the full refactor when practical:

```bash
npm run typecheck
npm run lint
npm test
```

## Phase 1 - Composer

```bash
npm run typecheck
npm test -- src/components/composer src/features/home/screen.test.tsx src/features/workflow/screen.test.tsx src/features/summary/screen.test.tsx
rg -n "components/input-bar|InputBar|input-bar/input-bar" src docs --glob '!docs/superpowers/specs/**'
```

Expected:

- The targeted tests pass.
- `InputBar` and `components/input-bar` do not appear in `src`.
- Active docs either do not mention old paths or mention them only as historical context with new paths nearby.

## Phase 2 - Runtime Commands

```bash
npm run typecheck
npm test -- src/core/runtime/commands src/components/composer src/features/palette src/cli/rpc/run.test.ts
rg -n "core/slash-commands|SlashCommand|executeSlashCommand|createCommands|lookupCommand|fuzzyMatchCommand" src docs --glob '!docs/superpowers/specs/**'
```

Expected:

- The targeted tests pass.
- `SlashCommand` terms are gone from `src` except user-facing strings/comments that intentionally discuss `/` syntax.
- `core/slash-commands` is gone from `src` and active docs.

## Phase 3 - Palette And Help

```bash
npm run typecheck
npm test -- src/features/palette src/features/help src/app.tsx src/stores/ui/command-palette-mru.test.ts
rg -n "workflow/components/command-palette-overlay|engine/palette-aggregate|components/overlays/help-overlay|palette-mru" src docs --glob '!docs/superpowers/specs/**'
```

Expected:

- Palette overlay and result tests pass under new paths.
- No production import points to the old workflow/engine/help paths.

## Phase 4 - App Shell And Runners

```bash
npm run typecheck
npm test -- src/app/keys.test.tsx src/hooks src/features/settings src/features/runners src/features/setup/screen.test.tsx
rg -n "hooks/use-app-keys|navigate-index|features/tool-picker|src/features/tool-picker" src docs --glob '!docs/superpowers/specs/**'
```

Expected:

- App key behavior and picker/settings tests pass.
- Old app-key, pure navigation, and tool-picker paths are gone from `src`.

## Final Checks

```bash
npm run test-ci
rg --files src | rg '/index\\.(ts|tsx)$'
rg -n "components/input-bar|core/slash-commands|features/tool-picker|hooks/use-app-keys|workflow/components/command-palette-overlay|engine/palette-aggregate" src docs --glob '!docs/superpowers/specs/**'
git diff --check
git status --short
```

Expected:

- `npm run test-ci` passes.
- The barrel search returns no files.
- Old source paths return no matches in `src` and active docs.
- `git diff --check` passes.
- Worktree remains unstaged; the user commits manually.

## Known Risk

Full `npm test` has previously exposed unrelated order-sensitive flake behavior in picker tests. If full test fails but the failing file passes in isolation, report it explicitly with both command outputs and do not hide it.

