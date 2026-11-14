# Project Structure

How `src/` is organized on disk. For data flow between layers (CLI → stores → engine/UI), see [`ARCHITECTURE.md`](./ARCHITECTURE.md). For state patterns, see [`STORES-AND-UI.md`](./STORES-AND-UI.md). For hook placement rules, see [`HOOKS.md`](./HOOKS.md).

SPLITBRIEF organizes UI code by **business domain**, not by technical layer. A feature is a self-contained business concept — its internals (components, hooks, pure helpers, tests) live in one folder under `src/features/`. The **entry** of each surface is a FLAT page in the `src/app/` shell that *composes* that feature. Cross-cutting primitives (shared UI, shared hooks, low-level utilities) live flat at `src/` root.

## What we follow

This is **feature-based organization, bulletproof-react-inspired**, adapted for an Ink CLI:

- `src/features/{feature}/` holds the internals (vertical slice) for one business concept.
- The `src/app/` shell is the composition layer: shell modules (`root.tsx`, `router.tsx`, `provider.tsx`, `layout.tsx`, `keys.ts`, `command-context.ts`) plus FLAT page entries under `app/screens/` and `app/overlays/`.
- Shared code sits flat at `src/` root in `components/`, `hooks/`, `utils/`, `lib/` — no `shared/` wrapper.
- Features **do not import from other features**, and pages **do not import other pages**. Composition happens at the `app/` shell (the router dispatches the FLAT pages).
- No barrels anywhere, per [`NO-BARRELS.md`](./NO-BARRELS.md).
- Tests are colocated next to source.

## Top-level layout

```
src/
├── cli.ts                                   # binary entry (commander)
├── node-env.ts                              # first import of cli.ts: NODE_ENV=production so React ships its production build; children get the user's NODE_ENV
├── app/                                     # app shell + FLAT pages (composition layer)
│   ├── screens/                             # FLAT page entries: home, workflow, setup
│   └── overlays/                            # FLAT pages: help, palette, skills, sessions, settings, runners, usage, editor
├── cli/                                     # CLI subcommand handlers
├── core/                                    # domain logic (config, types, state, formatting)
├── engine/                                  # workflow orchestrator (zero React)
├── stores/                                  # external stores — see STORES-AND-UI.md
├── components/                              # shared UI (cross-feature)
├── hooks/                                   # shared hooks (cross-feature) — see HOOKS.md
├── lib/                                     # infrastructure wrappers (git, fs, process, terminal) — see LAYERS.md
├── utils/                                   # generic primitives (zero domain, zero infra) — see LAYERS.md
└── features/                                # business-feature internals (entries are pages in app/)
```

Outside `src/`, the repo root also carries `skills/` — the pipeline packaged as agent skills for skills.sh (`skills/splitbrief/` is canonical; its `references/` library and the four `SKILL.md` files carry `<!-- generated -->` blocks rendered from the pipeline spec, the prompt builders and the CLI adapters by `scripts/skill-blocks.ts`, and are mirrored into the `splitbrief-brief`, `splitbrief-run`, and `splitbrief-review` siblings by `scripts/sync-skills.ts`, both gated by `npm run skills:check`), and `.claude-plugin/marketplace.json`, which declares the four as one Claude Code plugin and gives the skills.sh picker its group row. Executable helpers live in `skills/*/scripts/` (`wait-attempt.sh`, `splitbrief-gate.sh`), sourced from `skills/splitbrief-run/scripts/` and mirrored byte-identically by the same script; their tests are `testing/integration/skills/`. See [`SKILLS.md`](./SKILLS.md).

`skills/splitbrief-babysit/` adds a fifth, self-contained contributor skill for supervised CLI dogfooding. Its bundled Node.js watcher is mirrored from the script library by `skills:sync`. Its `after-apply.md` holds the steps that land the change of a run after Apply. It carries `metadata.internal: true`, so skills.sh hides it, and the plugin manifest does not list it.

The distinction between `lib/` (infrastructure wrappers around external systems) and `utils/` (pure primitives with zero domain and zero infra dependency) is the layering spine of the codebase. See [`LAYERS.md`](./LAYERS.md) for the full decision tree and anti-patterns.

`help`, `sessions`, `setup`, and `skills` have **no `features/` folder** — they dissolved into a single page each (the page *is* the whole surface). The feature folders keep only internals; their entry is a page in `src/app/`.

There is no top-level `screens/` directory. Each surface's entry is a FLAT page under `src/app/screens/` (full screens) or `src/app/overlays/` (overlays), and the router dispatches based on `routerStore.use(s => s.screen)` (driven by the composition root).

## Feature anatomy

A feature folder contains the internals a surface needs, and nothing else — its **entry is a FLAT page in `src/app/`** that composes these internals (imported via `../../features/<x>/…`). Subfolders appear only where there is natural grouping.

**Full-screen feature** (e.g. `features/workflow/`; entry page `app/screens/workflow.tsx`).

There is no `features/summary/` and no `app/screens/summary.tsx`. A run that stops stays on the run screen; `features/workflow/closed/` is its summary, rendered as the last rows of the same transcript.

The page `app/screens/workflow.tsx` holds the composition (layout math + `ScreenShell` JSX) and delegates state to `useWorkflowScreen()` in `hooks/workflow-screen/use-model.ts`.

**Overlay-style feature** (e.g. `features/settings/`; entry page `app/overlays/settings.tsx`).

The `SettingsOverlay` entry is the page `app/overlays/settings.tsx`; it composes `items.ts`, `presentation.ts`, `hooks/editor.ts` and the `crew` feature's renderers.

`features/palette/` follows the same shape: its entry is the page `app/overlays/palette.tsx`, which composes the feature-local `sources.ts` and `results.ts` (`sources.ts` assembles commands/skills/live tasks/sessions/custom actions; `results.ts` ranks/filter-matches them for rendering).

**Dissolved (pure-entry) surfaces** (e.g. `setup`, `help`, `sessions`, `skills`):

A dissolved surface has **no `features/` folder** — the page *is* the whole surface. It may still compose a context-free feature owned by another domain: the setup page renders the `crew` feature directly (`useCrew` + `CrewRowView` + `PresetRowView`) and reaches the runners picker through `crewActivate`, which owns the seat→overlay map and performs the `overlayStore.open`. The cross-surface hop is a **store-mediated overlay transition**, not a render prop. `runners` is the feature boundary; `ToolModelPicker` is a component name, not a `tool-picker` feature. `help`, `sessions`, and `skills` are likewise the page alone.

Rules:
- **`components/` subfolder** appears only when the feature has ≥2 component files.
- **`hooks/` subfolder** appears only when the feature has ≥2 hook files.
- **Pure helpers** (non-React modules) sit at the feature root as flat files (`handlers.ts`, `keyboard.ts`, `layout.ts`). They get the `.ts` extension and their tests colocate when they carry behavior (`layout.test.ts`).
- **No `index.ts` barrels** inside a feature. The surface's entry is a FLAT page in `src/app/` (`app/screens/<x>.tsx` | `app/overlays/<x>.tsx`); feature folders hold only internals. See [`NO-BARRELS.md`](./NO-BARRELS.md).

### Example: the inline editor feature

The `editor` surface is a headless pure editing kernel feeding one thin Ink surface: a full-surface editor for the plan card's `plan.json`, whose save runs the plan checks (`use-plan-editor-session.ts`). Its decision logic lives in pure `src/core/` modules so the Ink glue carries no branch logic.

The raw editor overlay and `ReviewView` share `FramePanel` (in `features/workflow/components/`). It draws its top rule with the shared `Divider` from `src/components/`, a features→components import that the boundaries allow. The overlay consumes it page→feature (`app/overlays/editor.tsx → features/workflow/components/frame-panel`); `ReviewView` consumes it same-slice. The `Ctrl+O` external-editor escape hatch never lets `features/editor` import `features/workflow`: `features/editor` emits an intent into `stores/ui/external-edit-request.ts` and the workflow effect in `features/workflow/hooks/workflow-screen/use-inline-edit.ts` consumes it and runs the existing `review-parser` handoff (`features/editor → store ← workflow effect`, gate 9 clean).

Colocated tests sit next to each source file (`editor-state.test.ts`, `grapheme-motions.test.ts`, `editor.test.ts`, `editor-line-segments.test.ts`, `editor-buffer-view.test.tsx`, `external-edit-request.test.ts`, `frame-panel.test.tsx`). The editor keymap (`resolveEditorKeyAction`) is the single source of truth for editor chords; the documented keymap in [`SLASH-COMMANDS-REFERENCE.md`](./SLASH-COMMANDS-REFERENCE.md#inline-editor-planjson) is asserted against it by the keymap's colocated test so the two cannot drift. `Ctrl+O` maps to `{ kind: 'open-external' }` (open the file in the external editor): the overlay pre-saves the buffer (owner-token guarded) then hands off.

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
└── YES → src/stores/<domain>/  (see STORES-AND-UI.md)

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
| `src/app/screens\|overlays/` (pages) | features + shared `components/`, `hooks/`, stores; `app/keys.ts`, `app/command-context.ts`, `app/prepare-resume.ts`, `app/refresh-skills.ts` | only `app/router.tsx` |

Violations are blockers: `utils/ → core/`, `lib/ → engine/`, `core/ → features/`, `features/A → features/B`, page → page, and page → app shell (`app/{root,router,provider,layout}`).

## Cross-feature rule

**Features must not import from each other.** `features/home/*` must not import from `features/workflow/*`. Shared UI goes to `src/components/`. If two features need the same component, promote it — see the `SessionRow` case in [`LAYERS.md`](./LAYERS.md#promoting-a-shared-component--the-2-consumer-rule).

Why:
- Two features importing each other breaks the "one folder, one concept" model.
- It creates implicit ordering constraints: you cannot remove or rewrite feature A without checking what feature B consumed.
- It invites circular imports.

If you need shared behavior across features, it belongs in `src/components/`, `src/hooks/`, `src/utils/`, `src/core/`, or `src/stores/`. Composition between features happens at the `app/` shell (the router dispatches the FLAT pages, the layout wraps).

When one surface needs UI owned by another (e.g. the `setup` page reaching the `runners` picker), the page imports the other domain's context-free feature and coordinates the rest through stores: the setup page and the settings overlay page both render the `crew` feature, and each opens the picker by calling `crewActivate`, which performs the `overlayStore.open` for the selected seat. Keep the feature folder named for the domain (`runners`, `crew`); component names do not create folder names.

The one sanctioned cross-cutting channel between features is **stores**. Feature A can write to `workflowStore`, and feature B can read from it — that is the same engine→UI pattern already described in [`STORES-AND-UI.md`](./STORES-AND-UI.md#engine-to-ui----the-event-path).

## Shared components

`components/text-spans.tsx` renders text spans with colours and bold text across home and workflow.

`src/components/` holds UI that is not tied to any single feature:

- **Primitives** — `theme.tsx`, `divider.tsx`, `rule-header.tsx`, `scroll-indicator.tsx`, `scrollbar.ts`, `scrollable-document.tsx`, `screen-shell.tsx`, `filter-input.tsx`, `markdown.tsx`, `list-row.tsx`, `list-columns.ts`, `row-leading.ts`, `session-row.tsx`, `task-summary.tsx`. The spinner is a shared hook, `useSpinnerFrame`, not a component.
- **Input subsystem** — `input/` (multiline input primitive), `composer/` (composite used on every screen).
- **Shared overlays** — `overlays/overlay-panel.tsx`. The runner picker's text input overlay has one consumer, so it lives in the runners feature. Surface-specific overlay *entries* are FLAT pages in `src/app/overlays/` (e.g. `app/overlays/help.tsx`, `app/overlays/palette.tsx`); their feature-local internals (e.g. `features/palette/{sources,results}.ts`, `features/settings/items.ts`) stay in the feature folder.
- **Picker primitives** — `pickers/filterable-list.tsx`, `pickers/filtering.ts`, `pickers/single-column.tsx`, `pickers/aligned-option-row.tsx`, `pickers/row-zone.tsx`, `pickers/scroll-window.ts`, `pickers/list-viewport.tsx`, plus the `useStaticSelector` selection hook. Sectioned picker display uses the display-window/ListViewport stack: `scroll-window.ts` computes header/gap/item slots, and `list-viewport.tsx` renders them. The two-column runner picker (`two-column-picker/`) lives with its feature under `features/runners/`, not here.

`src/hooks/` holds the shared hooks: `use-spinner-frame.ts` (`useSpinnerFrame`), `use-static-selector.ts` (`useStaticSelector`), `use-key-state.ts` (`useKeyState`), `use-filterable-list.ts` (`useFilterableList`), `use-crew-display-names.ts` (`useCrewDisplayNames`), `use-shared-clock.ts` (`useSharedClock`) and `use-slow-probe-text.ts` (`useProbeActivity`, `useSlowProbeText`). See [`HOOKS.md`](./HOOKS.md).

There is **no separate top-level `ui/` directory** for primitives. The distinction between "primitive" and "composed" is fuzzy in practice (stateful primitives exist; stateless composed widgets exist). Flat `src/components/` with natural subfolders (`input/`, `overlays/`, `pickers/`) is enough.

If `src/components/` ever grows past ~30 direct entries, revisit and consider a `ui/` subfolder of `src/components/` for atomic design-system primitives. Not before.

## The app shell and FLAT pages

The `src/app/` shell is the composition layer. It has two parts:

- **Shell modules** — `app/root.tsx` (composition root), `app/router.tsx` (dispatch), `app/provider.tsx` (`AppProvider`, today only `<ThemeProvider>`), `app/layout.tsx` (header + body + footer), `app/keys.ts` (`useAppKeys`), `app/command-context.ts` (`useRuntimeCommands`).
- **FLAT pages** — one file per surface under `app/screens/` (full screens) and `app/overlays/` (overlays). Each page is the surface's entry point and *composes* its feature's internals.

`app/mouse.ts` (`useAppMouse`) sits beside `app/keys.ts`. `app/prepare-resume.ts` (the readiness check before a run continues, imported by the home, setup, workflow, sessions and palette pages) and `app/session-preparation.tsx` (the continuation's readiness page, rendered by `app/router.tsx`) are app-level helpers too. Gate 9's shell guard covers only `root`, `router`, `provider` and `layout`.

`app/refresh-skills.ts` is a plain helper, not a shell module: it re-runs `discoverSkills(projectDir)` into `skillsStore` and is called from the two sites that open the skills overlay (`app/keys.ts` for `Ctrl+S`, `app/command-context.ts` for the `/skills` command's `refreshSkills` port). The page→shell guard does not cover it, so a page may import it.

`app/root.tsx` is the composition root: it reads `routerStore`/`overlayStore`/`lifecycleStore`, wires runtime commands via `useRuntimeCommands()` (`app/command-context.ts`), app-wide keys via `useAppKeys()` (`app/keys.ts`) and app-wide mouse input via `useAppMouse()` (`app/mouse.ts`), and renders `<AppProvider>` wrapping `<Router/>`.

`app/router.tsx` dispatches by reading `routerStore.screen` and importing each page directly:

```ts
// the router (conceptually)
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

`renderScreen` and `renderOverlay` return JSX that `app/router.tsx` hands to `<Layout screen={…} overlay={…}/>` (`app/layout.tsx`). This replaces the previous top-level `screens/*.tsx` layer and the old monolithic root + layout shell (which no longer exist — the shell now lives entirely under `src/app/`). A page lives at `src/app/screens/<x>.tsx` | `src/app/overlays/<x>.tsx`; the feature it composes keeps its internals in `src/features/<x>/`, imported via `../../features/<x>/…`.

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

| Blast radius | Location |
|---|---|
| ≤ 1 top-level folder, unit test | Colocated next to source (`foo.test.ts` by `foo.ts`) |
| ≤ 1 top-level folder, integration test | Colocated next to source (`<name>.integration.test.ts` by `<name>.ts`) |
| ≥ 2 top-level folders | `testing/integration/<layer>/` |

Three `testing/integration/` subfolders align with the three stable seams: commander (`cli/`), `runWorkflow()` (`orchestrator/`), and Ink screen + engine-written stores (`ui/`). Two more hold other suites: `skills/` tests the skill helper scripts, and `performance/` holds the `*.perf.test.*` suites.

`scripts/` is the second sanctioned colocated-test home alongside `src/`: tooling like `scripts/check-invariants.ts`, `scripts/import-boundaries.ts`, `scripts/sync-skills.ts`, and `scripts/skill-blocks.ts` keep their tests next to source (`check-invariants.test.ts`, `import-boundaries.test.ts`, `sync-skills.test.ts`, `skill-blocks.test.ts`), which is why `vitest.config.ts` includes a `scripts/**/*.test.{ts,tsx}` glob.

**Companion rules:**

- **Pure helpers get colocated tests.** `keyboard.ts`, `layout.ts`, `handlers.ts`, `core/state/machine.ts`, parsers, pricing math — inputs → outputs, zero I/O.
- **Ink tested at behavior seams.** Page entries (`app/screens/<x>.tsx`, `app/overlays/<x>.tsx`) and behavior-heavy feature sub-components get tests. Shared primitives in `src/components/` (`FilterableList`, `MultilineInput`) and the runner feature's `TwoColumnPicker` earn dedicated tests because their cost amortises across consumers.
- **Engine tested by blast radius.** Pure decision modules and narrow orchestrator control-flow modules get colocated units; cross-module workflow behavior is covered through integration tests at the `runWorkflow()` seam with fakes from `testing/helpers/`.
- **Trivial hooks (≤30 LOC, no branching) do not need tests.** Covered through the component that uses them. See [`HOOKS.md`](./HOOKS.md).
- **Fixtures vs factories split by kind.** `testing/fixtures/<domain>/` = read-only bytes on disk; `testing/helpers/factories/<domain>.ts` = pure TS constructors. Rule of two: inline until the second consumer appears.
- **Static is a tier.** TS strict + Zod schemas are first-class correctness — no runtime shape tests for Zod schemas, no `expectType<>` games.
- **Do not test implementation.** No `vi.mock()` on `./` / `../` siblings, no spies on internal module functions, no `toHaveBeenCalledTimes` unless call-count IS the contract. See [TESTING.md](./TESTING.md).

`vitest.config.ts` collects the `src/`, `scripts/`, `testing/`, and `evals/` test roots across three projects. `npm test` runs `unit`. `npm run test:integration` runs `integration` and `workflow-screen`. See [TESTING.md](./TESTING.md#unit-and-integration-tests) for the membership rule.

## Design decisions

**Why features + flat shared, not `shared/` wrapper?**
Bulletproof-react allows both. We chose flat shared because:
1. `src/components/`, `src/hooks/`, `src/utils/` already exist as flat top-level dirs. Wrapping them in a `shared/` folder would add depth without changing semantics.
2. One hop (`from '../components/theme.js'`) is shorter and clearer than two (`from '../shared/components/theme.js'`).
3. Node ESM with no bundler means every directory jump is a real filesystem lookup — fewer hops is a minor perf win.

**Why not Feature-Sliced Design (FSD)?**
FSD's seven layers (`app`, `processes`, `pages`, `widgets`, `features`, `entities`, `shared`) are designed for large product teams shipping web SPAs. For a single-binary CLI with one screen-dispatch root, five of those layers collapse into our `features/` + the `src/app/` shell. Adopting FSD literally would create empty `processes/`, `pages/`, and `entities/` layers with no content. The signal-to-noise ratio is wrong for this project.

**Why eliminate the top-level `screens/` folder?**
A screen is the entry point of a surface — it is not a separate technical layer. The FLAT pages under `src/app/screens/` are that entry; they compose the feature's internals from `src/features/<x>/`. Keeping a parallel top-level `screens/` dir would force every surface change to touch a third folder.

**Why merge the old top-level `ui/` folder into `src/components/`?**
See "Shared components" above. The primitive/composed boundary is fuzzy and unenforced. One folder = one mental model.

**Why not generate features from templates?**
Features are small and irregular. A template would over-prescribe (minimal features are two files; workflow has a dozen). Copy the nearest matching feature and prune.

## Anti-patterns

| Don't | Why |
|---|---|
| Import from another feature (`features/home` imports from `features/workflow`) | Breaks the "one folder, one concept" model. Use a shared module or store. |
| Import one page from another (`app/screens/home` imports `app/overlays/palette`) | Pages compose features and coordinate via stores; gate 9 blocks page↔page imports. |
| Import the app shell from a page (`app/screens/home` imports `app/router`) | Pages must not reach into `app/{root,router,provider,layout}`; gate 9's shell guard blocks it. `app/keys.ts` / `app/command-context.ts` are allowed. |
| Create a `shared/` or `common/` folder under `src/features/` | That is `src/components/`, `src/hooks/`, `src/utils/`. Do not nest shared under features. |
| Keep a top-level `screens/` folder | Screens are FLAT pages in `src/app/screens/`; they compose a feature, not live in one. |
| Nest a page (`app/screens/home/home.tsx`) | Pages must be flat depth-3 files or they escape the gate-9 `sliceRoot` page predicate. Feature-local nesting lives under `src/features/<x>/`. |
| Add a primitive to a top-level `ui/` folder | There is no such folder. Shared primitives go in `src/components/`. |
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

## Screaming folders

Folder names describe **what** the code does in the domain, not **which** technical layer it sits in.

✅ `orchestrator/planning/`, `orchestrator/escalation/`, `orchestrator/drift/`, `features/workflow/`
❌ `services/`, `use-cases/`, `controllers/`, `repositories/`, `handlers/`

A reader opening a folder should immediately know what workflow capability lives there. When you are deciding a folder name, ask: does the name reveal the domain or only the tech layer? If the latter, rename.

Reference: [Milan Jovanović — Screaming Architecture](https://www.milanjovanovic.tech/blog/screaming-architecture).

## Deep modules and folder colocation

The codebase follows John Ousterhout's *deep module* principle: a module's public surface should be a small fraction of its internal complexity. A single file with 8 exports and no internals is shallow; a folder with 5 internal files and one entry point is deep.

**When a file grows past the [length threshold](#file-length-thresholds), create a folder named after the file and move its helpers inside alongside the entry file.**

The canonical patterns in this codebase are `src/engine/orchestrator/planning/` and `src/engine/orchestrator/task/`.

Callers import from `./planning/run.js` or `./task/loop.js`. Files other than the entry are **considered internal to the folder** — the folder boundary is the privacy boundary. A few narrow helpers are also imported from outside the folder (for example `task/refresh-code.ts`, `task/attempt-gate.ts` and `planning/call-loop.ts`). There is no `_prefix.ts` convention, no linter-enforced "private" — the convention is structural: if it's not the entry file, it's an internal helper of that folder.

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

- [`CODE-STANDARD.md`](./CODE-STANDARD.md) — the SOTA review bar and, in [§6](./CODE-STANDARD.md#6-the-hard-conventions-enforced--summarized-linked), the one-page index of all architectural rules; consolidates the file-length triggers here into the split recipe and the reviewer checklist.
- [`HOOKS.md`](./HOOKS.md) — hook placement rules; companion to this doc.
- [`STORES-AND-UI.md`](./STORES-AND-UI.md) — state architecture; same colocation principle.
- [`TYPES.md`](./TYPES.md) — type placement and Zod schema conventions.
- [`NO-BARRELS.md`](./NO-BARRELS.md) — project-wide barrel policy.
- [bulletproof-react — project structure](https://github.com/alan2207/bulletproof-react/blob/master/docs/project-structure.md) — source pattern.
- [Feature-Sliced Design — Overview](https://feature-sliced.design/docs/get-started/overview) — adjacent methodology considered and declined for this project's size.
- [React docs — Thinking in React](https://react.dev/learn/thinking-in-react) — component decomposition.
