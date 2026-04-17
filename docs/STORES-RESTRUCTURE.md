# Stores Restructure — Architecture RFC

> **Status**: All phases executed (2026-04-17). Phase 1 + 1.5 + 2 + 3 complete.
> **Scope**: `src/stores/`, colocated tests, every `src/` import path that resolves into `src/stores/`
> **Companion doc**: [`docs/STORES.md`](./STORES.md) (current architecture — will be updated after execution)

## 1. Why

Current `src/stores/` is **flat with 17 domain stores + 3 infrastructure files**. Audit (2026-04-17) surfaced concrete friction:

1. **Trivial stores polluting the directory.** `workflow-sidebar.ts` (3 LOC, 1 boolean, 1 consumer), `input-mode.ts` (3 LOC, used only through a wrapper hook). Single-boolean state shared with nobody does not need a store.
2. **`createBooleanStore` abstraction over-applied.** Three consumers. Only one (`abort.ts`) justifies the abstraction via a debounce timer. The other two are 3 LOC of wrapper over 3 LOC of state — the factory is pure ceremony.
3. **Implementation-detail tests** on ~7 stores (~650 LOC) that assert "setter sets, getter gets" — tautologies guaranteed by React's `useSyncExternalStore` and our own `create-store.ts` (which *is* tested). They violate [`test-behavior-not-implementation`](../CLAUDE.md): they do not describe a domain rule a user would notice.
4. **No domain narrative in the directory.** 17 files side-by-side make it impossible to answer "what stores does the workflow screen depend on?" without grep. Natural clusters exist in consumption patterns but are invisible in structure.

**Non-goals:** rewriting `create-store.ts`, changing store semantics, touching engine code, migrating off `useSyncExternalStore`, or introducing a third-party state library. The factory + selector pattern documented in `docs/STORES.md` stays.

## 2. Invariants (must hold before, during, and after)

These come from `CLAUDE.md` ("State Management (External Stores)") and are non-negotiable:

- **Zero** `useMemo`, `useCallback`, `React.memo`, `forwardRef`, `useImperativeHandle` in `src/`.
- **Zero** React Context (`ThemeContext` is the only sanctioned exception and is unaffected).
- Stores remain **module-scoped singletons** — reachable from both React components and engine code via `store.get()`.
- Engine code (`src/engine/`) keeps **zero** React/Ink imports.
- `store.set()` / `store.load()` are **never called during React render** — initialization stays in `src/cli/init-stores.ts`.
- `configStore.useConfig()` remains the guard-backed accessor; non-React code keeps using `configStore.get()`.
- `useStores(...)` multi-store hook stays; its Proxy tracking contract is unchanged.
- `npm run typecheck`, `npm run lint`, and `npm test` must be green after **every** commit in this restructure (not just at the end).

## 3. Current state (facts, not opinions)

Audit summary — full table lives in the implementation brief handed to agents.

| Bucket | Count | Files |
|---|---:|---|
| Infrastructure | 3 | `create-store.ts`, `use-stores.ts`, `workflow-reducers.ts` |
| TRIVIAL (≤10 LOC, single primitive) | 4 | `input-mode.ts`, `workflow-sidebar.ts`, `input-height.ts`*, `abort.ts`* |
| THIN (10–50 LOC, CRUD) | 7 | `detection.ts`, `feedback.ts`, `input-history.ts`, `review.ts`, `sessions.ts`, `skills.ts`, `terminal-size.ts` |
| SUBSTANTIAL (>50 LOC) | 6 | `config.ts`, `conversation-scroll.ts`, `model-cache.ts`, `overlay.ts`, `router.ts`, `workflow.ts` |

\* `input-height.ts` and `abort.ts` have real cross-component/timer logic despite low LOC — they are architecturally justified.

**Cross-store writes in production code (clean, one-way):**
- `workflow.reset()` → `abort.clear()` (timer cleanup on workflow reset)
- `router.navigate()` → `feedback.setError()` (invalid transition guard)

No cycles. No other production cross-dependencies.

## 4. Decisions

### 4.1 Phase 1 — Eliminate garbage

Execute in this order so each step leaves `main` green.

| # | Target | Action | Rationale |
|---|---|---|---|
| 1 | `src/stores/workflow-sidebar.ts` + test | **DELETE** | 1 consumer (`workflow.tsx`), no cross-component sync, no domain logic. Replace with `useState<boolean>` local to `workflow.tsx` + `sidebar` prop to `<Sidebar>` (or existing equivalent). |
| 2 | `src/stores/input-mode.ts` + test | **DELETE store**, keep `useInputMode` hook | Only consumed via `src/hooks/use-input-mode.ts`, which already owns the Promise-based lifecycle. If (and only if) the hook proves to rely on module-scoped singleton semantics (two separate mount sites observing the same flag — see §7), keep the store and drop only the test. Hook review is a precondition, not a formality. |
| 3 | `src/stores/create-store.ts` — `createBooleanStore` export | **DELETE** after #1 + #2 | Remaining consumer (`abort.ts`) gets rewritten to use the generic `createStore` directly (still ~25 LOC, no regression). One-off custom shape is cheaper than a shared factory for one site. |
| 4 | `src/stores/input-height.test.ts` | **DELETE** | Impl-only (tests `set` / `setRows` / `reset`). Store itself stays — verified consumers span `workflow.tsx`, `input-bar/index.tsx`, and `conversation-layout-snapshot.ts` (cross-tree). Behavioral coverage happens through integration at the layout level. |
| 5 | `src/stores/sessions.test.ts` | **DELETE** | Impl-only (`load` / `loadAll` / `reset`). Store kept (3 consumers). Real loading behavior is exercised through `home.tsx` flows. |
| 6 | `src/stores/skills.test.ts` | **DELETE** | Impl-only (`discover` / `setSelected` / `reset`). Store kept (overlay + setup consumers). |
| 7 | `src/stores/detection.test.ts` | **DELETE after case-by-case read** | Audit classified as impl-only, but the file is 165 LOC. The implementing agent MUST read the file first. Default action: delete the whole file. Exception: if any `it()` block asserts a domain rule (e.g., "planner and implementer fields are consistent after `setDetection`"), rewrite that case as an integration test under the feature that relies on the rule (most likely `src/screens/setup.test.tsx`) before deleting. No orphaned assertions. |
| 8 | `src/stores/review.test.ts` | **DELETE** | Impl-only (setter mechanics). Real review UX covered by `review-view.tsx` integration. |
| 9 | `src/stores/feedback.test.ts` | **TRIM** | Keep: auto-clear timer test, message-vs-error distinction. Remove: raw setter-mirrors-getter assertions. |
| 10 | `src/stores/terminal-size.test.ts` | **TRIM** | Keep: resize subscription lifecycle. Remove: `cols`/`rows` getter tests. |
| 11 | `src/stores/input-history.test.ts` | **TRIM** | Keep: dedup, max-size trim, disk I/O. Remove: raw push/load round-trips. |

**Expected delta:**
- Stores: 17 → **15** domain stores (−`input-mode`, −`workflow-sidebar`).
- Infra factory surface: `createBooleanStore` removed.
- Test LOC: roughly −650 LOC in impl-only tests + further −~150 LOC from TRIM (#9–#11). Net reduction ≈ **800 LOC of tests** with **no loss of behavioral coverage**.

### 4.1.5 Phase 1.5 — Consolidate cross-tree booleans into `controls` store

**Why this phase exists.** Phase 1 execution surfaced that `workflow-sidebar.ts` and `input-mode.ts` cannot be deleted — each has 3+ cross-tree consumers reading via `.get()` from non-React code (`use-global-keys.ts`, `conversation-layout-snapshot.ts`). Deleting them would require invasive prop-drilling into key dispatch. Instead of accepting two 3-LOC boolean stores wrapping `createBooleanStore`, we consolidate them into one substantive store — `controls.ts` — that holds the cross-tree interaction flags the Ink layer needs globally.

**What "controls" means here.** A `controlsStore` is the established term for "active UI controls and modes" (media controls, accessibility controls, game controls). It holds flags that:
1. Are **globally observed** from non-React hooks (key dispatch, layout measurement).
2. Describe **interaction mode**, not domain data.
3. Are **immutable-shallow** (primitives or short unions; no objects).

**Shape (flat, per §4.1.5.1 rationale):**
```ts
export type InputMode = 'normal' | 'review' | 'question';

export interface ControlsState {
  sidebarVisible: boolean;
  inputMode: InputMode;
}
```

**Public API:**
```ts
controlsStore.use((s) => s.sidebarVisible)       // React subscription
controlsStore.get().inputMode                     // Non-React read (hooks, key dispatch)
controlsStore.toggleSidebar()                     // Domain action
controlsStore.setSidebar(visible: boolean)        // Domain action
controlsStore.setInputMode(mode: InputMode)       // Domain action
controlsStore.clearInputMode()                    // → 'normal'
```

No direct `.set()` export. All mutations go through domain actions — the store encapsulates the shape invariants.

#### 4.1.5.1 Flat vs nested — design decision

Considered: `{ sidebar: { visibility }, input: { mode } }`. Rejected because:
1. **Every other store in `src/stores/` is flat.** Only external-schema payloads (e.g., `config.config`) are nested. Consistency with the codebase matters more than theoretical extensibility.
2. **Each sub-object would have exactly one field.** Nesting a single-field object is pure ceremony — adds two `...spread` layers per update, doubles the surface for bugs, and gives no namespacing benefit.
3. **`useStores` Proxy tracking becomes coarser.** A consumer reading `sidebar.visibility` would re-render on any `sidebar.*` change, not just `visibility`. Flat per-key tracking is finer-grained.
4. **YAGNI.** If `sidebar` later gains `width` + `pinned` + `collapsed` (3+ fields), refactoring flat → nested takes ~10 minutes. The reverse refactor is pointless.

Revisit nesting when any single concept grows to 2+ fields.

#### 4.1.5.2 Action list (execute after Phase 1 lands)

1. **Create `src/stores/controls.ts`** — flat shape above, domain actions above.
2. **Migrate `workflow-sidebar.ts` consumers**:
   - `src/screens/workflow.tsx` — replace `workflowSidebarStore.use(...)` with `controlsStore.use(s => s.sidebarVisible)`; replace toggles with `controlsStore.toggleSidebar()`.
   - `src/hooks/use-global-keys.ts` — replace `workflowSidebarStore.get()` with `controlsStore.get().sidebarVisible`.
   - `src/hooks/conversation-layout-snapshot.ts` — same.
   - `src/hooks/conversation-layout-snapshot.test.ts` — replace fixture setup `workflowSidebarStore.set(true)` with `controlsStore.setSidebar(true)`.
3. **Migrate `input-mode.ts` consumers**:
   - `src/hooks/use-input-mode.ts` — replace all `inputModeStore.set(...)` calls with `controlsStore.setInputMode(...)` / `controlsStore.clearInputMode()`. The hook's Promise-based lifecycle stays unchanged; only the backing store swaps.
   - `src/hooks/use-global-keys.ts` — replace `inputModeStore.get()` with `controlsStore.get().inputMode`.
4. **Delete** `src/stores/workflow-sidebar.ts` and `src/stores/input-mode.ts`.
5. **Remove `createBooleanStore` export from `src/stores/create-store.ts`.** After step 4, the only remaining consumer is `abort.ts` — rewrite it as follows:
   ```ts
   // src/stores/abort.ts
   import { createStore, storeBase } from './create-store.js';

   interface AbortState { pending: boolean; }
   const initial: AbortState = { pending: false };
   const store = createStore<AbortState>(initial);

   let pendingTimer: ReturnType<typeof setTimeout> | null = null;

   function markPending(): void {
     if (pendingTimer) clearTimeout(pendingTimer);
     store.set({ pending: true });
     pendingTimer = setTimeout(() => {
       store.set({ pending: false });
       pendingTimer = null;
     }, 2000);
   }

   function clear(): void {
     if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
     store.set({ pending: false });
   }

   export const abortStore = {
     ...storeBase(store),
     markPending,
     clear,
   };
   ```
   Exact timer duration and cleanup semantics must match current behavior — the agent MUST read current `abort.ts` first and preserve the observable contract byte-for-byte.
6. **Gates**: `npm run typecheck && npm run lint && npm test`.
7. **Greps (must return zero):**
   ```bash
   rg 'workflowSidebarStore|inputModeStore|createBooleanStore' src/
   ```

#### 4.1.5.3 Expected delta

- Stores: 17 → **16** (`controls` replaces `workflow-sidebar` + `input-mode`).
- Infra factory: `createBooleanStore` removed.
- New file: `src/stores/controls.ts` (~40 LOC with domain actions).
- Net code: roughly neutral (~6 LOC of old boolean stores × 2 gone, ~40 LOC of new store, plus consumer migrations are like-for-like renames).
- Domain narrative: restored — the directory now has one clear home for "interaction flags the Ink layer observes globally".

### 4.2 Phase 2 — Group into domain subdirectories (Option B1, **no barrels**)

Final structure — subdirectories for organization only, **zero `index.ts` barrels** anywhere in the stores subtree:

```
src/stores/
├── create-store.ts           # infrastructure — do not move
├── use-stores.ts             # infrastructure — do not move
├── ui/
│   ├── controls.ts           # created in Phase 1.5
│   ├── terminal-size.ts
│   ├── overlay.ts
│   ├── feedback.ts
│   ├── input-history.ts
│   └── input-height.ts
├── workflow/
│   ├── workflow.ts
│   ├── reducers.ts           # renamed from workflow-reducers.ts
│   ├── abort.ts
│   ├── conversation-scroll.ts
│   └── review.ts
├── navigation/
│   └── router.ts
├── project/
│   ├── config.ts
│   ├── sessions.ts
│   ├── skills.ts
│   └── detection.ts
└── discovery/
    └── model-cache.ts
```

**Why B1 over "three wide domains" (B2):** the audit's coupling-cluster analysis showed stores group along **five** lines of consumption, not three. B2 would concatenate `router` + `config` + `overlay` into one `app/` bucket solely because all three are initialized early, conflating concerns that evolve independently. B1 keeps `navigation/` (route state) separate from `project/` (loaded-from-disk state) from `ui/` (ephemeral screen chrome).

**Grouping rules applied:**
- `ui/` — ephemeral screen chrome, not tied to a specific screen.
- `workflow/` — anything that exists only while a workflow is running, *including* the scroll and review panels that only matter inside the workflow screen.
- `navigation/` — screen routing. `router.ts` is alone; `overlay.ts` deliberately lives in `ui/` because overlays are UI chrome that apply to multiple screens, not a route.
- `project/` — loaded-from-disk state tied to the project root (`config.projectDir`).
- `discovery/` — external-world reads cached with TTL.

**No barrels.** Consumers import directly from the store file: `from '../stores/workflow/workflow.js'`. Rationale and project-wide policy live in [`docs/NO-BARRELS.md`](./NO-BARRELS.md). The short version: this is a non-bundled Node ESM runtime; a barrel forces every consumer (and every Vitest worker) to evaluate every re-exported module. Subdirectories give us the domain narrative we want without the runtime cost.

### 4.3 Import migration

Every consumer import of a store moves from its current flat path to the new subdirectory path. No barrels, no wildcards — each import names its file.

Pattern:

```ts
// Before
import { workflowStore } from '../stores/workflow.js';
import { configStore } from '../stores/config.js';

// After
import { workflowStore } from '../stores/workflow/workflow.js';
import { configStore } from '../stores/project/config.js';
```

Agent must grep for `from '.*stores/<storeName>\\.js'` for each of the 16 stores and rewrite every hit to its new location. Keep `.js` extensions per project convention. Absolute paths are not used in this codebase.

If an import source uses `type` imports (`import type { ... }`), preserve that qualifier through the rewrite.

## 5. Execution — who does what

**Main context (Claude-Opus):** owns this RFC, answers design questions, reviews agent output, never touches source files.

**Implementation agents (one per phase):** receive a self-contained brief containing:
- this RFC path
- phase scope (Phase 1 OR Phase 2 — never both in one agent run)
- invariants from §2
- exact file list with action per file
- success criteria (§6)
- instruction: **no commits, no staging** (enforced by `.claude/hooks/block-git-commits.sh`)

**Execution order:**
1. Phase 1 agent — runs deletions + trims. Runs `npm run typecheck && npm run lint && npm test` at the end. Reports back.
2. Main context verifies report, reads diff, approves or requests changes.
3. Phase 1.5 agent — creates `controls.ts`, migrates consumers, removes `createBooleanStore`, rewrites `abort.ts`. Runs the same gates. Reports back.
4. Main context verifies.
5. Phase 2 agent — runs structural move + import rewrite + barrel creation. Runs the same gates. Reports back.
6. Main context verifies, updates `docs/STORES.md` to reflect new structure, marks this RFC as **Executed**.

## 6. Success criteria (per phase, binary)

**Phase 1 done when:**
- [ ] `src/stores/workflow-sidebar.ts`, `input-mode.ts` deleted; their `.test.ts` siblings deleted.
- [ ] `createBooleanStore` export removed from `create-store.ts`; `abort.ts` rewritten without it.
- [ ] `input-height.test.ts`, `sessions.test.ts`, `skills.test.ts`, `detection.test.ts`, `review.test.ts` deleted (with §4.1 #7 exception handled).
- [ ] `feedback.test.ts`, `terminal-size.test.ts`, `input-history.test.ts` trimmed to behavioral cases only.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` all green.
- [ ] Diff shows zero changes in `src/engine/**`.
- [ ] Grep for `createBooleanStore` returns zero hits.

**Phase 2 done when:**
- [ ] Directory layout matches §4.2 exactly.
- [ ] **Zero `index.ts` files inside `src/stores/`** (verify: `find src/stores -name 'index.ts' -o -name 'index.tsx'` returns empty).
- [ ] Every import in `src/` that previously resolved into `src/stores/*.js` now resolves into `src/stores/<group>/<store>.js`.
- [ ] No import in `src/` points at a path that no longer exists.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` all green.
- [ ] `docs/STORES.md` updated to describe the new directory layout (handled by main context, not the agent).

## 7. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Deleting `input-mode.ts` store breaks `useInputMode` if the hook actually relied on module-scoped singleton semantics (two instances seeing the same flag). | Medium | Agent MUST read `src/hooks/use-input-mode.ts` in full before deleting the store. If the hook relies on singleton state across consumers, keep the store and only drop the test. |
| `detection.test.ts` contains a domain rule we lose. | Low | §4.1 #7 explicitly requires reading the file and retaining any domain-rule case. |
| Barrel re-exports in `src/stores/index.ts` create circular imports once domain barrels exist. | Low | Use direct file exports in domain barrels; only the top-level barrel re-exports from subdirectory barrels. No subdirectory imports the top-level barrel. |
| Path churn causes an import to resolve to a stale compiled artifact. | Low | `tsc --noEmit` runs in every gate. `dist/` is git-ignored and rebuilt on `npm run build`. |
| An agent partially completes Phase 2, leaves broken imports on the working tree. | Medium | Agent instruction: "If any gate fails, revert all moves in this run via `git restore` of files it created or modified. Do not leave half-migrated state." |

## 4.3 Phase 3 — Split `workflowStore` into 4 domain sub-stores

**Status:** Proposed (2026-04-17). Follows Phase 2 completion.

### 4.3.1 Why

Post-Phase-2, `src/stores/workflow/workflow.ts` remains a 98-LOC god-store with 11 fields, 5 public actions, and 15 consumers. Audit (see §9 audit record) surfaced four natural domains inside the state:

- **EVENTS** — `events` (event log, append-only, 10k-cap)
- **TASKS** — `currentTask`, `totalTasks`, `taskCompletionTimes`, `taskMap`, `tasks`
- **TOKENS** — `localCount`, `escalatedCount`, `tokenUsage`
- **LIFECYCLE** — `phase`, `cancelled`, `queueDepth`

Single monolithic store forces every subscriber's selector to re-run on every event. `sidebar.tsx` (needs only `tasks`) re-evaluates its selector on every `planner-text` chunk, `cost-update`, `queue-*` event. Splitting into 4 sub-stores moves the re-render cost to where it matters: sidebar only wakes when tasks change.

A secondary win is test isolation — bugs in task counting fail `tasks.test.ts` instead of a 222-LOC monolith.

### 4.3.2 Decisions

**Naming.** No `workflow` prefix on the store names (contrary to first proposal). Since they live in `src/stores/workflow/` subdirectory, the path already disambiguates. Short names: `eventsStore`, `tasksStore`, `tokensStore`, `lifecycleStore`.

**No composite wrapper.** Evaluated a `workflowStore` composite object holding sub-stores as properties — rejected because no other part of `src/stores/` uses that pattern, and it would introduce inconsistency for marginal ergonomic gain. Sub-stores stand alone as first-class singletons, same style as `configStore`, `sessionsStore`, etc.

**Actions module.** Composite operations (`addEvent`, `markCancelled`, `resetWorkflow`, `useSections`, `getSections`) live in `src/stores/workflow/actions.ts`. This is not a store — it's a namespace module of functions that orchestrate writes across sub-stores. Called by engine (`addEvent` via `use-workflow-runner.ts`) and UI (`markCancelled`, `resetWorkflow`, `useSections`).

**Cancelled gate.** Lives in `actions.addEvent()`. Reads `lifecycleStore.get().cancelled` synchronously before dispatching. Sub-stores are not responsible for the gate — a direct write to `eventsStore.set(...)` bypasses it. This is documented as a contract: "writes go through `actions.ts`; direct sub-store writes are for tests only."

**Atomicity.** `addEvent` makes 4 sequential `.set()` calls. React 19 + Ink batch synchronous store updates in the same microtask, so the UI observes one commit with all 4 stores already updated. **The dispatcher must be strictly synchronous** — no `await`, no `setTimeout`, no `Promise.resolve().then`. Invariant documented here and enforced by code review.

**Reducer co-location.** Each sub-store file contains its own pure reducer(s). No shared `reducers.ts`. `events.ts` has `mergeEvent` + `MAX_EVENTS`, `tasks.ts` has `updateTaskMap` + `updateTaskCounts`, etc. Reducers stay pure functions, exported for testing.

**Engine coupling unchanged.** `use-workflow-runner.ts` imports `addEvent` and `resetWorkflow` from `actions.ts` instead of `workflowStore`. Callback wire-up identical. Zero other engine files touched.

### 4.3.3 Final structure

```
src/stores/workflow/
├── events.ts                ← eventsStore + mergeEvent + MAX_EVENTS
├── tasks.ts                 ← tasksStore + updateTaskMap + updateTaskCounts
├── tokens.ts                ← tokensStore + updateTokens
├── lifecycle.ts             ← lifecycleStore + updatePhase + updateQueueDepth
├── actions.ts               ← addEvent, markCancelled, resetWorkflow, useSections, getSections
├── abort.ts                 (unchanged)
├── review.ts                (unchanged)
├── conversation-scroll.ts   (unchanged)
└── <each has colocated *.test.ts>
```

**Deleted:** `workflow.ts`, `reducers.ts`, `workflow.test.ts`, `reducers.test.ts`.

### 4.3.4 Action list for executor agent

Order matters — each step must leave the tree in a buildable state. If a gate fails mid-run, fix before proceeding.

1. **Create `src/stores/workflow/events.ts`**:
   - `interface EventsState { events: TuiEvent[] }`
   - `eventsStore` from `createStore<EventsState>({ events: [] })` + `storeBase`
   - Export `MAX_EVENTS = 10_000` and `mergeEvent(events, event)` — copy verbatim from current `reducers.ts`.

2. **Create `src/stores/workflow/tasks.ts`**:
   - `interface TasksState { currentTask, totalTasks, taskCompletionTimes, taskMap, tasks }`
   - `tasksStore` with appropriate `INITIAL_TASKS_STATE`
   - Export `updateTaskMap(taskMap, event)` — copy verbatim from current `reducers.ts`.
   - Export `updateTaskCounts(state, event)` — split from current `updateCounts`, returning only task-related fields (`currentTask`, `totalTasks`, `taskCompletionTimes`). Drop the `phase` part — that moves to `lifecycle.ts`.

3. **Create `src/stores/workflow/tokens.ts`**:
   - `interface TokensState { localCount, escalatedCount, tokenUsage }`
   - `tokensStore`
   - Export `updateTokens(state, event)` — handles `task-complete` (increments local/escalated counts based on `method`) and `cost-update` (replaces `tokenUsage`). Returns identity if event irrelevant.

4. **Create `src/stores/workflow/lifecycle.ts`**:
   - `interface LifecycleState { phase, cancelled, queueDepth }`
   - `lifecycleStore` initial state `{ phase: 'idle', cancelled: false, queueDepth: 0 }`
   - Export `updatePhase(state, event)` — handles `planner-status` event's phase field.
   - Export `updateQueueDepth(state, event)` — handles `message-queued` (++), `queue-drained` (=0), `queue-cleared` (-= count).

5. **Create `src/stores/workflow/actions.ts`**:
   - Import all 4 sub-stores + their reducers.
   - Import `abortStore` from `./abort.js`.
   - `addEvent(event)`:
     - Short-circuit if `lifecycleStore.get().cancelled`.
     - Fast path for `cost-update`: only `tokensStore.set({ ...s, tokenUsage })`, return.
     - Else fan out: events → tasks → tokens → lifecycle (ordering invariant documented in comment).
     - Each sub-store's reducer returns identity when event is irrelevant → `Object.is` check in `createStore` makes it a no-op notify.
   - `markCancelled()` — preserves current behavior byte-for-byte:
     - Return `false` if already cancelled.
     - Rewrite running `planner-status` events to `done` in `eventsStore`.
     - Append `workflow-cancelled` event.
     - Set `lifecycleStore.cancelled = true`.
     - Return `true`.
   - `resetWorkflow(resume?)`:
     - Call `abortStore.clear()` first (preserves current contract).
     - `eventsStore.reset()`, `tasksStore.reset()`, `tokensStore.reset()`, `lifecycleStore.reset()`.
     - If `resume` provided, apply `phase`, `currentTask`, `totalTasks` to appropriate stores.
   - `getSections()` + `useSections()` — file-local memo cache (`cachedEvents`, `cachedSections` module-scoped), identical semantics to current implementation.

6. **Split tests** from `workflow.test.ts` (27 tests) + `reducers.test.ts` (15 tests) into:
   - `events.test.ts` — event-append, merge, MAX_EVENTS, planner-text coalescing.
   - `tasks.test.ts` — task-start/complete/skipped, taskMap, counts, tasks array.
   - `tokens.test.ts` — cost-update, local/escalated counters.
   - `lifecycle.test.ts` — phase transitions, queueDepth, cancelled flag gate (stored, gate itself tested in actions.test.ts).
   - `actions.test.ts` — cancelled gate blocks cross-store writes, fan-out order, `markCancelled` writes events + lifecycle, `resetWorkflow` calls `abortStore.clear`, sections memo invalidation.

   Agent **MUST** read each existing `it()` block and classify it before moving. Impl-only tests ("setter sets, getter gets") are DELETED, not migrated. Behavioral tests are preserved in the appropriate new file.

7. **Migrate consumers** — grep every reference to `workflowStore` in `src/` and `testing/`, rewrite per these patterns:
   - `workflowStore.use(s => s.<FIELD>)` → use appropriate sub-store based on FIELD's bucket
   - `workflowStore.get().<FIELD>` → `<subStore>.get().<FIELD>`
   - `useStores(workflowStore)` with multi-bucket destructure → split into `useStores(storeA, storeB, ...)` matching accessed buckets
   - `workflowStore.addEvent(e)` → `import { addEvent } from '../stores/workflow/actions.js'; addEvent(e)`
   - `workflowStore.markCancelled()` → `import { markCancelled } from '../stores/workflow/actions.js'; markCancelled()`
   - `workflowStore.reset(state)` → `import { resetWorkflow } from '../stores/workflow/actions.js'; resetWorkflow(state)`
   - `workflowStore.useSections()` / `.getSections()` → imports from `actions.js`
   - `workflowStore.set(...)` (used in test helpers) → direct sub-store writes (tests only)
   - `type WorkflowViewState` references → if any consumer imports the type, expose it from `actions.ts` as a computed type `EventsState & TasksState & TokensState & LifecycleState` for backward compat.

8. **Delete** `src/stores/workflow/workflow.ts`, `reducers.ts`, `workflow.test.ts`, `reducers.test.ts`.

9. **Gates**: `npm run typecheck && npm run lint && npm test`. Fix any regressions.

10. **Post-flight greps** (all must return zero in `src/` and `testing/`):
    ```bash
    rg "workflowStore\." src/ testing/
    rg "from ['\"].*/stores/workflow/workflow\\.js['\"]" src/ testing/
    rg "from ['\"].*/stores/workflow/reducers\\.js['\"]" src/ testing/
    ```

### 4.3.5 Success criteria

- [ ] 5 new files (`events.ts`, `tasks.ts`, `tokens.ts`, `lifecycle.ts`, `actions.ts`) created with described exports.
- [ ] 4 new test files + 1 actions test file replace old 2 test files.
- [ ] Old `workflow.ts` + `reducers.ts` (and their test files) deleted.
- [ ] Every consumer migrated; greps above return zero.
- [ ] `npm run typecheck && npm run lint && npm test` — all green.
- [ ] `abortStore.clear()` still called on workflow reset (verify in `actions.test.ts`).
- [ ] Cancelled gate still blocks new events after `markCancelled()` (verify in `actions.test.ts`).
- [ ] Engine coupling unchanged: `src/engine/` diff is empty.
- [ ] `docs/STORES.md` updated — main context does this after executor finishes.

### 4.3.6 Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Atomicity breaks under Ink's render scheduler (intermediate state visible) | Low | Dispatcher strictly synchronous. Invariant documented. Actions.test.ts asserts that a subscriber to 2 stores observes consistent state after `addEvent`. |
| A consumer bypasses the gate by calling `eventsStore.set(...)` directly | Low | No consumer does this today; `set` is not re-exported from sub-stores (only `storeBase.set` accessible via pattern — but direct writes to event append are not idiomatic). Document in STORES.md: "write via `actions.ts`, not sub-stores". |
| Test migration drops a behavioral case | Medium | Agent MUST read every `it()` and classify before moving. Report lists kept vs deleted vs migrated with per-test rationale. Main context spot-checks report. |
| Consumer destructure pattern across multiple buckets is awkward after split | Low | `useStores(a, b, c)` handles multi-store reads cleanly — same pattern already used elsewhere in the codebase. |
| `WorkflowViewState` type referenced by consumers breaks | Low | Expose as computed intersection type from `actions.ts` or from a type-only file. Agent reports occurrences and picks the lowest-churn fix. |

### 4.3.7 What stays out of scope

- **`input-history.ts` disk I/O boundary** — still deferred.
- **`model-cache.ts` TTL policy** — still deferred.
- **Unbarreling `src/engine/`** — separate future RFC per `NO-BARRELS.md`.

## 8. Non-decisions (deferred)

These surfaced during this RFC but are out of scope:

- **`input-history.ts` disk persistence boundary** — the store mixes in-memory state with file I/O. Worth revisiting once the restructure lands, but not blocking.
- **`model-cache.ts` TTL policy** — 5-minute TTL means most reads miss. Could become lazy. Defer.
- **Deep-module deepening of `workflow/`** — `workflow.ts` is 109 LOC and has 15 consumers. It is a genuine god-store. After Phase 2 lands, we can revisit splitting it into `events`, `tasks`, `tokens` sub-stores. **Not** part of this restructure.
- **Unbarreling the rest of the codebase** — `src/engine/`, `src/core/{config,providers,slash-commands}/`, `src/components/summary/` still contain barrel `index.ts` files. Removing them is governed by the principle in [`docs/NO-BARRELS.md`](./NO-BARRELS.md) and will be executed in future RFCs. Stores go first because they were the target of this restructure and because their singleton-init cost makes the runtime benefit largest.

## 9. Changelog

- **2026-04-17** — Initial draft. Phase 1 + Phase 2 decisions fixed. Pending user approval before agent dispatch.
- **2026-04-17** — Phase 1 executed. Deviations recorded: `workflow-sidebar` and `input-mode` kept because audit undercounted their cross-tree consumers. `createBooleanStore` retained for now.
- **2026-04-17** — Phase 1.5 added (§4.1.5): consolidate `workflow-sidebar` + `input-mode` into single `controls` store with flat shape `{ sidebarVisible, inputMode }`. `createBooleanStore` removed. `abort.ts` rewritten without factory.
- **2026-04-17** — Phase 1.5 executed. Gates green, greps zero.
- **2026-04-17** — Phase 2 structure changed: **zero barrels**. Subdirectories only for organization. Principle and broader rollout plan documented in new `docs/NO-BARRELS.md`.
- **2026-04-17** — Phase 2 executed. 27 store/test files moved into 5 subdirectories. 63 consumer files rewrote imports. Zero barrels inside `src/stores/`. `workflow-reducers.ts` renamed to `workflow/reducers.ts`. Gates green, 1737/1737 tests pass. `docs/STORES.md` updated.
- **2026-04-17** — Phase 3 added (§4.3): split `workflowStore` into 4 domain sub-stores (`eventsStore`, `tasksStore`, `tokensStore`, `lifecycleStore`) + `actions.ts` composite operations module. No composite wrapper — sub-stores stand alone as first-class singletons. Pending execution.
- **2026-04-17** — Phase 3 executed. 5 new files + 5 test files created; old `workflow.ts` + `reducers.ts` (and their tests) deleted. 18 consumer files migrated. 12 redundant reducer-level tests merged with their store-level counterparts. Gates green, 1735/1735 tests pass. All greps zero. Invariants preserved: `abortStore.clear()` in `resetWorkflow`, cancelled gate in `actions.addEvent`, engine untouched.
