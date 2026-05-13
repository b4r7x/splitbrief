# diptych — Extending

How to add things. Each section is a recipe: what you're adding, what files to touch, in what order. Read [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) for the system flow and [ENGINE.md](./ENGINE.md) for the EventBus before writing engine code.

---

## 1. New CLI subcommand

1. Create `src/cli/commands/<name>.ts`
2. Export a `register<Name>Command(program: Command)` function
3. Inside the handler, follow the pattern: parse flags, `resolveProjectDir()`, load config, optionally `initStores()`, optionally `renderApp()` or run headless
4. In `src/cli.ts`: import and call `register<Name>Command(program)`
5. Document in `docs/CLI-REFERENCE.md`

Existing example to follow: `src/cli/commands/start.ts`.

---

## 2. New slash command

1. Open `src/core/runtime/commands/registry.ts`
2. Add a new entry to the array returned by `createRuntimeCommands(ctx)`
3. Each entry needs:
   - `kind` — `'noarg'` or `'arg'`
   - `name` — the `/command` string
   - `handler` — sync or async function
   - `validScreens` — array of screens where the command is available (use `ALL_SCREENS` from `src/core/navigation/types.ts` for global)
   - Optional: `label` (for command palette), `shortcut`, `description`, `aliases`
4. Phase guards: add a `phaseGuard` function if the command should only run in certain phases (see `canReviseSpec` / `canRevisePlan` in the same file)
5. Document in `docs/SLASH-COMMANDS-REFERENCE.md`

---

## 3. New EngineEvent type

1. Add a variant to the `EngineEvent` discriminated union in `src/engine/events/types.ts`
   - Every variant needs: `type` (snake_case string literal) and `ts: number`
   - Add `phase: Phase` unless the event is intentionally global or snapshot-resolution metadata; current phase-less events are `snapshot_restored`, `snapshot_restore_conflict`, and `approval_mode_changed`
2. Add a typed publish helper in `src/engine/orchestrator/events.ts`
   - Pattern: `export function publishMyEvent(bus: EventBus, phase: Phase, payload): void { bus.publish({ type: 'my_event', ts: Date.now(), phase, ...payload }); }`
3. If the event should update UI state: handle it in `src/stores/workflow/actions.ts` inside `addEvent()`
   - The ordering invariant is: events store, then tasks store, then tokens store, then lifecycle store (all synchronous)
4. If the event needs a visual card: add a case in `src/features/workflow/components/event-cards/event-card.tsx`

---

## 4. New store

1. Create `src/stores/<group>/<name>.ts`
2. Define the state type and initial value
3. Create the store:
   ```ts
   import { createStore, storeBase } from '../create-store.js';

   const store = createStore<MyState>(initialState);
   export const myStore = storeBase(store);
   ```
4. `storeBase()` gives consumers: `use`, `get`, `subscribe`, `reset`
5. Export write access only for specific dispatchers:
   ```ts
   export const _myInternal = { set: store.set };
   ```
6. If the store reads disk on startup: add the init call in `src/cli/init-stores.ts`
7. Tests: call `myStore.reset()` in `beforeEach`

Factory: `src/stores/create-store.ts` (~45 LOC).

---

## 5. New planner/implementer backend

1. Add the kind name to the `RUNNER_KINDS` array and `RunnerKindSchema` in `src/core/schemas/enums.ts`
2. Create `src/engine/planners/<name>.ts` implementing the `Planner` interface from `src/engine/planners/types.ts`
   - Use `createPlannerBase()` from `src/engine/planners/base.ts` if it fits
3. Create `src/engine/implementers/<name>.ts` implementing the `Implementer` interface from `src/engine/implementers/types.ts`
   - Use `createImplementerBase()` from `src/engine/implementers/base.ts` if it fits
4. Add config schema variants:
   - `src/core/schemas/planner-config.ts` — planner-side config discriminated union
   - `src/core/schemas/implementer-config.ts` — implementer-side config discriminated union
5. Add factory cases in `src/engine/runners/factory.ts`:
   - Add a lazy loader: `const loadMyPlanner = lazy(() => import('../planners/<name>.js'));`
   - Add the `case '<kind>':` branch in both `loadPlanner()` and `loadImplementer()`
6. Declare a `capabilities` struct — the orchestrator reads capability flags, never backend identity
7. Write colocated tests: `src/engine/planners/<name>.test.ts`, `src/engine/implementers/<name>.test.ts`

---

## 6. New workflow phase

1. Add the phase string to the `PHASES` array and `PhaseSchema` in `src/core/schemas/enums.ts`
2. Add transitions in `src/core/state/machine.ts` — the state reducer
   - Add the phase to `phaseActions` (allowed state-action combinations)
   - Add transition logic in the reducer function
3. Update phase taxonomy in `src/core/phases.ts`:
   - Add to the correct sets: `CANCELLABLE_PHASES`, `RESUMABLE_PHASES`, `IMPLEMENTER_PHASES` / `PLANNER_COST_PHASES` / `IMPLEMENTER_COST_PHASES`
   - Update `phaseRole()` if needed
4. Add orchestrator logic — typically a new file under `src/engine/orchestrator/planning/` or `src/engine/orchestrator/task/`
5. If the phase has a visual: update `WorkflowScreen` components in `src/features/workflow/`

---

## 7. New UI feature (screen / overlay / picker)

### Screen

1. Create `src/features/<name>/screen.tsx`
2. Add the screen name to the `Screen` type in `src/core/navigation/types.ts`
3. Wire into `renderScreen()` in `src/app.tsx`

### Overlay

1. Create `src/features/<name>/overlay.tsx` (or `picker.tsx`)
2. Add the overlay name to the `OverlayType` union in `src/core/navigation/types.ts`
3. Wire into `renderOverlay()` in `src/app.tsx`

### Both

- Feature-local components: `src/features/<name>/components/`
- Feature-local hooks: `src/features/<name>/hooks/`
- Features never import from other features. Shared code goes to `src/components/`, `src/hooks/`, `src/utils/`

---

## 8. New provider (for api runner kind)

1. Create `src/engine/providers/<name>.ts`
   - Export a factory function: `createMyProvider(overrides?: ProviderOverrides): ProviderDef`
2. Register in `src/engine/providers/registry.ts`
   - If bespoke: add to the `BESPOKE_PROVIDERS` map
   - If OpenAI-compatible: add an entry in `src/core/providers/catalog.ts` with `baseURL` and `apiKeyEnv` — the `buildOpenAICompatFactories()` loop picks it up automatically
3. Add bundled model pricing in `src/core/providers/known-models.ts` when a fallback is needed. Runtime/model catalog pricing is resolved through `src/engine/providers/models-dev.ts`, `src/engine/providers/model/`, and `src/engine/providers/pricing-resolver.ts`.

---

## 9. New event card renderer

1. Open `src/features/workflow/components/event-cards/event-card.tsx`
2. The `EventCard` component is a switch on `event.type`. Two switches exist:
   - `getGutterRole()` returns `'planner'`, `'implementer'`, or `null` for gutter styling
   - The main `switch` in `EventCard()` returns the rendered `content`
3. Add your event type to both switches:
   - In `getGutterRole()`: return the appropriate role or `null`
   - In `EventCard()`: return a `<Card>` (simple label/value), a dedicated component, or `null` (silent)
4. If the card is non-trivial, create a dedicated component in the same directory (e.g., `my-event-card.tsx`) and import it
5. Existing dedicated components: `ImplementerCard`, `ValidateCard`, `PlannerStatusCard`, `CostPredictionCard`, `EscalateCard`, `WorkflowConfigCard`, `UserMessageCard`

The `assertNever(event)` default case ensures the compiler catches missing event types.

---

## 10. New readiness check

1. Create `src/core/readiness/checks/<name>.ts`
2. Export a `build<Name>Checks(config: Config): ReadinessCheck[]` function
3. Each `ReadinessCheck` has: `id` (dotted string), `severity` (`ok` | `info` | `warning` | `blocker`), `summary` (one line), optional `details`, `fix`, `nextAction`, `metadata`
4. Wire into `buildSections()` in `src/core/readiness/checks/build.ts`:
   - Import your builder
   - Add a `{ id, title, checks: build<Name>Checks(input.config) }` entry to the sections array
5. Existing checks: `config`, `mode`, `runners`, `context`, `validation`, `repo`, `cost`

Follow the `runners.ts` pattern: return an array of checks, use `metadata` for machine-readable details, use `fix` for actionable suggestions.

---

## 11. New config key

1. Add the field to the appropriate schema in `src/core/schemas/config.ts` (or a sub-schema it imports)
2. If the field needs a runtime accessor, create or extend a file under `src/core/config/accessors/` (existing: `runner-config.ts`, `implementer-profiles.ts`, `state.ts`)
3. If the field affects readiness, add a check in the matching `src/core/readiness/checks/` file
4. If the field needs a CLI flag, add it in `src/cli/options.ts` and map it in `applyCLIOverrides()` (`src/core/config/runtime/overrides.ts`)
5. Document in `docs/CONFIGURATION.md`

---

## 12. New workflow hook event

1. Add the event name to `HookEventSchema` in `src/core/schemas/hooks.ts`
   - Names follow the convention: `pre_*`, `post_*`, `on_*`
2. For `pre_*` hooks (blocking, before the action happens):
   - Call `runPreHooks()` from `src/engine/hooks/run-pre-hook.ts` at the orchestrator call site
   - `runPreHooks()` returns `{ allow: boolean; reason?: string }` — abort the action if `allow` is false
3. For `post_*` / `on_*` hooks (fire-and-forget, after the action):
   - Add a mapping case in `eventToHookKey()` inside `src/engine/hooks/sink.ts`
   - The hook sink subscribes to the EventBus and dispatches automatically when the matching EngineEvent fires
4. Document in `docs/HOOKS-CONFIG.md`
