# B07 — Providers / planners / runners parameter objects

> Implement **only this brief**. Never run `git add`, `git stage`, `git commit`, or
> `git stash`. Do not revert other briefs' edits or the user's changes. This brief is
> self-contained — everything you need is inlined below; you should not need the full
> audit, but it lives at `docs/audits/sota-quality-audit-opus-2026-05-28.md` if you want
> a row's full description.

## Goal

Convert the positional-parameter signatures across the planner, provider, and runner
layers to named option objects (the dominant Parameter-Design category for these files),
plus the small set of structured-error / DRY / reusability fixes that live in the same
files. The keystone is the `Planner` **interface** in `planners/types.ts`: today its 5
core methods take 4–5 positional args each, forcing every backend and call site into
brittle positional shapes. After this brief the interface, its sole implementation
(`createPlannerBase` in `planners/base.ts`), and all 10 call/dispatch sites pass single
typed option objects; the provider cost-math and catalog-merge helpers take option
objects; the OpenAI-compat factory drops the dead `isLocal` flag; the agent-SDK factory
loader is deleted in favour of the backend's structured error; `agent.ts` delegates to
`command-based`; and `isSameOrigin` is single-sourced in `core/providers/catalog.ts`.
Behavior is unchanged except where a finding explicitly fixes a bug; this is a
signature/structure refactor.

## Wave / ordering

- **Wave:** 4. **Runs after:** B01 (formatting sweep — all edits land in formatted
  files), B02 (type-safety gate + exhaustiveness; `factory.ts` already carries B02's
  `assertNever` in the kind switch), B03 (schema/enum single-sourcing; the enums B07
  reads — `ProviderId`, `EffortLevel`, `PricingMode` — are stable by then). Also runs
  **before B10**, which renames/splits `providers/pricing.ts` → `cost.ts` (D9): B10
  rebases its split onto the `calculateUsageCost` signature B07 lands here. Also runs
  **before B09**, which threads `modelCache` into `predictCost` and deletes
  `getProviderPricing` (D8): B07 converts only the local `cost-prediction.ts` helper
  signature and must leave the cache/`getProviderPricing` work for B09.
- **Decisions that bind this brief:**
  - **D9** — `providers/pricing.ts` will be renamed to `cost.ts` by B10. B07 changes
    signatures *inside* the current `pricing.ts` only; **do not rename the file or its
    importers' `.js` paths** — B10 owns that.
  - **D8** — `predictCost` cache threading and `getProviderPricing` deletion are **B09's**.
    B07 must **not** thread `modelCache` into `cost-prediction.ts` and **not** delete
    `getProviderPricing`.
  - **D13** — the validator re-derives each finding from the diff; address every row
    below in code, not in prose.

## File ownership

**Edit (B07 owns fully):**
- `src/engine/planners/types.ts` — add `PlanOptions`/`EscalateOptions`/`RegenerateOptions`;
  convert the 5 core `Planner` interface methods (PD-15).
- `src/engine/planners/base.ts` — convert `createPlannerBase`'s implementation of those
  methods to the new option objects (the sole `Planner` implementation; required for
  PD-15 to typecheck).
- `src/engine/planners/api.ts` — `invokeApi` single options object (PD-16).
- `src/engine/planners/escalation.ts` — one `EscalateOptions`-shaped `escalateHint`/
  `escalateFull` (PD-17).
- `src/engine/planners/agent.ts` — delegate to command-based; option-object invoke (PD-23, DRY-19).
- `src/engine/planners/agent-sdk.ts` — `createAgentSdkPlanner` option object spreading
  `config.planner` (PD-23).
- `src/engine/planners/claude-code.ts` — `createClaudeCodePlanner` option object (PD-23).
- `src/engine/providers/openai-compat.ts` — drop `isLocal` param (PD-18 / YA-01).
- `src/engine/providers/pricing.ts` — `calculateUsageCost` token-counts option object +
  align `recordProviderCost`/`recordPricedUsage` family (PD-19). **Signatures only — no
  rename, no split (D9, B10).**
- `src/engine/providers/pricing-resolver.ts` — `makePricedResult` option object (PD-41b).
- `src/engine/providers/model/catalog.ts` — `mergeCatalogEntries` named `sources` object (PD-22).
- `src/engine/orchestrator/budget/cost-prediction.ts` — `estimateImplementerCost` option
  object (PD-20). **Do NOT thread `modelCache` or delete `getProviderPricing` (D8, B09).**
- `src/engine/spec/prompt-formatter.ts` — `formatTaskPrompt`/`formatRetryPrompt` option
  objects (PD-21).
- `src/engine/runners/factory.ts` — delete the redundant agent-SDK loader; reuse the
  backend's structured error (EH-09 / DRY-06). **Keep B02's `assertNever`/default arms.**
- `src/engine/runners/command-based.ts` — fold trailing positionals of
  `invokeCommandBasedRunner` into `opts` (PD-25).
- `src/engine/implementers/base.ts` — `processImplementerOutput` option object (PD-41b);
  swap inline `readFileSnapshot` for `readFileSafeAsync` (DRY-38).
- `src/core/providers/catalog.ts` — add guarded `isSameOrigin` (RU-14, producer).

**Edit for one concern only — shared with other briefs (read post-prior-brief state, change ONLY my concern, never revert):**
- `src/engine/orchestrator/planning/shared.ts` — **B06** owns the function param-objects
  here; **B07 touches ONLY the `planner.plan(...)` / `quickPlan` invocation argument
  shape** at lines ~149–153 (the `quickPlanFn.call(...)` + `planner.plan(...)` calls).
- `src/engine/orchestrator/planning/rewind.ts` — **B06** owns the function param-objects;
  **B07 touches ONLY the two `planner.regenerate(...)` call arguments** (~lines 40, 130).
- `src/engine/orchestrator/planning/instant.ts` — **B06** territory; **B07 touches ONLY
  the `instantFn.call(...)` invocation** (~line 60).
- `src/engine/orchestrator/escalation/run-escalation-tier.ts` — **B06** owns the function
  param-objects; **B07 touches ONLY the `ctx.planner.escalateHint(...)` /
  `ctx.planner.escalateFull(...)` call arguments** (~lines 145, 195).
- `src/engine/orchestrator/approval/approval.ts` — **B07 touches ONLY the
  `planner.regenerate(...)` call argument** (~line 59); the `Awaited<ReturnType<Planner['regenerate']>>`
  type reference is unaffected.
- `src/engine/orchestrator/planner-review.ts` — **B07 touches ONLY the `planner.review(...)`
  call** (~line 25), and only if `review` is converted (see Required changes step 2 — it
  is **kept positional**, so this file likely needs no change; verify against typecheck).
- `src/cli/commands/spec.ts` — **B07 touches ONLY the `planner.plan(...)` call argument**
  (~line 53).
- `src/engine/orchestrator/context-routing/assessment.ts` and `.../estimation.ts` — **B07
  touches ONLY the `formatTaskPrompt(...)` call argument** (PD-21 ripple); `context-routing`
  param-objects otherwise belong to B06 (PD-41a) — do not convert those functions.
- `src/engine/planners/command-invoke.ts` and `src/engine/implementers/command-invoke.ts` —
  **B07 touches ONLY the `invokeCommandBasedRunner(...)` call argument** (PD-25 ripple).
- `src/features/workflow/worker-packet-preview.ts` — **B09 owns this file (SRP-04); B07
  updates ONLY the `formatTaskPrompt(...)` call argument** so it compiles against PD-21's new
  signature. Read post-B09 state; never revert B09's edits.

**Edit (tests — update to the new shapes; part of this brief's gate):**
- `src/engine/providers/openai-compat.test.ts` — drop the 4th positional `false`
  (`isLocal`) arg in the ~8 `createOpenAICompatProvider(...)` calls.
- `src/engine/providers/pricing.test.ts` — update the 2 `calculateUsageCost(...)` calls to
  the option-object shape.
- `src/engine/runners/factory.test.ts` — align with the EH-09/DRY-06 error path if it
  asserts on the missing-package message (read it first; the structured error message text
  changes from the factory's wording to the backend's).
- Any planner backend test that calls `createApiPlanner`/`createAgentSdkPlanner`/
  `createClaudeCodePlanner` or the `Planner` methods positionally (grep — see step 12).

## Findings covered

| ID | Sev | file:line | Required change |
|---|:---:|---|---|
| PD-15 | high | `engine/planners/types.ts:131-201` | Introduce `PlanOptions`/`EscalateOptions`/`RegenerateOptions`; convert the 5 core `Planner` methods (`plan`, `quickPlan`, optional `instantPlan`, `regenerate`, `escalateHint`, `escalateFull`) to a single typed option object each. |
| PD-16 | high | `engine/planners/api.ts:26-35` | Replace `invokeApi`'s 9 positional params with one options object. |
| PD-17 | high | `engine/planners/escalation.ts:23-30` | Give `escalateHint`/`escalateFull` (module fns) one shared `EscalateOptions`-shaped object. |
| PD-18 | high | `engine/providers/openai-compat.ts:8-14` | Drop the `isLocal` parameter; pass an options object (same as YA-01). |
| PD-19 | high | `engine/providers/pricing.ts:17-23` | `calculateUsageCost` takes `{inputTokens,outputTokens,cacheReadTokens,cacheCreateTokens,pricing}`; align `recordProviderCost`/`recordPricedUsage` family to option objects. **Leave `calculateCost` (2 token args) untouched.** |
| PD-20 | high | `engine/orchestrator/budget/cost-prediction.ts:38` | `estimateImplementerCost` 6 positional → one options object. |
| PD-21 | high | `engine/spec/prompt-formatter.ts:155-160,178-185` | `formatTaskPrompt`/`formatRetryPrompt` take option objects. |
| PD-22 | high | `engine/providers/model/catalog.ts:106-111` | `mergeCatalogEntries(providerId, {bundled,runtime,modelsDev})` — named `sources` object. |
| PD-23 | h/m | `engine/runners/factory.ts:68` + `planners/{agent-sdk,claude-code}.ts` | `createAgentSdkPlanner`/`createClaudeCodePlanner` take an options object; factory spreads `config.planner` into it. |
| PD-25 | med | `engine/runners/command-based.ts:41` | Fold `invokeCommandBasedRunner`'s trailing `prompt,projectDir,onOutput,signal` positionals into `opts`. |
| PD-41b | l–m | `engine/implementers/base.ts:48` + `engine/providers/pricing-resolver.ts:75` | `processImplementerOutput` and `makePricedResult` take option objects. |
| EH-09 | med | `engine/runners/factory.ts:27-32` | Delete `agentSdkMissingError`; reuse the backend's structured `agent-sdk-not-installed` error (= DRY-06). |
| DRY-06 | high | `engine/runners/factory.ts:25-40` | Delete the factory's duplicate agent-SDK package loader (`loadAgentSdkPackage`/`ensureAgentSdkPackage`); let the backend's `loadSdk()` surface the install error (= EH-09). |
| DRY-19 | high | `engine/planners/agent.ts:17-47` | Make `createAgentPlanner` delegate its invoke to `command-based` via the shared option shape (= PD-23). |
| DRY-38 | med | `engine/implementers/base.ts:40-46` | Replace the inline `readFileSnapshot` with `readFileSafeAsync` from `lib/fs.ts`. |
| RU-14 | med | `engine/providers/registry.ts:77-82` + `core/config/load/validate.ts:98-105` + `core/providers/catalog.ts:23-26` | Add a guarded `isSameOrigin(candidate, expected)` to `core/providers/catalog.ts`; delegate both duplicate origin comparisons to it, preserving each caller's empty-input semantics. |
| YA-01 | med | `engine/providers/openai-compat.ts:12` | Remove the always-`false` `isLocal` flag (= PD-18). |

## Required changes

Do them in this order so the interface change compiles before its callers are touched.

### 1. Option types in `planners/types.ts` (PD-15)

Add (single-source so PD-17 reuses `EscalateOptions`):

```ts
export interface PlanOptions {
  feature: string;
  projectDir: string;
  callbacks: PlannerCallbacks;
  skillsContext?: string | undefined;
  codebaseContext?: string | undefined;
}

export interface EscalateOptions {
  task: Task;
  error: string;
  projectDir: string;
  callbacks: PlannerOutputCallbacks;
  languageContext?: LanguageContext | undefined;
}

export interface RegenerateOptions {
  prompt: string;
  artifactType: 'spec' | 'plan';
  projectDir: string;
  callbacks: PlannerOutputCallbacks;
}
```

Convert the interface methods:
- `plan(opts: PlanOptions): Promise<PlanResult>`
- `quickPlan(opts: PlanOptions): Promise<PlanResult>` (ignores `skillsContext`)
- `instantPlan?: (opts: PlanOptions) => Promise<PlanResult>` (ignores `skillsContext`)
- `regenerate(opts: RegenerateOptions): Promise<RegenerateResult>`
- `escalateHint(opts: EscalateOptions): Promise<EscalationResult>`
- `escalateFull(opts: EscalateOptions): Promise<EscalationResult>`

**Keep positional (out of PD-15 scope — the audit row enumerates only the "4–5
positional" methods):** `review(prompt, projectDir, callbacks)`, `summarize(...)`,
`summarizeStructured(...)`, `injectUserTurn(...)`. Leaving `review` positional means
`planner-review.ts` and `base.ts review` need no signature change.

### 2. `createPlannerBase` in `planners/base.ts` (PD-15 impl — mandatory)

Rewrite the returned object's `plan`/`quickPlan`/`instantPlan`/`regenerate`/`escalateHint`/
`escalateFull` to destructure the new option objects. Concretely:
- `async plan(opts: PlanOptions)` → destructure `{ feature, projectDir, callbacks, skillsContext, codebaseContext }`; the body is otherwise identical.
- `async quickPlan(opts: PlanOptions)` and `async instantPlan(opts: PlanOptions)` →
  forward to `runSinglePhasePlanning`. **Check `planning-helpers.ts:runSinglePhasePlanning`'s
  current parameter list** — it takes `(config, buildPrompt, phase, feature, projectDir,
  callbacks, codebaseContext)` positionally; either pass `opts.feature, opts.projectDir,
  opts.callbacks, opts.codebaseContext` through unchanged (keeps `runSinglePhasePlanning`
  positional — `planning-helpers.ts` is **not** in B07's scope, so prefer this) or, if it
  reads cleaner, that's fine — just do not change `runSinglePhasePlanning`'s own signature
  (B16 owns `planning-helpers` nits).
- `regenerate(opts: RegenerateOptions)` → destructure; `_artifactType` stays unused.
- `escalateHint(opts)` / `escalateFull(opts)` → call the module fns (see step 3) with the
  same option object.
- `review`/`summarize*` unchanged.

### 3. `escalation.ts` module fns (PD-17)

Change `escalateHint`/`escalateFull` to:

```ts
export async function escalateHint(config: PlannerEscalationConfig, opts: EscalateOptions): Promise<EscalationResult>
export async function escalateFull(config: PlannerEscalationConfig, opts: EscalateOptions): Promise<EscalationResult>
```

Destructure `{ task, error, projectDir, callbacks, languageContext }` inside. Update the
two call sites in `base.ts` (step 2) to pass the option object straight through.

### 4. `api.ts` `invokeApi` (PD-16)

Replace the 9 positional params with one object, e.g.:

```ts
async function invokeApi(opts: {
  client: StreamClient | null;
  model: string;
  planner: { provider: string; apiBase?: string | undefined; apiKey: string };
  prompt: string;
  onOutput: (text: string) => void;
  priorMessages?: PriorMessage[] | undefined;
  effort?: EffortLevel | undefined;
  images?: Attachment[] | undefined;
  signal?: AbortSignal | undefined;
}): Promise<InvokeResult>
```

Update the single internal caller (the `invoke` closure in `createApiPlanner`) to pass the
object. The closure already receives an options object from `base.ts`'s `InternalInvokeFn`
— do not change that internal `invoke` shape (it conforms to `PlannerBaseConfig.invokePlan`).

### 5. `openai-compat.ts` drop `isLocal` (PD-18 / YA-01)

`createOpenAICompatProvider` currently takes `(name, defaultBaseURL, envKeyName, isLocal,
overrides?)`. The flag is **always `false`** in production (`registry.ts:40,63`) and only
local providers (ollama, lm-studio) are local — they use bespoke factories that call
`createMetadataProvider` directly with `isLocal: true`. So `isLocal` here is dead.

Convert to an options object and drop `isLocal`:

```ts
export function createOpenAICompatProvider(opts: {
  name: string;
  defaultBaseURL: string;
  envKeyName: string;
  overrides?: ProviderOverrides;
}): ProviderDefWithMetadata
```

Pass `isLocal: false` through to `createMetadataProvider` internally (its `opts.isLocal`
stays required — do **not** edit `client.ts`). Update both `registry.ts` call sites
(40, 63) and the ~8 test calls (drop the `false` arg, switch to the object). This is the
RU-14 file too (see step 11) — keep the two edits separate within `registry.ts`.

### 6. `pricing.ts` `calculateUsageCost` + recorder family (PD-19)

- Change `calculateUsageCost` to a single object:

```ts
export function calculateUsageCost(opts: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  pricing: ResolvedPricing;
}): number
```

- Update its internal callers: `applyImplementerUsageCost` (~line 127),
  `calculateAggregateImplementerCost` (~line 154), `calculateTaskUsageCost` (~line 270),
  `calculateCostBreakdown` (~line 318), and the 2 `pricing.test.ts` calls.
- Align the two recorder helpers to option objects for swap-safety:
  `recordProviderCost(providerCosts, { tool, inputTokens, outputTokens, cost })` and
  `recordPricedUsage(providerCosts, { tool, inputTokens, outputTokens, cost, pricing })`.
  Update their call sites (within `pricing.ts` only).
- **Do NOT touch `calculateCost(inputTokens, outputTokens, pricing)`** — it has an external
  caller `orchestrator/budget/estimate.ts:92` (a B12-owned file) and the PD-19 anchor is
  line 17, not the `calculateCost` definition.
- **Do NOT rename `pricing.ts` or split it** (D9 → B10).

### 7. `pricing-resolver.ts` `makePricedResult` (PD-41b)

Convert the 6-positional `makePricedResult(modelId, input, output, source, cacheRead?,
cacheWrite?)` to one object `{ modelId, input, output, source, cacheRead?, cacheWrite? }`.
Update its 3 internal call sites (~lines 110, 122, 133).

### 8. `model/catalog.ts` `mergeCatalogEntries` (PD-22)

Change to `mergeCatalogEntries(providerId: ProviderId, sources: { bundled: ResolvedModelCatalogEntry[];
runtime: ResolvedModelCatalogEntry[]; modelsDev: ResolvedModelCatalogEntry[] })`. The body
iterates `sources.bundled.forEach(...)`, `sources.modelsDev.forEach(...)`,
`sources.runtime.forEach(...)` — preserve the **current insertion order** (bundled →
modelsDev → runtime), which the merge relies on. Update the one caller
`resolveCatalogEntries` (~line 191). (KISS-02 about resolving a stable id up front is
**B16's**, not this brief — leave the merge logic otherwise as-is.)

### 9. `cost-prediction.ts` `estimateImplementerCost` (PD-20)

Convert the 6-positional `estimateImplementerCost(taskCount, escalationRate, plannerTool,
implementerTool, plannerModel?, implementerModel?)` to one object. Update the 3 call sites
(`predictCost`, ~lines 62–64). **Do NOT** thread `modelCache` into `getProviderPricing`
calls and **do NOT** delete `getProviderPricing` — those are D8/B09. `cost-prediction.ts`
keeps importing `getProviderPricing` from `../../providers/pricing.js`.

### 10. `prompt-formatter.ts` `formatTaskPrompt`/`formatRetryPrompt` (PD-21)

- `formatTaskPrompt(opts: { task: Task; context: ProjectContext; contextLength?: number;
  languageContext?: LanguageContext })`.
- `formatRetryPrompt(opts: { task: Task; context: ProjectContext; error: string;
  attempt: number; contextLength?: number; languageContext?: LanguageContext })`.
- Update **all** call sites (verified by `grep -rln "formatTaskPrompt\|formatRetryPrompt" src`):
  - `engine/implementers/base.ts:119-122` (the `buildPrompt`/`buildRetryPrompt` defaults).
  - `engine/orchestrator/context-routing/assessment.ts:38` — `formatTaskPrompt(opts.task, opts.context, contextLength, languageContext)`.
  - `engine/orchestrator/context-routing/estimation.ts:13` — `formatTaskPrompt(opts.task, opts.context, opts.contextLength, languageContext)`.
  - `engine/spec/formatter.test.ts` — ~20 `formatTaskPrompt(...)` + 4 `formatRetryPrompt(...)` calls.
  - `engine/orchestrator/context-routing/estimation.test.ts:36`.
  - `features/workflow/worker-packet-preview.ts:140,213` — **B09 owns the broader refactor of
    this file (SRP-04); B07 updates ONLY the `formatTaskPrompt(...)` call argument** so it
    compiles against the new signature. Read post-B09 state; if B09 already moved/changed the
    call, just make it match the new signature and mark PD-21 satisfied for this file.
  These are pure call-shape updates (positional → object); no behavior change.

### 11. RU-14 — single-source `isSameOrigin`

- In `core/providers/catalog.ts` add:

```ts
export function isSameOrigin(candidate: string, expected: string): boolean {
  try {
    return new URL(candidate).origin === new URL(expected).origin;
  } catch {
    return false;
  }
}
```

- `engine/providers/registry.ts:77-82` `isSameProviderBaseURL`: delete it; at its call site
  (`rejectApiBaseExfiltration`, ~line 70) keep the existing **empty → false** behavior by
  guarding before delegating: `if (!overrides.apiBase || !info.baseURL) ...` already returns
  early via the surrounding logic — verify, then call `isSameOrigin(overrides.apiBase,
  info.baseURL)`. Import `isSameOrigin` from `../../core/providers/catalog.js`.
- `core/config/load/validate.ts:98-105` `isSameProviderOrigin`: delete it; preserve its
  **both-empty → true** semantics at the call site `envRecommendedForApiProvider` (~line 111):
  `if (!apiBase || !info.baseURL) return true; return isSameOrigin(apiBase, info.baseURL);`.
  Import `isSameOrigin` from `../../providers/catalog.js`.
- `validate.ts:117` in the RU-14 row is a stray cross-reference (the agent-sdk `switch`
  case) — **no change there**.

### 12. EH-09 / DRY-06 — `factory.ts` agent-SDK error dedup

- Delete `agentSdkMissingError`, `ensureAgentSdkPackage`, `loadAgentSdkPackage`, and the
  `AGENT_SDK_PACKAGE` const.
- Remove the two `await ensureAgentSdkPackage();` calls in the `agent-sdk` arms of
  `loadPlanner` (~line 66) and `createImplementer` (~line 103). **Both arms remain safe**
  because both backends route through `loadSdk()`, which throws the structured
  `error('agent-sdk-not-installed', …)` lazily on first invoke:
  - Planner: `createAgentSdkPlanner` → `createAgentSdkBackend` → `backend.invoke` →
    `loadSdk()` (`agent-sdk-backend.ts`).
  - Implementer: `implementers/agent-sdk.ts` imports `createAgentSdkBackend` (line 4) and
    builds the backend (line 11) → same `backend.invoke` → `loadSdk()`.
  So the install error still surfaces on both paths, from one place. Keep B02's `default:`
  arms (`throw runnerConfigError.invalidKind(...)`) and the `assertNever`/exhaustiveness
  intact.
- Read `factory.test.ts` first: if it asserts the missing-package message text, the message
  becomes "Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk"
  (the backend's wording). Update the assertion. If the test triggered the error by calling
  `createPlanner`/`createImplementer` (which no longer eagerly checks), adjust it to drive
  the error through an invoke, or assert the construction succeeds — match the test's intent.

### 13. PD-23 — agent-sdk / claude-code factory option objects + spread

- `createAgentSdkPlanner(opts: { model?: string; apiKey?: string; initialSessionId?: string | null;
  effort?: EffortLevel })`. Update the body to read `opts.model` etc.
- `createClaudeCodePlanner(opts: { model?: string; initialSessionId?: string | null;
  effort?: EffortLevel })`.
- In `factory.ts loadPlanner`, call with a spread of `config.planner` fields:
  `mod.createAgentSdkPlanner({ model: config.planner.model, apiKey: config.planner.apiKey,
  initialSessionId, effort: config.planner.effort })` (~line 68) and the analogous
  claude-code call (~line 48, no `apiKey`). The `config.planner` union is already narrowed
  by `kind` at those arms.
- The only production callers are those two factory arms (verified by
  `grep -rn "createAgentSdkPlanner\|createClaudeCodePlanner" src --include="*.ts"`). Re-run
  that grep and update any **test** callers (e.g. planner/factory tests) to the option-object
  shape — `createApiPlanner`/`createAgentPlanner` keep `(config)` and are unaffected.

### 14. DRY-19 / PD-23 — `agent.ts` delegate to command-based

`createAgentPlanner`'s `invoke` already calls `invokeCommandBasedRunner` — after step 15
folds that runner's trailing positionals into `opts`, update this `invoke` to pass the new
single options object (`{ command, args, outputFormat, notFoundMessage, prompt, projectDir,
onOutput, signal }`) instead of the positional tail. Keep the `onQuestion` post-processing.
This is the "delegate to command-based via the shared option shape" the DRY-19 row asks for.

### 15. PD-25 — `command-based.ts` fold trailing positionals

Change `invokeCommandBasedRunner(opts, prompt, projectDir, onOutput?, signal?)` to a single
object that extends the current `CommandBasedOptions` with the run inputs:

```ts
export async function invokeCommandBasedRunner(opts: CommandBasedOptions & {
  prompt: string;
  projectDir: string;
  onOutput?: ((chunk: string) => void) | undefined;
  signal?: AbortSignal | undefined;
}): Promise<CommandBasedResult>
```

Update the body to read `opts.prompt`/`opts.projectDir`/`opts.onOutput`/`opts.signal`.
Update **all** callers (verified by `grep -rln "invokeCommandBasedRunner" src`):
`engine/planners/agent.ts` (step 14), `engine/planners/command-invoke.ts:40`,
`engine/implementers/command-invoke.ts:34`, and `engine/runners/command-based.test.ts`.
Each currently passes `(runnerOpts, prompt, projectDir, onOutput, signal)` positionally —
fold those tail args into the single object.

### 16. PD-41b / DRY-38 — `implementers/base.ts`

- DRY-38: delete the local `readFileSnapshot` (lines ~40–46); import `readFileSafeAsync`
  from `../../lib/fs.js` (its body is identical: `try readFile utf-8 catch return null`).
  Replace both uses (`processImplementerOutput` baseline read, `runPipeline` oldContent read).
- PD-41b: convert `processImplementerOutput(text, task, projectDir, approvedBaselineContent,
  approveWrite?)` to one object `{ text, task, projectDir, approvedBaselineContent,
  approveWrite? }`; update its single caller in `runPipeline` (~line 184).

### 17. Update the remaining `Planner` call sites (PD-15 ripple)

Convert each to the new option object. Exact current → new:

- `cli/commands/spec.ts:53`
  `planner.plan(feature, projectDir, { onOutput, onPhase, sessionId })`
  → `planner.plan({ feature, projectDir, callbacks: { onOutput, onPhase, sessionId } })`.
- `orchestrator/planning/shared.ts:149-150` (quick mode dispatch):
  `const quickPlanFn = planner.quickPlan ?? planner.plan;`
  `const result = await quickPlanFn.call(planner, prompt, projectDir, plannerCallbacks, codebaseContext);`
  → `const result = await quickPlanFn.call(planner, { feature: prompt, projectDir, callbacks: plannerCallbacks, codebaseContext });`
  (the option object eliminates the positional-slot mismatch between `plan` and `quickPlan`).
- `orchestrator/planning/shared.ts:153`
  `planner.plan(prompt, projectDir, plannerCallbacks, skillsContext, codebaseContext)`
  → `planner.plan({ feature: prompt, projectDir, callbacks: plannerCallbacks, skillsContext, codebaseContext })`.
- `orchestrator/planning/instant.ts:60`
  `const instantFn = planner.instantPlan ?? planner.quickPlan ?? planner.plan;`
  `await instantFn.call(planner, feature, projectDir, plannerCallbacks, opts.codebaseContext)`
  → `await instantFn.call(planner, { feature, projectDir, callbacks: plannerCallbacks, codebaseContext: opts.codebaseContext })`.
- `orchestrator/planning/rewind.ts:40`
  `planner.regenerate(regenPrompt, 'spec', projectDir, { onOutput, signal })`
  → `planner.regenerate({ prompt: regenPrompt, artifactType: 'spec', projectDir, callbacks: { onOutput, signal } })`.
- `orchestrator/planning/rewind.ts:130` — same shape with `artifactType: 'plan'`.
- `orchestrator/approval/approval.ts:59`
  `planner.regenerate(regenPrompt, type, projectDir, { onOutput, signal })`
  → `planner.regenerate({ prompt: regenPrompt, artifactType: type, projectDir, callbacks: { onOutput, signal } })`.
- `orchestrator/escalation/run-escalation-tier.ts:145`
  `ctx.planner.escalateHint(initialTask, lastError, ctx.projectDir, { onOutput, signal }, languageContext)`
  → `ctx.planner.escalateHint({ task: initialTask, error: lastError, projectDir: ctx.projectDir, callbacks: { onOutput, signal }, languageContext })`.
- `orchestrator/escalation/run-escalation-tier.ts:195`
  `ctx.planner.escalateFull(t, err, projectDir, { onOutput: textHandler, signal }, languageContext)`
  → `ctx.planner.escalateFull({ task: t, error: err, projectDir, callbacks: { onOutput: textHandler, signal }, languageContext })`.
- `planner-review.ts:25` `planner.review(prompt, projectDir, { ... })` — **unchanged**
  (`review` stays positional).

After editing, run `grep -rn "\.plan(\|\.quickPlan(\|\.instantPlan(\|\.regenerate(\|\.escalateHint(\|\.escalateFull(" src --include="*.ts"` and confirm every match (incl. `*.test.ts`) passes the new option object. Update any positional test call.

## Out of scope (owned elsewhere — do NOT touch)

- **`providers/pricing.ts` rename → `cost.ts` and the file split** → **B10** (D9). Signatures
  only here.
- **`predictCost` `modelCache` threading + `getProviderPricing` deletion** in
  `cost-prediction.ts`/`pricing.ts` → **B09** (D8, AR-01).
- **`calculateCost` (2 token args) signature** → leave as-is (external caller in
  `estimate.ts`, a B12 file).
- **`PD-38` (`spec/prompts/{constitution,analyze}.ts` typed input)** → **B08** (the PD-38
  row is assigned to B08 and B08's file scope lists those files; the "PD-38?" in the B07
  coverage line resolves to B08).
- **Function param-objects in `planning/shared.ts`, `planning/rewind.ts`,
  `planning/instant.ts`, `run-escalation-tier.ts`** → **B06**. B07 changes only the
  `planner.<method>(...)` invocation arguments in those files.
- **`KISS-02` (resolve stable id up front in `catalog.ts`)** → **B16**.
- **`client.ts` `createMetadataProvider`/`createProviderShell` `isLocal` param** → leave
  required; the local providers legitimately pass `isLocal: true`.
- **`runners/factory.ts` `assertNever`/switch exhaustiveness** → **B02** already landed it;
  preserve it.
- **`planning-helpers.ts` `runSinglePhasePlanning` signature** → not B07; pass through
  positionally.

## Acceptance criteria

- [ ] Every finding ID above (PD-15,16,17,18,19,20,21,22,23,25,41b; EH-09; DRY-06,19,38;
  RU-14; YA-01) is addressed in the code.
- [ ] `Planner` interface's 5 core methods take single option objects; `createPlannerBase`
  implements them with the new shapes; `review`/`summarize*`/`injectUserTurn` remain
  positional.
- [ ] All 9 mutated `planner.<method>(...)` call sites + the 2 dispatch fallbacks
  (`shared.ts`/`instant.ts`) pass the new option objects; `planner.review(...)` is the only
  unchanged one.
- [ ] `createOpenAICompatProvider` no longer accepts `isLocal`; `registry.ts` (×2) and the
  `openai-compat.test.ts` calls compile against the new options object.
- [ ] `calculateUsageCost` takes the token-counts object; `calculateCost` is unchanged; the
  recorder family takes objects; `pricing.ts` is **not** renamed/split.
- [ ] `cost-prediction.ts` still imports `getProviderPricing` and does **not** thread
  `modelCache` (D8 deferred to B09).
- [ ] `factory.ts` has no agent-SDK loader/`agentSdkMissingError`; the missing-package error
  is produced solely by `agent-sdk-backend.ts:loadSdk()`; both factory dispatchers keep
  their `default`/`assertNever` arms.
- [ ] `agent.ts` delegates via the command-based options object; `invokeCommandBasedRunner`
  takes a single object.
- [ ] `implementers/base.ts` uses `readFileSafeAsync` (no local `readFileSnapshot`);
  `processImplementerOutput` takes an object.
- [ ] `isSameOrigin` is exported from `core/providers/catalog.ts` and used by both prior
  duplicates; each call site preserves its original empty-input semantics (registry: empty
  → not-same; validate: both-empty → recommended).
- [ ] No new `!`/broad `as`/`any`/barrels/non-`Error` classes/memoization; `.js` imports on
  every relative import; `engine/` imports nothing from `react`/`ink`/`features`; no
  decorative comments added.
- [ ] `npm run typecheck` and `npm run lint` pass.
- [ ] Affected tests pass (added/updated where behavior or signatures changed).

## Tests

```bash
npm test -- src/engine/planners src/engine/providers src/engine/runners \
  src/engine/implementers src/engine/spec/formatter.test.ts \
  src/engine/orchestrator/budget/cost-prediction.test.ts \
  src/engine/orchestrator/context-routing/estimation.test.ts \
  src/engine/orchestrator/planning src/engine/orchestrator/escalation \
  src/engine/orchestrator/approval src/core/config/load/validate.test.ts \
  src/core/providers
npm run typecheck
npm run lint
```

Note: `prompt-formatter` is tested by `src/engine/spec/formatter.test.ts` (there is no
`prompt-formatter.test.ts`).
