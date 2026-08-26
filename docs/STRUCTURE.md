# Project Structure

How `src/` is organized on disk. For data flow between layers (CLI → stores → engine/UI), see [`ARCHITECTURE.md`](./ARCHITECTURE.md). For state patterns, see [`STORES.md`](./STORES.md). For hook placement rules, see [`HOOKS.md`](./HOOKS.md).

SPLITBRIEF organizes UI code by **business domain**, not by technical layer. A feature is a self-contained business concept — its internals (components, hooks, pure helpers, tests) live in one folder under `src/features/`. The **entry** of each surface is a FLAT page in the `src/app/` shell that *composes* that feature. Cross-cutting primitives (shared UI, shared hooks, low-level utilities) live flat at `src/` root.

## What we follow

This is **feature-based organization, bulletproof-react-inspired**, adapted for an Ink CLI:

- `src/features/{feature}/` holds the internals (vertical slice) for one business concept.
- The `src/app/` shell is the composition layer: shell modules (`root.tsx`, `router.tsx`, `provider.tsx`, `layout.tsx`, `keys.ts`, `command-context.ts`) plus FLAT page entries under `app/screens/` and `app/overlays/`.
- Shared code sits flat at `src/` root in `components/`, `hooks/`, `utils/`, `lib/` — no `shared/` wrapper.
- Features **do not import from other features**, and pages **do not import other pages**. Composition happens at the `app/` shell (`src/app/router.tsx` dispatches the FLAT pages).
- No barrels anywhere, per [`NO-BARRELS.md`](./NO-BARRELS.md).
- Tests are colocated next to source.

## Top-level layout

```
src/
├── cli.ts                                   # binary entry (commander)
├── app/                                     # app shell + FLAT pages (composition layer)
│   ├── root.tsx                             # composition root; mounts <AppProvider><Router/>
│   ├── router.tsx                           # renderScreen + renderOverlay switches → <Layout>
│   ├── provider.tsx                         # AppProvider (app-level providers; today ThemeProvider)
│   ├── layout.tsx                           # structural shell (header + body + footer)
│   ├── keys.ts                              # app-wide keyboard dispatch (useAppKeys)
│   ├── command-context.ts                   # runtime-command wiring (useRuntimeCommands)
│   ├── screens/                             # FLAT page entries: home, workflow, summary, setup
│   └── overlays/                            # FLAT pages: help, palette, skills, sessions, settings, runners, editor
├── cli/                                     # CLI subcommand handlers
├── core/                                    # domain logic (config, types, state, formatting)
├── engine/                                  # workflow orchestrator (zero React)
├── stores/                                  # external stores — see STORES.md
├── components/                              # shared UI (cross-feature)
├── hooks/                                   # shared hooks (cross-feature) — see HOOKS.md
├── lib/                                     # infrastructure wrappers (git, fs, process, terminal) — see LAYERS.md
├── utils/                                   # generic primitives (zero domain, zero infra) — see LAYERS.md
└── features/                                # business-feature internals (entries are pages in app/)
    ├── workflow/
    ├── home/
    ├── palette/
    ├── summary/
    ├── settings/                            # retains mode-selector.tsx + items.ts + presentation.ts + hooks/
    ├── crew/                                # seat rows + renderers (no page of its own)
    ├── runners/
    └── editor/                              # inline spec/plan/brief editor (overlay entry: app/overlays/editor.tsx)
```

The distinction between `lib/` (infrastructure wrappers around external systems) and `utils/` (pure primitives with zero domain and zero infra dependency) is the layering spine of the codebase. See [`LAYERS.md`](./LAYERS.md) for the full decision tree and anti-patterns.

`help`, `sessions`, `setup`, and `skills` have **no `features/` folder** — they dissolved into a single page each (the page *is* the whole surface). The folders above keep only internals; their entry is a page in `src/app/`.

There is no `src/screens/` directory. Each surface's entry is a FLAT page under `src/app/screens/` (full screens) or `src/app/overlays/` (overlays), and `src/app/router.tsx` dispatches based on `routerStore.use(s => s.screen)` (driven by `src/app/root.tsx`).

## Layer inventory — non-feature folders

Representative contents of the non-feature folders that have more than a handful of files. Feature folders are catalogued in [Feature inventory](#feature-inventory); use `rg --files <folder>` for the exact current inventory.

### `src/cli/` — CLI entry + subcommand handlers

```
src/cli/
├── init-stores.ts     # single-file bootstrap; 3 internal helpers; see BOOTSTRAP.md
├── options.ts         # commander option builder (addWorkflowOptions)
├── setup.ts           # bootstrap prep (resolveProjectDir, ensureGitAndConfig, setupWorkflow)
├── render/            # Ink / fullscreen render setup (app.ts is the production entry)
│   ├── app.ts
│   ├── input-config.ts
│   ├── process-lifecycle.ts
│   └── terminal-handover.ts
├── errors.ts          # cliError() factory + isCliError predicate — see ERRORS.md
├── headless.ts        # runHeadless(feature, dir, opts) — no-TUI workflow driver for `--json`
├── hook-trust-prompt.ts  # TTY hook disclosure + trust prompt (executable, resolved path, argv); refuses in non-TTY unless --allow-hooks
├── …                  # plus leaf modules (crash-diagnostic, render-table, parse-at-files, …) — `rg --files src/cli` for the full set
├── commands/          # commander subcommand handlers — one file per subcommand, registered in cli.ts (thin — delegate to core). Listing is representative; `rg --files src/cli/commands` for the full set
│   ├── start/
│   ├── resume.ts
│   ├── spec.ts
│   ├── init.ts
│   ├── status.ts
│   └── …              # plus attach, continue, ps, doctor, mcp, and more — see the rg pointer above
├── rpc/               # attached-client RPC: reader/writer framing, gates, command dispatch, run loop
│   ├── run/
│   │   ├── host.ts        # runRpc, transport lifetime, turn/restart loop
│   │   ├── status.ts      # queue/gate/approval/status projection
│   │   ├── brief-review.ts # Task Brief draft read/validate/quality/persist
│   │   └── recovery.ts    # recovery command validation and prompt loop
│   ├── dispatch.ts
│   ├── gates.ts
│   ├── reader.ts
│   ├── writer.ts
│   ├── callbacks.ts
│   ├── command-context.ts
│   ├── errors.ts          # rpcError factory + isTransportClosed predicate — see ERRORS.md
│   └── types.ts
└── sessions/          # session-id resolution for subcommands
    ├── resolve.ts          # resolveSessionOrThrow(dir, opt) — ps alias / active pointer resolution
    ├── aliases.ts          # numeric alias ↔ session-id mapping from lockfiles
    └── single-running.ts   # findSingleRunningSession scan (single | none | multiple)
```

`cli/input-history-persistence.ts` moved to `stores/ui/persistence.ts`.

### `src/stores/ui/` — ephemeral UI chrome stores

```
src/stores/ui/
├── controls.ts        # sidebarVisible + inputMode (cross-tree flags)
├── terminal-size.ts   # terminal resize tracking + responsive layout
├── overlay.ts         # overlay active/exclusive/stack state
├── feedback.ts        # feedback/error message state
├── input-history.ts   # command input history (in-memory)
├── input-height.ts    # composer rendered height (cross-tree)
├── external-edit-request.ts # one-shot Ctrl+O intent bridge (features/editor → store ← workflow effect); carries the CAS ownerToken, non-gated neutral vocabulary
└── persistence.ts     # disk I/O for inputHistoryStore (hydrate + debounced save)
```

`persistence.ts` is called from `cli/init-stores.ts` at boot. See [`BOOTSTRAP.md`](./BOOTSTRAP.md) for why I/O colocates with the store rather than living in `cli/`.

### `src/engine/events/` — EventBus subsystem

```
src/engine/events/
├── bus.ts             # createEventBus() — sync pub/sub with per-sink crash isolation
├── schema.ts          # EngineEventSchema type-dispatched schema + parseEngineEvent
├── types.ts           # EngineEvent alias (z.infer of EngineEventSchema) + EventSink + EventBus ports
└── sinks/
    ├── jsonl.ts       # appends every event to sessions/<id>/session.jsonl
    ├── tree-recorder.ts # EventSink dispatcher; maps EngineEvents to session tree entries
    ├── tree-recorder/
    │   ├── persistence.ts       # tree init/resume, protected append/branch, disk commit
    │   └── runner-invocation.ts # runner call payloads and warning aggregation for the tree
    ├── stdout-json.ts # NDJSON emitter for `splitbrief start --json`
    └── otel.ts        # optional OpenTelemetry span emitter
```
The interactive TUI sink lives at `src/features/workflow/tui-sink.ts` because it forwards into workflow stores.

### `src/engine/hooks/` — workflow hook runtime

```
src/engine/hooks/
├── dispatch.ts        # runHook(entry, event, ctx) — subprocess for command hooks
├── load-module.ts     # dynamic import() for `kind: module` hooks
├── substitute.ts      # ${event.<path>} regex substitution (no eval)
├── run-pre.ts         # sequential pre_* runner; deny short-circuits
├── sink.ts            # bus sink fan-out for post_*/on_* (fire-and-forget)
├── types.ts           # HookOutcome, HookContext
└── builtins/
    ├── registry.ts
    ├── prettier-on-change.ts
    └── block-secrets.ts
```

### `src/engine/codebase/` — repo-map pipeline

```
src/engine/codebase/
├── repomap.ts                       # entry; composes the pipeline into a budgeted summary
├── parse.ts                         # tree-sitter symbol extraction
├── cache.ts                         # per-project SQLite cache of parsed symbols
├── graph.ts                         # symbol → file edge graph
├── pagerank.ts                      # rank files by reference density
├── format.ts                        # render the ranked graph into the planner-facing section
├── budget.ts                        # token-aware truncation
├── rebuild.ts                       # rebuild the parsed-symbol cache from scratch
├── extract-mentioned-filenames.ts   # pulls filenames out of user feature prompt for seeding
└── types.ts
```

### `src/core/hooks/` — hook config domain

```
src/core/hooks/
└── trust.ts           # hook config + module file digest trust hash; compared against the owner's receipt in ~/.splitbrief/trust/hooks.json
```

### `src/core/tokens/` — token math

```
src/core/tokens/
└── estimate.ts        # shared token estimator (planner base + repo-map budget)
```

### `src/core/runtime/commands/` — runtime command domain

```
src/core/runtime/commands/
├── registry.ts        # createRuntimeCommands(ctx) and phase guards
├── dispatch.ts        # parses /name args, validates screen/phase, executes
├── lookup.ts          # exact, alias, and fuzzy command lookup
└── types.ts           # RuntimeCommandDef, RuntimeCommandContext, CommandPaletteItem
```

These are runtime commands, not a slash-only subsystem: the same registry backs composer `/` input, the command palette, and RPC command dispatch. Colocated tests include `dispatch.test.ts`, `lookup.test.ts`, and split `registry-*.test.ts` suites (for example `registry-configuration.test.ts`, `registry-recovery.test.ts`, `registry-conversation.test.ts`) covering the phase / screen / arg matrix.

### `src/core/sessions/` — session domain

```
src/core/sessions/
├── analytics.ts       # session analytics (cost, duration, tasks)
├── io.ts              # read/write session state + log files
├── lifecycle.ts       # active-session pointer (readActive, writeActive, clearActive)
├── log-reader.ts      # JSONL session log reader
├── guards.ts          # clearStaleSession and related session-state predicates
├── compaction.ts      # session-log compaction
├── display.ts         # session display formatting
├── errors.ts          # session error factory + predicates — see ERRORS.md
├── find-unused-id.ts  # findUnusedId(input) — first free session id (flat, not under id/)
└── tree/              # session tree entry model
    ├── io.ts          # append/read tree entries
    ├── parse-entry.ts # parse a tree entry envelope
    ├── payloads.ts    # entry payload Zod schemas
    ├── schemas.ts     # TreeEntryEnvelope + EntryId schemas
    └── store.ts       # in-memory tree store
```

### `src/utils/` — generic primitives

```
src/utils/
├── diff.ts            # LCS diff algorithm
├── error.ts           # error(kind, msg, data?, cause?) factory + matches(kind) predicate — see ERRORS.md
├── format-errors.ts   # error → string with redaction
├── format-time.ts     # generic time formatters
├── frontmatter.ts     # generic YAML frontmatter parser
├── redact.ts          # secret / API-key redaction
├── truncate.ts        # text truncation helpers
├── type-guards.ts     # assertNever, isRecord, typedEntries
└── with-timeout.ts    # promise / async-iterable timeout
```

## Feature anatomy

A feature folder contains the internals a surface needs, and nothing else — its **entry is a FLAT page in `src/app/`** that composes these internals (imported via `../../features/<x>/…`). Subfolders appear only where there is natural grouping.

**Full-screen feature** (e.g. `features/workflow/`; entry page `app/screens/workflow.tsx`):

```
features/workflow/
├── components/               # feature-local components
│   ├── header.tsx
│   ├── sidebar.tsx
│   ├── chrome.tsx            # workflow header/footer chrome
│   └── conversation-flow/    # row-based conversation viewport
├── hooks/                    # feature-local hooks
│   ├── workflow-screen/      # screen model split by intent
│   │   ├── use-model.ts      # public useWorkflowScreen + WorkflowScreenDeps
│   │   ├── use-attachment.ts # IPC attach client
│   │   ├── use-inline-edit.ts # inline field context + external-edit CAS
│   │   ├── use-readiness.ts  # readiness collection + TUI persistence
│   │   └── resume.ts         # cancelled-session resumability
│   ├── use-runner.ts
│   └── use-keys.ts
├── handlers.ts               # pure helper — engine↔UI bridge
├── keyboard.ts               # pure helper — keyboard action dispatchers
├── input-footer-byline.ts    # pure byline layout — width budget, truncation, accessory ordering
├── display/                  # pure display formatters — activity labels, shell prettifier, tones
└── layout/                   # geometry helpers — rects, chrome rows, snapshots
```

The page `app/screens/workflow.tsx` holds the composition (layout math + `ScreenShell` JSX) and delegates state to `useWorkflowScreen()` in `hooks/workflow-screen/use-model.ts`.

**Overlay-style feature** (e.g. `features/settings/`; entry page `app/overlays/settings.tsx`):

```
features/settings/
├── mode-selector.tsx         # router-imported feature component (NOT a page) — mounted by renderOverlay in app/router.tsx
├── items.ts                  # builds the one settings list: crew rows first, then the settings defs by section
├── presentation.ts           # pure formatters on SettingDef (value color, filter match, validate, display) — feature-local
└── hooks/
    ├── buffer.ts             # useEditBuffer — feature-local
    └── editor.ts             # useSettingsEditor — feature-local
```

The `SettingsOverlay` entry is the page `app/overlays/settings.tsx`; it composes `items.ts`, `presentation.ts`, `hooks/editor.ts` and the `crew` feature's renderers. `mode-selector.tsx` is the exception that proves the rule — it stays in the feature and is imported **directly by `app/router.tsx`** (a router-imported feature component, not a page).

`features/palette/` follows the same shape: its entry is the page `app/overlays/palette.tsx`, which composes the feature-local `sources.ts` and `results.ts` (`sources.ts` assembles commands/modes/picker actions/live tasks/sessions/custom actions; `results.ts` ranks/filter-matches them for rendering).

**Dissolved (pure-entry) surfaces** (e.g. `setup`, `help`, `sessions`, `skills`):

A dissolved surface has **no `features/` folder** — the page *is* the whole surface. It may still compose a context-free feature owned by another domain: `src/app/screens/setup.tsx` renders `src/features/crew/` directly (`useCrew` + `CrewRowView` + `PresetRowView`) and reaches the runners picker through `crewActivate` in `src/features/crew/rows.ts`, which owns the seat→overlay map and performs the `overlayStore.open`. The cross-surface hop is a **store-mediated overlay transition**, not a render prop. `runners` is the feature boundary; `ToolModelPicker` is a component name, not a `tool-picker` feature. `help`, `sessions`, and `skills` are likewise the page alone (`src/app/overlays/{help,sessions,skills}.tsx`).

Rules:
- **`components/` subfolder** appears only when the feature has ≥2 component files.
- **`hooks/` subfolder** appears only when the feature has ≥2 hook files.
- **Pure helpers** (non-React modules) sit at the feature root as flat files (`handlers.ts`, `keyboard.ts`, `layout.ts`). They get the `.ts` extension and their tests colocate when they carry behavior (`layout.test.ts`).
- **No `index.ts` barrels** inside a feature. The surface's entry is a FLAT page in `src/app/` (`app/screens/<x>.tsx` | `app/overlays/<x>.tsx`); feature folders hold only internals. See [`NO-BARRELS.md`](./NO-BARRELS.md).

## File placement decision tree

This is the **canonical decision tree** for any new module. For the per-layer reference (what each layer contains, acceptance criteria, anti-patterns), see [`LAYERS.md`](./LAYERS.md).

Ask the questions in order; stop at the first `YES`.

```
Is it a Zod schema (data shape validated at runtime)?
└── YES → src/core/schemas/<domain>.ts

Is it a TypeScript type (compile-time only)?
├── One file uses it                  → inline into that file
├── Multiple files in one folder      → <folder>/types.ts
├── Cross-folder (multi-consumer)     → next to producer, consumers `import type`
└── Fan-in >30, ≥3 top-level folders  → src/core/types/
   (see TYPES.md for the three-case rule)

Does the code import React / Ink?
├── Shared across ≥2 features         → src/components/<category>/
├── React hook shared across ≥2 features or a UI primitive → src/hooks/
├── A surface entry (screen / overlay) → src/app/screens/<name>.tsx | src/app/overlays/<name>.tsx (FLAT page composing the feature)
└── Single-feature UI                 → src/features/<name>/
                                          ├── components/ (≥2 component files)
                                          └── hooks/ (≥2 hook files)

Is it global state with subscribers?
└── YES → src/stores/<domain>/  (see STORES.md)

Is it a pure, zero-dep, framework-agnostic primitive?
  (no SPLITBRIEF literals, no Node APIs beyond stdlib types, npm-publishable in isolation)
└── YES → src/utils/

Is it a boundary wrapper around an external system?
  (git, fs, node:child_process, terminal I/O, better-sqlite3, simple-git, HTTP)
└── YES → src/lib/<domain>/

Does it know SPLITBRIEF concepts (config, cost, tokens, sessions, `.splitbrief/`, state machine)?
├── Workflow orchestration (planner/implementer/validation/retry) → src/engine/<domain>/
└── Pure domain logic / types / formatting                         → src/core/<domain>/

Is it CLI-only prep (commander flags, TTY, exit codes) with a single consumer?
└── YES → src/cli/  (promote to core/ on second consumer)

Is the file about to exceed 300 LOC with >1 concern?
└── Create a folder with helpers (see Deep modules and folder colocation)

Am I about to create an `index.ts` that only re-exports?
└── STOP — barrels banned (see NO-BARRELS.md).
```

**Default rule: start narrow, promote on the second consumer.** Single-feature UI starts inside the feature; it moves to `src/components/` or `src/hooks/` only when a second feature imports it. The reverse (moving shared code back into a feature) is a worse refactor — but demote if the false sharing is already in place (see [`LAYERS.md` §Demoting a misplaced shared component](./LAYERS.md#demoting-a-misplaced-shared-component--the-1-consumer-reversal)).

**Cross-check — import direction is one-way, top to bottom** (enforced by review):

| Layer | May import from | Imported by |
|---|---|---|
| `src/utils/` | stdlib, npm, other `utils/` | anyone |
| `src/lib/` | stdlib, npm, `utils/`, other `lib/` | anyone except `utils/` |
| `src/core/` | `utils/`, `lib/`, `core/` siblings | `engine/`, `stores/`, `features/` |
| `src/engine/` | `utils/`, `lib/`, `core/`, `engine/` siblings | `cli/`, `app/`, `features/workflow/`, `features/runners/` |
| `src/stores/` | `utils/`, `core/`, `lib/`, `engine/` (type-only) | anyone |
| `src/features/{f}/` | everything below + shared `components/`, `hooks/` | only the `app/` shell (pages in `app/screens\|overlays` + `app/router.tsx`) |
| `src/app/screens\|overlays/` (pages) | features + shared `components/`, `hooks/`, stores; `app/keys.ts`, `app/command-context.ts` | only `app/router.tsx` |

Violations are blockers: `utils/ → core/`, `lib/ → engine/`, `core/ → features/`, `features/A → features/B`, page → page, and page → app shell (`app/{root,router,provider,layout}`).

## Cross-feature rule

**Features must not import from each other.** `features/home/*` must not import from `features/workflow/*`. Shared UI goes to `src/components/`. If two features need the same component, promote it — see the `SessionRow` case in [`LAYERS.md`](./LAYERS.md#promoting-a-shared-component--the-2-consumer-rule).

Why:
- Two features importing each other breaks the "one folder, one concept" model.
- It creates implicit ordering constraints: you cannot remove or rewrite feature A without checking what feature B consumed.
- It invites circular imports.

If you need shared behavior across features, it belongs in `src/components/`, `src/hooks/`, `src/utils/`, `src/core/`, or `src/stores/`. Composition between features happens at the `app/` shell (`src/app/router.tsx` dispatches the FLAT pages, `src/app/layout.tsx` wraps).

When one surface needs UI owned by another (e.g. the `setup` page reaching the `runners` picker), the page imports the other domain's context-free feature and coordinates the rest through stores: `src/app/screens/setup.tsx` and `src/app/overlays/settings.tsx` both render `src/features/crew/`, and each opens the picker by calling `crewActivate` from `src/features/crew/rows.ts`, which performs the `overlayStore.open` for the selected seat. Keep the feature folder named for the domain (`runners`, `crew`); component names do not create folder names.

The one sanctioned cross-cutting channel between features is **stores**. Feature A can write to `workflowStore`, and feature B can read from it — that is the same engine→UI pattern already described in [`STORES.md`](./STORES.md).

## Shared components

`src/components/` holds UI that is not tied to any single feature:

- **Primitives** — `theme.tsx`, `spinner.tsx`, `scroll-indicator.tsx`, `labeled-row.tsx`, `screen-shell.tsx`, `filter-input.tsx`, `markdown.tsx`, `session-row.tsx`.
- **Input subsystem** — `input/` (multiline input primitive), `composer/` (composite used on every screen).
- **Shared overlays** — `overlays/overlay-panel.tsx`, `overlays/text-input-overlay.tsx`. Surface-specific overlay *entries* are FLAT pages in `src/app/overlays/` (e.g. `app/overlays/help.tsx`, `app/overlays/palette.tsx`); their feature-local internals (e.g. `features/palette/{sources,results}.ts`, `features/settings/mode-selector.tsx`) stay in the feature folder.
- **Picker primitives** — `pickers/filterable-list.tsx`, `pickers/single-column.tsx`, `pickers/scroll-window.ts`, `pickers/list-viewport.tsx`, plus the `src/hooks/use-static-selector.ts` selection hook. Sectioned picker display uses the display-window/ListViewport stack: `scroll-window.ts` computes header/gap/item slots, and `list-viewport.tsx` renders them. The two-column runner picker (`two-column-picker/`) lives with its feature under `features/runners/`, not here.

There is **no separate `src/ui/` directory** for primitives. The distinction between "primitive" and "composed" is fuzzy in practice (stateful primitives exist; stateless composed widgets exist). Flat `src/components/` with natural subfolders (`input/`, `overlays/`, `pickers/`) is enough.

If `src/components/` ever grows past ~30 direct entries, revisit and consider `src/components/ui/` for atomic design-system primitives. Not before.

## The app shell and FLAT pages

The `src/app/` shell is the composition layer. It has two parts:

- **Shell modules** — `app/root.tsx` (composition root), `app/router.tsx` (dispatch), `app/provider.tsx` (`AppProvider`, today only `<ThemeProvider>`), `app/layout.tsx` (header + body + footer), `app/keys.ts` (`useAppKeys`), `app/command-context.ts` (`useRuntimeCommands`).
- **FLAT pages** — one file per surface under `app/screens/` (full screens) and `app/overlays/` (overlays). Each page is the surface's entry point and *composes* its feature's internals.

`app/root.tsx` is the composition root: it reads `routerStore`/`overlayStore`/`lifecycleStore`, wires runtime commands via `useRuntimeCommands()` (`app/command-context.ts`) and app-wide keys via `useAppKeys()` (`app/keys.ts`), and renders `<AppProvider>` wrapping `<Router/>`.

`app/router.tsx` dispatches by reading `routerStore.screen` and importing each page directly:

```ts
// src/app/router.tsx (conceptually)
import { HomeScreen } from './screens/home.js';
import { WorkflowScreen } from './screens/workflow.js';
// ...

function renderScreen(screen: Screen) {
  switch (screen) {
    case 'home': return <HomeScreen />;
    case 'workflow': return <WorkflowScreen />;
    // ...
  }
}
```

`renderScreen` and `renderOverlay` return JSX that `app/router.tsx` hands to `<Layout screen={…} overlay={…}/>` (`app/layout.tsx`). This replaces the previous `src/screens/*.tsx` layer and the old monolithic root + layout shell (which no longer exist — the shell now lives entirely under `src/app/`). A page lives at `src/app/screens/<x>.tsx` | `src/app/overlays/<x>.tsx`; the feature it composes keeps its internals in `src/features/<x>/`, imported via `../../features/<x>/…`.

### Page isolation and the shell guard

The FLAT (depth-3) page layout is load-bearing — two rules are enforced by gate 9 (`scripts/import-boundaries.ts`, see [`INVARIANTS.md`](./INVARIANTS.md)):

- **Page ↔ page isolation.** Pages must not import one another — not screen↔screen, not overlay↔overlay, not screen↔overlay. They coordinate only through stores. A page composes *features*, never sibling pages.
- **Page → shell guard.** Pages must not import the shell modules (`app/root.tsx`, `app/router.tsx`, `app/provider.tsx`, `app/layout.tsx`). `app/keys.ts` and `app/command-context.ts` are *not* guarded — a page may consume them.

Both rules depend on the page being a flat file exactly three path segments deep (`app/screens/<x>.tsx`). A depth-4 file under `app/screens/` would escape the `sliceRoot` page predicate and slip past isolation — so pages stay flat, and all feature-local nesting lives under `src/features/<x>/`.

## Page entry-point naming

| Surface kind | Entry page |
|---|---|
| Full screen | `src/app/screens/<name>.tsx` |
| Overlay | `src/app/overlays/<name>.tsx` |
| Picker overlay | `src/app/overlays/<name>.tsx` |

The page basename is the bare surface name with **no path-echo** — `app/screens/home.tsx`, not `home-screen.tsx` or `screens/home/home.tsx`. Export names are unchanged by the flattening: the page still exports `HomeScreen`, `WorkflowScreen`, `CommandPaletteOverlay`, `ToolModelPicker`, etc. Consistency helps `grep` and editor navigation; one surface = one flat page.

## Test strategy

Tests follow a hybrid layout driven by **blast radius** — how many top-level folders a test imports from. See [`TESTING.md`](./TESTING.md) for the hands-on guide.

**Placement rule (two bins):**

| Blast radius | Location | Example |
|---|---|---|
| ≤ 1 top-level folder | Colocated next to source (`foo.test.ts` by `foo.ts`) | `src/engine/orchestrator/drift/analyze.test.ts`, `src/features/workflow/components/header.test.tsx` |
| ≥ 2 top-level folders | `testing/integration/<layer>/` | `testing/integration/cli/`, `testing/integration/orchestrator/`, `testing/integration/ui/` |

The three `testing/integration/` subfolders align with the three stable seams: commander (`cli/`), `runWorkflow()` (`orchestrator/`), and Ink screen + engine-written stores (`ui/`).

`scripts/` is the second sanctioned colocated-test home alongside `src/`: tooling like `scripts/check-invariants.ts` and `scripts/import-boundaries.ts` keep their tests next to source (`check-invariants.test.ts`, `import-boundaries.test.ts`), which is why `vitest.config.ts` includes a `scripts/**/*.test.{ts,tsx}` glob.

**Companion rules:**

- **Pure helpers get colocated tests.** `keyboard.ts`, `layout.ts`, `handlers.ts`, `core/state/machine.ts`, parsers, pricing math — inputs → outputs, zero I/O.
- **Ink tested at behavior seams.** Page entries (`app/screens/<x>.tsx`, `app/overlays/<x>.tsx`) and behavior-heavy feature sub-components get tests. Shared primitives in `src/components/` (`FilterableList`, `MultilineInput`, `TwoColumnPicker`) earn dedicated tests because their cost amortises across consumers.
- **Engine tested by blast radius.** Pure decision modules and narrow orchestrator control-flow modules get colocated units; cross-module workflow behavior is covered through integration tests at the `runWorkflow()` seam with fakes from `testing/helpers/`.
- **Trivial hooks (≤30 LOC, no branching) do not need tests.** Covered through the component that uses them. See [`HOOKS.md`](./HOOKS.md).
- **Fixtures vs factories split by kind.** `testing/fixtures/<domain>/` = read-only bytes on disk; `testing/helpers/factories/<domain>.ts` = pure TS constructors. Rule of two: inline until the second consumer appears.
- **Static is a tier.** TS strict + Zod schemas are first-class correctness — no runtime shape tests for Zod schemas, no `expectType<>` games.
- **Do not test implementation.** No `vi.mock()` on `./` / `../` siblings, no spies on internal module functions, no `toHaveBeenCalledTimes` unless call-count IS the contract. See [TESTING.md](./TESTING.md).

Test discovery is configured in `vitest.config.ts` via `include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.{ts,tsx}', 'testing/integration/**/*.test.{ts,tsx}', 'testing/helpers/**/*.test.{ts,tsx}', 'testing/visual/**/*.test.{ts,tsx}', 'evals/eval.test.ts']`. All trees are picked up by a single `npm test`.

## Design decisions

**Why features + flat shared, not `shared/` wrapper?**
Bulletproof-react allows both. We chose flat shared because:
1. `src/components/`, `src/hooks/`, `src/utils/` already exist as flat top-level dirs. Wrapping them in `src/shared/` would add depth without changing semantics.
2. One hop (`from '../components/theme.js'`) is shorter and clearer than two (`from '../shared/components/theme.js'`).
3. Node ESM with no bundler means every directory jump is a real filesystem lookup — fewer hops is a minor perf win.

**Why not Feature-Sliced Design (FSD)?**
FSD's seven layers (`app`, `processes`, `pages`, `widgets`, `features`, `entities`, `shared`) are designed for large product teams shipping web SPAs. For a single-binary CLI with one screen-dispatch root, five of those layers collapse into our `features/` + the `src/app/` shell. Adopting FSD literally would create empty `processes/`, `pages/`, and `entities/` layers with no content. The signal-to-noise ratio is wrong for this project.

**Why eliminate `src/screens/`?**
A screen is the entry point of a surface — it is not a separate technical layer. The FLAT pages under `src/app/screens/` are that entry; they compose the feature's internals from `src/features/<x>/`. Keeping a parallel `src/screens/` dir would force every surface change to touch a third folder.

**Why merge `src/ui/` into `src/components/`?**
See "Shared components" above. The primitive/composed boundary is fuzzy and unenforced. One folder = one mental model.

**Why not generate features from templates?**
Features are small and irregular. A template would over-prescribe (minimal features are two files; workflow has a dozen). Copy the nearest matching feature and prune.

## Anti-patterns

| Don't | Why |
|---|---|
| Import from another feature (`features/home` imports from `features/workflow`) | Breaks the "one folder, one concept" model. Use a shared module or store. |
| Import one page from another (`app/screens/home` imports `app/overlays/palette`) | Pages compose features and coordinate via stores; gate 9 blocks page↔page imports. |
| Import the app shell from a page (`app/screens/home` imports `app/router`) | Pages must not reach into `app/{root,router,provider,layout}`; gate 9's shell guard blocks it. `app/keys.ts` / `app/command-context.ts` are allowed. |
| Create `src/features/shared/` or `src/features/common/` | That is `src/components/`, `src/hooks/`, `src/utils/`. Do not nest shared under features. |
| Keep a `src/screens/` folder | Screens are FLAT pages in `src/app/screens/`; they compose a feature, not live in one. |
| Nest a page (`app/screens/home/home.tsx`) | Pages must be flat depth-3 files or they escape the gate-9 `sliceRoot` page predicate. Feature-local nesting lives under `src/features/<x>/`. |
| Add a primitive to `src/ui/` | There is no `src/ui/`. Shared primitives go in `src/components/`. |
| Create `features/{f}/index.ts` as a re-export barrel | Barrels are forbidden per [`NO-BARRELS.md`](./NO-BARRELS.md). Use the named page entry (`app/screens/<x>.tsx` / `app/overlays/<x>.tsx`) and import feature internals directly. |
| Put pure functions under a feature's `hooks/` subfolder | Hooks imply React lifecycle. Pure fns go at the feature root (`keyboard.ts`, `layout.ts`). |
| Test a trivial feature-local hook in isolation | Behavior lives in the component that uses it. Test at that level. |
| Create a feature for a single overlay file | If the overlay has no hooks, no pure helpers, and no tests, it is not a feature. Keep it in `src/components/overlays/` until it earns feature status. |
| Share a type by cross-feature import | Shared types belong in `src/core/types/` or the store that owns the domain. |

## Rules of thumb

1. **A feature is discoverable.** Opening `src/features/{feature}/` must reveal the entire feature. If you need to grep to understand what a feature does, the layout failed.
2. **Shared earns its place.** A module enters `src/components/`, `src/hooks/`, or `src/utils/` only when used by ≥2 features. Premature sharing is as costly as premature abstraction.
3. **The `app/` shell is the only cross-feature composition point.** Pages (`app/screens|overlays`) compose features; `app/router.tsx` wires them together. If you find yourself wiring feature A's output into feature B's input anywhere else — or importing one page from another — re-examine the boundary.
4. **Changes to one feature should touch one folder.** If a feature change requires edits in multiple top-level directories, something crossed a boundary that shouldn't have.

## Feature inventory

| Surface | Responsibility | Entry page | Feature folder |
|---|---|---|---|
| `workflow` | Running workflow — conversation flow, event cards, sidebar, input mode, keyboard, runner lifecycle | `app/screens/workflow.tsx` | `features/workflow/` |
| `home` | Landing screen — banner, seat block, recent sessions, input | `app/screens/home.tsx` | `features/home/` |
| `summary` | Post-workflow report — cost, task table, phase timing | `app/screens/summary.tsx` | `features/summary/` |
| `setup` | First-run crew setup — ready-made crews above the seat block | `app/screens/setup.tsx` | dissolved (page only) |
| `palette` | Command palette overlay — source assembly, filtering, MRU ranking | `app/overlays/palette.tsx` | `features/palette/` |
| `settings` | Settings overlay — the crew section plus the field editor for config | `app/overlays/settings.tsx` | `features/settings/` (mode-selector + items + presentation + hooks) |
| `crew` | No page of its own — rows + renderers consumed by the settings and setup pages | — | `features/crew/` |
| `runners` | Seat picker — tool + model selection for each seat picker role | `app/overlays/runners.tsx` | `features/runners/` |
| `editor` | Inline spec / plan / Task Brief editor — headless editing kernel over raw + brief-field surfaces | `app/overlays/editor.tsx` | `features/editor/` |
| `help` | Global help overlay — keyboard and command reference | `app/overlays/help.tsx` | dissolved (page only) |
| `sessions` | Sessions picker — select a past session to resume | `app/overlays/sessions.tsx` | dissolved (page only) |
| `skills` | Skills picker — toggle available skills for a workflow | `app/overlays/skills.tsx` | dissolved (page only) |

Each surface's entry page is what `src/app/router.tsx` imports (and `app/layout.tsx` wraps). Internal structure is documented by inspection — there is no catalog per-feature.

### Inline editor feature layout

The `editor` surface is a headless pure editing kernel feeding two thin Ink surfaces (a full-surface raw editor for `spec.md` / `plan.md` and a small-viewport field editor for Task Briefs). Its decision logic lives in pure `src/core/` modules so the Ink glue carries no branch logic:

```
src/features/editor/                  # feature internals (imported by app/overlays/editor.tsx)
├── raw-editor-view.tsx               # full-surface exclusive-overlay raw editor
├── brief-field-editor.tsx           # small-viewport Task Brief field editor
├── brief-field-model.ts             # editable-brief field projection over the parsed Task model
├── brief-save.ts                    # brief round-trip + dep-cycle / quality save gate
├── editor-line-segments.ts          # visual-row segmentation for rendering
├── editor-viewport.ts               # viewport-scroll math for the editor surfaces
├── use-editor-keys.ts               # useInput wiring over resolveEditorKeyAction
└── use-inline-edit-trigger.ts       # Ctrl+E review-gate opener (confined read + owner-token capture)

src/app/overlays/editor.tsx           # FLAT overlay page (exclusive; sets overlayStore.setExclusive)
src/stores/ui/editor.ts               # editorStore singleton (openRaw / openField, owner-token write gate)
src/stores/ui/external-edit-request.ts # one-shot Ctrl+O intent bridge (features/editor → store ← workflow effect); non-gated, carries the CAS ownerToken
src/core/editor/editor-state.ts       # EditorEvent / EditorMotion types + pure editing-state reducer
src/core/editor/grapheme-motions.ts   # grapheme + display-width caret/selection motions
src/core/keybindings/editor.ts        # resolveEditorKeyAction — the single-owner editor keymap

src/features/workflow/components/frame-panel.tsx  # shared single-line-border frame (border + ◇ dir/base title + top Divider); one shape for the raw editor overlay and ReviewView
```

The raw editor overlay and `ReviewView` share `FramePanel` (in `features/workflow/components/`, beside `divider.tsx` — so it can use the sibling `Divider` without a components→features boundary violation). The overlay consumes it page→feature (`app/overlays/editor.tsx → features/workflow/components/frame-panel`); `ReviewView` consumes it same-slice. The `Ctrl+O` external-editor escape hatch never lets `features/editor` import `features/workflow`: `features/editor` emits an intent into `stores/ui/external-edit-request.ts` and the workflow effect in `features/workflow/hooks/workflow-screen/use-inline-edit.ts` consumes it and runs the existing `review-parser` handoff (`features/editor → store ← workflow effect`, gate 9 clean).

Colocated tests sit next to each source file (`editor-state.test.ts`, `grapheme-motions.test.ts`, `editor.test.ts`, `brief-field-model.test.ts`, `brief-save.test.ts`, `editor-line-segments.test.ts`, `editor-buffer-view.test.tsx`, `external-edit-request.test.ts`, `frame-panel.test.tsx`, `src/stores/ui/editor.test.ts`). The keymap in `src/core/keybindings/editor.ts` is the single source of truth for editor chords; the documented keymap in [`SLASH-COMMANDS-REFERENCE.md`](./SLASH-COMMANDS-REFERENCE.md#inline-editor-spec-plan-and-task-brief) is asserted against it by `src/core/keybindings/editor.test.ts` so the two cannot drift. `Ctrl+O` maps to `{ kind: 'open-external' }` (open the file in the external editor) on both surfaces — raw pre-saves the buffer (CAS-guarded) then hands off; the field surface discards the in-progress edit and opens the whole `tasks.md`.

**Ratified kernel-contract amendments** (recorded as intentional): (1) `EditorState.affinity: 'upstream' | 'downstream'` — a 1-bit field so a caret on a soft-wrap seam resolves to the correct visual row (`'upstream'` is the default and reproduces prior behavior everywhere except exactly on a seam); (2) `EditorKeyAction` gains `{ kind: 'open-external' }` for the `Ctrl+O` escape hatch; (3) `followCaretScroll` (`src/core/editor/editor-state.ts:264`) reads `state.affinity` instead of the `upstream` default so a downstream seam's painted lower-row caret is not clipped at the viewport's bottom edge (model ≡ paint). The two delete-line reads (`editor-state.ts:137,143`) keep the `upstream` default.

## Screaming folders

Folder names describe **what** the code does in the domain, not **which** technical layer it sits in.

✅ `orchestrator/planning/`, `orchestrator/escalation/`, `orchestrator/drift/`, `features/workflow/`
❌ `services/`, `use-cases/`, `controllers/`, `repositories/`, `handlers/`

A reader opening a folder should immediately know what workflow capability lives there. When you are deciding a folder name, ask: does the name reveal the domain or only the tech layer? If the latter, rename.

Reference: [Milan Jovanović — Screaming Architecture](https://www.milanjovanovic.tech/blog/screaming-architecture).

## Deep modules and folder colocation

The codebase follows John Ousterhout's *deep module* principle: a module's public surface should be a small fraction of its internal complexity. A single file with 8 exports and no internals is shallow; a folder with 5 internal files and one entry point is deep.

**When a file grows past the [length threshold](#file-length-thresholds), create a folder named after the file and move its helpers inside alongside the entry file.**

The canonical patterns in this codebase are `src/engine/orchestrator/planning/` and `src/engine/orchestrator/task/`:

```
orchestrator/
├── planning/
│   ├── run.ts        # entry — dispatches to the right planning variant
│   ├── full.ts       # internal — standard/full planning flow
│   ├── quick.ts      # internal — quick-mode planning flow
│   ├── rewind.ts     # internal — rewind-to-approval flow
│   ├── io.ts         # internal — spec/brief read-write helpers
│   ├── call-loop.ts  # internal — planner call/stream loop
│   ├── queue-drain.ts # internal — drain queued messages into the planner
│   ├── failure.ts    # internal — planner failure handling
│   └── brief-quality-gate.ts # internal — brief severity gate
├── task/
│   ├── step.ts              # entry — single-task execution
│   ├── pre-task.ts          # internal — pre-hook dispatch, task-start event, snapshot
│   ├── run-implementation.ts # internal — continuation loop, streaming, staging
│   ├── apply-changed-files.ts # internal — post-impl approval, promotion, conflict detection
│   ├── analyze-drift.ts     # internal — per-task drift chain analysis after task attempts
│   ├── rollback.ts          # internal — restore task files after denied validation or exhausted retries
│   └── resolve-deps.ts     # internal — dependency resolution
```

Callers import from `./planning/run.js` or `./task/step.js`. Files other than the entry are **considered internal to the folder** — the folder boundary is the privacy boundary. There is no `_prefix.ts` convention, no linter-enforced "private" — the convention is structural: if it's not the entry file, it's an internal helper of that folder.

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

See [CLAUDE.md](https://github.com/b4r7x/splitbrief/blob/main/CLAUDE.md) for the full comment policy.

## References

- [`PRINCIPLES.md`](./PRINCIPLES.md) — one-page index of all architectural rules.
- [`CODE-STANDARD.md`](./CODE-STANDARD.md) — the SOTA review bar; consolidates the file-length triggers here into the split recipe and the reviewer checklist.
- [`HOOKS.md`](./HOOKS.md) — hook placement rules; companion to this doc.
- [`STORES.md`](./STORES.md) — state architecture; same colocation principle.
- [`TYPES.md`](./TYPES.md) — type placement and Zod schema conventions.
- [`NO-BARRELS.md`](./NO-BARRELS.md) — project-wide barrel policy.
- [bulletproof-react — project structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) — source pattern.
- [Feature-Sliced Design — Overview](https://feature-sliced.design/docs/get-started/overview) — adjacent methodology considered and declined for this project's size.
- [React docs — Thinking in React](https://react.dev/learn/thinking-in-react) — component decomposition.
