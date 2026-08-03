# Planners and implementers

How the two roles are created, what interfaces they expose, how the five runner kinds work, and how to add a new backend.

---

## Two roles, one factory

Both roles are created by `src/engine/runners/factory.ts`:

- `createPlanner(config, { preparedConfig, preparationId, gates, slot, initialSessionId?, ... })` returns a `Planner`
- `createImplementer(config, { preparedConfig, preparationId, gates, slot, ... })` returns an `Implementer`

Both option objects are required. `config` and `preparedConfig` must be the same object returned by execution preparation; the factory rejects a different configuration even when its runner has the same tool, provider, endpoint, or command identity. The selected slot lets the implementer factory derive named-profile and intermediate configuration from that prepared snapshot.

Factory dispatch is async and lazy. Backend modules load via memoized dynamic imports (`lazy()` wrapper), so startup only imports the configured kind. If you set `kind: api` for your planner, the `cli`, `shell`, `agent`, and `agent-sdk` modules never load.

The factory reads `config.planner.kind` and `config.implementer.kind` to pick a backend. Each backend is a thin module that calls `createPlannerBase()` or `createImplementerBase()` with a backend-specific invoke function and a capabilities struct.

### Execution preparation and runner gates

Local execution is admitted by `prepareExecution()` in `src/engine/runners/prepare-execution.ts`, not by the discovery cache or picker state. It parses and recursively freezes the exact effective config, evaluates the runner contexts required by the command, and returns one prepared bundle containing the readiness report, configuration, `preparationId`, session reference, and generic `gates`. Factories reject a gate whose preparation, slot, kind, or safe runner identity does not match that bundle.

`gates` is an exhaustive per-kind union:

| `kind` | Authority carried into execution |
|---|---|
| `cli` | Fresh exact-context trust, compatibility, authentication, and executable receipt. The executable identity is resolved again before session creation and revalidated immediately before each spawn. |
| `api` | The current provider credential and endpoint-policy validation, bound to the provider and endpoint origin. |
| `agent-sdk` | The current SDK installation and credential validation, bound to the provider. |
| `shell` | The current configured-command trust/admission result. |
| `agent` | The current configured-command trust/admission result. |

Non-CLI gates reuse the validation or admitted invocation already produced during that preparation; execution does not turn cached discovery into a second authority decision. Every gate is also bound to its exact role: planner, intermediate escalation runner, or named implementer profile. New workflows and resumes prepare the planner, every configured implementer profile, and the configured intermediate runner when enabled. `spec` prepares only the planner.

Entry points express policy differences while sharing this boundary. Interactive CLI starts, Home, and Setup use disclosure/approval policy. JSON, RPC, and detached starts use headless policy, which denies unverified authentication unless the caller explicitly enables it. Resume reauthorizes the existing session's required runner contexts without creating another session. An attached TUI is only a client for a workflow already running elsewhere, so it uses an explicit attached route and does not perform local runner admission.

---

## The Planner interface

Defined in `src/engine/planners/types.ts`. Every planner implements:

```typescript
interface Planner extends RunnerRuntime {
  plan(feature, projectDir, callbacks, skillsContext?, codebaseContext?): Promise<PlanResult>
  quickPlan(feature, projectDir, callbacks, codebaseContext?): Promise<PlanResult>
  instantPlan?(feature, projectDir, callbacks, codebaseContext?): Promise<PlanResult>
  regenerate(prompt, artifactType, projectDir, callbacks): Promise<RegenerateResult>
  escalateHint(task, error, projectDir, callbacks, languageContext?): Promise<EscalationResult>
  escalateFull(task, error, projectDir, callbacks, languageContext?): Promise<EscalationResult>
  review(prompt, projectDir, callbacks): Promise<{ text: string; usage: TokenDelta | null }>
  summarize(messages, projectDir?): Promise<string>
  summarizeStructured?(messages, previousSummary?, projectDir?): Promise<{ text: string; structured: StructuredSummary | null }>
  injectUserTurn?(text, projectDir): Promise<void>
  readonly capabilities: PlannerCapabilities
}
```

`plan()` runs the full 4-phase pipeline: research, spec, plan, tasks. `quickPlan()` collapses that into one call. `instantPlan()` is optional -- backends that don't implement it fall back to `quickPlan` via the dispatcher.

`escalateHint()` and `escalateFull()` handle tiered escalation when the implementer fails. Both prompt builders include a **Similar Issues** section with language-matched few-shot examples selected by keyword scoring against the error text (`src/engine/spec/prompts/escalation-examples.ts`). `regenerate()` re-runs spec or plan after user comments. `review()` does the final review pass.

`PlanResult` is the return type for all planning methods:

```typescript
interface PlanResult {
  spec: string
  plan: string
  tasks: Task[]
  usage: TokenDelta | null
  phases?: PhaseResult[]
}
```

The `tasks[]` array is the durable contract. `spec` and `plan` are supporting documents for human review -- they may be empty in instant/quick modes.

---

## Planner capabilities

The orchestrator reads capabilities, not backend identity, to decide what's possible. This replaces if-chains on backend type.

| Capability | What it gates |
|---|---|
| `supportsConversationalPlanning` | Planner can emit inline clarification questions during planning |
| `supportsHintEscalation` | Planner can produce a short hint before full escalation |
| `supportsSessionResume` | Backend exposes a reusable session handle (Claude `--session-id`, Codex exec resume) |
| `supportsEffort` | Backend honors effort/reasoning hints (thinking budget, `reasoning_effort`) |
| `supportsImages` | Backend can accept image attachments (vision models) |
| `supportsSelfSummarisation` | Planner can summarize its own prior transcript for compaction |

Two presets exist for common patterns:

- `CONVERSATIONAL_CAPS` -- all true. Used by Claude Code, Agent SDK, Codex.
- `ONE_SHOT_API_CAPS` -- conversational planning off, session resume off, effort/images off. Used by API backends.

When a capability is missing, the orchestrator falls back. No session resume means context is rebuilt from the JSONL log. No conversational planning means no inline Q&A. No image support means attachments are dropped with a `planner_attachments_dropped` event.

---

## Planner base pipeline

`src/engine/planners/base.ts` -- `createPlannerBase(config)`.

Wraps a backend-specific `invokePlan()` function with the standard 4-phase pipeline:

1. **Research** -- `buildResearchPrompt()`. Repo map injected as `<repo-map>` block. Image attachments delivered on this first phase only.
2. **Spec** -- `buildSpecPrompt()`. Language context extracted from research output.
3. **Plan** -- `buildPlanPrompt()`. Project context and skills context injected.
4. **Tasks** -- `buildTasksPrompt()`. Output is markdown that gets parsed into `Task[]`.

Each phase:
- Calls `callbacks.onPhase()` so the UI can update
- Creates a transcript buffer (16KB, flushed to `session.jsonl`)
- On resume, injects prior messages into the first phase. API backends receive them as an OpenAI messages array (`consumesPriorMessages: true`). CLI backends get a prompt-level prefix.
- Converts the backend response into `RunnerCallResult` immediately, then accumulates token usage from the typed call result
- Returns artifact text via `readPhaseOutput()` (backends that write files to disk) or raw stdout

The `quickPlan()` and `instantPlan()` paths skip straight to a single-phase call using `buildQuickPlanPrompt()` or `buildInstantPrompt()` respectively. Same pipeline machinery, one invocation instead of four.

Planner backend invoke functions return `RunnerCallResult`. Use `toInvokeResult()` only at outer legacy postprocess/extraction boundaries that explicitly need `{ text, usage }`; do not collapse typed call results before they reach the planner base. New adapters must emit typed call results directly and set `backendKind` (`api`, `cli`, `shell`, `agent`, or `agent-sdk`).

---

## The Task Brief

Defined in `src/core/schemas/task.ts`. The schema is the persisted transport for Product Task Brief v1. Nine semantic sections:

| Section | Schema fields | Markdown header in `tasks.md` |
|---|---|---|
| Identity | `id`, `title`, `action`, `file`, `dependsOn` | YAML frontmatter |
| Intent | `description` | `### Description` |
| Scope | `scope.inBounds`, `scope.outOfBounds`, `scope.approvedOutOfBounds` | `### Scope` |
| Code Context | `signature`, `currentCode`, `typeDefs`, `pattern` | `### Signature`, `### Current Code`, `### Type Definitions`, `### Pattern` |
| Implementation Plan | `implementationSteps` | `### Implementation Steps` |
| Validation | `tests` | `### Tests` |
| Constraints | `constraints` | `### Constraints` |
| Escalation | `escalation` | `### Escalation` |
| Evidence | `evidence` | `### Evidence` |

The planner outputs briefs as markdown in `tasks.md`. The parser (`src/engine/spec/tasks/parse.ts`, with `blocks.ts` and `sections.ts`) splits blocks by `---` separators, extracts YAML frontmatter per block, reads `###`-headed sections, and toposorts the result by `dependsOn`.

Here is what a single brief looks like in `tasks.md`:

````markdown
---
id: T001
title: Add provider guard tests
action: modify
file: src/core/schemas/enums.test.ts
depends_on: []
---

### Description
Add focused Vitest coverage for the provider guard helpers
in `src/core/schemas/enums.ts`.

### Signature
```typescript
export function isProviderId(id: string): id is ProviderId
```

### Type Definitions
```typescript
export const PROVIDER_IDS = [...] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
```

### Current Code
```typescript
// existing file content, captured at task start
```

### Pattern
Follow existing test style: import from `./enums.js`, group
with `describe`, use `it.each`.

### Implementation Steps
1. Update imports to include guard functions
2. Add `describe('isProviderId')` block with positive and negative cases
3. Add `describe('isPlannerToolId')` block

### Tests
- `isProviderId('anthropic')` returns true
- `isProviderId('bogus')` returns false
- `isPlannerToolId('ollama')` returns false

### Scope
**In bounds:**
- Modify only the test file
**Out of bounds:**
- Do not change runtime behavior

### Escalation
- Stop and ask if the test file structure has diverged

### Evidence
- `npm test -- src/core/schemas/enums.test.ts` passes

### Constraints
- ESM imports with `.js` extensions
- Follow existing codebase patterns
````

The implementer sees only its own brief. It has no access to the spec, the plan, or other tasks.

---

## The Implementer interface

Defined in `src/engine/implementers/types.ts`:

```typescript
interface Implementer extends RunnerRuntime {
  implement(opts: ImplementerOptions): Promise<ImplementerResult>
  retry(opts: RetryOptions): Promise<ImplementerResult>
  capabilities?: ImplementerCapabilities
}
```

`implement()` executes a single task. `retry()` re-executes with error context and escalating temperature.

`ImplementerCapabilities` has one field:

```typescript
type ImplementerCapabilities = {
  writesFiles: 'extracted-code' | 'direct'
}
```

- `extracted-code` -- the implementer returns code in its response text. SPLITBRIEF extracts it from markdown fences and writes it to disk. Used by `api` and `shell`.
- `direct` -- the implementer writes files to disk itself. SPLITBRIEF detects changes via `git diff`. Used by `cli`, `agent`, and `agent-sdk`.

---

## Implementer base pipeline

`src/engine/implementers/pipeline/run.ts` -- `createImplementerBase(config)`.

Wraps a backend-specific `invoke()` with:

1. **Build prompt** -- `formatTaskPrompt()` (`src/engine/spec/prompt-formatter.ts`) assembles the task sections. For modify tasks, `currentCode` is resolved through a tiered context strategy.
2. **Prepend system preamble** -- language context, project conventions. API backends handle this separately as a system message (`prependSystemPreamble: false`).
3. **Call backend `invoke()`** -- the actual model call. `InvokeOpts.callContext` identifies the runner call for adapters that can emit typed events directly.
4. **Process output:**
   - If `extractsCode`: extract code from response via `extractCode()`, run through tiered approval (`approveWrite`), apply to disk via `applyCode()`, compute diff.
   - If `!extractsCode`: detect file changes via `detectChanges()` (git diff against pre-invocation snapshot).
5. **Publish result** -- `publishDone` with diff metrics (lines added/removed, duration) or `publishFailed`.

For retries, `buildRetryPrompt()` prepends the error message with escalating framing -- attempt 1 says "fix it", attempt 2 says "rephrase", attempt 3 says "try a completely different approach". Temperature increases by `retryTemperatureStep` per attempt.

The implementer base normalizes backend output into `RunnerCallResult` before processing files. A non-completed status returns a failed `ImplementerResult` with partial output and usage preserved; user aborts, timeouts, truncation, refusals, unsupported tools, and incomplete streams are not collapsed into generic success/failure strings.

---

## Token accounting

Token usage is tracked as `TokenDelta` (`src/core/schemas/tokens.ts`):

```typescript
type TokenDelta = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
}
```

Deltas are normalized in `src/engine/calls/usage.ts`, which handles delta, cumulative, and final samples consistently. Accumulated usage is published through `cost_update` events.

Per-task usage is recorded as `TaskTokenUsage`, which tracks: implementer tokens, escalation tokens, retry count, cost, model used, context fit classification (`fits` / `tight` / `overflow`), and the `currentCodeContextMode` that was selected.

**Token budget for implementer prompts** (`src/engine/spec/token-budget.ts`):

```
budget = contextLength - systemPromptTokens - taskBodyTokens - (contextLength * 0.25)
```

Token estimation uses a per-model-family character-to-token ratio (`src/core/tokens/estimate.ts`): Claude models use 3.5, GPT uses 4.0, DeepSeek/Qwen/Llama/etc. use family-specific ratios. When a model ID is available (e.g., during implementer profile routing), the calibrated ratio produces more accurate estimates — reducing unnecessary escalations from overestimates and overflow failures from underestimates. Callers without model context (repomap budget, planner base) default to 4.0 chars/token.

The 25% reserve is for output. The remaining budget goes to `currentCode`. If the whole file doesn't fit, the prompt formatter tries these modes in order:

1. **whole-file** -- entire file content
2. **function-level** -- imports + target function only (extracted via signature name)
3. **truncated-middle** -- first half + `// ... truncated ...` + last half
4. **none** -- no code context

---

## Five runner kinds in practice

### cli

`src/engine/planners/cli.ts`, `src/engine/implementers/cli.ts`

Spawns a CLI tool as a subprocess. Supported tools: `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code`.

The planner reads artifacts from disk (session directory or project root) via `readCliPhaseOutput()`. It checks the session folder first, then looks for markdown-linked paths in stdout, then falls back to stdout text. Claude Code uses `--session-id` for session resume. Output is parsed line by line via each tool's `parseLine` function.

The implementer writes files directly (`writesFiles: 'direct'`). Change detection via git diff. Claude Code gets a special path through `runClaudeOneShot()`.

#### Canonical CLI runner matrix

Runtime source of truth: `src/core/runners/cli-tool-catalog.ts` (`CLI_TOOL_CATALOG`, `CLI_TOOL_TRUST`). This section is the canonical support matrix for admitted CLI runners. Parity is enforced by `testing/docs/planners-and-implementers.test.ts`.

Each admitted tool carries a `testedVersion` and a `minimumAdmittedVersion` — the upstream CLI release the flag, subcommand, and output contract were last verified against, and the oldest release admitted. `detectAvailablePlanners` (`src/engine/detection/detect.ts`) probes the installed version via the adapter-declared version command. Admission is forward-compatible: only versions below the minimum are incompatible; newer releases are admitted, and malformed or unproven versions remain unverified. It does not print a startup stderr warning for unselected tools.

When you adjust a tool's adapter to track an upstream CLI change, bump that tool's `testedVersion` in the catalog and update this matrix.

##### Admitted support summary

| `tool` | command | roles | tested version | evidence as-of | model policy (planner / implementer) | billing |
|---|---|---|---|---|---|---|
| `claude-code` | `claude` | planner, implementer | 2.0.0 | 2026-07-31 | optional / optional | subscription-included |
| `codex` | `codex` | planner, implementer | 0.40.0 | 2026-07-31 | optional / optional | subscription-included |
| `opencode` | `opencode` | planner, implementer | 0.5.0 | 2026-07-31 | optional / optional | provider-dependent |
| `aider` | `aider` | planner, implementer | 0.86.0 | 2026-07-31 | optional / optional | provider-dependent |
| `copilot` | `copilot` | planner, implementer | 0.3.0 | 2026-07-31 | optional / optional | subscription-included |
| `kilo-code` | `kilo` | planner, implementer | 0.1.0 | 2026-07-31 | optional / optional | provider-dependent |

##### Posture, trust, and auth

| `tool` | direct write (planner / implementer) | shell | network | automatic approval (implementer) | sandbox (planner / implementer) | auth channels | credential env |
|---|---|---|---|---|---|---|---|
| `claude-code` | no / yes | yes / yes | yes / yes | `--permission-mode acceptEdits` | none / none | session, api-key | `ANTHROPIC_API_KEY` (api-key channel) |
| `codex` | no / yes | yes / yes | yes / yes | `--sandbox workspace-write` | mode-dependent / cli-managed | session, api-key | `OPENAI_API_KEY` (api-key channel) |
| `opencode` | no / yes | yes / yes | yes / yes | — | none / none | provider-dependent | inherited from provider config |
| `aider` | no / yes | yes / yes | yes / yes | `--yes-always` | none / none | provider-dependent | inherited from provider config |
| `copilot` | no / yes | yes / yes | yes / yes | `--allow-all` | none / none | session | `GH_TOKEN`, `GITHUB_TOKEN` |
| `kilo-code` | no / yes | yes / yes | yes / yes | `--auto` | none / none | provider-dependent | inherited from provider config |

Session channels use `host-cli-state` bridging where noted in the catalog. SPLITBRIEF never copies credentials into argv. Subscription-included tools bill through the vendor login; provider-dependent tools inherit the upstream model provider's billing posture.

##### Readiness states

Each admitted CLI exposes check ID `runners.cli.<tool>.readiness`. `deriveCliReadiness()` (`src/core/schemas/readiness.ts`) resolves these states in order:

| state | meaning |
|---|---|
| `disabled` | Tool is not enabled for selection |
| `unavailable` | Binary not installed or not on trusted PATH |
| `untrusted` | Executable identity does not match the trusted fingerprint |
| `unverified` | Version probe failed or compatibility is unknown |
| `incompatible` | Installed version is below the minimum admitted version |
| `unauthenticated` | Required auth channel is not satisfied in the staged environment |
| `ready` | Binary trusted, version compatible, auth satisfied |

Run `splitbrief doctor` or workflow start readiness to surface remediation copy for each non-ready state.

Only `ready` produces the trusted start gate execution requires. `splitbrief start` therefore refuses to open a session while a configured CLI runner sits in any other state — including `unverified`, which `doctor` reports as a warning — and exits non-zero with that state's remediation.

##### Minimal configuration

```yaml
version: 3
planner:
  kind: cli
  tool: claude-code
  model: claude-sonnet-4-20250514 # optional for optional-policy tools
implementer:
  kind: cli
  tool: claude-code
  model: claude-sonnet-4-20250514
```

Swap `tool` and `model` for any admitted CLI. Omit `model`, or write `model: auto`, to use the CLI's automatic selection — both spellings pass no `--model` flag, so the tool keeps its own configured model. Tools with `backend-default` or `auto-only` model policy (none in the current admitted set) accept model absence or `auto` and reject an explicit model ID or `customModels` before spawn.

##### Blocked admission candidates (OMIT)

These researched CLIs have **blocked verdicts** — they do not appear in the admitted support table above and have no first-class catalog ID until their admission gate passes.

| candidate | verdict | as-of | evidence | route when gate passes |
|---|---|---|---|---|
| `cursor` | OMIT | 2026-08-02 | Candidate metadata only. R7-008 must prove an exact build-pinned protocol in a fresh filtered workspace; the prior project-cwd invocation, broad semver, synthetic fixtures, `--mode agent`, and invented JSON flags are not evidence. | No planner/implementer adapter, provider row, auth channel, catalog, run path, or picker row until R7-008 is accepted. |
| `antigravity` | OMIT | 2026-07-31 | `.nuke/release-evidence/antigravity.json` | implementer-only `agy`; conditional consumer route replacing legacy Gemini CLI |

`CURSOR_CLI_ADMISSION_VERDICT` and `ANTIGRAVITY_CLI_ADMISSION_VERDICT` are `OMIT` in `cli-tool-catalog.ts`. Candidate runtime adapter sources must remain absent while the verdict is OMIT. Cursor records `agent` as a primary candidate and `cursor-agent` as a fallback only for later, safe resolution testing; those aliases do not configure a runnable tool. No unverified-auth override can promote Cursor. `agent status --format json` is a current-build fact, but no model JSON flag, model catalog, or run protocol is admitted; planner `plan` mode and an implementer invocation without `--mode` remain R7-008 work, not active configuration.

##### Excluded researched candidates

These candidates have **dated blocked verdicts** — no first-class ID, descriptor, adapter, or picker row.

| candidate | verdict | as-of | reason |
|---|---|---|---|
| `kiro` | DEFER | 2026-07-31 | Blocker 1: written Kiro/AWS permission confirming official-CLI orchestration is permitted for paid individual subscriptions. Blocker 2: credentialed stable-2.x staged fixture (target 2.16.0) proving prompt transport, scoped direct writes, text parsing, auth isolation, exit behavior, cancellation, and model-selection boundary. See `.nuke/.../research-kiro.md`. |
| `gemini` | REJECT | 2026-06-18 | Legacy consumer Gemini CLI entitlement ended 2026-06-18 for free, Google AI Pro, and Google AI Ultra accounts. Consumer-plan users should use the conditional Antigravity route. Enterprise licenses and paid API keys remain on the separate Gemini API provider path — not this legacy CLI. |
| `auggie` | DEFER | 2026-07-31 | Indie plan exists, but official docs state non-interactive mode may be disabled by customer agreement; unattended entitlement smoke test required. |
| `junie` | DEFER | 2026-07-31 | Headless flow documents `JUNIE_API_KEY` on usage-based billing; paid-plan subscription entitlement for headless tasks is not explicitly documented. |
| `qwen` | REJECT | 2026-07-31 | Qwen Code Coding Plan Pro ($50/month) terms prohibit automated scripts and non-interactive/batch scenarios. Not positioned for SPLITBRIEF implementer use. |
| `cline` | FUTURE | 2026-07-31 | Strong generic/BYOK CLI contract; no subscription-backed consumer plan. Possible future generic implementer, not this feature wave. |

### api

`src/engine/planners/api.ts`, `src/engine/implementers/api.ts`

REST call to an OpenAI-compatible HTTP endpoint. Works with: Ollama, LM Studio, Anthropic, OpenRouter, DeepSeek, OpenAI, Groq, Together.

The planner uses `dispatchStreamCompletion()` which handles both OpenAI-format and Anthropic-native streaming. Prior messages are passed as a proper messages array (`consumesPriorMessages: true`). Token usage comes from the API response.

The implementer extracts code from the response text (`writesFiles: 'extracted-code'`). System preamble is sent as a separate system message. Token budget calculation determines `maxTokens`. Temperature increases on retry (`retryTemperatureStep: 0.1`).

### shell

`src/engine/planners/shell.ts`, `src/engine/implementers/shell.ts`

Arbitrary command run via `createCommandBasedPlanner()` / `createCommandBasedImplementer()`. The prompt is piped to stdin, output read from stdout. Config provides `command`, `args`, and `outputFormat`.

The implementer extracts code from stdout (`writesFiles: 'extracted-code'`). The planner detects artifact changes via git diff.

### agent

`src/engine/planners/agent.ts`, `src/engine/implementers/agent.ts`

Like shell, but the subprocess writes files to disk directly instead of returning code in stdout. Change detection via `createChangeDetector()` (git diff before/after).

The planner reads phase artifacts from the session directory. Full escalation also uses git-based change detection instead of code extraction.

The implementer uses `writesFiles: 'direct'` with git-based change detection.

### agent-sdk

`src/engine/planners/agent-sdk.ts`, `src/engine/implementers/agent-sdk.ts`

Anthropic Agent SDK library call via `@anthropic-ai/claude-agent-sdk` (optional peer dependency). Thread persistence and tool integration built in. The factory checks for the package at import time and throws a clear error if it's missing.

The planner uses `CONVERSATIONAL_CAPS` (all capabilities on) except `supportsHintEscalation: false`. It supports `injectUserTurn()` for conversational context.

The implementer writes files directly with git-based change detection.

---

## Adding a new backend

Step by step:

1. **Add the ID to its catalog**: a CLI tool goes in `CLI_TOOL_CATALOG` (`src/core/runners/cli-tool-catalog.ts`), an API provider in `API_PROVIDER_CATALOG` (`src/core/providers/api-provider-catalog.ts`). A meta runner goes in `META_PROVIDER_IDS` (`src/core/schemas/enums.ts`), which composes `PROVIDER_IDS` from the catalog tuples.

2. **Create the planner module** at `src/engine/planners/<name>.ts`. Export a `create<Name>Planner()` function that calls `createPlannerBase()` with:
   - `invokePlan` -- your backend-specific call
   - `invokeEscalate` -- can be the same function or a separate path
   - `capabilities` -- declare what your backend supports
   - `isAvailable` / `getVersion` -- runtime checks

3. **Create the implementer module** at `src/engine/implementers/<name>.ts`. Export a `create<Name>Implementer()` function that calls `createImplementerBase()` with:
   - `invoke` -- your backend-specific call
   - `extractsCode` -- true if SPLITBRIEF should extract code from response, false if your backend writes files directly
   - `detectChanges` -- required when `extractsCode` is false

4. **Add lazy imports and factory cases** in `src/engine/runners/factory.ts`. Add a `const load<Name>Planner = lazy(...)` and `const load<Name>Implementer = lazy(...)` at the top, then add `case '<name>':` branches in both `loadPlanner()` and `createImplementer()`.

5. **Extend execution admission.** Add the kind to the exhaustive `RunnerGate` and `RunnerGateExpectation` unions, evaluate it during `prepareExecution()`, and validate its slot-bound authority in the factory before loading the adapter.

6. **Add config schema variants** for your kind in the planner and implementer config schemas. The `kind` field is the discriminant.

7. **Write tests.** Colocated as `<name>.test.ts` next to each module. Cover fresh admission, factory gate mismatch, named-profile selection when supported, and adapter behavior.

---

## Config shape (planner and implementer)

Source: `src/core/schemas/config.ts`, `src/core/schemas/runner-fields.ts`, `src/core/schemas/planner-config.ts`, `src/core/schemas/implementer-config.ts`.

Both `planner` and `implementer` are discriminated unions on the `kind` field. The five variants share generation-common fields and add kind-specific ones:

```typescript
// Shared across all five kinds
type GenerationCommon = {
  model: string
  customModels?: string[]
  contextLength?: number
  temperature?: number       // 0–2
  timeout?: number           // ms, max 600000
  effort?: EffortLevel
}

// Kind-specific fields (simplified)
type CliRunner    = { kind: 'cli';       tool: CliToolId; args?: string[] }
type ApiRunner    = { kind: 'api';       provider: string; service: string; offering: ApiOffering; apiBase: string; apiKey?: string }
type ShellRunner  = { kind: 'shell';     command: string; args?: string[] }
type AgentRunner  = { kind: 'agent';     command: string; args?: string[] }
type SdkRunner    = { kind: 'agent-sdk'; apiKey?: string }

type PlannerConfig      = (CliRunner | ApiRunner | ShellRunner | AgentRunner | SdkRunner) & GenerationCommon
type ImplementerConfig  = (CliRunner | ApiRunner | ShellRunner | AgentRunner | SdkRunner) & GenerationCommon
```

The top-level `Config` groups these with workflow settings:

```typescript
type Config = {
  version: 3
  planner: PlannerConfig
  implementer: ImplementerConfig
  implementerProfiles?: { default?: string; profiles: Record<string, ImplementerProfileConfig> }
  validation: { typecheck: boolean; lint: boolean; test: boolean; testCommand?: string; ... }
  workflow: {
    mode?: WorkflowMode          // instant | quick | standard | speckit
    approve?: ApproveLevel       // none | spec | plan | all | default
    maxRetries: number
    maxBudget?: number           // dollars
    budgetPauseThreshold?: number // 0–1
    persistTranscript?: boolean
    compactionThreshold?: number
    git?: { commitStrategy?: CommitStrategy; createBranch?: boolean }
    // ... plus taskReview, briefReview, costGate, driftChainThreshold
  }
  escalation?: { intermediateProvider?: string; intermediateModel?: string; enabled?: boolean }
  approval?: { enabled?: boolean; tiers?: TierMap; feedRejectionsToPlanner?: boolean; ... }
  codebase?: CodebaseConfig
  hooks?: HooksConfig
  otel?: OtelConfig
  snapshots?: { auto?: { preTask?: boolean; postTask?: boolean; preFinalReview?: boolean } }
  // ... plus theme, sessions, palette
}
```

Factory dispatch reads `config.planner.kind` and `config.implementer.kind` and lazy-loads the matching backend module. The rest of the config flows through to the orchestrator, validation pipeline, and budget enforcement.

---

## Language context

`src/engine/spec/prompts/language-context.ts`

The planner prompt builders adapt import conventions, type annotation style, and code-fence language to the target project. The `LanguageContext` struct carries five fields: `language`, `importConvention`, `typeAnnotationStyle`, `fileExtension`, `moduleSystem`. Built-in presets exist for TypeScript, JavaScript, Python, Go, and Rust; everything else gets generic defaults.

**Detection** happens two ways. `detectPromptLanguage(projectDir)` probes the project root for manifest files: `Cargo.toml` (Rust), `go.mod` (Go), `pyproject.toml` (Python), then `package.json` (TypeScript if the `typescript` dependency exists, JavaScript otherwise). Separately, `extractLanguageFromResearch()` parses the planner's research markdown output for a `**Language**: <name>` line -- this is the primary detection path in modes that run research (standard, speckit), since the research prompt asks the planner to identify the language. In quick and instant modes, only `detectPromptLanguage()` is available.

**Which phases receive it:** spec, plan, tasks, quick-plan, and instant prompts all accept an optional `LanguageContext`. Research does not -- it is the phase that produces the language signal. For non-JavaScript/TypeScript projects, language context is injected as a visible `Language Context` section in the prompt. For JS/TS projects it is omitted (the prompt defaults already assume JS/TS conventions).

**Adding a new language:** add a case to `buildLanguageContext()` mapping the normalized name to a `LanguageContext` struct, add the name to `normalizeLanguage()`, add a code-fence mapping in `codeFenceLanguage()`, and add a manifest check to `detectPromptLanguage()` if applicable.

---

## Planner prompt builders

`src/engine/spec/prompts/`

Each planning phase has a dedicated prompt builder. All builders produce a single string via the shared `buildPrompt()` helper, which assembles titled sections with headings. Signatures and what they receive:

**`buildResearchPrompt(feature, projectContext, skillsContext?)`** -- the first planner call. `projectContext` includes the repo map. The prompt asks the planner to read files, map architecture, identify relevant code, note constraints, and output a structured research report including validation toolchain and detected language.

**`buildSpecPrompt(feature, researchOutput, languageContext?)`** -- receives the research output and writes `spec.md`. Defines what to build (not how). Language context sections are injected for non-JS/TS projects.

**`buildPlanPrompt(spec, projectContext, skillsContext?, languageContext?)`** -- receives the approved spec (as a `PlanPromptSpec` with content and a `hasClarifications` flag) and writes `plan.md`. Defines how to build it. If the spec includes user clarifications, the output instruction tells the planner to reference those decisions.

**`buildTasksPrompt(spec, plan, languageContext?)`** -- receives spec and plan, produces `tasks.md` markdown. The prompt includes the full Task Brief v1 contract (nine semantic sections), critical rules for self-containment, and a format example. Output is parsed into `Task[]` by the task parser.

**`buildQuickPlanPrompt(feature, projectContext, languageContext?)`** -- collapses all phases into one call. Receives the feature and project context directly, emits `tasks.md` with no spec or plan document.

**`buildInstantPrompt(feature, projectContext, languageContext?)`** -- like quick but narrower. Tells the planner the change is trivial, caps output at 1-5 briefs, and skips spec/plan. Same output shape.

**Context availability by phase:** Research sees the feature text, project context (including repo map), and skills context. Spec sees feature + research output + language context. Plan sees spec + project context + skills context + language context. Tasks sees spec + plan + language context. Quick and instant see feature + project context + language context.

---

## What to read next

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** -- full config schemas and YAML examples for all runner kinds
- **[WORKFLOW.md](./WORKFLOW.md)** -- how the orchestrator drives the planner through phases
- **[ENGINE.md](./ENGINE.md)** -- how events flow from engine to UI
