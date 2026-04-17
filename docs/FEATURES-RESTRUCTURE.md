# Features Restructure — Architecture RFC

> **Status**: Executed (2026-04-17). See commit history.
> **Scope**: `src/components/`, `src/screens/`, `src/hooks/`, `src/ui/`, and every import path in `src/` that resolves into any of the above.
> **Companion docs**: [`STRUCTURE.md`](./STRUCTURE.md) (steady-state principles produced by this RFC), [`HOOKS.md`](./HOOKS.md), [`STORES.md`](./STORES.md), [`NO-BARRELS.md`](./NO-BARRELS.md), [`STORES-RESTRUCTURE.md`](./STORES-RESTRUCTURE.md) (template).

## 1. Why

`src/` mixes three organization styles side by side and none of them express the domain clearly:

1. **`src/components/` is a dumping ground.** It holds shared UI primitives (`labeled-row.tsx`, `screen-shell.tsx`), feature-specific composites (`workflow/`, `home/`, `summary/`, `event-cards/`, `conversation-flow/`), and cross-cutting widgets (`overlays/`, `pickers/`, `input-bar/`). Nothing in the folder name tells a reader which category a given file falls into.
2. **`src/ui/` and `src/components/` overlap.** Both hold shared presentational primitives. The distinction ("ui = stateless, components = stateful") does not survive contact with `diff-view.tsx` (stateful, in `ui/`) or `screen-shell.tsx` (stateless, in `components/`). Two folders with no enforced rule = drift over time.
3. **`src/hooks/` is flat and contaminated.** 14 files, of which 4 are not hooks at all (pure functions, handler registries). Cross-feature primitives and workflow-specific hooks sit side by side with no grouping. See [`HOOKS.md`](./HOOKS.md) for the target hook layout.
4. **`src/screens/` and `src/components/{feature}/` are siblings but own the same domain.** `src/screens/workflow.tsx` imports from `src/components/workflow/*`. The screen is the feature entry point, the components are the feature internals — they belong together.

**Non-goals:** redesigning store semantics, rewriting `app.tsx` dispatch, touching `src/engine/**`, `src/core/**`, `src/cli/**` beyond import updates, changing CLI UX.

## 2. Invariants (must hold before, during, and after)

From [`CLAUDE.md`](../CLAUDE.md) and the stores restructure precedent:

- **No commits, no staging.** The `.claude/hooks/block-git-commits.sh` guardrail enforces this. Every agent brief in this RFC repeats it.
- **Zero** `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle` in `src/`.
- **Zero** React Context (`ThemeContext` is the sanctioned exception; unaffected by this restructure).
- **Zero barrel files** per [`NO-BARRELS.md`](./NO-BARRELS.md). Any `index.ts` that re-exports from siblings must be deleted; any `index.tsx` containing a real component stays.
- Engine code (`src/engine/**`) keeps **zero** React/Ink imports.
- `store.set()` / `store.load()` are **never called during React render**.
- `npm run typecheck`, `npm run lint`, and `npm test` must be green at the end of **every phase** (not just the whole restructure).
- `configStore.useConfig()`, `useStores(...)`, and the multi-store Proxy tracking contract are unchanged.

## 3. Current state (facts, not opinions)

### 3.1 Top-level layout (`src/`)

```
src/
├── app.tsx, layout.tsx, cli.ts, types.ts, type-safety-sweep.test.ts
├── cli/             — CLI subcommand handlers
├── core/            — domain logic (config, types, commands, state, layout helpers)
├── engine/          — workflow orchestrator + planners/implementers (no React)
├── stores/          — external stores (restructured 2026-04-17)
├── components/      — mixed shared + feature UI (TARGET: shared only)
├── ui/              — shared primitives (TARGET: merge into components/)
├── hooks/           — React hooks + 4 fake hooks (TARGET: 4 shared primitives only)
├── screens/         — 4 screen entry points (TARGET: absorbed into features/)
└── utils/           — pure helpers (no React)
```

Missing: `src/features/`.

### 3.2 Hook inventory (`src/hooks/`, 14 files)

See [`HOOKS.md`](./HOOKS.md) for the post-restructure inventory. Pre-restructure:

| Real hook (10) | Fake hook (4) |
|---|---|
| `use-async-highlight`, `use-filterable-list`, `use-global-keys`, `use-input-mode`, `use-mouse-scroll`, `use-review-content`, `use-static-selector`, `use-workflow-review-input`, `use-workflow-runner`, `use-workflow` | `keyboard-handlers.ts` (pure fn), `workflow-handlers.ts` (handler registry), `conversation-layout-snapshot.ts` (pure geometry), `detection-adapter.ts` (pure async) |

Additional hooks colocated with components (10 files under `src/components/**/use-*.ts*`) — these are already correctly placed and move alongside their component during the feature migration.

### 3.3 Barrels inventory (relevant to this restructure)

Per [`NO-BARRELS.md`](./NO-BARRELS.md):

| Path | Type | Action |
|---|---|---|
| `src/components/summary/index.ts` | Barrel | **Delete** (Phase 4) |
| `src/components/overlays/sessions-picker/index.tsx` | Real code | Keep; move with feature |
| `src/components/overlays/settings-overlay/index.tsx` | Real code | Keep; move with feature |
| `src/components/input-bar/` | No index as of 2026-04-17 working tree | N/A |
| `src/components/event-cards/` | No index as of 2026-04-17 working tree | N/A |

### 3.4 Features (target)

Eight features fall out of the current code organically:

| Feature | Current sources |
|---|---|
| `workflow` | `screens/workflow.tsx`, `components/workflow/`, `components/conversation-flow/`, `components/event-cards/`, `hooks/use-workflow*.ts`, `hooks/use-input-mode.ts`, `hooks/use-review-content.ts`, `hooks/use-mouse-scroll.ts`, `hooks/workflow-handlers.ts`, `hooks/keyboard-handlers.ts` (partial), `hooks/conversation-layout-snapshot.ts`, `components/workflow/use-cost-stats.ts` |
| `home` | `screens/home.tsx`, `components/home/` |
| `setup` | `screens/setup.tsx` |
| `summary` | `screens/summary.tsx`, `components/summary/` |
| `settings` | `components/overlays/settings-overlay/` |
| `sessions` | `components/overlays/sessions-picker/`, `components/sessions/` |
| `tool-picker` | `components/overlays/tool-model-picker/` |
| `skills` | `components/overlays/skills-picker.tsx` |

## 4. Decisions

### 4.1 Target layout

```
src/
├── app.tsx, layout.tsx, cli.ts, types.ts, type-safety-sweep.test.ts
├── cli/                        # unchanged
├── core/                       # unchanged
├── engine/
│   └── detection/
│       ├── adapter.ts          # NEW — ex src/hooks/detection-adapter.ts
│       └── adapter.test.ts
├── stores/                     # unchanged (already restructured)
├── components/                 # SHARED cross-feature UI only (ui/ merged in)
│   ├── diff-view.tsx           # ex src/ui/
│   ├── filter-input.tsx        # ex src/ui/
│   ├── labeled-row.tsx
│   ├── markdown.tsx            # ex src/ui/
│   ├── screen-shell.tsx
│   ├── scroll-indicator.tsx    # ex src/ui/
│   ├── spinner.tsx             # ex src/ui/
│   ├── theme.tsx (+ theme.test.tsx)  # ex src/ui/
│   ├── input/                  # ex src/ui/input/
│   ├── input-bar/
│   ├── overlays/               # SHARED overlays only
│   │   ├── command-palette.tsx
│   │   ├── help-overlay.tsx
│   │   ├── mode-selector.tsx
│   │   ├── overlay-panel.tsx
│   │   └── text-input-overlay.tsx
│   └── pickers/                # picker primitives
├── hooks/                      # 4 shared primitives (see HOOKS.md)
│   ├── use-filterable-list.ts (+ trimmed test)
│   ├── use-static-selector.ts
│   ├── use-async-highlight.ts
│   └── use-app-keys.ts         # NEW — split from use-global-keys
├── utils/
│   └── kitty-keyboard.ts       # ex src/ui/kitty-keyboard.ts
└── features/
    ├── workflow/
    │   ├── screen.tsx          # ex src/screens/workflow.tsx
    │   ├── components/
    │   │   ├── conversation-flow/
    │   │   ├── event-cards/    # incl. card.tsx (workflow-only primitive)
    │   │   ├── cost-footer.tsx
    │   │   ├── header.tsx
    │   │   ├── pipeline-bar.tsx
    │   │   ├── review-view.tsx
    │   │   ├── sidebar.tsx
    │   │   └── task-summary.tsx
    │   ├── hooks/
    │   │   ├── use-workflow.ts
    │   │   ├── use-workflow-runner.ts
    │   │   ├── use-workflow-review-input.ts
    │   │   ├── use-input-mode.ts
    │   │   ├── use-review-content.ts
    │   │   ├── use-mouse-scroll.ts
    │   │   ├── use-cost-stats.ts
    │   │   └── use-workflow-keys.ts  # NEW — split from use-global-keys
    │   ├── handlers.ts         # ex src/hooks/workflow-handlers.ts
    │   ├── keyboard.ts         # ex workflow-scope fn from src/hooks/keyboard-handlers.ts
    │   └── layout.ts           # ex src/hooks/conversation-layout-snapshot.ts
    ├── home/
    │   ├── screen.tsx          # ex src/screens/home.tsx
    │   └── components/         # ex src/components/home/
    ├── setup/
    │   └── screen.tsx          # ex src/screens/setup.tsx
    ├── summary/
    │   ├── screen.tsx          # ex src/screens/summary.tsx
    │   └── components/         # ex src/components/summary/ (without index.ts barrel)
    ├── settings/
    │   ├── overlay.tsx         # ex src/components/overlays/settings-overlay/index.tsx
    │   ├── use-edit-buffer.ts
    │   ├── use-settings-editor.ts
    │   └── (use-settings-list DELETED — flattened into overlay.tsx)
    ├── sessions/
    │   ├── picker.tsx          # ex src/components/overlays/sessions-picker/index.tsx
    │   ├── picker-select.ts    # ex sessions-picker-select.ts
    │   ├── session-row.tsx     # ex src/components/sessions/session-row.tsx
    │   └── picker.test.tsx     # ex sessions-picker.test.tsx
    ├── tool-picker/
    │   ├── picker.tsx
    │   ├── picker-view.tsx
    │   ├── catalog-adapter.ts (+ test)
    │   ├── config-transforms.ts (+ test)
    │   ├── model-sorting.ts
    │   ├── picker-model-catalog.ts
    │   ├── picker-options.ts (+ test)
    │   ├── tool-row.tsx
    │   ├── view-state.ts
    │   ├── use-picker-actions.ts
    │   └── use-picker-catalog.ts
    └── skills/
        └── picker.tsx          # ex src/components/overlays/skills-picker.tsx
```

Gone: `src/screens/`, `src/ui/`, `src/hooks/detection-adapter.ts`, `src/hooks/conversation-layout-snapshot.ts`, `src/hooks/workflow-handlers.ts`, `src/hooks/keyboard-handlers.ts`, `src/hooks/use-global-keys.ts`, all other workflow-scoped hooks in `src/hooks/`, `src/components/workflow/`, `src/components/conversation-flow/`, `src/components/event-cards/`, `src/components/home/`, `src/components/summary/` (barrel + contents), `src/components/sessions/`, overlays that became features.

### 4.2 `use-global-keys` split rationale

Current hook (`src/hooks/use-global-keys.ts`, 130 LOC) has three concerns behind three `useInput` callbacks:

1. **Ctrl+C** — always active. Double-press → exit. Single-press on workflow screen with live phase → abort turn. Branch is screen-aware but the keybinding is app-global.
2. **Escape → overlay close** — active when overlay is open, not exclusive, stack empty.
3. **Main dispatcher** — active when no overlay. Handles: workflow escape (navigate home on cancelled), app-wide shortcut keys (command-palette, settings, skills, help, quit), workflow ctrl-chords (`Ctrl+E` sidebar toggle, `Ctrl+D` diff toggle), workflow scroll (shift+arrows, page up/down, `g`/`G` for review or conversation).

**Split line:** behavior that mounts on every screen stays in `src/hooks/use-app-keys.ts`. Behavior that only makes sense inside the workflow screen moves to `src/features/workflow/hooks/use-workflow-keys.ts` and mounts only when `screen === 'workflow'`.

| Concern | New location |
|---|---|
| Ctrl+C quit / abort | `use-app-keys` (with screen-aware branch kept inline) |
| Escape → overlay close | `use-app-keys` |
| `handleShortcutKeys` dispatch (Ctrl+K, Ctrl+I, Ctrl+S, Ctrl+/, Ctrl+,, Ctrl+Q) | `use-app-keys` (helper inlined — single call site) |
| Workflow escape → navigate home | `use-workflow-keys` |
| Workflow Ctrl chords (sidebar, diff toggle) | `use-workflow-keys` (reads `features/workflow/keyboard.ts`) |
| Workflow scroll (review + conversation) | `use-workflow-keys` (reads `features/workflow/keyboard.ts` + `features/workflow/layout.ts`) |

The `KeyAction` union type (`src/hooks/keyboard-handlers.ts:5-15`) splits alongside: the `exit | navigate-home | open-overlay` cases are emitted by `use-app-keys`; `toggle-sidebar | toggle-diff | review-scroll | conversation-scroll-*` cases are emitted by `use-workflow-keys`. Each hook keeps its own local `applyAction` dispatcher.

### 4.3 Import migration pattern

Every consumer of a moved file gets rewritten in the same commit as the move. Examples:

```ts
// Before Phase 1
import { useWorkflow } from '../hooks/use-workflow.js';
import { WorkflowHeader } from '../components/workflow/header.js';

// After Phase 1
import { useWorkflow } from '../features/workflow/hooks/use-workflow.js';
import { WorkflowHeader } from '../features/workflow/components/header.js';
```

```ts
// Before Phase 0 (ui/ merge)
import { Spinner } from '../ui/spinner.js';
import { theme } from '../ui/theme.js';

// After Phase 0
import { Spinner } from '../components/spinner.js';
import { theme } from '../components/theme.js';
```

Agent rule: for each phase, run `rg "from '.*<moved-path>'" src/` before declaring the phase complete. Zero hits on old paths.

### 4.4 Test handling

| File | Action | Reason |
|---|---|---|
| `src/hooks/workflow-handlers.test.ts` | DELETE (Phase 0) | Asserts setter/getter mechanics on a handler registry. Pure implementation detail. |
| `src/hooks/use-workflow.test.tsx` | DELETE (Phase 0) | Tests the composite facade; each sub-hook (`use-workflow-runner`, `use-workflow-review-input`) has its own behavioral test. |
| `src/hooks/use-filterable-list.test.ts` | TRIM (Phase 0) | Keep arrow-navigation + filter semantics. Remove raw state-push assertions. |
| `src/hooks/keyboard-handlers.test.ts` | DELETE (Phase 0) if exists, or move pure-fn tests to `features/workflow/keyboard.test.ts` (Phase 9) | Pure functions test at the feature location. |
| `src/hooks/detection-adapter.test.ts` | MOVE (Phase 0) to `src/engine/detection/adapter.test.ts` | Integration tests — keep. |
| All other hook tests | MOVE alongside their hook | Colocated tests move with the file. |

## 5. Phases

Each phase is self-contained. One agent per phase. Gate commands run at the end of every phase (§7).

### Phase 0 — Pre-work: cleanup + merges

Scope: no feature folders yet. Restructure shared infrastructure and prune tests.

**Actions:**

1. **Merge `src/ui/` → `src/components/`** — move files:
   - `src/ui/diff-view.tsx` → `src/components/diff-view.tsx`
   - `src/ui/filter-input.tsx` → `src/components/filter-input.tsx`
   - `src/ui/markdown.tsx` → `src/components/markdown.tsx`
   - `src/ui/scroll-indicator.tsx` → `src/components/scroll-indicator.tsx`
   - `src/ui/spinner.tsx` → `src/components/spinner.tsx`
   - `src/ui/theme.tsx` → `src/components/theme.tsx`
   - `src/ui/theme.test.tsx` → `src/components/theme.test.tsx`
   - `src/ui/input/` → `src/components/input/`
2. **Move `src/ui/kitty-keyboard.ts` → `src/utils/kitty-keyboard.ts`** (it is not a component).
3. **Move `src/hooks/detection-adapter.ts` + test → `src/engine/detection/adapter.ts` + `src/engine/detection/adapter.test.ts`**.
4. **Delete `src/components/summary/index.ts`** (barrel per [`NO-BARRELS.md`](./NO-BARRELS.md)). Rewrite consumers to import directly from sibling files.
5. **Test pruning:**
   - Delete `src/hooks/workflow-handlers.test.ts`.
   - Delete `src/hooks/use-workflow.test.tsx`.
   - Trim `src/hooks/use-filterable-list.test.ts` to behavioral cases (arrow navigation + filter). Remove raw setter/getter assertions. Agent must read the file before trimming and document which cases were removed.
6. **Rewrite every consumer import** for the moved files. Grep confirmations listed below.
7. Delete `src/ui/` directory (must be empty after step 1–2).

**Exclusions:** Do not create `src/features/`. Do not touch `src/hooks/use-global-keys.ts` yet.

**Grep confirmations (must return zero hits):**

```bash
rg "from '.*src/ui/" src/                              # no imports from src/ui
rg "from '.*\\.\\./ui/" src/                            # no relative imports to ../ui
rg "from '.*hooks/detection-adapter" src/              # detection-adapter moved
rg "from '.*summary/index'" src/                        # summary barrel gone
```

**Expected diff shape:** all changes in `src/components/`, `src/utils/`, `src/engine/detection/`, `src/hooks/`, and import sites. No changes in `src/features/` (does not exist yet). No changes in `src/engine/` except the new `detection/adapter.ts` pair. No changes in `src/core/**`, `src/cli/**`, `src/stores/**`.

### Phase 1 — Feature: `workflow`

Scope: create `src/features/workflow/` and absorb every file currently dedicated to the workflow domain.

**Actions:**

1. Create directory structure (subfolders: `components/`, `hooks/`).
2. **Move screen:**
   - `src/screens/workflow.tsx` → `src/features/workflow/screen.tsx`
3. **Move components:**
   - `src/components/workflow/header.tsx` → `src/features/workflow/components/header.tsx`
   - `src/components/workflow/sidebar.tsx` → `src/features/workflow/components/sidebar.tsx`
   - `src/components/workflow/cost-footer.tsx` → `src/features/workflow/components/cost-footer.tsx`
   - `src/components/workflow/pipeline-bar.tsx` → `src/features/workflow/components/pipeline-bar.tsx`
   - `src/components/workflow/review-view.tsx` → `src/features/workflow/components/review-view.tsx`
   - `src/components/workflow/task-summary.tsx` → `src/features/workflow/components/task-summary.tsx`
   - `src/components/workflow/use-cost-stats.ts` → `src/features/workflow/hooks/use-cost-stats.ts`
   - `src/components/conversation-flow/` → `src/features/workflow/components/conversation-flow/`
   - `src/components/event-cards/` → `src/features/workflow/components/event-cards/`
4. **Move hooks:**
   - `src/hooks/use-workflow.ts` → `src/features/workflow/hooks/use-workflow.ts`
   - `src/hooks/use-workflow-runner.ts` → `src/features/workflow/hooks/use-workflow-runner.ts`
   - `src/hooks/use-workflow-review-input.ts` (+ test) → `src/features/workflow/hooks/use-workflow-review-input.ts` (+ test)
   - `src/hooks/use-input-mode.ts` (+ test) → `src/features/workflow/hooks/use-input-mode.ts` (+ test)
   - `src/hooks/use-review-content.ts` (+ test) → `src/features/workflow/hooks/use-review-content.ts` (+ test)
   - `src/hooks/use-mouse-scroll.ts` (+ test) → `src/features/workflow/hooks/use-mouse-scroll.ts` (+ test)
5. **Move pure helpers:**
   - `src/hooks/workflow-handlers.ts` → `src/features/workflow/handlers.ts` (test was deleted in Phase 0)
   - `src/hooks/conversation-layout-snapshot.ts` (+ test) → `src/features/workflow/layout.ts` (+ test)
6. **Rewrite every consumer import**, including within moved files (relative paths change depth).
7. **Delete empty directories:** `src/components/workflow/`, `src/components/conversation-flow/`, `src/components/event-cards/`. Do not delete `src/screens/` yet (Phases 2–4 still use it).

**Exclusions:** Do not split `use-global-keys` (Phase 9). Do not move `keyboard-handlers.ts` yet (Phase 9).

**Grep confirmations:**

```bash
rg "from '.*screens/workflow'" src/                           # workflow screen moved
rg "from '.*components/workflow/" src/                        # workflow components moved
rg "from '.*components/conversation-flow" src/                # conversation-flow moved
rg "from '.*components/event-cards" src/                      # event-cards moved
rg "from '.*hooks/use-workflow" src/                          # workflow hooks moved
rg "from '.*hooks/(use-input-mode|use-review-content|use-mouse-scroll)" src/
rg "from '.*hooks/workflow-handlers" src/                     # handlers moved
rg "from '.*hooks/conversation-layout-snapshot" src/          # layout moved
```

### Phase 2 — Feature: `home`

**Actions:**

1. Create `src/features/home/` with `components/`.
2. `src/screens/home.tsx` → `src/features/home/screen.tsx`.
3. `src/components/home/config-summary.tsx` → `src/features/home/components/config-summary.tsx`.
4. `src/components/home/recent-sessions.tsx` → `src/features/home/components/recent-sessions.tsx`.
5. Rewrite consumer imports.
6. Delete empty `src/components/home/`.

**Grep confirmations:**

```bash
rg "from '.*screens/home'" src/
rg "from '.*components/home/" src/
```

### Phase 3 — Feature: `setup`

**Actions:**

1. Create `src/features/setup/`.
2. `src/screens/setup.tsx` → `src/features/setup/screen.tsx`.
3. Rewrite consumer imports.

**Grep confirmation:**

```bash
rg "from '.*screens/setup'" src/
```

### Phase 4 — Feature: `summary`

**Actions:**

1. Create `src/features/summary/` with `components/`.
2. `src/screens/summary.tsx` → `src/features/summary/screen.tsx`.
3. `src/components/summary/summary-cost-breakdown.tsx` → `src/features/summary/components/summary-cost-breakdown.tsx`.
4. `src/components/summary/summary-phase-timing.tsx` → `src/features/summary/components/summary-phase-timing.tsx`.
5. `src/components/summary/summary-progress.tsx` → `src/features/summary/components/summary-progress.tsx`.
6. `src/components/summary/summary-task-table.tsx` → `src/features/summary/components/summary-task-table.tsx`.
7. Barrel `src/components/summary/index.ts` was deleted in Phase 0; verify it is gone.
8. Rewrite consumer imports.
9. Delete empty `src/components/summary/`.

**Grep confirmations:**

```bash
rg "from '.*screens/summary'" src/
rg "from '.*components/summary/" src/
```

### Phase 5 — Feature: `settings`

**Actions:**

1. Create `src/features/settings/`.
2. `src/components/overlays/settings-overlay/index.tsx` → `src/features/settings/overlay.tsx`.
3. `src/components/overlays/settings-overlay/use-edit-buffer.ts` → `src/features/settings/use-edit-buffer.ts`.
4. `src/components/overlays/settings-overlay/use-settings-editor.ts` → `src/features/settings/use-settings-editor.ts`.
5. **`use-settings-list.ts`** — this is a thin wrapper over `use-filterable-list`. Read the consumer (`use-settings-editor.ts`) and inline. If after inlining, `use-settings-list` is no longer used anywhere, delete the file. If inlining is non-trivial, defer to a follow-up RFC and move the file to `src/features/settings/use-settings-list.ts` unchanged. Agent must report which path was taken.
6. Rewrite consumer imports (primarily `src/app.tsx` and any overlay-routing code).
7. Delete empty `src/components/overlays/settings-overlay/`.

**Grep confirmations:**

```bash
rg "from '.*components/overlays/settings-overlay" src/
```

### Phase 6 — Feature: `sessions`

**Actions:**

1. Create `src/features/sessions/`.
2. `src/components/overlays/sessions-picker/index.tsx` → `src/features/sessions/picker.tsx`.
3. `src/components/overlays/sessions-picker/sessions-picker-select.ts` → `src/features/sessions/picker-select.ts`.
4. `src/components/overlays/sessions-picker/sessions-picker.test.tsx` → `src/features/sessions/picker.test.tsx`.
5. `src/components/sessions/session-row.tsx` → `src/features/sessions/session-row.tsx`.
6. Rewrite consumer imports.
7. Delete empty `src/components/overlays/sessions-picker/` and `src/components/sessions/`.

**Grep confirmations:**

```bash
rg "from '.*components/overlays/sessions-picker" src/
rg "from '.*components/sessions/" src/
```

### Phase 7 — Feature: `tool-picker`

**Actions:**

1. Create `src/features/tool-picker/`.
2. Move every file from `src/components/overlays/tool-model-picker/` to `src/features/tool-picker/` preserving names.
3. Update the `refreshDetectionStores` import in `picker-view.tsx` to point at the new `src/engine/detection/adapter.ts` path (the Phase 0 target).
4. Rewrite consumer imports.
5. Delete empty `src/components/overlays/tool-model-picker/`.

**Grep confirmations:**

```bash
rg "from '.*components/overlays/tool-model-picker" src/
```

### Phase 8 — Feature: `skills`

**Actions:**

1. Create `src/features/skills/`.
2. `src/components/overlays/skills-picker.tsx` → `src/features/skills/picker.tsx`.
3. Rewrite consumer imports.

**Grep confirmations:**

```bash
rg "from '.*components/overlays/skills-picker" src/
```

### Phase 9 — Split `use-global-keys` + `keyboard-handlers`

Scope: last hook restructuring step, executed after all feature folders exist so the new paths resolve.

**Actions:**

1. **Create `src/features/workflow/keyboard.ts`** with the workflow-scope pure functions from `src/hooks/keyboard-handlers.ts`:
   - `handleWorkflowEscape`
   - `handleWorkflowCtrlChords`
   - `handleReviewScroll`
   - `handleConversationScroll`
   - Move the `KeyAction` variants used only by these (`toggle-sidebar`, `toggle-diff`, `review-scroll`, `conversation-scroll-*`).
2. **Create `src/features/workflow/hooks/use-workflow-keys.ts`**:
   - Hosts the workflow-scoped `useInput` dispatchers currently in `use-global-keys.ts`: workflow escape (`navigate-home` on cancelled), workflow ctrl-chords, workflow scroll.
   - Owns a local `applyAction` that dispatches workflow actions only.
   - Reads from `features/workflow/keyboard.ts` (pure fn) and `features/workflow/layout.ts` (snapshot).
   - Mounted from `src/features/workflow/screen.tsx` unconditionally (the screen itself only renders when `screen === 'workflow'`).
3. **Create `src/hooks/use-app-keys.ts`**:
   - Hosts the always-active dispatchers: Ctrl+C (with screen-aware abort branch preserved verbatim from current behavior), Escape → overlay close, app-wide shortcuts (`handleShortcutKeys` inlined — only one call site remained after the split).
   - Owns a local `applyAction` for app-level actions (`exit`, `navigate-home`, `open-overlay`).
4. **Update `src/layout.tsx`** (or wherever `useGlobalKeys` is currently called): replace `useGlobalKeys({ exit })` with `useAppKeys({ exit })`. Ensure `useWorkflowKeys` is called inside `features/workflow/screen.tsx`, not at the layout level.
5. **Delete** `src/hooks/use-global-keys.ts` and `src/hooks/keyboard-handlers.ts`.
6. Colocate tests for `features/workflow/keyboard.ts` as `features/workflow/keyboard.test.ts` (if pure-fn tests existed for `handleWorkflow*` / `handleReviewScroll` / `handleConversationScroll` in the old test file, move those cases; drop the rest).

**Risk — cross-cutting behavior in Ctrl+C:** the current implementation checks `screen === 'workflow'` inside the Ctrl+C callback to decide abort vs exit. Keep this branch in `use-app-keys` (not in `use-workflow-keys`). Rationale: Ctrl+C must fire even when workflow-specific listeners are unmounted; the abort side-effect is keyed on screen state at the moment the key fires, not on listener mount state.

**Grep confirmations:**

```bash
rg "use-global-keys|useGlobalKeys" src/                        # must be zero
rg "keyboard-handlers" src/                                     # must be zero
rg "from '.*features/workflow/keyboard" src/                    # new location referenced
rg "from '.*features/workflow/hooks/use-workflow-keys" src/     # new hook referenced
rg "from '.*hooks/use-app-keys" src/                            # new hook referenced
```

### Phase 10 — Finalization

**Actions:**

1. Delete empty `src/screens/` directory (verify: `ls src/screens` returns nothing).
2. Delete empty `src/components/overlays/` subdirectories (only shared overlay files should remain at `src/components/overlays/*.tsx`).
3. Verify no `src/hooks/{subdir}/` was created — directory must stay flat per [`HOOKS.md`](./HOOKS.md).
4. Verify final shared `src/hooks/` contents match §4.1: exactly `use-filterable-list.ts` (+ test), `use-static-selector.ts`, `use-async-highlight.ts`, `use-app-keys.ts`.
5. **Update [`CLAUDE.md`](../CLAUDE.md) project tree** to reflect the new layout.
6. **Update [`STORES.md`](./STORES.md)** "Engine Write Pattern" section — replace references to `src/hooks/*` paths that moved.
7. **Update [`ARCHITECTURE.md`](./ARCHITECTURE.md)** — the layer diagram and narrative mention `src/screens/`, `src/ui/`, `src/components/` in its pre-restructure shape. Rewrite to reflect `src/features/` + flat shared.
8. Mark this RFC as **Executed** (status header in §1).

**Grep confirmations:**

```bash
find src/hooks -type d                                         # only src/hooks itself
find src/hooks -name 'index.ts' -o -name 'index.tsx'           # zero results (no barrels)
find src -name 'index.ts' -type f | xargs -I {} grep -l "^export .* from" {} || true
                                                                # any remaining barrel files (should be zero in src/)
find src/screens -type f                                       # zero results
find src/ui -type f                                            # zero results
```

## 6. Execution

**Main context** (this session): owns the RFC, writes the docs, spawns agents, reviews reports. Does not touch source files directly for phased moves — that work goes to agents so the main context does not carry the per-file diff weight.

**Phase agent** (one per phase, 0–10): receives a self-contained brief with:
- This RFC path.
- Phase number.
- Exact file list with action per file (copied from §5 into the brief).
- Invariants from §2.
- Success criteria from §7.
- Gate commands from §7.
- **`NEVER STAGE, NEVER COMMIT`** reminder. The `.claude/hooks/block-git-commits.sh` guardrail enforces this.
- List of grep confirmations that must return zero hits.

**Execution order:** strictly sequential. Phase N+1 starts only after main context verifies Phase N's report and diff.

**Agent instruction for all phases:**

> Execute the moves exactly as listed. Rewrite imports as you go. Run the gate commands at the end. If any command fails, **stop** — do not continue to the next file. Report back with: (a) list of files changed, (b) gate command output, (c) grep confirmations. Do not commit, do not stage. Leave every change as unstaged modification. If the gate fails, do not try to "fix" it aggressively — report the failure and let the main context decide.

## 7. Success criteria (per phase, binary)

Every phase is done when **all** of the following pass:

```bash
npm run typecheck
npm run lint
npm test
```

...plus the phase-specific grep confirmations listed in §5, which must return **zero hits** before the phase is considered complete.

Additional per-phase gates:

- **Phase 0:** `find src/ui -type f` returns zero results.
- **Phase 1:** `src/features/workflow/` exists with the exact subtree in §4.1.
- **Phase 9:** `rg "use-global-keys|keyboard-handlers" src/` returns zero.
- **Phase 10:** CLAUDE.md project tree updated; status header of this RFC updated to **Executed**.

## 8. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Phase 1 is huge (workflow is the dominant feature). Agent runs out of steam mid-move and leaves broken imports. | High | Split Phase 1 into sub-phases at agent-brief time if the agent reports context pressure. Sub-phases: 1a components, 1b hooks, 1c handlers/layout. Gate between each. |
| Ctrl+C split (Phase 9) loses the double-press-window or the abort branch. | Medium | Agent must read current `use-global-keys.ts` lines 74–96 before writing `use-app-keys.ts`. Behavior must be byte-equivalent for the Ctrl+C callback. |
| `use-settings-list` inline (Phase 5) turns out to be non-trivial. | Medium | RFC explicitly allows deferral. Agent moves the file unchanged and reports. Follow-up RFC handles the inline. |
| Import depth changes cause a cascading rewrite the agent misses. | Medium | Grep confirmations in §5 are the contract. If any grep returns a hit, the phase is not done. |
| A test file relies on relative imports that break. | Low | Colocated tests move with their source. Test imports update like any other consumer. |
| `components/summary/index.ts` deletion (Phase 0) breaks a consumer that imported via the barrel. | Low | Agent greps `from '.*summary/index'` and `from '.*components/summary'` (without trailing file), then rewrites each to a direct sibling import. |
| An agent partially completes a phase, leaves broken imports. | Medium | Agent instruction: if any gate fails mid-phase, revert the phase's moves with `git restore src/` (working-tree state only; the block-git-commits hook prevents accidental commits) and report. Do not leave half-migrated state. |

## 9. Post-execution

After Phase 10, `src/` stabilizes around:

- Seven top-level infra directories (`cli/`, `core/`, `engine/`, `stores/`, `components/`, `hooks/`, `utils/`).
- One domain directory (`features/`) containing eight feature folders.
- Five root files (`app.tsx`, `layout.tsx`, `cli.ts`, `types.ts`, `type-safety-sweep.test.ts`).

Future RFCs can then address:

- **Shared component unbarreling** if any re-export barrels remain outside the audited set.
- **Store restructure Phase 4** (if `src/stores/workflow/` gains more cross-tree actions, consider a `controls/` peer).
- **Engine feature alignment** — map `src/engine/orchestrator/*` concerns onto the `features/workflow/` boundary where useful (e.g., does `features/workflow/` own the orchestrator's UI-facing types?). Deferred — engine is stable.

## References

- [`STRUCTURE.md`](./STRUCTURE.md) — steady-state architecture doc produced by this RFC. After execution, that doc is the living reference; this one is historical.
- [`HOOKS.md`](./HOOKS.md) — target hook layout, anti-patterns, and placement rule this RFC delivers.
- [`STORES.md`](./STORES.md) — companion doc; same colocation principle, different state.
- [`NO-BARRELS.md`](./NO-BARRELS.md) — project-wide barrel policy.
- [`STORES-RESTRUCTURE.md`](./STORES-RESTRUCTURE.md) — template this RFC follows (phased execution, agent briefs, gate commands).
- [bulletproof-react — project structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) — source of the shared-vs-feature rule.
- [Feature-Sliced Design — Overview](https://feature-sliced.design/docs/get-started/overview) — adjacent methodology; informed the decision to stop at features/ + flat shared (no `shared/` wrapper, no `pages/` layer).
