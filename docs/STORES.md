# Store Architecture

diptych uses a DIY external store system built on React's `useSyncExternalStore`. The entire framework is 42 lines. It provides the same core capabilities as Zustand with zero dependencies.

## Why DIY

Zustand's core is ~95% identical to what we need. But we don't need middleware (devtools, persist, immer), partial merge semantics, custom equality functions, or SSR support. Rolling our own keeps the dependency count at zero and the implementation fully visible.

## Factory: `createStore<T>`

**File:** `src/stores/create-store.ts`

```typescript
const store = createStore<State>(initialState);
```

Returns a `Store<T>` with five methods:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `get()` | `() => T` | Synchronous read (non-React code) |
| `set()` | `(updater: T \| (prev: T) => T) => void` | Replace state. Skips notify if `Object.is(state, next)` |
| `subscribe()` | `(listener: () => void) => () => void` | Register listener, returns unsubscribe |
| `use()` | `<S>(selector: (s: T) => S) => S` | React hook via `useSyncExternalStore` |
| `reset()` | `(state?: T) => void` | Reset to initial or provided state. Same `Object.is` bailout as `set()` |

**Key semantics:**
- State is a closure variable, not React state. Changes are synchronous.
- Listeners are stored in a `Set<Listener>` — no duplicates, O(1) add/remove.
- `set()` accepts either a value or an updater function `(prev) => next`.
- Both `set()` and `reset()` bail out via `Object.is` when the value hasn't changed.
- `use()` wraps `useSyncExternalStore(subscribe, () => selector(get()))` — concurrent-mode safe, no tearing.

## Domain Store Pattern

Each domain store wraps the factory with named actions. Raw `set` is never exported.

Directory layout is grouped by concern. **Zero barrels** (`index.ts` files) — see [`NO-BARRELS.md`](./NO-BARRELS.md) for rationale. Consumers import directly from the store file.

```
src/stores/
├── create-store.ts           # Factory
├── use-stores.ts             # Multi-store Proxy-tracked hook
├── ui/                       # Ephemeral screen chrome
│   ├── controls.ts           # Sidebar visibility + input mode (cross-tree flags)
│   ├── terminal-size.ts      # Terminal dimensions + responsive layout
│   ├── overlay.ts            # Active overlay panel + stack
│   ├── feedback.ts           # Info/error feedback messages
│   ├── input-history.ts      # Command history — pure in-memory state; persistence lives in cli/input-history-persistence.ts
│   └── input-height.ts       # Input bar rendered height
├── workflow/                 # State that only exists during a workflow run
│   ├── workflow.ts           # Event log, phase, task counters
│   ├── reducers.ts           # Pure reducer functions for workflow updates
│   ├── abort.ts              # Abort pending flag + auto-clear timer
│   ├── conversation-scroll.ts # Scroll position + expanded diffs
│   └── review.ts             # Review file path + scroll
├── navigation/               # Screen routing
│   └── router.ts             # Route state + transition guards
├── project/                  # Loaded-from-disk state tied to projectDir
│   ├── config.ts
│   ├── sessions.ts
│   ├── skills.ts
│   └── detection.ts
└── discovery/                # External-world reads with TTL cache
    └── model-cache.ts
```

**Import pattern:**

```typescript
import { workflowStore } from '../stores/workflow/workflow.js';
import { controlsStore } from '../stores/ui/controls.js';
import { configStore } from '../stores/project/config.js';
```

**Pattern:**

```typescript
// 1. Create internal store
const store = createStore<DomainState>(initial);

// 2. Define named action functions (closures over store)
function doSomething(arg: string) {
  store.set(s => ({ ...s, field: arg }));
}

// 3. Export facade — storeBase (use, get, reset) + domain actions
export const domainStore = { ...storeBase(store), doSomething };
```

This gives:
- **Encapsulated mutations** — consumers can't set arbitrary state
- **Self-documenting API** — actions describe what they do
- **Stable references** — action functions are module-level closures, never change identity

## Initialization Flow

Stores that need data from disk are loaded **synchronously before React renders**:

```
CLI (commander parses args)
  → initStores(projectDir, opts)
      1. configStore.load(projectDir, overrides)
      2. sessionsStore.load(scope, projectDir)
      3. skillsStore.discover(plannerTool, projectDir)
  → routerStore.init(route)           // set initial screen
  → render(<App />)                   // React starts here
```

**Why this matters:** If stores were loaded inside React hooks (e.g., in a `useEffect`), there would be a render cycle where the store is empty, requiring loading flags and conditional rendering. By loading before React boots, components always see initialized data.

`configStore.useConfig()` includes a guard that throws if config is null — a fail-fast safety net for this contract.

## Consumption Patterns

### In React components: `store.use(selector)`

```typescript
// Subscribe to a specific slice — only re-renders when that slice changes
const screen = routerStore.use(s => s.screen);
const config = configStore.useConfig(); // typed non-null Config
```

Selectors should return primitives or stable references. Avoid selectors that create new objects/arrays on every call (e.g., `.filter()`) unless the data changes infrequently.

### Multi-store flat reads: `useStores(...stores)`

When a component reads several fields from one or more stores, `useStores` (`src/stores/use-stores.ts`) collapses the boilerplate while preserving per-key re-render precision via Proxy tracking:

```typescript
import { useStores } from '../stores/use-stores.js';

const [{ projectDir }, { allSessions }, { cols, isSmall }] = useStores(
  configStore,
  sessionsStore,
  terminalSizeStore,
);
```

Each store snapshot is wrapped in a tracking `Proxy` — only the keys you actually read trigger re-renders. Reading `cols` but not `rows` means a change to `rows` alone will not re-render the component.

**Limitations** (Proxy `get` trap only). Fall back to `store.use(selector)` when:
- You use a computed / conditional selector: `workflowStore.use(s => hasWorkflowConfig(s.events))`.
- You need `Object.keys(x)`, `for...in`, spread (`{...x}`) or rest destructure (`{a, ...r}`) — none are intercepted.
- You read a field in an event handler or async callback (outside the render phase) — those reads don't register.

### In non-React code: `store.get()`

```typescript
// Synchronous read — used in CLI code, action functions, async handlers
const { projectDir } = configStore.get();
```

### Mutations: `store.action()`

```typescript
// Named actions — the only way to mutate state
overlayStore.open('help');
workflowStore.addEvent(event);
routerStore.navigate('workflow', { feature: 'auth' });
```

## Store Inventory

| Store | Path | State shape | Key actions |
|-------|------|-------------|-------------|
| `controlsStore` | `ui/controls.ts` | `{ sidebarVisible: boolean, inputMode: 'normal' \| 'review' \| 'question' }` | `toggleSidebar()`, `setSidebar()`, `setInputMode()`, `clearInputMode()` |
| `overlayStore` | `ui/overlay.ts` | `{ active, exclusive, focus?, stack[] }` | `open()`, `close()`, `setExclusive()` |
| `feedbackStore` | `ui/feedback.ts` | `{ message: string \| null, isError: boolean }` | `setMessage()`, `setError()`, `reset()` |
| `terminalSizeStore` | `ui/terminal-size.ts` | `{ cols, rows, isSmall }` | `set()`, `subscribeToResize()` |
| `inputHistoryStore` | `ui/input-history.ts` | `{ entries: string[] }` | `push()`, `hydrate()` — disk I/O lives in `cli/input-history-persistence.ts` wired from `init-stores.ts` |
| `inputHeightStore` | `ui/input-height.ts` | `{ rows: number }` | `setRows()` |
| `eventsStore` | `workflow/events.ts` | `{ events: TuiEvent[] }` | internal writes via `actions.addEvent` |
| `tasksStore` | `workflow/tasks.ts` | `{ currentTask, totalTasks, taskCompletionTimes, taskMap, tasks }` | internal writes via `actions.addEvent` |
| `tokensStore` | `workflow/tokens.ts` | `{ localCount, escalatedCount, tokenUsage }` | internal writes via `actions.addEvent` |
| `lifecycleStore` | `workflow/lifecycle.ts` | `{ phase, cancelled, queueDepth }` | internal writes via `actions.addEvent` |
| `abortStore` | `workflow/abort.ts` | `{ pending: boolean }` | `markPending()` (2s auto-clear), `clear()` |
| `conversationScrollStore` | `workflow/conversation-scroll.ts` | `{ scrollOffset, expandedDiffs, ... }` | `scrollUp()`, `scrollDown()`, `scrollToBottom()`, `toggleDiff()` |
| `reviewStore` | `workflow/review.ts` | `{ filePath, scrollOffset, lineCount }` | `setReviewFile()`, `setScrollOffset()`, `clearReview()` |
| `routerStore` | `navigation/router.ts` | `RouteData` (discriminated union on `screen`) | `navigate()`, `init()` — with transition guards |
| `configStore` | `project/config.ts` | `{ config: Config \| null, projectDir, overrides }` | `load()`, `save()`, `useConfig()` |
| `sessionsStore` | `project/sessions.ts` | `{ sessions, allSessions }` | `load()`, `loadAll()` |
| `skillsStore` | `project/skills.ts` | `{ available: SkillMeta[], selected: Set<string> }` | `discover()`, `setSelected()` |
| `detectionStore` | `project/detection.ts` | `{ planners, implementers }` | `setDetection()` |
| `modelCacheStore` | `discovery/model-cache.ts` | `{ providers: Map, modelsDevCatalog, ... }` | `setProviderModels()`, `invalidateAll()` |

### Workflow actions module

`workflow/actions.ts` is not a store — it's a namespace module holding composite operations that orchestrate writes across the four workflow sub-stores. All engine and UI code that mutates workflow state goes through this module; direct `.set()` on sub-stores is reserved for test helpers.

| Export | Purpose |
|---|---|
| `addEvent(event: TuiEvent)` | Single ingress for engine events. Reads `lifecycleStore.cancelled` as a gate; short-circuits for `cost-update`; otherwise fans out (events → tasks → tokens → lifecycle). Strictly synchronous. |
| `markCancelled(): boolean` | Writes terminal `workflow-cancelled` event to `eventsStore`, sets `lifecycleStore.cancelled`. Idempotent. |
| `resetWorkflow(resume?)` | Calls `abortStore.clear()` first, then resets all 4 sub-stores; applies resume state if provided. |
| `getSections()` / `useSections()` | Memoized derivation of conversation sections from `eventsStore.events`. Cache lives file-local. |
| `WorkflowViewState` | Type alias `EventsState & TasksState & TokensState & LifecycleState` — exported for any consumer that needs the flattened shape. |

**Reducers live with their owner sub-store** — `events.ts` exports `mergeEvent` + `MAX_EVENTS`, `tasks.ts` exports `updateTaskMap` + `updateTaskCounts`, `tokens.ts` exports `updateTokens`, `lifecycle.ts` exports `updatePhase` + `updateQueueDepth`. They are pure functions and can be tested directly.

## Design Decisions

**Why not Zustand?**
Same core pattern, zero dependencies. We don't use middleware, devtools, persist, or partial merge — so the 45 lines we have is all we need.

**Why not React Context?**
Context re-renders all consumers when any part of the context value changes. External stores with selectors re-render only when the selected slice changes. Also eliminates provider nesting.

**Why module-scoped singletons?**
The app is a single CLI process. There is exactly one instance of each store, shared between React components and engine code. No need for dependency injection or multiple instances.

**Why no useMemo / useCallback / React.memo?**
Store selectors make them unnecessary. Components subscribe to specific slices and only re-render when those slices change. Action functions are module-level closures with stable identity.

## Anti-Patterns

| Don't | Why |
|-------|-----|
| Call `store.set()` during React render | Causes infinite render loops |
| Add `loaded: boolean` flags to stores | Init belongs in CLI entry point, not hooks |
| Create React Context for shared state | Use stores instead |
| Export raw `store.set()` | Breaks encapsulation — use named actions |
| Use `configStore.get()` in components | Use `configStore.use(selector)` for reactive reads |
| Add `useMemo` / `useCallback` / `React.memo` | Store selectors make them unnecessary |

## Engine Write Pattern

`src/engine/orchestrator/planning.ts`, `run.ts`, and `task-step.ts` deliberately import `workflowStore` (and `abortStore` where needed) to write events and register abort/queue handlers. This is the intended **engine → store → UI** data flow direction, not a layer violation:

- The engine writes events via `workflowStore.addEvent()` — UI components subscribe reactively and re-render only when their selected slice changes.
- `abortStore` (or equivalent) is written by the engine to signal cancellation; the UI reads it to show abort state.
- Engine modules live in `src/engine/` and have zero React/Ink imports — they only touch store singletons, which are plain module-scoped objects with no UI dependencies.

The distinction is one-directional: engine code **writes** to stores; React components **read** from stores. Nothing in `src/engine/` calls `store.use()` (a React hook) — it only calls `store.get()` and `store.set()` / named actions.
