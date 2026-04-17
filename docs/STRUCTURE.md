# Project Structure

How `src/` is organized on disk. For data flow between layers (CLI → stores → engine/UI), see [`ARCHITECTURE.md`](./ARCHITECTURE.md). For state patterns, see [`STORES.md`](./STORES.md). For hook placement rules, see [`HOOKS.md`](./HOOKS.md).

diptych organizes UI code by **business domain**, not by technical layer. A feature is a self-contained business concept — the code that implements it (screen, components, hooks, pure helpers, tests) lives in one folder under `src/features/`. Cross-cutting primitives (shared UI, shared hooks, low-level utilities) live flat at `src/` root.

## What we follow

This is **feature-based organization, bulletproof-react-inspired**, adapted for an Ink CLI:

- `src/features/{feature}/` holds the full vertical slice for one business concept.
- Shared code sits flat at `src/` root in `components/`, `hooks/`, `utils/`, `lib/` — no `shared/` wrapper.
- Features **do not import from other features**. Composition happens at the top level (`src/app.tsx`).
- No barrels anywhere, per [`NO-BARRELS.md`](./NO-BARRELS.md).
- Tests are colocated next to source.

## Top-level layout

```
src/
├── app.tsx, layout.tsx, cli.ts              # app entry + shell
├── cli/                                     # CLI subcommand handlers
├── core/                                    # domain logic (config, types, state, formatting)
├── engine/                                  # workflow orchestrator (zero React)
├── stores/                                  # external stores — see STORES.md
├── components/                              # shared UI (cross-feature)
├── hooks/                                   # shared hooks (cross-feature) — see HOOKS.md
├── lib/                                     # infrastructure wrappers (git, fs, process, terminal, highlight) — see LAYERS.md
├── utils/                                   # generic primitives (zero domain, zero infra) — see LAYERS.md
└── features/                                # business features
    ├── workflow/
    ├── home/
    ├── setup/
    ├── summary/
    ├── settings/
    ├── sessions/
    ├── tool-picker/
    └── skills/
```

The distinction between `lib/` (infrastructure wrappers around external systems) and `utils/` (pure primitives with zero domain and zero infra dependency) is the layering spine of the codebase. See [`LAYERS.md`](./LAYERS.md) for the full decision tree and anti-patterns.

There is no `src/screens/` directory. Each feature exports its own `screen.tsx` (or `picker.tsx` / `overlay.tsx` for overlay-style features), and `src/app.tsx` dispatches based on `routerStore.use(s => s.screen)`.

## Feature anatomy

A feature folder contains the code a feature needs, and nothing else. Subfolders appear only where there is natural grouping.

**Full-screen feature** (e.g. `features/workflow/`):

```
features/workflow/
├── screen.tsx                # feature entry — rendered by app.tsx
├── components/               # feature-local components
│   ├── header.tsx
│   ├── sidebar.tsx
│   ├── conversation-flow/    # sub-component folder
│   └── event-cards/
├── hooks/                    # feature-local hooks
│   ├── use-workflow.ts
│   └── use-workflow-keys.ts
├── handlers.ts               # pure helper — engine↔UI bridge
├── keyboard.ts               # pure helper — keyboard action dispatchers
└── layout.ts                 # pure helper — geometry snapshots
```

**Overlay-style feature** (e.g. `features/settings/`):

```
features/settings/
├── overlay.tsx               # feature entry — rendered when overlay active
├── use-edit-buffer.ts        # feature-local hook (trivial, inline candidate)
└── use-settings-editor.ts    # feature-local hook
```

**Minimal feature** (e.g. `features/setup/`):

```
features/setup/
└── screen.tsx
```

Rules:
- **`components/` subfolder** appears only when the feature has ≥2 component files.
- **`hooks/` subfolder** appears only when the feature has ≥2 hook files.
- **Pure helpers** (non-React modules) sit at the feature root as flat files (`handlers.ts`, `keyboard.ts`, `layout.ts`). They get the `.ts` extension and their tests colocate (`keyboard.test.ts`).
- **No `index.ts` barrels** inside a feature. The entry point is a named file (`screen.tsx`, `overlay.tsx`, `picker.tsx`). See [`NO-BARRELS.md`](./NO-BARRELS.md).

## Placement decision

When adding new UI code, ask: **does this belong to a single business feature, or to multiple?**

| Situation | Location |
|---|---|
| Code used by one feature only | `src/features/{feature}/` |
| Component reused by ≥2 features | `src/components/` (flat or in an existing subfolder like `overlays/` / `pickers/`) |
| Hook reused by ≥2 features or a UI primitive | `src/hooks/` — see [`HOOKS.md`](./HOOKS.md) |
| Pure primitive (no React, no domain, no infra) | `src/utils/` |
| Infrastructure wrapper (wraps an external system — git, filesystem, subprocess, terminal) | `src/lib/` |
| Domain logic (knows tiny-spec concepts — config, cost, tokens, sessions) | `src/core/` |
| New business concept that does not fit any existing feature | New `src/features/{new-name}/` |

If you are not sure whether code is shared, **start in the feature**. Promote to shared only when the second consumer appears. The reverse (moving shared code back into a feature) is a worse refactor.

## Cross-feature rule

**Features must not import from each other.** `features/home/*` must not import from `features/workflow/*`.

Why:
- Two features importing each other breaks the "one folder, one concept" model.
- It creates implicit ordering constraints: you cannot remove or rewrite feature A without checking what feature B consumed.
- It invites circular imports.

If you need shared behavior across features, it belongs in `src/components/`, `src/hooks/`, `src/utils/`, `src/core/`, or `src/stores/`. Composition between features happens at the app level (`src/app.tsx` dispatches, `src/layout.tsx` wraps).

The one sanctioned cross-cutting channel between features is **stores**. Feature A can write to `workflowStore`, and feature B can read from it — that is the same engine→UI pattern already described in [`STORES.md`](./STORES.md).

## Shared components

`src/components/` holds UI that is not tied to any single feature:

- **Primitives** — `theme.tsx`, `spinner.tsx`, `scroll-indicator.tsx`, `card.tsx`, `labeled-row.tsx`, `screen-shell.tsx`, `diff-view.tsx`, `filter-input.tsx`, `markdown.tsx`.
- **Input subsystem** — `input/` (multiline input primitive), `input-bar/` (composite used on every screen).
- **Shared overlays** — `overlays/overlay-panel.tsx`, `overlays/command-palette.tsx`, `overlays/help-overlay.tsx`, `overlays/mode-selector.tsx`, `overlays/text-input-overlay.tsx`.
- **Picker primitives** — `pickers/filterable-list.tsx`, `pickers/static-selector.tsx`, `pickers/two-column-picker/`.

There is **no separate `src/ui/` directory** for primitives. The distinction between "primitive" and "composed" is fuzzy in practice (stateful primitives exist; stateless composed widgets exist). Flat `src/components/` with natural subfolders (`input/`, `overlays/`, `pickers/`) is enough.

If `src/components/` ever grows past ~30 direct entries, revisit and consider `src/components/ui/` for atomic design-system primitives. Not before.

## Screen-per-feature

`src/app.tsx` dispatches screens by reading `routerStore.screen` and importing each feature's entry point directly:

```ts
// src/app.tsx (conceptually)
import { HomeScreen } from './features/home/screen.js';
import { WorkflowScreen } from './features/workflow/screen.js';
// ...

function renderScreen(screen: Screen) {
  switch (screen) {
    case 'home': return <HomeScreen />;
    case 'workflow': return <WorkflowScreen />;
    // ...
  }
}
```

This replaces the previous `src/screens/*.tsx` layer. The screen component is the feature's entry point and lives with the feature's internals — same folder, same context.

## Feature entry-point naming

| Feature kind | Entry filename |
|---|---|
| Full screen | `screen.tsx` |
| Overlay | `overlay.tsx` |
| Picker overlay | `picker.tsx` |

Consistency helps `grep` and editor navigation. If a feature has multiple entry points (rare), use descriptive names instead of `index.tsx`.

## Test strategy

- Tests live next to source (`keyboard.test.ts` next to `keyboard.ts`).
- **Integration / behavior tests belong at the hook or component level.** Test what a consumer would observe.
- **Pure helpers have their own tests.** `keyboard.ts`, `layout.ts`, `handlers.ts` — pure fns are trivial to test without React.
- **Trivial hooks (≤30 LOC, no branching) do not need tests.** They are covered through the integration test of the component that uses them. See [`HOOKS.md`](./HOOKS.md) for the full rule.
- **Do not test implementation.** Do not assert on `setState` calls, hook call counts, or private-module internals. See [`test-behavior-not-implementation`](../CLAUDE.md#testing-policy).

## Design decisions

**Why features + flat shared, not `shared/` wrapper?**
Bulletproof-react allows both. We chose flat shared because:
1. `src/components/`, `src/hooks/`, `src/utils/` already exist as flat top-level dirs. Wrapping them in `src/shared/` would add depth without changing semantics.
2. One hop (`from '../components/theme.js'`) is shorter and clearer than two (`from '../shared/components/theme.js'`).
3. Node ESM with no bundler means every directory jump is a real filesystem lookup — fewer hops is a minor perf win.

**Why not Feature-Sliced Design (FSD)?**
FSD's seven layers (`app`, `processes`, `pages`, `widgets`, `features`, `entities`, `shared`) are designed for large product teams shipping web SPAs. For a single-binary CLI with one screen-dispatch root, five of those layers collapse into our `features/` + `app.tsx`. Adopting FSD literally would create empty `processes/`, `pages/`, and `entities/` layers with no content. The signal-to-noise ratio is wrong for this project.

**Why eliminate `src/screens/`?**
A screen is the entry point of a feature — it is not a separate technical layer. Keeping screens in their own dir forces every change to a feature to touch two folders. The feature folder *is* the screen's home.

**Why merge `src/ui/` into `src/components/`?**
See "Shared components" above. The primitive/composed boundary is fuzzy and unenforced. One folder = one mental model.

**Why not generate features from templates?**
Features are small and irregular. A template would over-prescribe (minimal features are two files; workflow has a dozen). Copy the nearest matching feature and prune.

## Anti-patterns

| Don't | Why |
|---|---|
| Import from another feature (`features/home` imports from `features/workflow`) | Breaks the "one folder, one concept" model. Use a shared module or store. |
| Create `src/features/shared/` or `src/features/common/` | That is `src/components/`, `src/hooks/`, `src/utils/`. Do not nest shared under features. |
| Keep a `src/screens/` folder | Screens are feature entry points; they live in their feature. |
| Add a primitive to `src/ui/` | There is no `src/ui/`. Shared primitives go in `src/components/`. |
| Create `features/{f}/index.ts` as a re-export barrel | Barrels are forbidden per [`NO-BARRELS.md`](./NO-BARRELS.md). Use the named entry (`screen.tsx`, `overlay.tsx`, `picker.tsx`). |
| Put pure functions under a feature's `hooks/` subfolder | Hooks imply React lifecycle. Pure fns go at the feature root (`keyboard.ts`, `layout.ts`). |
| Test a trivial feature-local hook in isolation | Behavior lives in the component that uses it. Test at that level. |
| Create a feature for a single overlay file | If the overlay has no hooks, no pure helpers, and no tests, it is not a feature. Keep it in `src/components/overlays/` until it earns feature status. |
| Share a type by cross-feature import | Shared types belong in `src/core/types/` or the store that owns the domain. |

## Rules of thumb

1. **A feature is discoverable.** Opening `src/features/{feature}/` must reveal the entire feature. If you need to grep to understand what a feature does, the layout failed.
2. **Shared earns its place.** A module enters `src/components/`, `src/hooks/`, or `src/utils/` only when used by ≥2 features. Premature sharing is as costly as premature abstraction.
3. **The app.tsx is the only cross-feature composition point.** If you find yourself wiring feature A's output into feature B's input anywhere else, re-examine the feature boundary.
4. **Changes to one feature should touch one folder.** If a feature change requires edits in multiple top-level directories, something crossed a boundary that shouldn't have.

## Feature inventory

| Feature | Responsibility | Entry file |
|---|---|---|
| `workflow` | Running workflow — conversation flow, event cards, sidebar, input mode, keyboard, runner lifecycle | `screen.tsx` |
| `home` | Landing screen — banner, config summary, recent sessions, input | `screen.tsx` |
| `setup` | First-time setup — planner + implementer selection | `screen.tsx` |
| `summary` | Post-workflow report — cost, task table, phase timing | `screen.tsx` |
| `settings` | Settings overlay — field editor for config | `overlay.tsx` |
| `sessions` | Sessions picker — select a past session to resume | `picker.tsx` |
| `tool-picker` | Planner/implementer tool + model selection | `picker.tsx` |
| `skills` | Skills picker — toggle available skills for a workflow | `picker.tsx` |

Each feature's entry file is what `src/app.tsx` (or `src/layout.tsx` for overlays) imports. Internal structure is documented by inspection — there is no catalog per-feature.

## References

- [`HOOKS.md`](./HOOKS.md) — hook placement rules; companion to this doc.
- [`STORES.md`](./STORES.md) — state architecture; same colocation principle.
- [`NO-BARRELS.md`](./NO-BARRELS.md) — project-wide barrel policy.
- [`FEATURES-RESTRUCTURE.md`](./FEATURES-RESTRUCTURE.md) — RFC that produced this layout.
- [bulletproof-react — project structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) — source pattern.
- [Feature-Sliced Design — Overview](https://feature-sliced.design/docs/get-started/overview) — adjacent methodology considered and declined for this project's size.
- [React docs — Thinking in React](https://react.dev/learn/thinking-in-react) — component decomposition.
