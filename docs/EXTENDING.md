# SPLITBRIEF — Extending

How to add things. Each section is a recipe: what you're adding, what files to touch, in what order. Read [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) for the system flow and [ENGINE.md](./ENGINE.md) for the EventBus before writing engine code.

---

## 1. New CLI subcommand

1. Create `src/cli/commands/<name>.ts`
2. Export a `register<Name>Command(program: Command)` function
3. Inside the handler, follow the pattern: parse flags, `canonicalizeProjectDir()`, load config, optionally `initStores()`, optionally `renderApp()` or run headless
4. In the CLI entry: import and call `register<Name>Command(program)`
5. Document in `docs/CLI-REFERENCE.md`

Existing example to follow: `registerStartCommand`.

---

## 2. New slash command

1. Open the `src/core/runtime/commands/defs/<category>.ts` module for the command's category (`navigate` · `crew` · `workflow` · `view` · `io`)
2. Add a new entry to the array returned by that module's `<category>Commands(ctx)`; `createRuntimeCommands` in `registry.ts` concatenates the five in `COMMAND_CATEGORIES` order
3. Each entry needs:
   - `kind` — `'noarg'` or `'arg'`
   - `name` — the `/command` string
   - `description` — one line; the palette and `/help` both render it
   - `category` — one of `COMMAND_CATEGORIES` (`navigate` | `crew` | `workflow` | `view` | `io`). It groups the row in the palette and in `/help`; there is no free-form group string
   - `validScreens` — array of screens where the command is available (use `ALL_SCREENS` for global)
   - `handler` — sync or async; an `'arg'` command receives the raw argument string. A `'noarg'` command never sees arguments: dispatch refuses words after its name with `<name> takes no argument. Usage: <name>`, and the composer keeps the line, so a handler cannot read stray arguments. A handler that refuses (a bad argument, a run that cannot take the command as it stands) returns the reason as a string and does nothing else: the dispatcher shows the reason and gives the typed line back to the field that sent it, the composer or the answer field of a planner question. A context callback that can refuse (`ctx.steerRun`, `ctx.resumeRun`) returns its reason, and the handler returns that. A command that ran and found nothing to do reports through `ctx.setFeedbackMessage` and returns nothing, so its line does not come back (`/copy` with nothing to copy). A command that ran and then failed reports through `ctx.setFeedbackError` and returns nothing
   - `args` — `'arg'` commands only: `{ kind: 'closed', options, optional? }` when the argument set is fixed (the completion menu offers exactly those — `/crew` closes over `CREW_COMMAND_SEATS`), or `{ kind: 'free', hint }`
   - Optional: `label` (for the command palette), `shortcut`, `hidden`
4. Guards: add `guard: (ctx) => string | undefined` when the command is only valid in some phases or states. A returned string is the reason — it blocks the command *and* hides its row, so no listed command errors on Enter. The context is `CommandGuardContext`: `{ phase, plannerSupportsImages, openRunAtRest, applyUnfinished, applying }`. `openRunAtRest` is true when the screen shows a run read back from disk that is not closed. `applyUnfinished` is true when the run on screen is at rest with an Apply that did not finish: End run refuses it. `applying` means this process's Apply is writing the run on screen to your checkout, which cannot be cut. Phase predicates live in the phase taxonomy: `isLivePhase` covers a call in progress, and `isRunLivePhase` adds a waiting plan card (`reviewing-plan`) and a brief's checks (`validating-task`)
5. One name, one command: there is no alias mechanism, so a second spelling means a second row. A name that is gone for good belongs in `REMOVED_COMMANDS` with the sentence that tells the user where it went, never as a row that errors
6. Document in `docs/SLASH-COMMANDS-REFERENCE.md`

---

## 3. New EngineEvent type

1. Add a Zod member to the type-dispatched `EngineEventSchema` contract
   - Use the `phaseEvent('my_event')` helper (a `z.looseObject` that supplies `type`, `ts: number`, and `phase: Phase`) and chain `.extend({ … })` for variant fields; use `noPhaseEvent('my_event')` for intentionally global or snapshot-resolution metadata. Current phase-less events are `snapshot_restored`, `snapshot_restore_conflict`, and `approval_mode_changed`
   - The `EngineEvent` TS alias is `z.infer<typeof EngineEventSchema>`, so the new variant flows into every consumer automatically — no separate type edit
2. Add a typed publish helper to the orchestrator's `publish*` helpers
   - Pattern: `export function publishMyEvent(bus: EventBus, phase: Phase, payload): void { bus.publish({ type: 'my_event', ts: Date.now(), phase, ...payload }); }`
3. If the event should update UI state: handle it inside `addEvent()`
   - The ordering invariant is: run view (`runViewStore`), then the cancellation gate, then events store, then tokens store, then lifecycle store, then operations store (all synchronous)
4. If the event should appear in the workflow conversation: add a case in `eventRowBlock()`

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
6. If the store reads disk on startup: add the init call in `loadProjectState()`
7. Tests: call `myStore.reset()` in `beforeEach`

Factory: `createStore()`.

---

## 5. New planner/implementer backend

Use an existing runner kind only (`cli`, `api`, `shell`, `agent`). Do not add a fifth kind — see [section 15](#15-cli-and-provider-admission-checklists).

1. Pick the kind in config (`RunnerKindSchema`); factory dispatch lives in the runner factory
2. Create `src/engine/planners/<name>.ts` implementing the `Planner` interface
   - Use `createPlannerBase()` if it fits
3. Create `src/engine/implementers/<name>.ts` implementing the `Implementer` interface
   - Use `createImplementerBase()` if it fits
4. Add config schema variants:
   - `PlannerConfigSchema` — planner-side config discriminated union
   - `ImplementerConfigSchema` — implementer-side config discriminated union
5. Add factory cases in the runner factory:
   - Add a lazy loader: `const loadMyPlanner = lazy(() => import('../planners/<name>.js'));`
   - Add the `case '<kind>':` branch in both `loadPlanner()` and `createImplementer()`
6. Declare a `capabilities` struct — the orchestrator reads capability flags, never backend identity
7. Set `backendKind` in the base config and normalize backend output through the runner-call contract
   - Prefer emitting `RunnerCallEvent` / `RunnerCallResult` directly
   - If the backend still returns `{ text, usage }`, keep that as a temporary compatibility projection only
   - Preserve terminal status, partial output, session IDs, tool-use, artifacts, warnings, and usage semantics
8. Write colocated tests: `src/engine/planners/<name>.test.ts`, `src/engine/implementers/<name>.test.ts`

---

## 6. New runner seat

A *seat* is a place in the run where a runner is called. Adding one is not the same as adding a backend — you reuse every existing kind and add a place for one of them to sit. This is the path the review seat took; follow it in this order.

1. **Config schema.** Add the optional top-level block in `src/core/schemas/<seat>-config.ts` and wire it into `ConfigSchema`. Keep it the same discriminated union as an existing seat, `.strict()` on every variant, and do not bump `version`.
2. **One resolver, and only one.** Add `src/core/config/accessors/<seat>-runner.ts` exporting a `resolve<Seat>Runner(config)` that returns the configured runner or the seat it falls back to, with the source tagged. Everything else in the codebase reads that resolver — it is the only module allowed to branch on `config.<seat>`.
3. **Role union.** If the seat is user-selectable, add it to `ActiveRunnerRole`. That is the single role union; do not introduce a second one.
4. **Slot and admission.** Add the slot variant to `RunnerConfigSlot`, then push the seat as a candidate in `prepareExecution()` *only when it is configured*. Add the slot to `RunnerAvailabilitySlot` — it is an explicit `Extract<…>` and does not widen on its own — and to the readiness checks that report per-seat availability and trust.
5. **The port.** Define the narrowest interface the seat actually needs in `src/engine/<seat>s/types.ts`. Narrower is better: it lets an existing runner satisfy the seat structurally and hold it unadapted. Do not put tool or model fields on the port — identity for user-facing messages comes from the config accessor that resolved the seat.
6. **The factory.** Add `create<Seat>()` to the runner factory, reusing the existing lazy backend loaders. Create the seat in the run's seat setup (the reviewer is built in `createPlannerSeat()`), reusing an already-built runner when the resolver says the seat falls back.
7. **The call.** Give the seat its own call module (`src/engine/orchestrator/<seat>-call.ts`) rather than repointing an existing helper. Repointing a shared helper silently moves every other call site with it — count them first.
8. **Token accounting.** Add the seat's fields to `TokenUsageSchema` with `.default(0)` so older session state still loads, add the category to `categoryFields` and `usageCategoryForRunnerCallRole()`, and check `attributePhaseTokenDelta` — moving tokens out of a bucket a phase's delta is computed from silently zeroes that phase in the recorded per-phase totals.
9. **Pricing and summary.** Price the new bucket at the seat's own rates when configured and fold it into the fallback seat's line when not. The run's own rollup is `summary.json`, built by `buildSummary()` from the state's `tokenUsage` and `calculateCostBreakdown()` — the bucket has to reach both or the seat's spend is dropped from the summary.
10. **CLI flags.** Mirror the existing per-seat flags in `addWorkflowOptions()`, map them in `workflowOptsToCLIOverrides()`, and apply them through `applyRunnerOverrides()`.
11. **UI.** Widen the role-parameterised picker rather than writing a new one, add the overlay to `SEAT_PICKER_OVERLAYS`, add the seat to `CREW_SEAT_IDS` / `CREW_SEAT_LABELS` and to `deriveCrewSeats()`, which `deriveCrewRows()` turns into rows — Settings, Setup, home and the workflow header all derive from those rows; there is no settings section to add.
12. **Docs.** [CONFIGURATION.md](./CONFIGURATION.md) for the block, [CLI-REFERENCE.md](./CLI-REFERENCE.md) for the flags, [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) for the command, [WORKFLOW.md](./WORKFLOW.md) for which seat runs which phase, and [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) for admission and call-time failure.

The rule that made the review seat cheap: **no automatic fallback at call time.** The seat falls back at *resolve* time, once, visibly. A seat that silently retries somewhere else at call time cannot be reasoned about from the evidence trail.

---

## 7. New workflow phase

1. Add the phase string to the `PHASES` array and `PhaseSchema`
2. Add transitions in `transition()` — the state reducer
   - Add the phase to `phaseActions` (allowed state-action combinations)
   - Add transition logic in the reducer function
3. Update the phase taxonomy:
   - Add to the correct sets: `LIVE_PHASES`, `IMPLEMENTER_PHASES` / `PLANNER_TOKEN_PHASES` / `IMPLEMENTER_TOKEN_PHASES`
   - Give the phase a resume step in `resumeStep()`
   - Update `phaseRole()` if needed
4. Add orchestrator logic — typically a new file under `src/engine/orchestrator/planning/` or `src/engine/orchestrator/task/`
5. If the phase has a visual: update `WorkflowScreen` components

---

## 8. New UI feature (screen / overlay / picker)

### Screen

1. Create `src/app/screens/<name>.tsx` — a FLAT page that composes the feature. Feature components/hooks live in `src/features/<name>/`; for a pure-entry surface, the page is the whole surface and no `features/<name>/` folder is created.
2. Add the screen name to `ALL_SCREENS`; the `Screen` type derives from it
3. Add a `case` to `renderScreen()`, importing the page via `./screens/<name>.js`

### Overlay

1. Create `src/app/overlays/<name>.tsx` — same shape as a screen (FLAT page composing the feature, or the whole surface for a pure-entry overlay)
2. Add the overlay name to `ACTIVE_OVERLAYS`; the `OverlayType` union derives from it
3. Add a `case` to `renderOverlay()`, importing the page via `./overlays/<name>.js`

### Both

- Feature-local components stay in `src/features/<name>/components/` and feature-local hooks in `src/features/<name>/hooks/`; the page imports them via `../../features/<name>/…`.
- Page↔page imports are forbidden — pages coordinate via stores.
- Features never import from other features. Shared code goes to `src/components/`, `src/hooks/`, `src/utils/`.
- Every panel passes a `density` (`compact` | `roomy` | `wide`) to `overlayRect()` or `OverlayPanel` and sizes itself from the returned rect. Pinned column constants are not an option.

---

## 9. New provider (for api runner kind)

Complete the [provider admission checklist](#provider-admission-checklist) before touching the registry.

1. Add an `ApiProviderDescriptor` entry to `API_PROVIDER_CATALOG`: `id`, display name, `service`, `offering`, `endpointPolicy`, credential fields, billing and privacy facts, and `asOf`. `ApiProviderId` derives from the catalog keys.
2. Create `src/engine/providers/<name>.ts`
   - Export a factory function: `createMyProvider(overrides?: ProviderOverrides): ProviderDef`
3. Register the factory in `KNOWN_PROVIDERS`. The map is typed `Record<ApiProviderId, …>`, so a catalog entry without a factory fails the type check. `getProvider()` resolves the descriptor's endpoint policy and calls the factory with the normalized `apiBase`.
4. Add bundled model pricing in `KNOWN_MODELS` when a fallback is needed. Runtime/model catalog pricing is resolved through the models.dev catalog, the runtime model metadata, and `resolvePricing`.

---

## 10. New workflow conversation event renderer

1. Open the event row dispatch
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
4. Wire into `buildSections()`:
   - Import your builder
   - Add a `{ id, title, checks: build<Name>Checks(input.config) }` entry to the sections array
5. Existing sections: `config`, `repo`, `workflow` (`plan-approval.ts`), `runners`, `context`, `validation`

Follow the `runners.ts` pattern: return an array of checks, use `metadata` for machine-readable details, use `fix` for actionable suggestions.

---

## 12. New config key

1. Add the field to `ConfigSchema` (or a sub-schema it imports)
2. If the field needs a runtime accessor, create or extend a file under `src/core/config/accessors/` (existing: `runner-config.ts`, `implementer-profiles.ts`, `values.ts`)
3. If the field affects readiness, add a check in the matching `src/core/readiness/checks/` file
4. If the field needs a CLI flag, add it in the CLI options and map it in `applyCLIOverrides()`
5. Document in `docs/CONFIGURATION.md`

---

## 13. New validation stack

`src/core/validation/stacks/` is the only place a validation command literal may live — invariant gate 48 fails the build when `npx tsc`, `npm test`, or a `.test.ts` literal appears in production `src/` outside it. A stack row resolves the planner's `test` checks. Its `allowedCommands` put the stack's tools on the plan command policy's allowlist. The planner names the project gate from the project itself, and SPLITBRIEF runs it as the reviewer checks. The reviewer command policy admits any installed program that follows its danger rules. Each refused command gets a named row. To add a sixth stack:

1. Create `src/core/validation/stacks/<language>.ts` exporting one `Stack` (shape in `types.ts`): `id`, `language` (the `LanguageContext` key), `markers` (project-relative filenames, or a predicate for a "the manifest mentions X" sniff), `test` — `(projectDir) => string | null`, returning `null` when the project has no test tool configured — plus `testFilePatterns` (single-`*` globs), `testDirs`, optional `inlineTests`, `narrowing`, and `allowedCommands`
2. Add the id to `StackId` in `types.ts` and to the `validation.stack` enum of `ConfigSchema`
3. Register the row in `STACKS`. **Array order is detection order** — `detectStack` takes the first row whose marker matches, so a narrow marker set goes above a broad one (`Cargo.toml` before `package.json`)
4. `allowedCommands` is the allowlist of the plan command policy: `sanitize-discovered-validation.ts` builds its allowed programs from it, so a plan `cmd` check that starts a program no stack lists is refused (except the file tests `test -e`, `-f`, `-x` or `-L <file>`; a reviewer check is not: the reviewer command policy has no allowlist), and it drops any discovered command no stack lists, so a stack whose runner is missing there is disarmed; the run records a `validation` warning for each dropped command (`it runs a program outside the allowlist`), but nothing fails
5. Write the colocated `<language>.test.ts` against temp dirs holding the marker and config files — one case per sniff branch, both the configured and the `null` outcome
6. Run `npm run skills:sync`: the `gates` block in `skills/*/references/gates.md` renders the coverage, narrowing, and allowed-command tables from `STACKS`, and `npm run skills:check` stays red until it is synced
7. Document the row in `docs/FEATURES.md` § Validation and in `docs/CONFIGURATION.md` under `validation.stack`

No plugin API: the registry is a closed array, the same way `RUNNER_KINDS` is a closed set.

---

## 14. New workflow hook event

1. Add the event name to `HookEventSchema`
   - Names follow the convention: `pre_*`, `post_*`, `on_*`
2. For `pre_*` hooks (blocking, before the action happens):
   - Call `runPreHooks()` at the orchestrator call site
   - `runPreHooks()` returns `{ allow: boolean; reason?: string }` — abort the action if `allow` is false
3. For `post_*` / `on_*` hooks (fire-and-forget, after the action):
   - Add a mapping case in `eventToHookKey()`
   - The hook sink subscribes to the EventBus and dispatches automatically when the matching EngineEvent fires
4. Document in `docs/HOOKS-CONFIG.md`

---

## 15. CLI and provider admission checklists

Canonical support matrices live in [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) and [CONFIGURATION.md](./CONFIGURATION.md). Extension work must follow the closed architectural constraints and ordered checklists below — not independent exhaustive lists in secondary guides.

### Architectural constraints

- **One runner-kind set:** `cli`, `api`, `shell`, `agent` (`RUNNER_KINDS`). New backends pick an existing kind; do not add a fifth runner kind.
- **No argv DSL or plugin framework:** each CLI adapter owns its vendor argv grammar in a dedicated module. Do not build a generic argv insertion DSL or broad plugin loader.
- **One OpenAI transport:** hosted API providers use the `openai-stream` transport only. Do not add a second generic OpenAI-compatible streaming transport.

### CLI admission checklist

Complete in order before registering in `CLI_PLANNER_ADAPTERS` / `CLI_IMPLEMENTER_ADAPTERS`:

1. **Core descriptor** — add `CliToolDescriptor` to `CLI_TOOL_CATALOG` with stable `id`, display name, install URL, and dated compatibility evidence (`asOf`).
2. **Supported roles, model, auth, posture** — declare `roles`, per-role `CliModelPolicy`, `CliAuthPolicy`, direct-write/trust/permission posture, and shell/network/approval/sandbox facts. Unsupported role pairs fail schema validation.
3. **Trusted identity** — `resolveCliExecutable` resolves one absolute real path; probe and execution reuse that identity.
4. **Probe** — bounded, non-billable version/auth probe with neutral cwd when the upstream contract allows it.
5. **Lossless transport** — `CliPromptTransport`: `stdin`, the only transport. An argument that holds a prompt placeholder is refused. The Task Brief reaches the child byte-for-byte or execution fails before spawn.
6. **Args conflicts** — user `args` have a documented insertion position; conflicts with prompt transport, output protocol, permission mode, model policy, or terminal behavior are rejected pre-spawn.
7. **Parser/terminal** — structured protocols require the documented terminal event; text protocols may use process exit plus direct-change proof only when the admitted fixture documents no stable terminal envelope.
8. **Env** — `createSandboxEnv` allowlists runtime env plus only the descriptor auth channel (the per-tool state allowlist itself is `CLI_STATE_PATHS`); never copy ambient secrets. A private HOME under `.splitbrief/sandbox/<role>/` is the default and the only thing a new tool should assume. The single sanctioned exception is a channel whose credential is an OS keychain item with no file to bridge: it declares `hostKeychainPlatforms` on the channel, `cliAuthChannelHostStateAccess()` maps that to `host-account`, and the child keeps the host `HOME`/`USER` while every other redirect stays. The Claude Code and Cursor Agent CLI `session` channels declare one today — see [API-KEYS.md](./API-KEYS.md#security-measures).
9. **Direct-change proof** — direct writers receive staged-cwd instructions; successful completion requires a real staged change, not stdout extraction alone.
10. **Common/live/eval gates** — pass the common CLI contract suite, any required credentialed live smoke, and implementation-quality/privacy evaluation before registration.
11. **Late registry/docs** — register in the CLI tool registry and update [PLANNERS-AND-IMPLEMENTERS.md](./PLANNERS-AND-IMPLEMENTERS.md) only after every gate above passes.

#### Raw/production transaction (CLI)

Admission evidence is a two-step transaction on the same role-singular `RawCliCandidateContract`:

1. **Raw** — `npx tsx scripts/cli-conformance.ts raw --contract-json '<json>' --record <json>` captures bounded version/auth/native output in a staged git project without parser, adapter, or registry. Writes candidate `id`, `role`, canonical contract SHA-256, and sanitized `rawCapture`.
2. **Production** — `npx tsx scripts/cli-conformance.ts production --module <module.ts> --role <planner|implementer> --record <same-json>` dynamically imports only the named adapter module, reuses the raw evidence, and appends `productionConformance`. Contract or identity mismatch fails the harness.

`OMIT` verdicts delete vendor sources; `PASS` retains them. Registration and docs are late steps — never before the transaction completes.

**Cwd leg.** `npx tsx scripts/cli-conformance.ts cwd --tool <id> [--model <id>] --record <json>` checks a registered implementer tool with one small model call. It runs the production argv and environment in a throwaway git project, with a neutral prompt to write `pwd` to a file. The file must land in that project; a write anywhere else is removed, recorded, and makes the verdict `OMIT`. A tool whose headless mode keeps its workspace apart from its cwd gets the seat directory on its own flag, pinned offline in `WORKSPACE_FLAGS` (`testing/integration/orchestrator/cli-adapter-contract.test.ts`). Its raw contract names that directory as a standalone `<PROJECT_DIR>` element, and the raw harness replaces it with the staged project's absolute path.

### Provider admission checklist

Complete in order before registering in `KNOWN_PROVIDERS`:

1. **Service/offering** — `ApiProviderDescriptor` with explicit `service` and `offering` (`payg`, `free-quota`, `coding-subscription`, `local`). Never infer offering from credential prefix alone.
2. **Endpoint** — `EndpointPolicy`; normalize and validate origin before client creation. Cross-origin redirects must not receive credentials.
3. **Credential** — `credentialEnv` and `credentialPrefix`; prefix or family mismatch fails before network access.
4. **Billing/privacy/asOf** — dated `billing`, `dataUse`, privacy/terms URLs in the descriptor. No runtime fetch of pricing, terms, or marketing pages.
5. **Policy** — `OpenAICompatPolicy` enables provider-specific request fields only when exact conformance fixtures prove them.
6. **Production conformance** — credentialed harness via `npx tsx scripts/provider-conformance.ts production …` reusing the same record as raw capture.
7. **Eval** — implementation-quality/privacy evaluation verdict is applied to runtime recommendation state before docs label a model recommended.
8. **Late registration** — until then, the conformance harness runs the candidate unregistered through `createUnregisteredOpenAICompatProvider()`. Add it to `API_PROVIDER_CATALOG` and `KNOWN_PROVIDERS` and document it in [CONFIGURATION.md](./CONFIGURATION.md) and [API-KEYS.md](./API-KEYS.md) only after every gate above passes.

#### Raw/production transaction (provider)

Same two-step transaction on `RawProviderCandidateContract`:

1. **Raw** — `npx tsx scripts/provider-conformance.ts raw --contract-json '<json>' --record <json>` captures the credentialed request/stream terminal in a neutral harness without registry registration.
2. **Production** — `npx tsx scripts/provider-conformance.ts production --module <module.ts> --record <same-json>` imports only the named provider module and appends `productionConformance` to the same record.

Fixed admission order for both CLI and API slices:

`primary-source record → deterministic fixtures → credentialed production-path smoke → implementation-quality/privacy evaluation → central registration/docs`

---

## 16. New halt reason

A halt reason is a `RecoveryReason`: the run stops on it and the operator picks the next action. Do these steps in this order. `checkout-changed` is the latest example: follow its change set.

1. Add the reason to `RECOVERY_REASONS`. The type check then finds every exhaustive `switch` that must name it.
2. Map the reason onto its halt in `REASON_HALT`: `needs-you` when the operator must decide, `seat-down` when the seat cannot run. The halt fixes the actions the reason may offer (`allowedActionsForHalt`), and the builder picks its subset with `haltActions()`.
3. Give the reason its headline in `formatRecoveryHeadlineSpans()`. The headline names what stopped and on which brief or tool. It never blames an actor that the evidence cannot identify. The `recovery_prompted` event and the at-rest byline read these spans. `formatRecoveryHeadline()` projects them to text.
4. If an implementer call reports the halt, add the same string to `RUNNER_OUTCOME_STATES` and give it a remediation in `defaultRemediation()`. Then add it to `failureStateFromCode()`. The pipeline returns the state as the `outcome` of the `ImplementerResult`.
5. Write the builder in `src/engine/orchestrator/recovery/builders/`. The message is the one line that the transcript, `session.jsonl` and the headless `<halt> (<reason>): …` line print, so it carries the evidence. The details are the fact rows of the panel. Register a runner-outcome builder in `RUNNER_DEFECT_BUILDERS` (`builders/runner-outcome.ts`). The first attempt and every rung of the retry ladder then halt on it, and no retry is spent.
6. Change `recoveryCauseParts()` only when the message carries evidence that the first fact row already shows. `formatRecoveryHeaderParts()` adds the halt state to those cause spans. The header then shows the headline, and the panel does not say the evidence twice.
7. Update the docs. Add a row to the recovery table in [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#recovery) and add the reason to the list in [WORKFLOW.md](./WORKFLOW.md). For a runner outcome, add a row to the runner `state` table in [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) and add the state to `RUNNER_WORKFLOW_STATES` in `testing/docs/troubleshooting.test.ts`. The test compares the row with `defaultRemediation()`. When the action set has `switch-seat`, add the reason to the `switch-seat` lists in APPROVAL-AND-RECOVERY.md and [FEATURES.md](./FEATURES.md).
8. Add the tests. Put one case each in `halt.test.ts`, `headline.test.ts`, the test file next to the builder in `builders/`, and `builders/runner-outcome.test.ts` (`recoveryBuilderForRunnerOutcome`), `task/implementation-failure.integration.test.ts` and `escalation/held-correction.integration.test.ts`. For a runner outcome, add the state to the taxonomy lists in the runner error tests and `testing/integration/orchestrator/cli-adapter-contract.test.ts`.
9. Render the panel. Add a `workflow-recovery-<reason>` scenario to `testing/visual/catalog.ts`, run `npm run tui-shots -- --scenario <id>` and read the PNG (see the look-and-logic loop in `CLAUDE.md`).
