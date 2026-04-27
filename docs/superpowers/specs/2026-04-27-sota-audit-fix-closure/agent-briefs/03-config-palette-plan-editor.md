# 03 - Config, Palette, Plan Editor

> Fresh AI context brief. Implement only this change. Never stage, commit, or stash.

## Goal

Fix lossless config loading, make configured command palette actions work in real runs, and close plan editor correctness bugs.

## Read First

- `CLAUDE.md`
- `docs/CONFIGURATION.md`
- `docs/STORES.md`
- `docs/HOOKS.md`
- `docs/superpowers/specs/2026-04-26-command-palette/README.md`
- `docs/superpowers/specs/2026-04-26-plan-editor-screen/README.md`
- `src/core/schemas/config.ts`
- `src/core/config/load/load.ts`
- `src/features/tool-picker/config-transforms.ts`
- `src/features/workflow/components/command-palette-overlay.tsx`
- `src/features/workflow/components/plan-editor/actions.ts`
- `src/features/workflow/hooks/use-plan-editor-save.ts`
- `src/features/workflow/components/plan-editor/external-editor.ts`
- `src/stores/workflow/plan-editor.ts`

## Scope

**In bounds:**

- Preserve every schema-supported optional top-level config section during default merge.
- Preserve those sections during config save/write transforms used by setup or tool picker flows.
- Ensure `palette.customActions` from config reaches the command palette.
- Fix plan editor merge/delete dependency relinking.
- Fix save validation so parse errors are caught and ID validation is set-based, not index-based.
- Respect non-zero external editor exit.
- Avoid dirty state on no-op edits.
- Clear stale save errors after successful edits where appropriate.
- Add behavior tests for the real config load and plan editor public actions.

**Out of bounds:**

- New command palette feature types.
- Persistent MRU changes unless already implemented.
- Plan editor visual redesign.
- New React memoization or effect-driven derived state.

## Required Fixes

### 1. Config merge is lossless

`mergeWithDefaults()` and any config write/transform path must preserve schema-supported optional top-level sections, including:

- `codebase`,
- `hooks`,
- `otel`,
- `snapshots`,
- `palette`,
- `approval`.

The test must load and save/transform a config containing these sections and assert the runtime/written config still contains them.

### 2. Custom palette actions work from config

When `.diptych/config.yaml` contains `palette.customActions`, the command palette result aggregator/rendering must include those actions and execute their slash commands.

### 3. Plan editor dependency operations are coherent

Merge/delete operations must not create self-dependencies and must relink downstream tasks when a task is absorbed or deleted. Run `topoSort` where the existing design requires it.

### 4. Save flow reports errors safely

`parseTasks()` errors must be caught and surfaced through editor state. Save validation must compare task ID sets, not array positions, because parsing may topologically sort tasks.

### 5. External editor failures stop the edit

If the editor exits non-zero, do not read/parse/apply the temp file. Surface a user-facing error.

### 6. No-op edits remain clean

Boundary move/delete operations that return the same task list should not mark the plan dirty. New successful edits should clear stale save errors.

## Acceptance Criteria

- Loaded config preserves optional sections listed above.
- Config save/tool-picker transforms preserve optional sections listed above.
- A configured custom palette action appears in the palette and dispatches the configured slash command.
- Merging a task that depends on the previous task does not create self-dependency.
- Deleting or merging a task relinks downstream dependencies correctly.
- Invalid `tasks.md` content shows an editor error instead of throwing.
- Valid reordered task sets are not rejected only because parser output order differs.
- Non-zero external editor exit does not modify editor tasks.
- No-op boundary edits do not set `dirty: true`.

## Tests

Add or update tests for:

- config load from YAML with all optional sections,
- config save/transform round trip with all optional sections,
- custom palette action from config rendered/executed,
- merge self-dependency regression,
- delete/merge downstream relink,
- save parse error path,
- set-based ID validation,
- external editor non-zero exit,
- no-op dirty state and stale save error clearing.

Tests should render or exercise public stores/actions. Avoid implementation-spy call counts.

## Verification Commands

```bash
npm test -- src/core/config src/features/workflow/components/command-palette-overlay.test.tsx src/features/workflow/components/plan-editor src/features/workflow/hooks
npm run typecheck
npm run lint
npm test
```
