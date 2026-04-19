# Application Bootstrap

How the CLI starts up — from `bin` invocation to the first rendered frame. This is the companion to [`STORES.md`](./STORES.md) (what the stores are) and covers **how and when they get populated**.

If you are adding a new startup step — reading a file, hydrating a store, probing an external tool — this is the authority on where that step goes.

---

## Entry flow

```
bin/diptych
  → src/cli.ts                  # commander registers subcommands + top-level error handler
  → registerXCommand(program)   # each subcommand adds its .action() handler
  → program.parseAsync()        # dispatches to the matched action handler

# Inside a subcommand action (start, resume, spec, ...)
  → setupWorkflow(opts)         # git check, config presence, TTY/fullscreen detection
  → initStores(projectDir, opts) # hydrate stores from disk + external world
  → routerStore.init(route)     # set initial screen (conditional — only when a feature is known)
  → renderApp({ useFullscreen, useMouse })  # Ink render — React starts here
```

Two things about this flow are load-bearing:

1. **Stores are populated before React renders.** Components always see initialized data. No `loading: boolean` flags, no conditional rendering for "config not ready yet".
2. **Cross-store orchestration lives in `initStores()`, not in individual stores.** When loading A requires reading B, the wiring goes in `initStores()`. Stores do not know about each other.

---

## `initStores()` — single file, three sections

**File:** `src/cli/init-stores.ts`

The function is one sequential async procedure with three internal phases. Each phase is either a helper in the same file or a small block of direct calls. The file stays small on purpose — the structure of startup is visible at a glance.

```
initStores(projectDir, opts)
├── initUIChrome()          # terminal resize subscription, highlight theme
├── loadProjectState()      # config, sessions, input-history persistence
└── loadDiscovery()         # provider capabilities, skills, model catalog
```

**Phase responsibilities:**

| Phase | What it does | Sync/async |
|---|---|---|
| `initUIChrome` | Subscribe to terminal resize, apply Shiki theme from config | sync |
| `loadProjectState` | `configStore.load()`, `sessionsStore.load()`, `installHistoryPersistence()` | sync |
| `loadDiscovery` | `detectCapabilities()` → `configStore.setContextLength()`, skills + detection + catalog in parallel | async |

`detectCapabilities → setContextLength` is the canonical example of **cross-store orchestration**: reads from `configStore`, awaits a provider probe, writes back to `configStore`. This wiring has no natural home inside any single store — it lives in `initStores()`.

---

## Rules for adding bootstrap steps

### 1. One file until it hurts

`init-stores.ts` stays as a single file until it exceeds **150 LOC**. Past that threshold, split into a folder:

```
src/cli/bootstrap/
├── init.ts          # entry — orchestrates phases
├── ui-chrome.ts     # internal — UI bootstrap helpers
├── project.ts       # internal — project-state loading
└── discovery.ts     # internal — async discovery
```

This mirrors the folder-colocation pattern documented in [`STRUCTURE.md`](./STRUCTURE.md#deep-modules-and-folder-colocation). Do not split pre-emptively — the current file is short enough that three section-like helpers keep the flow readable without folder indirection.

### 2. Do not add a bootstrap file for <20 LOC of one-shot code

A new bootstrap step under ~20 LOC that runs once at startup stays inside `initStores()` or one of its helpers. Creating a new file for "hydrate feedback store from disk" when it is five lines is indirection with no benefit.

Promote to its own file when:
- The step has reusable logic beyond bootstrap (e.g., also called from a slash command or test)
- The step has its own error-handling surface (retry, timeout, fallback)
- The step exceeds ~30 LOC

### 3. Distributed init is optional, not required

A store **may** expose its own `.load()` / `.bootstrap()` method, but does not have to. Examples that do:

```ts
configStore.load(projectDir, overrides);
sessionsStore.load(projectDir);
skillsStore.discover(plannerTool, projectDir);
```

Examples that do not (init lives inline in `initStores()`):

```ts
terminalSizeStore.subscribeToResize();
if (storeConfig.shikiTheme) setHighlightTheme(storeConfig.shikiTheme);
```

The rule: if the loading logic is non-trivial (disk I/O, parsing, validation), put it on the store as `.load()`. If it is a one-liner subscribe or an external-library call, inline in `initStores()`.

### 4. Persistence logic lives with the store, not with the CLI

I/O for a store's state (hydrate from disk + debounced save) lives **next to the store**, not in `src/cli/`. The canonical example:

```
src/stores/ui/
├── input-history.ts       # store — in-memory state + hydrate()/push() actions
└── persistence.ts         # installHistoryPersistence() — fs I/O, debounced write
```

`initStores()` calls `installHistoryPersistence()` from `stores/ui/persistence.js`. The CLI layer knows about the step, but the I/O logic is a store concern.

See [ADR-0004](./adr/0004-input-history-persistence-placement.md) for the rationale behind this placement.

### 5. Cross-store orchestration goes in `initStores()`

When step A writes to store X after reading from store Y, or when the result of one external probe feeds a different store's state, the wiring belongs in `initStores()` — never inside a store.

Canonical example: `detectCapabilities()` reads `configStore.get().config`, probes the provider, and writes back via `configStore.setContextLength()`. This is not a `configStore` responsibility — the provider subsystem is an external dependency, and `configStore` stays ignorant of it.

### 6. One composed Promise.all for independent async work

At the end of `initStores()`:

```ts
await Promise.all([
  skillsStore.discover(getPlannerToolId(storeConfig.planner), projectDir),
  loadDetectionIntoStores({ detectAll, fetchModelsDevCatalog, discoverAllCliTools }, projectDir),
]);
```

Independent async steps fan out here. If you add a third, it joins this `Promise.all` — do not introduce a second one. Serialize only when there is a real data dependency.

---

## What `setupWorkflow()` does (and doesn't)

`setupWorkflow()` (in `src/cli/setup.ts`) runs **before** `initStores()`. It is prep logic:

- Resolves `projectDir` from `--project` flag
- Asserts the directory is a git repo (hard exit otherwise)
- Detects TTY and `CI` env to compute `useFullscreen` / `useMouse`
- Creates a default config if none exists

It does **not** touch stores. Stores know nothing about TTY flags or the git check result. `setupWorkflow()` returns a `SetupResult` that the subcommand handler passes to `renderApp()` and `initStores()`.

See [ADR-0003](./adr/0003-cli-options-setup-split.md) for why `addWorkflowOptions` (commander flags) and `setupWorkflow` (bootstrap prep) are split into two files.

---

## Render handoff

After `initStores()` returns, the subcommand handler calls `renderApp()` (from `src/cli/render.ts`). `renderApp()` does **not** know about stores — it sets up Ink's fullscreen rendering and mounts `<App />`. Components inside `<App />` subscribe via `store.use()` and see fully-populated state on first render.

If a component calls `store.use()` on a field that was never set by `initStores()`, that is a contract violation: either the store has a sensible default, or `initStores()` populates the field.

---

## Anti-patterns

| Don't | Why |
|---|---|
| Load a store inside a React `useEffect` | Causes a no-data render cycle and requires a `loading` flag in the store |
| Call `store.set()` during React render | Infinite render loop |
| Put cross-store orchestration inside a store method | The store gains a dependency on the other store — forms a cycle |
| Create `src/cli/bootstrap/` for <150 LOC of init | Folder indirection without deep modules — just keep `init-stores.ts` flat |
| Put disk I/O for a store in `src/cli/` | Colocation violation — the I/O is a store concern; see §4 |
| Add `loaded: boolean` to a store | Init guarantees population before render. Flag is a smell that the contract isn't being honored |

---

## References

- [STORES.md](./STORES.md) — full store architecture
- [STRUCTURE.md](./STRUCTURE.md#deep-modules-and-folder-colocation) — 150 LOC threshold and folder-colocation pattern
- [LAYERS.md](./LAYERS.md) — `cli/` / `core/` / `stores/` boundaries
- [ADR-0002](./adr/0002-init-stores-single-file.md) — why one file for init
- [ADR-0003](./adr/0003-cli-options-setup-split.md) — why options and setup split
- [ADR-0004](./adr/0004-input-history-persistence-placement.md) — why persistence lives with the store
