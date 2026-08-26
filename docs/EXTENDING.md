# SPLITBRIEF — Extending

How to add things. Each section is a recipe: what you're adding, what files to touch, in what order. Read [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) for the system flow and [ENGINE.md](./ENGINE.md) for the EventBus before writing engine code.

---

## 1. New CLI subcommand

1. Create `src/cli/commands/<name>.ts`
2. Export a `register<Name>Command(program: Command)` function
3. Inside the handler, follow the pattern: parse flags, `resolveProjectDir()`, load config, optionally `initStores()`, optionally `renderApp()` or run headless
4. In `src/cli.ts`: import and call `register<Name>Command(program)`
5. Document in `docs/CLI-REFERENCE.md`

Existing example to follow: `src/cli/commands/start/register.ts`.

---

## 2. New slash command

1. Open `src/core/runtime/commands/registry.ts`
2. Add a new entry to the array returned by `createRuntimeCommands(ctx)`
3. Each entry needs:
   - `kind` — `'noarg'` or `'arg'`
   - `name` — the `/command` string
   - `description` — one line; the palette and `/help` both render it
   - `category` — one of `COMMAND_CATEGORIES` (`navigate` | `crew` | `workflow` | `view` | `io`, `src/core/runtime/commands/types.ts`). It groups the row in the palette and in `/help`; there is no free-form group string
   - `validScreens` — array of screens where the command is available (use `ALL_SCREENS` from `src/core/navigation/types.ts` for global)
   - `handler` — sync or async; an `'arg'` command receives the raw argument string
   - `args` — `'arg'` commands only: `{ kind: 'closed', options, optional? }` when the argument set is fixed (the completion menu offers exactly those — `/crew` closes over `CREW_COMMAND_SEATS`), or `{ kind: 'free', hint }`
   - Optional: `label` (for the command palette), `shortcut`, `hidden`, `aliases`
4. Guards: add `guard: (ctx) => string | undefined` when the command is only valid in some phases or states. A returned string is the reason — it blocks the command *and* hides its row, so no listed command errors on Enter. The context is `{ phase, attached, plannerSupportsImages }`; phase predicates live in `src/core/phases.ts` (`canReviseSpec`, `canRevisePlan`, `canRedoTask`)
5. Aliases are `{ name, args? }` pairs, not bare strings — an alias may pin an argument, which is how `/planner` lives on as `{ name: '/planner', args: 'plan' }` on `/crew`. A name that is gone for good belongs in `REMOVED_COMMANDS` (`src/core/runtime/commands/types.ts`) with the sentence that tells the user where it went, never as a row that errors
6. Document in `docs/SLASH-COMMANDS-REFERENCE.md`

---

## 3. New EngineEvent type

1. Add a Zod member to the type-dispatched `EngineEventSchema` contract in `src/engine/events/schema.ts`
   - Use the `phaseEvent('my_event')` helper (it supplies `type`, `ts: number`, and `phase: Phase`) and chain `.extend({ … }).passthrough()` for variant fields; use `noPhaseEvent('my_event')` for intentionally global or snapshot-resolution metadata. Current phase-less events are `snapshot_restored`, `snapshot_restore_conflict`, and `approval_mode_changed`
   - The `EngineEvent` TS alias in `src/engine/events/types.ts` is `z.infer<typeof EngineEventSchema>`, so the new variant flows into every consumer automatically — no separate type edit
2. Add a typed publish helper in `src/engine/orchestrator/events.ts`
   - Pattern: `export function publishMyEvent(bus: EventBus, phase: Phase, payload): void { bus.publish({ type: 'my_event', ts: Date.now(), phase, ...payload }); }`
3. If the event should update UI state: handle it in `src/stores/workflow/actions/event.ts` inside `addEvent()`
   - The ordering invariant is: events store, then tasks store, then tokens store, then lifecycle store (all synchronous)
4. If the event should appear in the workflow conversation: add a case in `src/features/workflow/conversation-rows/event-rows/dispatch.ts`

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

Use an existing runner kind only (`cli`, `api`, `shell`, `agent`, `agent-sdk`). Do not add a sixth kind — see [section 14](#14-cli-and-provider-admission-checklists).

1. Pick the kind in config (`RunnerKindSchema` in `src/core/schemas/enums.ts`); factory dispatch lives in `src/engine/runners/factory.ts`
2. Create `src/engine/planners/<name>.ts` implementing the `Planner` interface from `src/engine/planners/types.ts`
   - Use `createPlannerBase()` from `src/engine/planners/base.ts` if it fits
3. Create `src/engine/implementers/<name>.ts` implementing the `Implementer` interface from `src/engine/implementers/types.ts`
   - Use `createImplementerBase()` from `src/engine/implementers/pipeline/run.ts` if it fits
4. Add config schema variants:
   - `src/core/schemas/planner-config.ts` — planner-side config discriminated union
   - `src/core/schemas/implementer-config.ts` — implementer-side config discriminated union
5. Add factory cases in `src/engine/runners/factory.ts`:
   - Add a lazy loader: `const loadMyPlanner = lazy(() => import('../planners/<name>.js'));`
   - Add the `case '<kind>':` branch in both `loadPlanner()` and `createImplementer()`
6. Declare a `capabilities` struct — the orchestrator reads capability flags, never backend identity
7. Set `backendKind` in the base config and normalize backend output through `src/engine/calls/*`
   - Prefer emitting `RunnerCallEvent` / `RunnerCallResult` directly
   - If the backend still returns `{ text, usage }`, keep that as a temporary compatibility projection only
   - Preserve terminal status, partial output, session IDs, tool-use, artifacts, warnings, and usage semantics
8. Write colocated tests: `src/engine/planners/<name>.test.ts`, `src/engine/implementers/<name>.test.ts`

---

## 6. New runner seat

A *seat* is a place in the run where a runner is called. Adding one is not the same as adding a backend — you reuse every existing kind and add a place for one of them to sit. This is the path the review seat took; follow it in this order.

1. **Config schema.** Add the optional top-level block in `src/core/schemas/<seat>-config.ts` and wire it into `ConfigSchema`. Keep it the same discriminated union as an existing seat, `.strict()` on every variant, and do not bump `version`.
2. **One resolver, and only one.** Add `src/core/config/accessors/<seat>-runner.ts` exporting a `resolve<Seat>Runner(config)` that returns the configured runner or the seat it falls back to, with the source tagged. Everything else in the codebase reads that resolver — it is the only module allowed to branch on `config.<seat>`.
3. **Role union.** If the seat is user-selectable, add it to `ActiveRunnerRole` in `src/core/runners/cli-tool-catalog.ts`. That is the single role union; do not introduce a second one.
4. **Slot and admission.** Add the slot variant to `RunnerConfigSlot` (`src/core/config/accessors/runner-config.ts`), then push the seat as a candidate in `prepareExecution()` (`src/engine/runners/prepare-execution.ts`) *only when it is configured*. Add the slot to `RunnerAvailabilitySlot` in `src/core/readiness/checks/availability.ts` — it is an explicit `Extract<…>` and does not widen on its own — and to the readiness checks that report per-seat availability and trust.
5. **The port.** Define the narrowest interface the seat actually needs in `src/engine/<seat>s/types.ts`. Narrower is better: it lets an existing runner satisfy the seat structurally and hold it unadapted. Do not put tool or model fields on the port — identity for user-facing messages comes from the config accessor that resolved the seat.
6. **The factory.** Add `create<Seat>()` to `src/engine/runners/factory.ts`, reusing the existing lazy backend loaders. Create the seat in `src/engine/orchestrator/run/init.ts`, reusing an already-built runner when the resolver says the seat falls back.
7. **The call.** Give the seat its own call module (`src/engine/orchestrator/<seat>-call.ts`) rather than repointing an existing helper. Repointing a shared helper silently moves every other call site with it — count them first.
8. **Token accounting.** Add the seat's fields to `TokenUsageSchema` (`src/core/schemas/tokens.ts`) with `.default(0)` so older session state still loads, add the category to `categoryFields` and `usageCategoryForRunnerCallRole()` in `src/engine/orchestrator/tokens.ts`, and check `attributePhaseTokenDelta` (`src/core/state/token-attribution.ts`) — moving tokens out of a bucket a phase's delta is computed from silently zeroes that phase in the cost drilldown.
9. **Pricing and summary.** Price the new bucket at the seat's own rates when configured and fold it into the fallback seat's line when not. `stats.json` aggregates by provider, not by role, so it needs no new bucket.
10. **CLI flags.** Mirror the existing per-seat flags in `addWorkflowOptions()` (`src/cli/options.ts`), map them in `src/core/config/runtime/overrides/from-options.ts`, and apply them through `applyRunnerOverrides()`.
11. **UI.** Widen the role-parameterised picker rather than writing a new one, add the overlay to `SEAT_PICKER_OVERLAYS` (`src/core/navigation/types.ts`), add the seat to `CREW_SEAT_IDS` / `CREW_SEAT_LABELS` (`src/core/crew/identity.ts`) and to `deriveCrewSeats()` (`src/core/crew/seats.ts`), which `deriveCrewRows()` (`src/core/crew/rows.ts`) turns into rows — Settings, Setup, home and the workflow header all derive from those rows; there is no settings section to add.
12. **Docs.** [CONFIGURATION.md](./CONFIGURATION.md) for the block, [CLI-REFERENCE.md](./CLI-REFERENCE.md) for the flags, [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) for the command, [WORKFLOW.md](./WORKFLOW.md) for which seat runs which phase, and [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for admission and call-time failure.

The rule that made the review seat cheap: **no automatic fallback at call time.** The seat falls back at *resolve* time, once, visibly. A seat that silently retries somewhere else at call time cannot be reasoned about from the evidence trail.

---

## 7. New workflow phase

1. Add the phase string to the `PHASES` array and `PhaseSchema` in `src/core/schemas/enums.ts`
2. Add transitions in `src/core/state/machine.ts` — the state reducer
   - Add the phase to `phaseActions` (allowed state-action combinations)
   - Add transition logic in the reducer function
3. Update phase taxonomy in `src/core/phases.ts`:
   - Add to the correct sets: `RESUMABLE_PHASES`, `LIVE_PHASES`, `IMPLEMENTER_PHASES` / `PLANNER_COST_PHASES` / `IMPLEMENTER_COST_PHASES`
   - Update `phaseRole()` if needed
4. Add orchestrator logic — typically a new file under `src/engine/orchestrator/planning/` or `src/engine/orchestrator/task/`
5. If the phase has a visual: update `WorkflowScreen` components in `src/features/workflow/`

---

## 8. New UI feature (screen / overlay / picker)

### Screen

1. Create `src/app/screens/<name>.tsx` — a FLAT page that composes the feature. Feature components/hooks live in `src/features/<name>/`; for a pure-entry surface, the page is the whole surface and no `features/<name>/` folder is created.
2. Add the screen name to the `Screen` type in `src/core/navigation/types.ts`
3. Add a `case` to `renderScreen()` in `src/app/router.tsx`, importing the page via `./screens/<name>.js`

### Overlay

1. Create `src/app/overlays/<name>.tsx` — same shape as a screen (FLAT page composing the feature, or the whole surface for a pure-entry overlay)
2. Add the overlay name to the `OverlayType` union in `src/core/navigation/types.ts`
3. Add a `case` to `renderOverlay()` in `src/app/router.tsx`, importing the page via `./overlays/<name>.js`

### Both

- Feature-local components stay in `src/features/<name>/components/` and feature-local hooks in `src/features/<name>/hooks/`; the page imports them via `../../features/<name>/…`.
- Page↔page imports are forbidden — pages coordinate via stores.
- Features never import from other features. Shared code goes to `src/components/`, `src/hooks/`, `src/utils/`.
- Every panel passes a `density` (`compact` | `roomy` | `wide`) to `overlayRect()` (`src/core/navigation/overlay-rect.ts`) or `OverlayPanel` (`src/components/overlays/overlay-panel.tsx`) and sizes itself from the returned rect. Pinned column constants are not an option.

---

## 9. New provider (for api runner kind)

Complete the [provider admission checklist](#provider-admission-checklist) before touching the registry.

1. Create `src/engine/providers/<name>.ts`
   - Export a factory function: `createMyProvider(overrides?: ProviderOverrides): ProviderDef`
2. Register in `src/engine/providers/registry.ts`
   - If bespoke: add to the `BESPOKE_PROVIDERS` map
   - If OpenAI-compatible: add an entry in `src/core/providers/catalog.ts` with `baseURL` and `apiKeyEnv` — the `buildOpenAICompatFactories()` loop picks it up automatically
3. Add bundled model pricing in `src/core/providers/known-models.ts` when a fallback is needed. Runtime/model catalog pricing is resolved through `src/engine/providers/models-dev.ts`, `src/engine/providers/model/`, and `src/engine/providers/pricing-resolver.ts`.

---

## 10. New workflow conversation event renderer

1. Open `src/features/workflow/conversation-rows/event-rows/dispatch.ts`
2. The row renderer is a switch on `event.type` and returns concrete one-terminal-row records.
3. Add your event type to `eventRowBlock()` when it should appear in the scrollable conversation.
4. Keep each returned `ConversationRow` height-safe. Use helpers from `conversation-rows/row-format/` (`text.ts`, `rows.ts`, `label-card.ts`, `card-block.ts`) for wrapping and cards.
5. Events that should remain silent in the conversation should return `[]`.

The `assertNever(event)` default case ensures the compiler catches missing event types.

---

## 11. New readiness check

1. Create `src/core/readiness/checks/<name>.ts`
2. Export a `build<Name>Checks(config: Config): ReadinessCheck[]` function
3. Each `ReadinessCheck` has: `id` (dotted string), `severity` (`ok` | `info` | `warning` | `blocker`), `summary` (one line), optional `details`, `fix`, `nextAction`, `metadata`
4. Wire into `buildSections()` in `src/core/readiness/checks/build.ts`:
   - Import your builder
   - Add a `{ id, title, checks: build<Name>Checks(input.config) }` entry to the sections array
5. Existing checks: `config`, `mode`, `runners`, `context`, `validation`, `repo`, `cost`

Follow the `runners.ts` pattern: return an array of checks, use `metadata` for machine-readable details, use `fix` for actionable suggestions.

---

## 12. New config key

1. Add the field to the appropriate schema in `src/core/schemas/config.ts` (or a sub-schema it imports)
2. If the field needs a runtime accessor, create or extend a file under `src/core/config/accessors/` (existing: `runner-config.ts`, `implementer-profiles.ts`, `values.ts`)
3. If the field affects readiness, add a check in the matching `src/core/readiness/checks/` file
4. If the field needs a CLI flag, add it in `src/cli/options.ts` and map it in `applyCLIOverrides()` (`src/core/config/runtime/overrides/apply.ts`)
5. Document in `docs/CONFIGURATION.md`

---

## 13. New workflow hook event

1. Add the event name to `HookEventSchema` in `src/core/schemas/hooks.ts`
   - Names follow the convention: `pre_*`, `post_*`, `on_*`
2. For `pre_*` hooks (blocking, before the action happens):
   - Call `runPreHooks()` from `src/engine/hooks/run-pre.ts` at the orchestrator call site
   - `runPreHooks()` returns `{ allow: boolean; reason?: string }` — abort the action if `allow` is false
3. For `post_*` / `on_*` hooks (fire-and-forget, after the action):
   - Add a mapping case in `eventToHookKey()` inside `src/engine/hooks/sink.ts`
   - The hook sink subscribes to the EventBus and dispatches automatically when the matching EngineEvent fires
4. Document in `docs/HOOKS-CONFIG.md`

---

## 14. CLI and provider admission checklists

Canonical support matrices live in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and [CONFIGURATION.md](./CONFIGURATION.md). Extension work must follow the closed architectural constraints and ordered checklists below — not independent exhaustive lists in secondary guides.

### Architectural constraints

- **One runner-kind set:** `cli`, `api`, `shell`, `agent`, `agent-sdk` (`RUNNER_KINDS` in `src/core/schemas/enums.ts`). New backends pick an existing kind; do not add a sixth runner kind.
- **No argv DSL or plugin framework:** each CLI adapter owns its vendor argv grammar in a dedicated module. Do not build a generic argv insertion DSL or broad plugin loader.
- **One OpenAI transport:** hosted API providers use `src/engine/providers/openai-stream/` only. Do not add a second generic OpenAI-compatible streaming transport.

### CLI admission checklist

Complete in order before registering in `CLI_PLANNER_ADAPTERS` / `CLI_IMPLEMENTER_ADAPTERS`:

1. **Core descriptor** — add `CliToolDescriptor` to `src/core/runners/cli-tool-catalog.ts` with stable `id`, display name, install URL, and dated compatibility evidence (`asOf`).
2. **Supported roles, model, auth, posture** — declare `roles`, per-role `CliModelPolicy`, `CliAuthPolicy`, direct-write/trust/permission posture, and shell/network/approval/sandbox facts. Unsupported role pairs fail schema validation.
3. **Trusted identity** — `src/engine/runners/resolve-cli-executable.ts` resolves one absolute real path; probe and execution reuse that identity.
4. **Probe** — bounded, non-billable version/auth probe with neutral cwd when the upstream contract allows it.
5. **Lossless transport** — `CliPromptTransport` (`stdin`, byte-limited `argv` with `<PROMPT>` sentinel, or mode-0600 `file`). The Task Brief reaches the child byte-for-byte or execution fails before spawn.
6. **Args conflicts** — user `args` have a documented insertion position; conflicts with prompt transport, output protocol, permission mode, model policy, or terminal behavior are rejected pre-spawn.
7. **Parser/terminal** — structured protocols require the documented terminal event; text protocols may use process exit plus direct-change proof only when the admitted fixture documents no stable terminal envelope.
8. **Env** — `src/engine/runners/sandbox-env.ts` allowlists runtime env plus only the descriptor auth channel; never copy ambient secrets. A private HOME under `.splitbrief/sandbox/<role>/` is the default and the only thing a new tool should assume. The single sanctioned exception is a channel whose credential is an OS keychain item with no file to bridge: it declares `hostKeychainPlatforms` on the channel, `cliAuthChannelHostStateAccess()` maps that to `host-account`, and the child keeps the host `HOME`/`USER` while every other redirect stays. Only the Claude Code `session` channel on macOS declares one today — see [WORKTREES.md](./WORKTREES.md#the-one-exception-claude-code-session-on-macos).
9. **Direct-change proof** — direct writers receive staged-cwd instructions; successful completion requires a real staged change, not stdout extraction alone.
10. **Common/live/eval gates** — pass the common CLI contract suite, any required credentialed live smoke, and implementation-quality/privacy evaluation before registration.
11. **Late registry/docs** — register in `src/engine/runners/cli-tools/registry.ts` and update [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) only after every gate above passes.

#### Raw/production transaction (CLI)

Admission evidence is a two-step transaction on the same role-singular `RawCliCandidateContract`:

1. **Raw** — `npx tsx scripts/cli-conformance.ts raw --contract-json '<json>' --record <json>` captures bounded version/auth/native output in a staged git project without parser, adapter, or registry. Writes candidate `id`, `role`, canonical contract SHA-256, and sanitized `rawCapture`.
2. **Production** — `npx tsx scripts/cli-conformance.ts production --module <module.ts> --role <planner|implementer> --record <same-json>` dynamically imports only the named adapter module, reuses the raw evidence, and appends `productionConformance`. Contract or identity mismatch fails the harness.

`OMIT` verdicts delete vendor sources; `PASS` retains them. Registration and docs are late steps — never before the transaction completes.

### Provider admission checklist

Complete in order before registering in `src/engine/providers/registry.ts`:

1. **Service/offering** — `ApiProviderDescriptor` with explicit `service` and `offering` (`payg`, `free-quota`, `coding-subscription`, `local`). Never infer offering from credential prefix alone.
2. **Endpoint** — `EndpointPolicy` in `src/core/providers/endpoint-policy.ts`; normalize and validate origin before client creation. Cross-origin redirects must not receive credentials.
3. **Credential** — `credentialEnv` and `credentialPrefix`; prefix or family mismatch fails before network access.
4. **Billing/privacy/asOf** — dated `billing`, `dataUse`, privacy/terms URLs in the descriptor. No runtime fetch of pricing, terms, or marketing pages.
5. **Policy** — `OpenAICompatPolicy` in `src/engine/providers/openai-compat-policy.ts` enables provider-specific request fields only when exact conformance fixtures prove them.
6. **Production conformance** — credentialed harness in `src/engine/providers/conformance.ts` via `npx tsx scripts/provider-conformance.ts production …` reusing the same record as raw capture.
7. **Eval** — implementation-quality/privacy evaluation verdict is applied to runtime recommendation state before docs label a model recommended.
8. **Late registration** — register through `createUnregisteredOpenAICompatProvider` / `src/engine/providers/registry.ts` and document in [CONFIGURATION.md](./CONFIGURATION.md) and [API-KEYS.md](./API-KEYS.md) only after every gate above passes.

#### Raw/production transaction (provider)

Same two-step transaction on `RawProviderCandidateContract`:

1. **Raw** — `npx tsx scripts/provider-conformance.ts raw --contract-json '<json>' --record <json>` captures the credentialed request/stream terminal in a neutral harness without registry registration.
2. **Production** — `npx tsx scripts/provider-conformance.ts production --module <module.ts> --record <same-json>` imports only the named provider module and appends `productionConformance` to the same record.

Fixed admission order for both CLI and API slices:

`primary-source record → deterministic fixtures → credentialed production-path smoke → implementation-quality/privacy evaluation → central registration/docs`
