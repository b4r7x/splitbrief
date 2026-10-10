# Application Bootstrap

How the CLI starts up — from `bin` invocation to the first rendered frame. This is the companion to [`STORES.md`](./STORES.md) (what the stores are) and covers **how and when they get populated**.

If you are adding a new startup step — reading a file, hydrating a store, probing an external tool — this is the authority on where that step goes.

---

## Entry flow

```
src/node-env.ts                 # first import: NODE_ENV=production before React/Ink load (the dev build leaks a performance.measure per render)
src/cli.ts                      # commander registers subcommands + top-level error handler
  → registerXCommand(program)   # each subcommand adds its .action() handler
  → program.parseAsync()        # dispatches to the matched action handler

# Interactive start
  → setupWorkflow(opts)          # project/config and terminal setup
  → initStoresForTuiMount(...)   # synchronous seed, hook trust, start discovery
  → renderApp(...)              # first Ink frame before discovery completes
  ↳ awaitDiscovery              # settles alongside the mounted TUI
  ↳ preparationStore.submit(...) # explicit start/continue, fresh execution checks
```

Two things about this flow are load-bearing:

1. The TUI mounts after synchronous project/store seeding; asynchronous discovery continues after the first render. Config, sessions and UI chrome are seeded first; discovery and preparation may remain pending. Hook trust is resolved before discovery can spawn subprocesses.
2. **Cross-store orchestration lives in `initStores()`, not in individual stores.** When loading A requires reading B, the wiring goes in `initStores()`. Stores do not know about each other.

---

## `initStores()` — single file, four sections

**File:** `src/cli/init-stores.ts`

`bootstrapStoresSync()` initializes UI chrome and project state. `initStoresForTuiMount()` then awaits `bootstrapStoresHooks()` and returns the `awaitDiscovery` promise without awaiting it. `runInteractiveStart()` mounts Ink while discovery continues. The separate `initStores()` entry awaits discovery for callers that require it.

```
initStores(projectDir, opts)
├── initUIChrome()          # terminal resize subscription
├── loadProjectState()      # config, sessions, input-history persistence
├── ensureHooksTrusted()    # prompt for hook trust before any subprocess discovery
└── loadDiscovery()         # provider capabilities, skills, model catalog
```

**Phase responsibilities:**

| Phase | What it does | Sync/async |
|---|---|---|
| `initUIChrome` | Subscribe to terminal resize | sync |
| `loadProjectState` | `configStore.load()`, `sessionsStore.load()`, `installHistoryPersistence()` | sync |
| `ensureHooksTrusted` | reads `config.hooks` from `configStore` → prompts for hook trust before any subprocess discovery | async |
| `loadDiscovery` | `detectCapabilities()` → `configStore.setContextLength()`, skills + detection + catalog in parallel | async |

`detectCapabilities → setContextLength` is the canonical example of **cross-store orchestration**: reads from `configStore`, awaits a provider probe (`src/engine/providers/capabilities.ts`), writes back to `configStore`. This wiring has no natural home inside any single store — it lives in `initStores()`.

---

## Preparation and continuation

The draft remains editable during preparation; start and continue wait for current admission and ownership checks.

`preparationStore.submit()` in `src/stores/navigation/preparation.ts` owns explicit starts and continuations. A newer attempt supersedes the earlier one; stale success or failure cannot replace the new route. Failure preserves the current draft and reports the actual preparation problem. A user-action problem may open a panel; ordinary checking stays beside the editable input.

`prepareExecution()` rechecks execution admission and session ownership for each attempt. A zero-blocker discovery report cannot authorize takeover of a live or unknown session owner. `createInFlightProbeSharing()` in `src/engine/detection/runner-evidence.ts` shares only compatible observations while they are pending, keyed by current config, executable and authentication context. It retains no completed readiness result; unspecified CLI auth context is not shared. Remembered discovery is presentation data, never authority to execute.

`awaitDiscovery` covers the discovery promise returned at mount. Model-catalog and live detection work also have separately tracked background promises. `awaitBackgroundDiscovery()` settles these promises for tests that remove temporary cache directories. Initial render does not wait for them.

See [ARCHITECTURE.md](./ARCHITECTURE.md#data-flow-one-task) for the cleanup order, process exit, and caller-requested unmount.

The models.dev cache shares one pending read per cache key between the catalog seed and live detection.
Its private worker parses JSON and validates the catalog, so the main thread can render and handle keys during parsing.
HTTP responses and cache-pruning records use the same worker parser.
Pruning receives only validated metadata, without the catalog.

The cache freezes the received catalog and snapshot envelope, then detection and the model store share that catalog by reference.
Readiness and CLI model snapshots keep their separate copies.
Missing or corrupt cache records remain misses; stale catalogs retain the existing refresh behavior.

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
const skills = await discoverSkills(projectDir);
skillsStore.setAvailable(skills);
```

Examples that do not (init lives inline in `initStores()`):

```ts
terminalSizeStore.subscribeToResize();
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

The placement follows colocation: UI-ephemeral state lives under `stores/ui/`, and its disk I/O sits beside the store it serializes.

### 5. Cross-store orchestration goes in `initStores()`

When step A writes to store X after reading from store Y, or when the result of one external probe feeds a different store's state, the wiring belongs in `initStores()` — never inside a store.

Canonical example: `detectCapabilities()` reads `configStore.get().config`, probes the provider, and writes back via `configStore.setContextLength()`. This is not a `configStore` responsibility — the provider subsystem is an external dependency, and `configStore` stays ignorant of it.

### 6. Track asynchronous discovery without blocking mount

`loadDiscovery()` first detects provider capabilities and reads remembered presentation data. It starts the model-catalog seed and live detection refresh through `trackDiscovery()`. Each promise reports failures. It then discovers skills. `awaitBackgroundDiscovery()` waits for tracked work in tests.

A bootstrap step that reaches detection after shutdown cannot start a refresh lane or queue a cache save. A new independent discovery step belongs in this lifecycle. A step with a data dependency waits for that dependency. Remembered results and background completion do not replace explicit execution preparation.

---

## What `setupWorkflow()` does (and doesn't)

`setupWorkflow()` (in `src/cli/setup.ts`) runs **before** `initStores()`. It is prep logic:

- Resolves `projectDir` from `--project` flag
- Asserts the directory is a git repo (hard exit otherwise)
- Detects TTY and `CI` env to compute `useFullscreen` / `useMouse`
- Creates a default config if none exists

It does **not** touch stores. Stores know nothing about TTY flags or the git check result. `setupWorkflow()` returns a `SetupResult` that the subcommand handler passes to `renderApp()` and `initStores()`.

`addWorkflowOptions` (commander flags) and `setupWorkflow` (bootstrap prep) are split into two files because they have different change rates: flags are rewritten when the commander surface changes; setup is rewritten when the bootstrap prerequisites change.

---

## Render handoff

After `initStoresForTuiMount()` returns, the interactive handler calls `renderApp()` (from `src/cli/render/app.ts`) while `awaitDiscovery` is still pending. `renderApp()` queries the terminal background before Ink takes stdin in fullscreen.
It stores the detected background in `terminalBackgroundStore` for the first frame.
The query stops at the device attributes reply or after 300 ms.
The filtered stdin skips late terminal replies.
`renderApp()` then sets up Ink's fullscreen rendering and mounts `<App />`. Components subscribe via `store.use()` and see seeded project state and UI chrome on the first render; discovery results arrive through store updates.

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
| Add a second readiness cache for asynchronous preparation | Read the shared preparation coordinator; config seed is synchronous, discovery is not. |

---

## References

- [STORES.md](./STORES.md) — full store architecture
- [STRUCTURE.md](./STRUCTURE.md#deep-modules-and-folder-colocation) — 150 LOC threshold and folder-colocation pattern
- [LAYERS.md](./LAYERS.md) — `cli/` / `core/` / `stores/` boundaries
