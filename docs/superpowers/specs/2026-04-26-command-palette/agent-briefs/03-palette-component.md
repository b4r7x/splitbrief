# 03 — Palette Component

> Fresh AI context brief. Implement only this change. Never stage or commit.

## Identity

**Brief 03 of 5** — Command Palette spec, 2026-04-26.
Depends on Brief 01 (fuzzy matcher) and Brief 02 (result aggregator) being merged first.
Must be coordinated with Brief 05 (MRU store) — that store must exist before this component imports it.

## Intent

Replace the existing stub `src/components/overlays/command-palette.tsx` with a full implementation at `src/features/workflow/components/command-palette-overlay.tsx`. Update `src/app.tsx` to mount the new component. Delete the old stub. The new component owns session loading, source assembly, fuzzy aggregation, and MRU recording.

## Scope

**In bounds:**
- `src/features/workflow/components/command-palette-overlay.tsx` (new file)
- `src/app.tsx` (update import + mount site)
- `src/components/overlays/command-palette.tsx` (delete)

**Out of bounds:**
- Do not touch the aggregator, fuzzy matcher, or MRU store — only consume them.
- Do not change `src/hooks/use-app-keys.ts` (keybinding already correct).
- Do not change the config schema (Brief 05 handles that).
- Do not add npm dependencies.

## Code Context

Read all of these before writing:

- `src/app.tsx` — current mount site of `CommandPalette`; `renderOverlay` function at line 101; imports `CommandPalette` from `'./components/overlays/command-palette.js'` and passes `paletteItems` prop
- `src/components/overlays/command-palette.tsx` — existing stub (full file; then delete it)
- `src/engine/palette/aggregate.ts` — `buildPaletteResults`, `PaletteResult`, `PaletteInputs`, `PaletteSource` (from Brief 02)
- `src/stores/ui/palette-mru.ts` — `paletteMruStore` (from Brief 05)
- `src/stores/project/sessions.ts` — `sessionsStore` (has `load(projectDir)` and `.sessions` array)
- `src/stores/workflow/tasks.ts` — `tasksStore` (has `.tasks: SidebarTask[]`)
- `src/stores/workflow/lifecycle.ts` — `lifecycleStore` (has `.phase`)
- `src/stores/ui/overlay.ts` — `overlayStore.close()`
- `src/stores/navigation/router.ts` — `routerStore` (current screen + navigation)
- `src/stores/project/config.ts` — `configStore.useConfig()` (for `palette.customActions`)
- `src/core/slash-commands/catalog.ts` — `createCommands(ctx)` for slash command list
- `src/core/slash-commands/context.ts` — `buildCommandContext`
- `src/core/runtime/commands/dispatch.ts` — `executeRuntimeCommand`; palette command items are assembled in `src/features/palette/sources.ts`
- `src/core/schemas/enums.ts` — `WORKFLOW_MODES`
- `src/features/sessions/picker-select.ts` — `handleSelect(session)` for session action
- `src/components/overlays/overlay-panel.tsx` — `OverlayPanel` wrapper (full file — understand props)
- `src/components/pickers/filterable-list.tsx` — `FilterableList` (understand the interface; the new component does NOT use this — see note below)
- `src/components/theme.tsx` — `useTheme()`
- `src/stores/use-stores.ts` — `useStores`

## Why Not Use FilterableList

The existing stub uses `FilterableList` which does its own internal filtering. The new component passes a pre-filtered and pre-sorted `PaletteResult[]` from `buildPaletteResults` — there is no need for `FilterableList`'s internal filter. The new component manages its own query state and renders a plain list with scroll support.

## Implementation Plan

### Component structure

`CommandPaletteOverlay` is a single function component. It subscribes to stores, assembles inputs, calls `buildPaletteResults`, and renders an `OverlayPanel` with a text input and a scrollable result list.

```tsx
// src/features/workflow/components/command-palette-overlay.tsx

export function CommandPaletteOverlay()
```

No props. All data comes from stores.

### State

```tsx
const [query, setQuery] = useState('');
const [cursor, setCursor] = useState(0);
```

### Store subscriptions

```tsx
const screen = routerStore.use(s => s.screen);
const config = configStore.useConfig();
const { phase } = lifecycleStore.use(s => ({ phase: s.phase }));
const mruIds = paletteMruStore.use(s => s.ids);
const { tasks } = tasksStore.use(s => ({ tasks: s.tasks }));
const sessions = sessionsStore.use(s => s.sessions);
const projectDir = configStore.use(s => s.projectDir);
```

Load sessions on mount:

```tsx
useEffect(() => { sessionsStore.load(projectDir); }, [projectDir]);
```

(Note: `useEffect` is acceptable here because it is a side-effect trigger on mount, not a memoization. Treat it as the standard Ink/React pattern for data loading in an overlay.)

### Assembling inputs

Build `PaletteInputs` inside the component body (not in a `useMemo`):

- `slashItems`: build from labeled runtime commands in `src/features/palette/sources.ts`, filtered to `.availableOn.includes(screen)`; the palette action should call the real runtime command handler
- `modeItems`: `WORKFLOW_MODES.map(mode => ({ label: mode, description: `Switch to ${mode} mode`, action: () => { ctx.setWorkflowMode(mode); } }))`
- `pickerItems`: 4 fixed entries — planner, implementer, sessions, settings — each calling `overlayStore.open(target)` (the component closes the palette first, then the action opens the target overlay — see "consistent close" note below)
- `taskItems`: only populate when `phase === 'implementing' || phase === 'validating-task' || phase === 'escalating'`; `tasks.map(t => ({ id: t.id, title: t.title, action: () => { feedbackStore.setMessage(`Task ${t.id}: ${t.title}`) } }))` — see note on task action
- `sessionItems`: `sessions.slice(0, 10).map(s => ({ id: s.id, feature: s.feature, status: s.status, action: () => { handleSelect(s); } }))`
- `customItems`: `(config.palette?.customActions ?? []).map(a => ({ id: a.id, label: a.label, description: a.description ?? '', action: () => { executeSlashCommand(commands, a.command, screen, feedbackStore.setError); } }))`
- `mruIds`: from `paletteMruStore`

### Note on consistent overlay close

The palette component calls `overlayStore.close()` exactly once, immediately before invoking `results[cursor].action()`, for every source. Source action builders must NOT call `overlayStore.close()` — if they do, the close happens twice and the overlay stack pops an extra entry. This applies to slash, mode, picker, task, session, and custom sources uniformly.

### Note on task action

There is no existing "scroll to task by id" API in `conversationScrollStore`. The task action for v1 shows a feedback message with the task title. A follow-up spec can wire the scroll. Do NOT invent a new scroll API here.

### Note on ctx and commands

Build `ctx` and `commands` once inside the component:

```tsx
const { exit } = useApp();
const ctx = buildCommandContext({ exit });
const commands = createCommands(ctx);
```

This matches the pattern in `app.tsx`. `useApp` is from Ink.

### Rendering

Use `OverlayPanel` with `title="Command Palette"` and `hint="↑↓ navigate  Enter select  Esc close"`.

Inside the panel:

1. A text input row at the top showing the query. Use `ink`'s `TextInput` from `ink`. Handle character input via `useInput` when the palette is active.
2. A result list below: render up to 8 items. Show cursor at `cursor` index. Scroll window if `cursor` goes out of view.
3. Each result row shows: `[source badge]  label  description  [shortcut]` — source badge is `[${result.source}]` dimmed.
4. If no results and query non-empty, show "No matching commands" dimmed.
5. If no results and query empty, show empty state (should not happen with sources populated).

### Keyboard handling

Use `useInput` with `isActive: true` (palette is mounted only when active):

- Printable character or backspace → update `query`, reset `cursor` to 0.
- Arrow up → `setCursor(c => Math.max(0, c - 1))`
- Arrow down → `setCursor(c => Math.min(results.length - 1, c + 1))`
- Enter → if `results[cursor]` exists: (1) `paletteMruStore.record(results[cursor].id)`, (2) `overlayStore.close()`, (3) `results[cursor].action()`. Always close first — this is the single close site regardless of source. Do not call `overlayStore.close()` inside any source action builder.
- Escape → `overlayStore.close()`

Reset `cursor` to 0 whenever `query` changes (already handled by setting cursor to 0 on query update).

### Updating `src/app.tsx`

1. Remove the import of `CommandPalette` from `'./components/overlays/command-palette.js'`.
2. Remove the `paletteItems` local variable and the `CommandPaletteItem` type import (if no longer used).
3. Add import of `CommandPaletteOverlay` from `'./features/workflow/components/command-palette-overlay.js'`.
4. In `renderOverlay`, change the `'command-palette'` case to `return <CommandPaletteOverlay />;`.
5. Remove `paletteItems` from the `renderOverlay` parameter object if it has no other uses.
6. Verify the `CommandPaletteItem` type import from `types.ts` is still needed by the current palette source/result types; remove it if not.

### Deleting the old stub

Delete `src/components/overlays/command-palette.tsx` after updating `app.tsx`. Verify no other file imports from that path:

```bash
grep -r "overlays/command-palette" src/
```

The only import site is `src/app.tsx` (already updated).

## Validation

### Tests (colocated in `src/features/workflow/components/command-palette-overlay.test.tsx`)

- Renders without crashing when all stores are at initial state.
- Typing updates the query and re-filters results.
- Arrow down moves cursor; arrow up moves cursor back; clamps at 0 and `results.length - 1`.
- Enter with cursor on item records MRU and calls the item's action.
- Escape closes the overlay.
- Source badge appears for each source type.
- Session items from store appear in results when query matches.
- Custom items from config appear in results.
- Task items appear only in implementing/validating-task phase.
- "No matching commands" shown when query non-empty and no matches.

Note: use Ink's `render` from `ink` test utilities. Mock stores with `__testReset` or by setting store state directly.

## Constraints

- No `useMemo`, `useCallback`, `React.memo`, `forwardRef`.
- No barrel imports from `src/engine/` or `src/stores/`.
- ESM `.js` import suffixes.
- No class keyword.
- The component must not import `src/engine/palette/aggregate.ts` via a path that goes through an `index.ts` barrel — import directly.

## Escalation

If `buildCommandContext({ exit })` inside the component causes a React rules-of-hooks violation (e.g. because it internally calls a hook), move it outside the component. In practice, `buildCommandContext` is a plain object factory — it should be safe inside the component body. If it is not, wrap it with `useRef` initialized once.

If `sessionsStore.load` is synchronous (it is — uses `readdirSync`), the `useEffect` is fine. If it becomes async, the effect must handle cleanup.

## Evidence Requirements

- `npm test -- src/features/workflow/components/command-palette-overlay.test.tsx` passes.
- `npm run typecheck` passes.
- `npm run lint` passes.
- `grep -r "overlays/command-palette" src/` returns no output.
- `find src -name "command-palette.tsx" -path "*/overlays/*"` returns nothing (old file deleted).
- `npm run test-ci` passes.
