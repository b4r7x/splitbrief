# Store Architecture

SPLITBRIEF uses a DIY external store system built on React's `useSyncExternalStore`. The entire framework is one short file, `src/stores/create-store.ts`. It provides the same core capabilities as Zustand with zero dependencies.

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
| `reset()` | `() => void` | Reset to the initial state (a factory initial runs again). Same `Object.is` bailout as `set()` |

**Key semantics:**
- State is a closure variable, not React state. Changes are synchronous.
- Listeners are stored in a `Set<Listener>` — no duplicates, O(1) add/remove.
- `set()` accepts either a value or an updater function `(prev) => next`.
- Both `set()` and `reset()` bail out via `Object.is` when the value hasn't changed.
- `use()` wraps `useSyncExternalStore(subscribe, getSnapshot)`, where `getSnapshot` caches the selected value per state and selector — concurrent-mode safe, no tearing.

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
│   ├── terminal-background.ts # Detected terminal background
│   ├── overlay.ts            # Active overlay panel + stack
│   ├── feedback.ts           # Info/error feedback messages (subscribes channels/feedback)
│   ├── input-history.ts      # Command history — pure in-memory state; persistence lives in stores/ui/persistence.ts
│   ├── input-height.ts       # Input bar rendered height
│   ├── command-palette-mru.ts # Command palette most-recently-used order
│   ├── project-files.ts      # Project-file picker refresh invalidation tick
│   ├── completion.ts         # Completion popup open/closed flag
│   ├── hover.ts              # Hovered conversation row index
│   ├── composer-draft.ts     # One-shot requests that place a document or an image in the composer draft
│   ├── composer-live.ts      # The composer's live draft (empty flag, text, document)
│   ├── session-drafts.ts     # Per-session draft.json load, save and flush (functions, no store)
│   ├── review-keys.ts        # Whether the keys belong to a comment on a review gate
│   ├── picker-view.ts        # Runner picker sub-view, expanded model row and option drafts
│   ├── editor.ts             # Inline editor session (openRaw, owner-token write gate)
│   ├── external-edit-request.ts # One-shot Ctrl+O intent bridge to the workflow effect
│   └── persistence.ts        # Disk I/O for inputHistoryStore (hydrate + debounced save)
├── workflow/                 # State that only exists during a workflow run
│   ├── events.ts             # Event log (mergeEvent + MAX_EVENTS)
│   ├── tasks.ts              # Task map + counters
│   ├── tokens.ts             # Token usage + completion count
│   ├── lifecycle.ts          # Phase, cancelled, queued ids and count
│   ├── operations/           # Active / last runner operation (state.ts, reducer.ts, …)
│   ├── actions/              # Composite writes across sub-stores (event, load, hydrate, interrupt, resume, pause, reset, sections, wait)
│   ├── stop.ts               # Stop/quit intent + termination phase (stopStore)
│   ├── attachments.ts        # Pending prompt attachments
│   ├── conversation-scroll.ts # Scroll position + expanded diffs
│   ├── streaming-output.ts   # Live streamed runner output
│   ├── transcript-tail.ts    # What the blocks after the run's events add to the transcript
│   ├── result-menu.ts        # Measured result menu rows, including Apply confirmation
│   ├── recovery-notice.ts    # The seat a halt stopped + its quota reset, for the header
│   └── review.ts             # Review file path + scroll
├── question-prompt/          # Planner questions waiting for answers
│   └── prompt.ts             # questionPromptStore
├── approval-prompt/          # Confirmation prompt (protected writes, custom-runner admission)
│   └── prompt.ts             # approvalPromptStore (via channels/prompt)
├── review-checks-prompt/     # Reviewer checks card (validation.approve_checks: ask)
│   └── prompt.ts             # reviewChecksPromptStore (via channels/prompt)
├── channels/                 # Cross-store messaging channels
│   ├── prompt.ts             # createPromptChannel — request/response with supersede/cancel
│   └── feedback.ts           # Feedback error publish/subscribe
├── navigation/               # Screen routing
│   ├── router.ts             # Route state + transition guards
│   ├── preparation.ts        # The readiness check before a run starts or continues
│   └── session-select.ts     # Session-picker selection state + continueRunInPlace
├── project/                  # Loaded-from-disk state tied to projectDir
│   ├── config.ts
│   ├── config-persistence.ts
│   ├── sessions.ts
│   ├── skills.ts
│   ├── save-feedback.ts      # Config save failure reporting
│   └── detection.ts          # View over the model cache's detection slice
└── discovery/                # External-world reads with TTL cache
    ├── model-cache/           # store entry state.ts + reconcile/lane helpers
    └── detection-adapter.ts
```

`stores/` is grouped by concern, one directory per domain.

`stores/channels/` holds cross-store messaging channels — decoupled pub/sub and request/response wires that let one store signal another without a direct import cycle. `feedback.ts` carries feedback errors (`router` publishes, `ui/feedback` subscribes); `prompt.ts` exposes `createPromptChannel`, the request/response primitive backing `approvalPromptStore` and `reviewChecksPromptStore` (with supersede / cancel semantics).

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

// 3. Export facade — storeBase (use, get, subscribe, reset) + domain actions
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
  → initStoresForTuiMount(projectDir, opts)   // src/cli/bootstrap/init.ts
      1. configStore.load(projectDir, overrides)
      2. sessionsStore.load(projectDir)
      3. hook trust check
      4. discovery, returned as awaitDiscovery and not awaited:
         detection hydrate + refresh, then discoverSkills(projectDir) → skillsStore.setAvailable(skills)
  → routerStore.init(route)           // set initial screen
  → render(<App />)                   // React starts here, while discovery continues
```

`initStores()` runs the same steps and awaits discovery too; `splitbrief init` and the interactive `continue` path use it.

**Why this matters:** If stores were loaded inside React hooks (e.g., in a `useEffect`), there would be a render cycle where the store is empty, requiring loading flags and conditional rendering. By loading before React boots, components always see initialized data.

`configStore.useConfig()` includes a guard that throws if config is null — a fail-fast safety net for this contract.

Skill discovery also runs again after boot: both sites that open the skills overlay (`Ctrl+S` in `src/app/keys.ts`, and the `/skills` command through `ctx.refreshSkills()`) call `refreshSkills()` from `src/app/refresh-skills.ts`, which re-runs `discoverSkills(projectDir)` and feeds `skillsStore.setAvailable()`. It is a helper called from the open sites, not a mount-time effect inside the overlay.

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

const [{ projectDir }, { sessions }, { cols, isSmall }] = useStores(
  configStore,
  sessionsStore,
  terminalSizeStore,
);
```

Each store snapshot is wrapped in a tracking `Proxy` — only the keys you actually read trigger re-renders. Reading `cols` but not `rows` means a change to `rows` alone will not re-render the component.

**Limitations** (Proxy `get` trap only). Fall back to `store.use(selector)` when:
- You use a computed / conditional selector: `overlayStore.use(s => s.active !== 'none')` (`src/app/screens/home.tsx`).
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
routerStore.navigate({ to: 'home' });
```

## Store Inventory

| Store | Path | State shape | Key actions |
|-------|------|-------------|-------------|
| `controlsStore` | `ui/controls.ts` | `{ sidebarVisible: boolean, inputMode: 'normal' \| 'review' \| 'question' }` | `toggleSidebar()`, `setSidebar()`, `setInputMode()`, `clearInputMode()` |
| `overlayStore` | `ui/overlay.ts` | `{ active, exclusive, focus?, stack[] }` | `open()`, `close()`, `setExclusive()` |
| `feedbackStore` | `ui/feedback.ts` | `{ message: string \| null, isError: boolean }` | `setMessage()`, `setError()`, `setTransientError()`, `reset()` |
| `terminalSizeStore` | `ui/terminal-size.ts` | `{ cols, rows, isSmall }` | `subscribeToResize()`, `reset()` |
| `terminalBackgroundStore` | `ui/terminal-background.ts` | `string \| undefined` | `detected(hex)`, `reset()` |
| `inputHistoryStore` | `ui/input-history.ts` | `{ entries: string[] }` | `push()`, `pushDocumentSubmission()`, `hydrate()` — disk I/O lives in `stores/ui/persistence.ts` wired from `cli/bootstrap/project.ts` |
| `inputHeightStore` | `ui/input-height.ts` | `{ rows: number }` | `setRows()` |
| `commandPaletteMruStore` | `ui/command-palette-mru.ts` | `{ ids: string[] }` | `record()` |
| `projectFilesStore` | `ui/project-files.ts` | `{ refreshEpoch: number }` invalidation tick; the composer owns file-list reads and local list state | `requestRefresh()` |
| `completionStore` | `ui/completion.ts` | `{ open: boolean }` | `setOpen()` |
| `hoverStore` | `ui/hover.ts` | `number \| null` — the hovered row index | `set()`, `clear()` |
| `composerDraftStore` | `ui/composer-draft.ts` | the pending draft request (a document or an image) | `request()`, `requestDocument()`, `requestImage()`, `clear()` |
| `composerLiveStore` | `ui/composer-live.ts` | `{ empty, text, document }` | `setDraft()` |
| `reviewKeysStore` | `ui/review-keys.ts` | `{ commenting: boolean, requested: boolean }` — `requested` holds a change request that Request changes opened, also while its draft is empty | `setCommenting()`, `requestComment()`, `endComment()` |
| `pickerViewStore` | `ui/picker-view.ts` | `{ view, preservedLeftIndex, expandedModelId, optionDraftId, … }` | `open()`, `close()`, `expand()`, `collapse()`, `setOptionDraftId()`, `setEffortDraft()`, `setAuthDraft()`, `setDraft()`, `setBrowseCatalog()` |
| `editorStore` | `ui/editor.ts` | `{ status: 'closed' }` or an open editor session | `openRaw()`, `dispatch()`, `setLayout()`, `scrollBy()`, `beginSubmit()`, `close()` |
| `externalEditRequestStore` | `ui/external-edit-request.ts` | the one pending Ctrl+O request | `request()`, `requestApply()`, `consume()` |
| `eventsStore` | `workflow/events.ts` | `{ events: EngineEvent[] }` | internal writes via `actions.addEvent` |
| `tasksStore` | `workflow/tasks.ts` | `{ currentTask, currentAttempt, attemptAllowance, totalTasks, taskMap, tasks }` | internal writes via `actions.addEvent` |
| `tokensStore` | `workflow/tokens.ts` | `{ tokenUsage, perPhase, perTask, completedTaskCount, pricingContext }` | internal writes via `actions.addEvent` |
| `lifecycleStore` | `workflow/lifecycle.ts` | `{ phase, status, cancelled, queueDepth, queuedMessageIds, steerableCall, startedAt, endedAt, durationMs, reason, plannerCall, plannerCallStartedTs, waitingSince, waitedMs, resumedAt, bankedRunMs }` — `plannerCall` is the call the phase is on when the engine names one, `plannerCallStartedTs` is where the byline clock of that call starts, `waitingSince` / `waitedMs` keep time spent waiting on the user out of the stage clock, `resumedAt` keeps a resumed run's park out of it, `bankedRunMs` is the run time of the stretches before the last resume, so the header clock (`runElapsedMs`) leaves parks out | internal writes via `actions.addEvent` / local cancel intent |
| `operationsStore` | `workflow/operations/state.ts` | `{ active, last, byCallId }` compact runner lifecycle/status | internal writes via `actions.addEvent` / local cancel intent |
| `stopStore` | `workflow/stop.ts` | `{ intent, phase, requestedAt, parked, error? }` — the run's stop intent and where its termination stands | `request(intent)`, phase marks (`markTerminating()`, `markSettling()`, `markForcing()`), `park()`, `resume(steer)`, `end()`, `fail()` |
| `conversationScrollStore` | `workflow/conversation-scroll.ts` | `{ scrollOffset, expandedDiffs, ... }` | `scrollUp()`, `scrollDown()`, `scrollToBottom()`, `toggleDiff()`, `toggleActivityBatch()` |
| `reviewStore` | `workflow/review.ts` | `{ filePath, scrollOffset, renderedLineCount, … }` | `setReviewFile()`, `setReviewArtifact()`, `setScrollOffset()`, `setRenderedLineCount()`, `clearReview()`, `clearReviewIfOwner()`, plus brief source, path and confirm setters |
| `attachmentsStore` | `workflow/attachments.ts` | `{ pending: Attachment[] }` | `add()`, `remove()`, `replacePendingImages()`, `drain()`, `peek()` — `attachImage()` / `detachImage()` / `listAttachments()` helpers |
| `streamingOutputStore` | `workflow/streaming-output.ts` | `{ taskId, lines, active }` | `startStreaming()`, `replaceLines()`, `stopStreaming()` |
| `transcriptTailStore` | `workflow/transcript-tail.ts` | `{ rowCount, renderableUnits }` — what a closed run's ledger adds after the run's own events | `setMetrics()` — written by the transcript, read by the keyboard so both measure one document |
| `resultMenuStore` | `workflow/result-menu.ts` | `number \| null` — measured result menu height, including Apply confirmation | `setHeight()`, `reset()` — written by the workflow screen, read by the scroll snapshot |
| `recoveryNoticeStore` | `workflow/recovery-notice.ts` | `{ seat, resetAt }` — the seat an open halt stopped on and the clock its quota returns on | `open({ seat, resetAt })`, `clear()` — written by the TUI recovery driver |
| `questionPromptStore` | `question-prompt/prompt.ts` | `{ hint, index, drafts, answers, focus, openedAt, complete }` — the planner questions on screen and the answers so far | `setHint()`, `setQuestions()`, `select()`, `setFocus()`, `previous()`, `answer()`, `takeAnswerBatch()`, `clearHint()` |
| `approvalPromptStore` | `approval-prompt/prompt.ts` | `{ status: 'idle' } \| { status: 'pending', request, resolve }` | `openApprovalPrompt()`, `closeApprovalPrompt()` (via `channels/prompt`) |
| `reviewChecksPromptStore` | `review-checks-prompt/prompt.ts` | `{ status: 'idle' } \| { status: 'pending', request, resolve }` — the reviewer's chosen commands waiting for Run all or Skip all | `openReviewChecksPrompt()`, `closeReviewChecksPrompt(answer?)` (via `channels/prompt`); a superseded or cancelled card resolves `undefined`, which the engine never reads as Run all |
| `routerStore` | `navigation/router.ts` | `RouteData` (discriminated union on `screen`) | `navigate({ to, … })`, `init()` — with transition guards |
| `preparationStore` | `navigation/preparation.ts` | `{ kind: 'idle' \| 'checking' \| 'blocked' \| 'failed', … }` — the readiness check before a run starts or continues | `submit()`, `cancel()`, `reset()` |
| `sessionSelectStore` | `navigation/session-select.ts` | the session picker's selection and its error | `clearError()`, `reset()` — `handleSessionSelect()` and `continueRunInPlace()` drive it |
| `configStore` | `project/config.ts` | `{ config: Config \| null, projectDir, overrides }` | `load()`, `refreshFromExecution()`, `save()`, `useConfig()`, `setContextLength()` |
| `sessionsStore` | `project/sessions.ts` | `{ sessions, totalCount, projectDir }` | `load()`, `refresh()` |
| `skillsStore` | `project/skills.ts` | `{ available: SkillMeta[], selected: Set<string> }` | `setAvailable()`, `setSelected()`, `toggleSelected()` |
| `detectionStore` | `project/detection.ts` | a view over the model cache's `detection` slice: `{ providers, cliTools, providerOutcomes, cliCatalogOutcomes, refresh }`. It has no state of its own | `setDetection()`, `beginRefresh()`, `hydrate()`, `publishLane()`, `publish()`, `reset()` — each forwards to `modelCacheStore` |
| `modelCacheStore` | `discovery/model-cache/state.ts` | `{ detection, providers, configuredProviders, cliCatalogs, modelsDevCatalog, refresh, … }` | `setDetection()`, `beginRefresh()`, `hydrateDetection()`, `publishLane()`, `publish()`, `setProviderModels()`, `hydrateModelsDevCatalog()`, `reset()` |

### Workflow actions module

`workflow/actions/` is not a store — it holds composite operations that orchestrate writes across workflow sub-stores (`event.ts`, `load.ts`, `hydrate.ts`, `interrupt.ts`, `resume.ts`, `pause.ts`, `reset.ts`, `sections.ts`, `wait.ts`). The TUI sink calls it for engine events, and UI command handlers call it for local intent such as cancellation. Direct `.set()` on sub-stores is reserved for test helpers.

| Export | Purpose |
|---|---|
| `addEvent(event: EngineEvent)` | Single ingress for engine events. Called by `addTuiEvent` (`src/features/workflow/tui-sink.ts`, registered on the engine `EventBus` as the TUI sink), **not** directly by the orchestrator. `cost_update` still updates tokens after cancellation. After local cancel, terminal runner events and final telemetry are accepted while UI noise is ignored. Normal fan-out order is events → tasks → tokens → lifecycle → operations. Strictly synchronous. |
| `markCancellationRequested(intent?)` | Local UI intent for immediate feedback. Terminalizes lifecycle and running operations with frozen duration, but does **not** append a fake event or rewrite `planner_status` to success. The canonical history event is still engine-published `workflow_cancelled`. |
| `resetWorkflow()` | Resets the workflow sub-stores (plus the stop, recovery-notice and streaming-output stores, and closes the approval and reviewer-checks prompts) **and invalidates the memo caches** (`cachedEvents`, `cachedSections`, through `clearSectionsCache()`) so subscribers observe a clean slate. It only clears: nothing is synthesized here. Cache invalidation is symmetric with sub-store reset — missing it leaks pre-reset sections into the first post-reset `useSections()` call. |
| `loadEvents(events)` (`load.ts`) | The hydration counterpart of `addEvent`: resets first, then folds a whole replayed log through the same reducers and commits each store once. |
| `hydrateFromState(state, { endedAt? })` (`hydrate.ts`) | Lays the saved state over whatever the replay rebuilt — the phase, the brief list, the spend and the queued count. It never claims a run read back from disk is running: an open run hydrates as `paused`, a finished one as `complete`, and the header clock freezes at the last event the log carries, without the parks the log records. |
| `getSections()` / `useSections()` | Memoized derivation of conversation sections from `eventsStore.events`. Cache lives file-local. |

**Reducers live with their owner sub-store** — `events.ts` exports `mergeEvent` + `MAX_EVENTS`, `tasks.ts` exports `updateTaskMap` + `updateTaskCounts`, `tokens.ts` exports `updateTokens`, `lifecycle.ts` exports `updatePhase` + `updateQueueDepth` + `updateStall`, and `operations/reducer.ts` exports `updateOperations`. They are pure functions and can be tested directly.

`lifecycle.ts` derives the queued count, `queueDepth`, from `queuedMessageIds`. `message_queued` adds its id. `message_injected_native` or `queue_drained` removes that id at its first delivery to any seat. A repeated delivery id changes nothing and cannot lower another message's count. `queue_cleared` removes cleared entries from the set. Older drain events without ids retain count-based replay compatibility.

`hydrateFromState(state)` restores ids through `isQueuedMessagePendingFirstDelivery`. It includes messages during native injection until confirmation. It excludes messages with an implementer, reviewer, native, or mid-call delivery record. A message that REVIEW read remains available to the next fix brief's BUILD call, but it no longer counts as queued. `/queue clear` preserves it as history. See [Queued count](./ENGINE.md#queued-count).

The lifecycle store also holds `steerableCall: { seat: CrewSeatId; taskId?: string } | null`. `steerable_call` events set the receiving seat and brief, or clear the value when both fields are absent. Run start and hydration reset it to `null`; replay cannot imply that a stopped call accepts messages. This state changes the delivery copy, not the queued count.

`message_queued` and `queue_drained` carry optional `seat` and `taskId` fields. A delivery into the running call adds `via: 'mid-call'` to `queue_drained`. The UI uses these fields to name the receiving seat and brief. Older events without these fields still render. The queued count includes only messages awaiting first delivery to any seat.

The byline remains `1 queued for BUILD on T003` until the first delivery event removes that message id. A narrow byline uses `1 queued`. The UI sets `queueCopy`'s `steerable` input when `steerableCall.seat` matches the receiving seat. See [FEATURES.md](./FEATURES.md#input-footer) for the copy.

`message_queued.steerable` is an optional boolean. The event records whether the queue captured a matching steerable call. The transcript uses it for the pending row's delivery timing.

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

A small number of stores ship test-only exports so tests and visual fixtures can arrange starting states that no domain action produces. There are three kinds: a state reset, a raw setter, and a value pin.

| Symbol | Shape | Who may import |
|---|---|---|
| `__testReset(next?)` on a store facade | Replaces current state with `{ ...initial, ...next }` | `*.test.ts` / `*.test.tsx` files, and the visual-gallery fixtures under `testing/visual/fixtures/` (`screen-fixtures.ts` resets `terminalSizeStore` and `configStore`) |
| `_<name>Internal = { set }` (e.g. `_lifecycleInternal`, `_operationsInternal`, `_eventsInternal`, `_tasksInternal`, `_tokensInternal`) | Exposes the raw store setter | `src/stores/workflow/actions/` for the production write path; tests that need to reach a state the public actions cannot produce (e.g. `src/app/keys.test.tsx` forcing a mid-workflow phase) |
| `__testSetClaudeCodeModelOptions(options)` on `modelCacheStore` | A value pin, not a state reset: it stores an override that `getClaudeCodeModelOptions()` prefers over the real read | `*.test.ts` / `*.test.tsx` files, and `testing/visual/fixtures/screen-fixtures.ts`, which pins the Claude Code option cache so a capture does not read the developer's `~/.claude.json` |

**Rule.** Production code outside `workflow/actions/` MUST NOT import any of these symbols. Reviewers reject PRs that add new call sites in `src/` outside that one module. Tests and the visual-gallery fixtures are the only other sanctioned callers.

**Why they exist.** `lifecycleStore` (and the other workflow sub-stores) expose no public setter — `addEvent` is the engine-event ingress, and `markCancellationRequested` is the local-intent ingress. A test that needs to assert behaviour while the store is already at `phase: 'implementing'` cannot replay a full event stream to get there, so `__testReset` arranges the state directly. Similarly, `_lifecycleInternal.set` lets the dispatcher write one slice without exposing generic mutation publicly.

**Rejected alternative.** Adding a full `lifecycleStore.setPhase(...)` / generic `set()` action to the public facade. Rejected — it widens the public surface to solve a test-only problem, and makes it trivial for production code to bypass the dispatcher's invariants. The `__` / `_Internal` prefix is the signal that the symbol is off-limits outside tests and the dispatcher.

## Engine Write Pattern

Since the 2026-04-20 release the engine no longer writes workflow stores directly or imports `workflow/actions.addEvent`. Events are published on the `EventBus` (`wctx.bus.publish(event)`); the TUI sink, `addTuiEvent` (`src/features/workflow/tui-sink.ts`), is subscribed at workflow init and forwards each bounded `EngineEvent` to `workflow/actions.addEvent`. This keeps the intended **engine → bus → sink → store → UI** direction and preserves the layer rule (engine has zero React, UI, or store imports):

- Engine code publishes events; sinks write to stores; UI components subscribe reactively and re-render only when their selected slice changes.
- Non-event cross-cutting writes (abort / queue handler registration) go through the `sinks` surface on the workflow context. The engine does not import stores to observe cancellation; it receives an `AbortSignal` from the caller.
- Engine modules live in `src/engine/` and have zero React/Ink/store imports. They publish `EngineEvent` values and return data.

The distinction is one-directional: engine code publishes to the bus; sinks write to stores; React components read from stores. Nothing in `src/engine/` calls `store.use()`, `store.get()`, or store actions.
