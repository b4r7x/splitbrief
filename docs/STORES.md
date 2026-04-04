# Store Architecture

tiny-spec uses a DIY external store system built on React's `useSyncExternalStore`. The entire framework is 45 lines. It provides the same core capabilities as Zustand with zero dependencies.

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

```
src/stores/
├── create-store.ts    # Factory (45 LOC)
├── overlay.ts         # Active overlay panel
├── router.ts          # Screen routing + transition guards
├── error.ts           # Global error message
├── config.ts          # Config from disk + CLI overrides
├── skills.ts          # Available + selected skills
├── sessions.ts        # Session history
└── workflow.ts        # Event log, phase, task counters, sidebar map
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

| Store | State shape | Key actions |
|-------|-------------|-------------|
| `overlayStore` | `{ active: OverlayType, exclusive: boolean }` | `open()`, `close()`, `setExclusive()` |
| `routerStore` | `RouteData` (discriminated union on `screen`) | `navigate()`, `init()` — with transition guards |
| `errorStore` | `{ message: string \| null }` | `setError()`, `clearError()` |
| `configStore` | `{ config: Config \| null, projectDir, overrides }` | `load()`, `reload()`, `useConfig()` |
| `skillsStore` | `{ available: SkillMeta[], selected: Set<string> }` | `discover()`, `setSelected()` |
| `sessionsStore` | `{ sessions: Session[] }` | `load()` |
| `workflowStore` | `{ events, phase, currentTask, totalTasks, ... taskMap }` | `addEvent()`, `setReviewFile()` |

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
