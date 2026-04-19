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

## Layer inventory — non-feature folders

Contents of the non-feature folders that have more than a handful of files. Feature folders are catalogued in [Feature inventory](#feature-inventory).

### `src/cli/` — CLI entry + subcommand handlers

```
src/cli/
├── init-stores.ts     # single-file bootstrap; 3 internal helpers; see BOOTSTRAP.md
├── options.ts         # commander option builder (addWorkflowOptions)
├── setup.ts           # bootstrap prep (resolveProjectDir, ensureGitAndConfig, setupWorkflow)
├── render.ts          # Ink / fullscreen render setup
├── errors.ts          # cliError() factory + isCliError predicate — see ERRORS.md
└── commands/          # commander subcommand handlers (thin — delegate to core)
    ├── start.ts
    ├── resume.ts
    ├── spec.ts
    ├── init.ts
    ├── status.ts
    └── migrate.ts     # thin wrapper; business logic in core/migration/executor.ts
```

The previous `cli/workflow.ts` is split into `options.ts` + `setup.ts`; `cli/input-history-persistence.ts` moved to `stores/ui/persistence.ts`.

### `src/stores/ui/` — ephemeral UI chrome stores

```
src/stores/ui/
├── controls.ts        # sidebarVisible + inputMode (cross-tree flags)
├── terminal-size.ts   # terminal resize tracking + responsive layout
├── overlay.ts         # overlay active/exclusive/stack state
├── feedback.ts        # feedback/error message state
├── input-history.ts   # command input history (in-memory)
├── input-height.ts    # input bar rendered height (cross-tree)
└── persistence.ts     # disk I/O for inputHistoryStore (hydrate + debounced save)
```

`persistence.ts` is called from `cli/init-stores.ts` at boot. See [`BOOTSTRAP.md`](./BOOTSTRAP.md) for why I/O colocates with the store rather than living in `cli/`.

### `src/core/sessions/` — session domain

```
src/core/sessions/
├── analytics.ts       # session analytics (cost, duration, tasks)
├── io.ts              # read/write session state + log files
├── lifecycle.ts       # active-session pointer (readActive, writeActive, clearActive)
├── log-reader.ts      # JSONL session log reader
└── guards.ts          # clearStaleSession and related session-state predicates
```

### `src/core/migration/` — pre-v3 state migration

```
src/core/migration/
├── legacy.ts          # pure helpers: deriveSessionId, migrateState, migrateEvents
└── executor.ts        # business logic for the migrate command (orchestrates legacy helpers + I/O)
```

The `migrate` subcommand handler in `cli/commands/migrate.ts` is a thin wrapper: it registers the command with commander and delegates to `executor.ts`. `maybeMigrate()` (used by start/resume) also lives in `executor.ts` — multiple consumers justify the domain placement.

### `src/utils/` — generic primitives

```
src/utils/
├── diff.ts            # LCS diff algorithm
├── error.ts           # error(kind, msg, data?, cause?) factory + matches(kind) predicate — see ERRORS.md
├── format-errors.ts   # error → string with redaction
├── format-time.ts     # generic time formatters
├── frontmatter.ts     # generic YAML frontmatter parser
├── redact.ts          # secret / API-key redaction
├── sectioned-list.ts  # list grouping helper
├── truncate.ts        # text truncation helpers
├── type-guards.ts     # assertNever, isRecord, typedEntries
└── with-timeout.ts    # promise / async-iterable timeout
```

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
└── screen.tsx                # accepts render-prop callbacks for cross-feature composition
```

`features/setup/` never imports from `features/tool-picker/`. It accepts a `renderToolPicker` prop; `src/app.tsx` composes setup + tool-picker together. This is the canonical **callback-composition-at-app.tsx** pattern for cases where one feature needs to render UI owned by another.

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

**Features must not import from each other.** `features/home/*` must not import from `features/workflow/*`. Shared UI goes to `src/components/`. If two features need the same component, promote it — see the `SessionRow` case in [`LAYERS.md`](./LAYERS.md#promoting-a-shared-component-the-2-consumer-rule).

Why:
- Two features importing each other breaks the "one folder, one concept" model.
- It creates implicit ordering constraints: you cannot remove or rewrite feature A without checking what feature B consumed.
- It invites circular imports.

If you need shared behavior across features, it belongs in `src/components/`, `src/hooks/`, `src/utils/`, `src/core/`, or `src/stores/`. Composition between features happens at the app level (`src/app.tsx` dispatches, `src/layout.tsx` wraps).

When feature A needs to render UI owned by feature B (e.g. `setup` rendering the `tool-picker`), feature A accepts a render-prop callback (`renderToolPicker`) and `src/app.tsx` supplies the implementation. See ADR [0007](./adr/0007-feature-boundary-enforcement.md) for the rationale and the canonical `setup/` example.

The one sanctioned cross-cutting channel between features is **stores**. Feature A can write to `workflowStore`, and feature B can read from it — that is the same engine→UI pattern already described in [`STORES.md`](./STORES.md).

## Shared components

`src/components/` holds UI that is not tied to any single feature:

- **Primitives** — `theme.tsx`, `spinner.tsx`, `scroll-indicator.tsx`, `card.tsx`, `labeled-row.tsx`, `screen-shell.tsx`, `diff-view.tsx`, `filter-input.tsx`, `markdown.tsx`.
- **Input subsystem** — `input/` (multiline input primitive), `input-bar/` (composite used on every screen).
- **Shared overlays** — `overlays/overlay-panel.tsx`, `overlays/command-palette.tsx`, `overlays/help-overlay.tsx`, `overlays/text-input-overlay.tsx`. Feature-specific overlays live in their feature folder (e.g. `features/settings/mode-selector.tsx`).
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

Tests follow a hybrid layout driven by **blast radius** — how many top-level folders a test imports from. See [`TESTING.md`](./TESTING.md) for the hands-on guide and [ADR T1](./adr/T1-hybrid-test-layout.md) for the rationale.

**Placement rule (two bins):**

| Blast radius | Location | Example |
|---|---|---|
| ≤ 1 top-level folder | Colocated next to source (`foo.test.ts` by `foo.ts`) | `src/engine/orchestrator/validation.test.ts`, `src/features/workflow/keyboard.test.ts` |
| ≥ 2 top-level folders | `testing/integration/<layer>/` | `testing/integration/cli/`, `testing/integration/orchestrator/`, `testing/integration/ui/` |

The three `testing/integration/` subfolders align with the three stable seams: commander (`cli/`), `runWorkflow()` (`orchestrator/`), and Ink screen + engine-written stores (`ui/`).

**Companion rules:**

- **Pure helpers get colocated tests.** `keyboard.ts`, `layout.ts`, `handlers.ts`, `core/state/machine.ts`, parsers, pricing math — inputs → outputs, zero I/O.
- **Ink tested at the feature seam.** Feature entries (`screen.tsx`, `overlay.tsx`, `picker.tsx`) get tests; feature sub-components do not. Shared primitives in `src/components/` (`FilterableList`, `MultilineInput`, `TwoColumnPicker`) earn dedicated tests because their cost amortises across consumers. See [ADR T3](./adr/T3-ink-feature-seam.md).
- **Engine tested at `runWorkflow()`.** Pure decision modules get colocated units; orchestrator control-flow modules are covered only via integration tests at the `runWorkflow()` seam with fakes from `testing/helpers/orchestrator-factories.ts`. See [ADR T4](./adr/T4-engine-at-runworkflow-boundary.md).
- **Trivial hooks (≤30 LOC, no branching) do not need tests.** Covered through the component that uses them. See [`HOOKS.md`](./HOOKS.md).
- **Fixtures vs factories split by kind.** `testing/fixtures/<domain>/` = read-only bytes on disk; `testing/helpers/factories/<domain>.ts` = pure TS constructors. Rule of two: inline until the second consumer appears. See [ADR T2](./adr/T2-fixtures-vs-factories.md).
- **Static is a tier.** TS strict + Zod schemas are first-class correctness — no runtime shape tests for Zod schemas, no `expectType<>` games. See [ADR T5](./adr/T5-static-as-trophy-tier.md).
- **Do not test implementation.** No `vi.mock()` on `./` / `../` siblings, no spies on internal module functions, no `toHaveBeenCalledTimes` unless call-count IS the contract. See [`test-behavior-not-implementation`](../CLAUDE.md#testing-policy).

Test discovery is configured in `vitest.config.ts` via `include: ['src/**/*.test.{ts,tsx}', 'testing/integration/**/*.test.{ts,tsx}']`. Both trees are picked up by a single `npm test`.

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

## Screaming folders

Folder names describe **what** the code does in the domain, not **which** technical layer it sits in.

✅ `orchestrator/planning/`, `orchestrator/escalation/`, `orchestrator/validation/`, `features/workflow/`
❌ `services/`, `use-cases/`, `controllers/`, `repositories/`, `handlers/`

A reader opening a folder should immediately know what workflow capability lives there. When you are deciding a folder name, ask: does the name reveal the domain or only the tech layer? If the latter, rename.

Reference: [Milan Jovanović — Screaming Architecture](https://www.milanjovanovic.tech/blog/screaming-architecture).

## Deep modules and folder colocation

The codebase follows John Ousterhout's *deep module* principle: a module's public surface should be a small fraction of its internal complexity. A single file with 8 exports and no internals is shallow; a folder with 5 internal files and one entry point is deep.

**When a file grows past the [length threshold](#file-length-thresholds), create a folder named after the file and move its helpers inside alongside the entry file.**

The canonical pattern in this codebase is `src/engine/orchestrator/planning/`:

```
orchestrator/
├── planning/
│   ├── run.ts        # entry — dispatches to the right planning variant
│   ├── new.ts        # internal — new-feature planning flow
│   ├── quick.ts      # internal — quick-mode planning flow
│   ├── rewind.ts     # internal — rewind-to-approval flow
│   └── shared.ts     # internal — shared planning helpers
```

Callers import from `./planning/run.js`. Files other than `run.ts` are **considered internal to the folder** — the folder boundary is the privacy boundary. There is no `_prefix.ts` convention, no linter-enforced "private" — the convention is structural: if it's not the entry file, it's an internal helper of that folder.

**No underscore prefix** (`_run-init.ts`, `_escalation-step.ts`). Google TypeScript Style Guide, Microsoft, and AWS all advise against it in 2025+. Use folder colocation instead.

References:
- [Sandor Dargo — Deep vs Shallow Modules](https://www.sandordargo.com/blog/2023/01/25/deep-vs-shallow-modules)
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)

## File length thresholds

Rough guidance — not a hard rule, but a strong signal:

| File LOC | Responsibilities | Action |
|---|---|---|
| ≤ 200 | Any | Fine |
| 200–300 | 1 | Fine |
| 200–300 | >1 | Split into sibling files |
| > 300 | 1 | Fine, but watch for creep |
| > 300 | >1 | Create a folder with helpers (see [Deep modules and folder colocation](#deep-modules-and-folder-colocation)) |
| > 500 | Any | Reconsider — the file is probably hiding a second concept |

**Counter-rule for giant merged files.** When cleaning up a folder with small scattered files, do not collapse them into one 460-LOC file. Prefer a folder with 4 clean sub-files over one big file with 4 section banners. Section banners are banned (see [No decorative comments](#no-decorative-comments)).

## Prompts folder

Every LLM prompt template (system prompts, task prompts, retry prompts, review prompts) lives in a dedicated folder. Currently `src/engine/spec/prompts/`.

Never inline prompt strings into orchestrator or runner code. This rule is universal across comparable projects (cline `core/prompts/`, continue `core/promptFiles/`, codex has its own `prompts/`). Keeping prompts separate makes them reviewable, testable, and swappable without touching control flow.

## No decorative comments

Banner comments inside files are banned:

```ts
// ❌
// ═══ Types ═══
type Foo = ...;

// ═══ Core dispatch ═══
export function dispatch() { ... }

// ═══ Helpers ═══
function helper() { ... }
```

Instead, organize the file so that related exports are near each other — the ordering IS the documentation. If a block needs a banner to explain why it's here, extract it into a named sibling file or into a folder (see [Deep modules and folder colocation](#deep-modules-and-folder-colocation)).

**Allowed comments**: non-obvious WHY, invariants, workarounds, TSDoc on public API, required legal notices. **Banned**: section banners, "// added for X flow", "// used by Y caller", restatements of what the code does.

See [CLAUDE.md](../CLAUDE.md) for the full comment policy.

## References

- [`PRINCIPLES.md`](./PRINCIPLES.md) — one-page index of all architectural rules.
- [`HOOKS.md`](./HOOKS.md) — hook placement rules; companion to this doc.
- [`STORES.md`](./STORES.md) — state architecture; same colocation principle.
- [`TYPES.md`](./TYPES.md) — type placement and Zod schema conventions.
- [`NO-BARRELS.md`](./NO-BARRELS.md) — project-wide barrel policy.
- [bulletproof-react — project structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) — source pattern.
- [Feature-Sliced Design — Overview](https://feature-sliced.design/docs/get-started/overview) — adjacent methodology considered and declined for this project's size.
- [React docs — Thinking in React](https://react.dev/learn/thinking-in-react) — component decomposition.
