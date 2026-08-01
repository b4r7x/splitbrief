# Store Architecture

SPLITBRIEF uses a DIY external store system built on React's `useSyncExternalStore`. The entire framework is 42 lines. It provides the same core capabilities as Zustand with zero dependencies.

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
│   ├── feedback.ts           # Info/error feedback messages (subscribes channels/feedback)
│   ├── input-history.ts      # Command history — pure in-memory state; persistence lives in stores/ui/persistence.ts
│   ├── input-height.ts       # Input bar rendered height
│   ├── command-palette-mru.ts # Command palette most-recently-used order
│   ├── project-files.ts      # Project-file picker refresh invalidation tick
│   ├── completion.ts         # Completion popup open/closed flag
│   ├── focus.ts              # Focused region + index (e.g. brief)
│   ├── hover.ts              # Hovered surface + index (brief / conversation)
│   └── persistence.ts        # Disk I/O for inputHistoryStore (hydrate + debounced save)
├── workflow/                 # State that only exists during a workflow run
│   ├── events.ts             # Event log (mergeEvent + MAX_EVENTS)
│   ├── tasks.ts              # Task map + counters
│   ├── tokens.ts             # Local / escalated token counts
│   ├── lifecycle.ts          # Phase, cancelled, queue depth
│   ├── operations/           # Active / last runner operation (state.ts, reducer.ts, …)
│   ├── actions/              # Composite writes across sub-stores (event, interrupt, resume, reset, sections)
│   ├── abort.ts              # Armed abort intent (ArmedKind) + auto-clear timer
│   ├── attachments.ts        # Pending prompt attachments
│   ├── conversation-scroll.ts # Scroll position + expanded diffs
│   ├── streaming-output.ts   # Live streamed runner output
│   └── review.ts             # Review file path + scroll
├── approval-prompt/          # Tiered approval request/response prompt
│   └── prompt.ts             # approvalPromptStore (via channels/prompt)
├── cost-approval/            # Cost-prediction approval prompt
│   └── prompt.ts             # costApprovalStore (via channels/prompt)
├── channels/                 # Cross-store messaging channels
│   ├── prompt.ts             # createPromptChannel — request/response with supersede/cancel
│   └── feedback.ts           # Feedback error publish/subscribe
├── navigation/               # Screen routing
│   ├── router.ts             # Route state + transition guards
│   └── session-select.ts     # Session-picker selection state
├── project/                  # Loaded-from-disk state tied to projectDir
│   ├── config.ts
│   ├── config-persistence.ts
│   ├── sessions.ts
│   ├── skills.ts
│   └── detection.ts
└── discovery/                # External-world reads with TTL cache
    ├── model-cache.ts
    └── detection-adapter.ts
```

`stores/` is grouped by concern, one directory per domain.

`stores/channels/` holds cross-store messaging channels — decoupled pub/sub and request/response wires that let one store signal another without a direct import cycle. `feedback.ts` carries feedback errors (`router` publishes, `ui/feedback` subscribes); `prompt.ts` exposes `createPromptChannel`, the request/response primitive backing `approvalPromptStore` and `costApprovalStore` (with supersede / cancel semantics).

**Import pattern:**

```typescript
import { eventsStore } from '../stores/workflow/events.js';
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
      3. discoverSkills(plannerTool, projectDir) → skillsStore.setAvailable(skills)
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
- You use a computed / conditional selector: `eventsStore.use(s => hasWorkflowConfig(s.events))`.
- You need `Object.keys(x)`, `for...in`, spread (`{...x}`) or rest destructure (`{a, ...r}`) — none are intercepted.
- You read a field in an event handler or async callback (outside the render phase) — those reads don't register.

### In non-React UI/CLI glue: `store.get()`

```typescript
// Synchronous read — used in CLI code, action functions, async UI handlers
const { projectDir } = configStore.get();
```

### Mutations: `store.action()`

```typescript
// Named actions — the only way to mutate state
overlayStore.open('help');
addEvent(event);
routerStore.navigate('workflow', { feature: 'auth' });
```

## Store Inventory

| Store | Path | State shape | Key actions |
|-------|------|-------------|-------------|
| `controlsStore` | `ui/controls.ts` | `{ sidebarVisible: boolean, inputMode: 'normal' \| 'review' \| 'question' }` | `toggleSidebar()`, `setSidebar()`, `setInputMode()`, `clearInputMode()` |
| `overlayStore` | `ui/overlay.ts` | `{ active, exclusive, focus?, stack[] }` | `open()`, `close()`, `setExclusive()` |
| `feedbackStore` | `ui/feedback.ts` | `{ message: string \| null, isError: boolean }` | `setMessage()`, `setError()`, `setTransientError()`, `reset()` |
| `terminalSizeStore` | `ui/terminal-size.ts` | `{ cols, rows, isSmall }` | `set()`, `subscribeToResize()` |
| `inputHistoryStore` | `ui/input-history.ts` | `{ entries: string[] }` | `push()`, `hydrate()` — disk I/O lives in `stores/ui/persistence.ts` wired from `init-stores.ts` |
| `inputHeightStore` | `ui/input-height.ts` | `{ rows: number }` | `setRows()` |
| `commandPaletteMruStore` | `ui/command-palette-mru.ts` | `{ ids: string[] }` | `record()` |
| `projectFilesStore` | `ui/project-files.ts` | `{ refreshEpoch: number }` invalidation tick; the composer owns file-list reads and local list state | `requestRefresh()` |
| `eventsStore` | `workflow/events.ts` | `{ events: EngineEvent[] }` | internal writes via `actions.addEvent` |
| `tasksStore` | `workflow/tasks.ts` | `{ currentTask, totalTasks, taskCompletionTimes, taskMap, tasks }` | internal writes via `actions.addEvent` |
| `tokensStore` | `workflow/tokens.ts` | `{ localCount, escalatedCount, tokenUsage }` | internal writes via `actions.addEvent` |
| `lifecycleStore` | `workflow/lifecycle.ts` | `{ phase, status, cancelled, queueDepth, startedAt, endedAt, durationMs, reason }` | internal writes via `actions.addEvent` / local cancel intent |
| `operationsStore` | `workflow/operations/state.ts` | `{ active, last, byCallId }` compact runner lifecycle/status | internal writes via `actions.addEvent` / local cancel intent |
| `abortStore` | `workflow/abort.ts` | `{ armed: ArmedKind }` | `arm(kind)` (2s auto-clear), `clear()` |
| `conversationScrollStore` | `workflow/conversation-scroll.ts` | `{ scrollOffset, expandedDiffs, ... }` | `scrollUp()`, `scrollDown()`, `scrollToBottom()`, `toggleDiff()` |
| `reviewStore` | `workflow/review.ts` | `{ filePath, scrollOffset, renderedLineCount }` | `setReviewFile()`, `setScrollOffset()`, `setRenderedLineCount()`, `clearReview()` |
| `attachmentsStore` | `workflow/attachments.ts` | `{ pending: Attachment[] }` | `add()`, `remove()`, `drain()`, `peek()` — `attachImage()` / `detachImage()` / `listAttachments()` helpers |
| `streamingOutputStore` | `workflow/streaming-output.ts` | `{ taskId, lines, active }` | `startStreaming()`, `replaceLines()`, `stopStreaming()` |
| `approvalPromptStore` | `approval-prompt/prompt.ts` | `{ status: 'idle' } \| { status: 'pending', request, resolve }` | `openApprovalPrompt()`, `closeApprovalPrompt()` (via `channels/prompt`) |
| `costApprovalStore` | `cost-approval/prompt.ts` | `{ status: 'idle' } \| { status: 'pending', prediction, resolve }` | `openCostApprovalPrompt()`, `closeCostApprovalPrompt()` (via `channels/prompt`) |
| `routerStore` | `navigation/router.ts` | `RouteData` (discriminated union on `screen`) | `navigate()`, `init()` — with transition guards |
| `configStore` | `project/config.ts` | `{ config: Config \| null, projectDir, overrides }` | `load()`, `save()`, `useConfig()` |
| `sessionsStore` | `project/sessions.ts` | `{ sessions, allSessions }` | `load()`, `loadAll()` |
| `skillsStore` | `project/skills.ts` | `{ available: SkillMeta[], selected: Set<string> }` | `setAvailable()`, `setSelected()` |
| `detectionStore` | `project/detection.ts` | `{ cliTools, implementers }` | `setDetection()` |
| `modelCacheStore` | `discovery/model-cache.ts` | `{ providers: Map, modelsDevCatalog, ... }` | `setProviderModels()`, `invalidateAll()` |

### Workflow actions module

`workflow/actions/` is not a store — it holds composite operations that orchestrate writes across workflow sub-stores (`event.ts`, `interrupt.ts`, `resume.ts`, `reset.ts`, `sections.ts`). The TUI sink calls it for engine events, and UI command handlers call it for local intent such as cancellation. Direct `.set()` on sub-stores is reserved for test helpers.

| Export | Purpose |
|---|---|
| `addEvent(event: EngineEvent)` | Single ingress for engine events. Called by `tuiSink` (registered on the engine `EventBus`), **not** directly by the orchestrator. `cost_update` still updates tokens after cancellation. After local cancel, terminal runner events and final telemetry are accepted while UI noise is ignored. Normal fan-out order is events → tasks → tokens → lifecycle → operations. Strictly synchronous. |
| `markCancellationRequested(intent?)` | Local UI intent for immediate feedback. Terminalizes lifecycle and running operations with frozen duration, but does **not** append a fake event or rewrite `planner_status` to success. The canonical history event is still engine-published `workflow_cancelled`. |
| `resetWorkflow(resume?)` | Calls `abortStore.clear()` first, then resets workflow sub-stores **and invalidates the memo caches** (`cachedEvents`, `cachedSections`) so subscribers observe a clean slate; applies resume state if provided. Cache invalidation is symmetric with sub-store reset — missing it leaks pre-reset sections into the first post-reset `useSections()` call. |
| `getSections()` / `useSections()` | Memoized derivation of conversation sections from `eventsStore.events`. Cache lives file-local. |

**Reducers live with their owner sub-store** — `events.ts` exports `mergeEvent` + `MAX_EVENTS`, `tasks.ts` exports `updateTaskMap` + `updateTaskCounts`, `tokens.ts` exports `updateTokens`, `lifecycle.ts` exports `updatePhase` + `updateQueueDepth`, and `operations/reducer.ts` exports `updateOperations`. They are pure functions and can be tested directly.

`lifecycle.ts` owns queue count state. `message_queued` increments `queueDepth`; `message_injected_native`, `queue_drained`, and `queue_cleared` decrement it. `resetWorkflow(resume)` reconstructs depth from undrained, non-native queue entries so resumed sessions show the same pending queue count near the composer.

`operations/state.ts` and `operations/reducer.ts` own compact runner lifecycle for operation-state consumers: active/last call identity, terminal status, frozen timing, warning count/detail, usage, partial output, runner, and model. It does not decide what activity text belongs in chrome. Conversation rows render safe `runner_call_activity` events from the retained event log as batched per-call activity blocks; assistant/result text, prompts, task bodies, full descriptions, and raw tool payloads remain transcript-bearing and must not update status chrome.

## Design Decisions

**Why not Zustand?**
Same core pattern, zero dependencies. We don't use middleware, devtools, persist, or partial merge — so the few lines we have is all we need.

**Why not React Context?**
Context re-renders all consumers when any part of the context value changes. External stores with selectors re-render only when the selected slice changes. Also eliminates provider nesting.

**Why module-scoped singletons?**
The app is a single CLI process. There is exactly one instance of each store, shared between React components, UI glue, and store actions. No need for dependency injection or multiple instances.

**Why no useMemo / useCallback / React.memo?**
Store selectors make them unnecessary. Components subscribe to specific slices and only re-render when those slices change. Action functions are module-level closures with stable identity.

## Anti-Patterns

| Don't | Why |
|-------|-----|
| Call `store.set()` during React render | Causes infinite render loops |
| Add `loaded: boolean` flags to stores | Init belongs in CLI entry point, not hooks |
| Create React Context for shared state | Use stores instead |
| Export raw `store.set()` from a facade | Breaks encapsulation — use named actions. Tests MAY use `__testReset(nextState?)` where no action fits; the `__` prefix signals internal/test-only and is the single sanctioned bypass. |
| Use `configStore.get()` in components | Use `configStore.use(selector)` for reactive reads |
| Add `useMemo` / `useCallback` / `React.memo` | Store selectors make them unnecessary |

### Cross-module writes within a store group

Workflow sub-stores (`events`, `tasks`, `tokens`, `lifecycle`, `operations`) are written exclusively by `workflow/actions/`. Each sub-store exports a package-private mutator (`_eventsInternal`, `_tasksInternal`, etc.) that only the action modules import. Consumers must go through `addEvent`, `markCancellationRequested`, or `resetWorkflow`. The raw `set` is not part of the facade — tests bypass actions via `__testReset`.

### Test escape hatches

A small number of stores ship two test-only exports so tests can arrange specific starting states that no domain action produces.

| Symbol | Shape | Who may import |
|---|---|---|
| `__testReset(next?)` on a store facade | Replaces current state with `{ ...initial, ...next }` | `*.test.ts` / `*.test.tsx` files only |
| `_<name>Internal = { set }` (e.g. `_lifecycleInternal`, `_operationsInternal`, `_eventsInternal`, `_tasksInternal`, `_tokensInternal`) | Exposes the raw store setter | `src/stores/workflow/actions/` for the production write path; tests that need to reach a state the public actions cannot produce (e.g. `src/app/keys.test.tsx` forcing a mid-workflow phase) |

**Rule.** Production code outside `workflow/actions/` MUST NOT import either symbol. Reviewers reject PRs that add new call sites in `src/` outside that one module. Tests are the only other sanctioned caller.

**Why they exist.** `lifecycleStore` (and the other workflow sub-stores) expose no public setter — `addEvent` is the engine-event ingress, and `markCancellationRequested` is the local-intent ingress. A test that needs to assert behaviour while the store is already at `phase: 'implementing'` cannot replay a full event stream to get there, so `__testReset` arranges the state directly. Similarly, `_lifecycleInternal.set` lets the dispatcher write one slice without exposing generic mutation publicly.

**Rejected alternative.** Adding a full `lifecycleStore.setPhase(...)` / generic `set()` action to the public facade. Rejected — it widens the public surface to solve a test-only problem, and makes it trivial for production code to bypass the dispatcher's invariants. The `__` / `_Internal` prefix is the signal that the symbol is off-limits outside tests and the dispatcher.

## Engine Write Pattern

Since the 2026-04-20 release the engine no longer writes workflow stores directly or imports `workflow/actions.addEvent`. Events are published on the `EventBus` (`wctx.bus.publish(event)`); the `tuiSink` (`src/features/workflow/tui-sink.ts`) is subscribed at workflow init and forwards each `EngineEvent` to `workflow/actions.addEvent`. This keeps the intended **engine → bus → sink → store → UI** direction and preserves the layer rule (engine has zero React, UI, or store imports):

- Engine code publishes events; sinks write to stores; UI components subscribe reactively and re-render only when their selected slice changes.
- Non-event cross-cutting writes (abort / queue handler registration) go through the `sinks` surface on the workflow context. The engine does not import stores to observe cancellation; it receives an `AbortSignal` from the caller.
- Engine modules live in `src/engine/` and have zero React/Ink/store imports. They publish `EngineEvent` values and return data.

The distinction is one-directional: engine code publishes to the bus; sinks write to stores; React components read from stores. Nothing in `src/engine/` calls `store.use()`, `store.get()`, or store actions.
