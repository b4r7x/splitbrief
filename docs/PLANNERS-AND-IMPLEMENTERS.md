# Planners and implementers

How the two roles and their three seats are created, what interfaces they expose, how the five runner kinds work, and how to add a new backend.

---

## Two roles, three seats, one factory

Two roles — planner and implementer — fill three seats: plan, build, and review. All three seats are created by `src/engine/runners/factory.ts`:

- `createPlanner(config, { preparedConfig, preparationId, gates, slot, initialSessionId?, ... })` returns a `Planner`
- `createImplementer(config, { preparedConfig, preparationId, gates, slot, ... })` returns an `Implementer`
- `createReviewer(config, { preparedConfig, preparationId, gates, slot, ... })` returns a `Reviewer`

Every option object is required. `config` and `preparedConfig` must be the same object returned by execution preparation; the factory rejects a different configuration even when its runner has the same tool, provider, endpoint, or command identity. The selected slot lets the implementer factory derive named-profile and intermediate configuration from that prepared snapshot.

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

The reviewer joins that list when — and only when — `.splitbrief/config.yaml` carries a `reviewer` block: `prepareExecution()` adds it as a candidate under slot `{ role: 'reviewer' }`, and a failed admission is a blocker naming the Reviewer. With no block, `resolveReviewerRunner()` hands the seat to the planner and the planner instance is reused unchanged, so there is nothing extra to admit.

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

## The Reviewer interface

Defined in `src/engine/reviewers/types.ts`. The review seat is one stateless, read-only call:

```typescript
interface Reviewer {
  review(prompt, projectDir, callbacks): Promise<{ text: string; usage: TokenDelta | null }>
  isAvailable(): Promise<boolean>
  unavailabilityReason?(): string | undefined
}
```

It is deliberately narrower than `Planner` — a reviewer cannot plan, regenerate, escalate, summarize, resume a session, or write files. A `Planner` satisfies it structurally, which is what lets the planner hold the seat unadapted when no `reviewer` block is configured.

The port carries no identity fields on purpose. No runner backend knows its own tool or model, so the identity in a failed-review message comes from the config accessor that resolved the seat (`resolveReviewerRunner`), not from the runner object.

`createReviewer()` builds the seat on the planner backends: it resolves the runner, then hands `loadPlanner()` a config whose planner slot holds the reviewer. A configured `effort` or `temperature` a backend cannot deliver is dropped with the same stderr warning the planner gets.

### Which calls the reviewer makes

Exactly one: the final review of the run diff, dispatched from `runFinalReviewPhase()` (`src/engine/orchestrator/final-review.ts`) through `runReviewerCall()` (`src/engine/orchestrator/review-call.ts`). Every other strong-side call stays on the planner — the planning phases, `regenerate`, `escalateHint`, `escalateFull`, the planner estimate review, `summarize` / `summarizeStructured`, `injectUserTurn`, and brief recovery. `runPlannerReview` is still the planner's own review helper and still serves the estimate-review and planning-regeneration call sites; the reviewer has its own call path rather than changing that one.

A reviewer that fails mid-call is reported, not replaced: `reviewStatus: 'failed'`, the reviewer's display name in the error, final-review evidence recorded, summary still produced. There is deliberately no automatic fallback to the planner.

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
- Returns the phase artifact text from the completed terminal result only; stdin/stdout adapters never reopen files that a backend wrote

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

The implementer is the **weaker model** of the pair. Which transport carries that model is a user choice, and two of them are equally supported:

- a **tool CLI running a cheaper model** -- `codex`, `claude-code`, or any other admitted CLI pointed at a low-cost model. Write mode `direct`.
- a **model behind an OpenAI-compatible API** -- OpenRouter, a local endpoint, a hosted provider. Write mode `extracted-code`.

Neither is the fallback for the other. Both get the same brief, the same prompt contract, and the same promotion and validation treatment. Isolation is the one thing they do not share: per ADR-4 the run's isolation directory is scoped to a direct writer, and `workflow.isolation` is not consulted for an `extracted-code` implementer (see below). SPLITBRIEF does not favour a transport.

Defined in `src/engine/implementers/types.ts`:

```typescript
interface Implementer extends RunnerRuntime {
  implement(opts: ImplementerOptions): Promise<ImplementerResult>
  retry(opts: RetryOptions): Promise<ImplementerResult>
  capabilities?: ImplementerCapabilities
  unavailabilityReason?(): string | undefined
}
```

`implement()` executes a single task. `retry()` re-executes with error context and escalating temperature. `unavailabilityReason()` -- optional, mirroring the Planner interface -- returns a human-readable cause for the most recent `isAvailable()` returning false (e.g. "the endpoint is unreachable"), which the unavailable-implementer recovery carries when the runner can state one.

### Write modes

`ImplementerCapabilities` has one field:

```typescript
type ImplementerCapabilities = {
  writesFiles: 'extracted-code' | 'direct'
}
```

It records **who holds the pen**, not which path is preferred.

A brief **requires** a direct-write implementer only when its `scope.inBounds` / `scope.approvedOutOfBounds` bullets name a concrete path token beyond the task's own `file` — a token carrying a directory separator or a glob, extracted by `scopePathPatterns` in `src/utils/path-patterns.ts` (`requiredWriteModeForTask`, `src/engine/orchestrator/context-routing/decision.ts`). Scope bullets are prose: a bullet that only re-names the task file, or names no path token at all, does not widen the write scope, and the brief routes to an `extracted-code` implementer.

| | `extracted-code` | `direct` |
|---|---|---|
| Writes the file | SPLITBRIEF | the implementer |
| Kinds | `api`, `shell` | `cli`, `agent`, `agent-sdk` |
| Model answers with | the complete file contents as text | edits already made on disk |
| Change detection | the extracted text is compared against the file it replaces | `detectChanges()` against a baseline captured before the call |
| Works in | the project directory, one file per task | the run's isolation directory (see below) |
| Approval applies | per write, before it lands (`approveWrite`) | at promotion, over the whole changed set |
| Empty result | extraction error | `no-staged-change` outcome + `implementer_wrote_nothing` warning |

### Isolation and promotion

A `direct` implementer edits files itself, so it is handed its own working directory instead of the user's checkout. The default isolation is a **git worktree created once per run** -- one directory for the whole run, not a copy per task. Project dependencies are reachable inside it, so the implementer can run the project's own typecheck, lint, and tests against its own work.

Isolation is scoped to direct writers (ADR-4). The task loop acquires a workspace only when the implementer's write mode is `direct` (`runImplementation`, `src/engine/orchestrator/task/run-implementation.ts`), so an `extracted-code` implementer writes through SPLITBRIEF into the project directly and `workflow.isolation` never applies to it -- see [CONFIGURATION.md](./CONFIGURATION.md) §5. Escalation is the one exception: a retry always acquires a workspace (`src/engine/orchestrator/escalation/step.ts`), and for an `extracted-code` implementer that acquisition bypasses the configured strategy and stages the retry in a temporary copy of the project.

When a task ends, the changed set is computed against the baseline captured when that task acquired the workspace, not when the isolation directory was created -- git status/diff when the isolation directory is a real checkout, a whole-tree hash diff when it is not (`getChangedFilesSinceSnapshot`, `src/engine/orchestrator/approval/file-snapshots/capture.ts`). The set is gated for approval and then **promoted into the user's real project directory**. Promotion is hash-guarded: a file whose content changed between the approval read and the write is not overwritten, it is reported as a conflict and the whole promotion is refused (`promoteStagedChanges`, `src/engine/orchestrator/approval/staged-project.ts`). Changes always land in the real project -- that is the point of the mechanism.

The run-scoped handle (`createRunIsolation`, `src/engine/orchestrator/isolation/create.ts`) keeps the isolation directory alive across tasks and retries. A worktree workspace is reused between acquisitions through a marker carrying the session id, and each acquisition takes a fresh baseline so a later task reports only its own edits. The worktree is disposed when the run ends: if nothing unpromoted remains it is removed with force and its branch deleted, otherwise it is retained -- it holds work that was never promoted -- and the run reports the retention.

A worktree isolates files, not the machine. It shares refs, git config, and hooks with the real repository, and it shares ports, databases, and environment with everything else running. It is not a security boundary. See [WORKTREES.md](./WORKTREES.md).

An isolation strategy that copies the project instead of checking it out must exclude build output and report artifacts as well as the VCS, dependency, and SPLITBRIEF directories. The staged copy derives its file list from git's own ignore rules, so gitignored `dist/`, `coverage/`, and tool output never enter the copy -- otherwise it would move hundreds of megabytes per run.

Whichever mode ran, validation happens in the real project directory after promotion. The implementer's ability to run checks on its own work is a first-pass-rate improvement, not the source of truth about correctness.

### Prompt contract per mode

`formatImplementerSystemPreamble(languageContext, writesFiles)` (`src/engine/spec/prompts/system.ts`) selects a preamble per write mode. The Task Brief body underneath it is the same in both modes -- description, signature, type definitions, pattern, implementation steps, tests, scope, escalation, evidence, constraints (`buildTaskSections`, `src/engine/spec/prompt-formatter.ts`).

| Preamble carries | `extracted-code` | `direct` |
|---|---|---|
| Language and import conventions | yes | yes |
| Output rules (whole file, no fences, no prose) | yes | n/a -- the model edits files |
| Worked example in the target language | yes | n/a |
| File scope -- which files it may touch and which it may not | n/a -- one file is written for it | yes |
| Stop conditions -- when to finish and when to escalate instead of improvising | via the brief's Escalation section | yes, restated as a hard rule for an agent that can keep going |
| Validation expectations -- which commands to run before declaring the task finished | n/a | yes |
| Reporting format -- what to say about what it changed | n/a -- the file *is* the answer | yes |

The last four rows are what makes `direct` reviewable. An agent that writes files on its own can wander, keep working past the task, or finish silently; the preamble is where those are bounded.

---

## Implementer base pipeline

`src/engine/implementers/pipeline/run.ts` -- `createImplementerBase(config)`.

Wraps a backend-specific `invoke()` with:

1. **Build prompt** -- `formatTaskPrompt()` (`src/engine/spec/prompt-formatter.ts`) assembles the task sections and takes the write mode, so the closing instruction matches how the model is expected to answer. For modify tasks, `currentCode` is resolved through a tiered context strategy.
2. **Prepend system preamble** -- `formatImplementerSystemPreamble(languageContext, writesFiles)`; the mode-specific preamble described above. API backends send it as a separate system message instead of prepending (`prependSystemPreamble: false`).
3. **Call backend `invoke()`** -- the actual model call. `InvokeOpts.callContext` identifies the runner call for adapters that can emit typed events directly. `InvokeOpts.sandboxEnv` carries the isolation directory's environment when the run is isolated.
4. **Process output:**
   - `extracted-code` (`extractsCode: true`): extract code from response via `extractCode()`, run through tiered approval (`approveWrite`), apply to disk via `applyCode()`, compute diff. Between approval and apply, a plausibility guard (`src/engine/implementers/pipeline/extracted-code.ts`) refuses a marker-less modify response that would keep less than half of a baseline file of at least five non-empty lines: the file is left untouched and the task fails with the kept-of-had line counts plus a literal SEARCH/REPLACE template, so the retry has an exact-patch escape hatch.
   - `direct` (`extractsCode: false`): detect file changes via `detectChanges()` against the baseline captured before the call. The isolated workspace declares which baseline that is rather than letting the detector sniff the directory: a linked worktree carries git metadata but is seeded with your uncommitted work, so it is compared by file-content hashes, and a retry that rewrites the file the previous attempt already wrote is seen as a change. No change at all is a `no-staged-change` failure, not a silent success: the detector's negative result carries the distinct `reason: 'no-files-changed'`, and the pipeline publishes one coded warning (`category: implementer`, `code: implementer_wrote_nothing`, `transcriptSafe: true`) naming the runner and the task. The warning lands in `session.jsonl` and in the review packet's warnings list, while the retry and escalation behaviour stays exactly as before — the task still fails.
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

Session totals (`TokenUsage`) carry four categories, not three: `planner*`, `implementer*`, `escalation*`, and `reviewer*` (`reviewerInput`, `reviewerOutput`, and the optional `reviewerCacheRead` / `reviewerCacheCreate`). `usageCategoryForRunnerCallRole()` (`src/engine/orchestrator/tokens.ts`) routes the `'review'` call role into the `reviewer` bucket; `'planner'`, `'summary'`, and `'compaction'` stay on the planner. Session state written before the reviewer bucket existed loads with those fields at `0`.

Pricing follows the seat: with a `reviewer` block, the reviewer's tokens are priced at the reviewer runner's rates and shown as their own line in the summary and the cost drilldown; without one, they are priced at the planner's rates and folded into the planner line, exactly as before. `splitbrief stats` is unaffected either way — it aggregates by provider, not by role.

CLI runners report usage through their protocol terminal: codex through its `turn.completed` record, claude-code and opencode through their streamed terminal events. Codex's `input_tokens` counts cached input, so the normalizer excludes `cached_input_tokens` from the reported input total and surfaces it as `cacheReadTokens`; claude-code's terminal `result` line takes precedence over mid-stream deltas. A CLI runner that completes without reporting usage records zero implementer tokens — by design for structurally unpriced runners, and never fabricated.

Per-task usage is recorded as `TaskTokenUsage`, which tracks: implementer tokens, escalation tokens, retry count, cost, model used, context fit classification (`fits` / `tight` / `overflow`), and the `currentCodeContextMode` that was selected.

A runner completing a task without reporting usage is recorded as zero tokens and surfaced, not hidden: `recordTaskUsage` (`src/engine/orchestrator/tokens.ts`) publishes exactly one warning with `category: 'cost'` and `code: 'implementer_usage_not_reported'` (`transcriptSafe: true`), naming the runner and the task, when neither the implementer nor the escalation delta is non-zero. The warning lands in `session.jsonl` and in the review packet's warnings list. An escalated task that spent planner tokens does not warn. SPLITBRIEF never invents a price or synthesises token counts for a runner that reported none — a CLI runner staying structurally unpriced is by design, and this warning is what makes a run that did real work distinguishable from a run whose runner reported nothing.

**Token budget for implementer prompts** (`src/engine/spec/token-budget.ts`):

```
budget = contextLength - systemPromptTokens - taskBodyTokens - (contextLength * 0.25)
```

An omitted `contextLength` resolves to a single documented default for every runner kind — `DEFAULT_UNKNOWN_CONTEXT_LENGTH = 32768` in `src/core/tokens/context-length.ts` — never to a per-consumer guess.

A boot-probed window applies only to the default implementer profile — the profile the probe ran for. A sibling profile that declares no `contextLength` still routes at the shared default.

A CLI runner under `model: auto` — or with the model omitted — resolves to no model id, so its window is the smallest the bundled catalog guarantees for that tool (`resolveRunnerContextWindow`, `src/engine/providers/model/context-window.ts`); automatic selection never adds a `--model` flag.

The window the router decides is the one the prompt budget uses: `configForProfile()` (`src/engine/orchestrator/task/routing.ts`) copies the decided `contextLength` into the config handed to the selected implementer when the profile declares none — a window the profile declared for itself is never overridden — so the wire carries the routed window rather than an unbudgeted whole-file prompt.

Token estimation uses a per-model-family character-to-token ratio (`src/core/tokens/estimate.ts`): Claude models use 3.5, GPT uses 4.0, DeepSeek/Qwen/Llama/etc. use family-specific ratios. When a model ID is available (e.g., during implementer profile routing), the calibrated ratio produces more accurate estimates — reducing unnecessary escalations from overestimates and overflow failures from underestimates. Callers without model context (repomap budget, planner base) default to 4.0 chars/token.

The 25% reserve is for output. The remaining budget goes to `currentCode`. If the whole file doesn't fit, the prompt formatter tries these modes in order:

1. **whole-file** -- entire file content
2. **function-level** -- imports + target function only (extracted via signature name)
3. **truncated-middle** -- first half + `// ... truncated ...` + last half
4. **none** -- no code context

---

## Model catalog lanes

Seat pickers prefer the native CLI catalog (`confirmed` / `stale`), then models.dev (`catalog-suggestion`). Bundled `KNOWN_MODELS` (`bundled-suggestion`) is an offline fallback only: `buildRightRows` (`src/features/runners/model-catalog/rows.ts`) hides those rows when any live lane is present, except the persisted model and custom rows. `resolveModelCatalog` (`src/engine/providers/model/catalog.ts`) still classifies bundled membership — the hide is a picker filter, not an engine-catalog drop.

Pricing and context-window lookup stay on the existing ladder: cached models.dev first, then runtime metadata, then the bundled catalog (`resolvePricing` in `src/engine/providers/pricing-resolver.ts`, `resolveRunnerContextWindow` in `src/engine/providers/model/context-window.ts`).

---

## Five runner kinds in practice

### cli

`src/engine/planners/cli.ts`, `src/engine/implementers/cli.ts`

Spawns a CLI tool as a subprocess. Supported tools: `claude-code`, `codex`, `opencode`, `aider`, `copilot`, `kilo-code`.

Every planner call declares its transport before dispatch: the current call's final response (`stdout-final`) or an exact declared-file lease. The candidate is that call's authoritative final output; session files, project-root artifacts, markdown-linked paths, prose mentions, stderr, and earlier attempts are evidence at most, never content (see [Compiler capability and planner conformance](#compiler-capability-and-planner-conformance)). The compiler path never resumes the workflow session. Claude Code continues a session it already minted with `--resume`. Output is parsed line by line via each tool's protocol parser; a configured `outputFormat` cannot replace a structured terminal contract.

The implementer writes files directly (`writesFiles: 'direct'`) inside the run's isolation directory, and change detection runs there. Claude Code gets a special path through `runClaudeOneShot()`. A CLI configured with a cheaper model than the planner's is one of the two canonical implementer setups -- see [Write modes](#write-modes).

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
| `claude-code` | no / yes | yes / yes | yes / yes | `--permission-mode acceptEdits` | none / none | session (host account on macOS, see below), api-key | `ANTHROPIC_API_KEY` (api-key channel) |
| `codex` | no / yes | yes / yes | yes / yes | `--sandbox workspace-write` | mode-dependent / cli-managed | session, api-key | `OPENAI_API_KEY` (api-key channel) |
| `opencode` | no / yes | yes / yes | yes / yes | — | none / none | provider-dependent | inherited from provider config |
| `aider` | no / yes | yes / yes | yes / yes | `--yes-always` | none / none | provider-dependent | inherited from provider config |
| `copilot` | no / yes | yes / yes | yes / yes | `--allow-all` | none / none | session | `GH_TOKEN`, `GITHUB_TOKEN` |
| `kilo-code` | no / yes | yes / yes | yes / yes | `--auto` | none / none | provider-dependent | inherited from provider config |

Session channels use `host-cli-state` bridging where noted in the catalog. SPLITBRIEF never copies credentials into argv. Subscription-included tools bill through the vendor login; provider-dependent tools inherit the upstream model provider's billing posture.

The bridge copies files, so a channel whose credential is an OS keychain item reaches a staged runner another way. A channel declares those platforms in `hostKeychainPlatforms` (`src/core/runners/cli-tool-catalog.ts`), which today names macOS for the Claude Code `session` channel: the subscription session lives in the login keychain, whose search list resolves through `HOME` and whose item is keyed on `USER`. `cliAuthChannelHostStateAccess()` maps that to `host-account`, and `createSandboxEnv()` then leaves `HOME`/`USER` at their host values and bridges no file — every other redirect stays. Readiness never infers such a credential from files: it runs the tool's own status command and reports what the child answers. See [docs/API-KEYS.md](./API-KEYS.md) and [docs/WORKTREES.md](./WORKTREES.md).

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

For session-channel tools, a positive local status command proves a credential is present, not that the token is live; a dead token surfaces at run time with its own remediation.

Only `ready` produces the trusted start gate execution requires. `splitbrief start` therefore refuses to open a session while a configured CLI runner sits in any other state — including `unverified`, which `doctor` reports as a warning — and exits non-zero with that state's remediation.

**Arg-vector preflight.** The CLI runner contract includes an arg-vector preflight (`src/engine/runners/arg-vector-preflight.ts`): at execution preparation, after the executable-trust ladder has admitted the runner and before any planning is paid for, SPLITBRIEF runs the installed binary's own `--help` (descending into the emitted subcommand when the tool's help lists one) and compares the flags the adapter would emit for the configured role against the flags the help text advertises. The help run is a real spawn, so it obeys the same rules as every other one: the absolute executable identity the trust ladder resolved, never a bare name the OS looks up on the inherited PATH, and a sanitised environment with no host credentials and no real `HOME`. An executable the ladder refuses yields no help text. A flag the binary does not list is reported as a readiness blocker (`runners.cli.<tool>.arg-vector.<role>`); a flag the binary marks deprecated is a warning; a help text that cannot be obtained or that carries no recognisable flags is reported ok rather than blocking. This turns the recorded class of first-attempt failures — `unexpected argument '--reasoning…'`, `unexpected argument '--quiet…'`, `warning: --full-auto is deprecated`, unexpected stdin reads, claude session-id errors — into a readiness blocker before the run spends anything.

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

The implementer extracts code from the response text (`writesFiles: 'extracted-code'`). System preamble is sent as a separate system message. Token budget calculation determines `maxTokens`. Temperature increases on retry (`retryTemperatureStep: 0.1`). This is the other canonical implementer setup -- a cheap model reached over HTTP, with SPLITBRIEF holding the pen.

Availability is probed, not assumed. An api-kind implementer's `isAvailable()` contacts the provider's model list (`createProviderAvailability`, the same helper the api planner uses) and reports unavailable when the endpoint refuses the connection or returns an empty list. A local endpoint is not assumed reachable just because it is local. The probe fires once per task iteration at the task-loop availability gate, and the verdict is never cached across tasks, so a daemon started between task N and task N+1 is picked up on N+1.

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

## Compiler capability and planner conformance

The Task Brief compiler (`src/engine/spec/tasks/compiler.ts`) compiles the manifest in deterministic four-item batches, at most 64 real dispatches per operation, each batch in a fresh detached session scope that cannot read, replace, expire, resume, or report into the workflow planner session. Every planner mode crosses the same admission boundary: standard and speckit run the compiler's detached batches, and quick and instant stay single-call while accepting only a current-call result.

`admitCompilerCapability` (`src/engine/runners/compiler-capability.ts`) admits a backend only on the exact tuple: runtime identity, effective role vector, declared transport, terminal contract, containment profile, credential channel, envelope version, and a verified conformance proof. Admission fails closed (REQ-016): a missing or unverified property returns the typed zero-dispatch refusal `task_compiler_capability_unsupported`, and no combination is downgraded to a weaker mode. Tiered capability admission applies: the tested version yields a full capability receipt; other detected versions of a supported backend are admitted with runtime-drift evidence and a run warning; unsupported candidates (`copilot`, `aider`, `shell`, `agent`) receive a typed fail-closed refusal. Versionless rows (`api`, `agent-sdk`, `custom-command`) admit only an empty version claim, and the verified conformance proof carries the identity evidence. Runtime guards (envelopes, terminal contract, dispatch ledger, post-run mutation detection) are the enforcement surface.

Planner mode does not grant artifact authority. A `--agent plan`, `--permission-mode plan`, or `--sandbox read-only` flag bounds what the tool may do; it does not prove what the process could reach, what its output means, or that an artifact is fresh. The production-factory conformance harness (`src/engine/runners/cli-tools/contract-harness.ts`, driven by `scripts/cli-conformance.ts`) is what can prove the effective role, containment, and final-response contract, but its verdicts do not reach admission on their own: they are recorded by hand into `COMPILER_SUPPORT_TABLE`, and nothing reads a harness record when a claim is admitted. A run's claim carries that row's recorded vector plus two live host observations — the detected runtime version and containment-launcher availability — and those two are what a running host can still refuse on.

### V1 support table

Source: `COMPILER_SUPPORT_TABLE` in `src/engine/runners/compiler-capability.ts`, mirrored for CLIs by `CLI_COMPILER_EVIDENCE` in `src/core/runners/cli-tool-catalog.ts` (registry parity tests fail on divergence). Every admitted row accepts both containment profiles: `seatbelt` (macOS `sandbox-exec`) and `bubblewrap` (Linux `bwrap`). Envelope version is 1 for every row.

| Backend | Tested runtime | V1 state | Transport | Terminal contract | Credential channels |
|---|---|---|---|---|---|
| `opencode` | 1.18.15 | required-baseline | `stdout-final` | `opencode-final-message-v1` | `session-copy` |
| `claude-code` | 2.1.232 | conformance-gated | `stdout-final` | `claude-terminal-result-v1` | `api-key`, `session-copy` |
| `codex` | 0.147.0 | conformance-gated | `declared-file` | `codex-output-last-message-v1` | `api-key`, `session-copy` |
| `kilo-code` | 7.0.49 | conformance-gated | `stdout-final` | `kilo-final-message-v1` | `session-copy` |
| `api` | (versionless) | conformance-gated | `stdout-final` | `provider-final-assistant-response-v1` | `api-key` |
| `agent-sdk` | (versionless) | conformance-gated | `stdout-final` | `agent-sdk-final-assistant-turn-v1` | `api-key` |
| `custom-command` | (versionless) | conformance-gated | `stdout-final`, `declared-file` | `custom-command-final-response-v1` | `api-key` |
| `copilot` | — | unsupported | — | — | — |
| `aider` | — | unsupported | — | — | — |
| `shell` | — | unsupported | — | — | — |
| `agent` | — | unsupported | — | — | — |

`required-baseline` means OpenCode 1.18.15 is the production planner once its full factory-path conformance passes. `conformance-gated` means the row admits only when the complete conformance row passes and fails closed otherwise: Kilo, the OpenAI-compatible API, the Agent SDK, and configured custom commands stay inactive until that happens. `unsupported` means a typed zero-dispatch refusal no matter what a candidate claims: Copilot has no proven non-writing programmatic planner posture in V1, Aider has no proven read-only planner contract, the legacy shell planner lacks compiler containment and final-response conformance, and the legacy agent planner's ambient session-file behavior violates exact lease ownership.

### Transports and containment

`stdout-final` derives the candidate from the current call's authoritative final response only. Earlier messages, partials, tool-call text, stderr, and prior attempts are evidence at most (REQ-010, REQ-020). `declared-file` hands the child one host-prepared, invocation-unique lease; acceptance requires that exact regular file, a bounded no-follow read, unchanged ancestry and identity, and a matching receipt. Missing, pre-existing, sibling, same-basename, traversal, absolute, symlinked, path-swapped, non-UTF-8, or oversized files fail. There is no `auto` source, source priority, prose sniffing, or filesystem search.

The containment profile in a capability tuple records which OS-level write-denial launcher the host offers -- `seatbelt` (macOS `sandbox-exec`) or `bubblewrap` (Linux `bwrap`) -- as observed by `platformContainmentProfile` (`src/engine/runners/planner-containment.ts`). Availability is all that observation reports: nothing in the compiler path launches that binary or stages a snapshot, and the planner child runs against the project checkout. On `unavailable` the tuple matches no row's containment profiles, so the backend lacks compiler capability and refuses before dispatch. Writes are observed after the fact by post-run mutation detection (`src/engine/orchestrator/planning/mutation-guard.ts`), which fails the planning call on unexpected filesystem mutations.

### Credential channels

`api-key` passes the provider's environment variable into the sanitized child environment. `session-copy` bridges exactly the tool's allowlisted credential files into the disposable HOME/XDG roots, with one exception on the shipping dispatch path: a channel whose credential is an OS keychain item — the Claude Code `session` channel on macOS — has no file to copy, so its child is handed the host `HOME` and `USER` the login keychain resolves through and does read and write the real home directory. Compiler calls take the same `createRunnerSandboxEnv` (`src/engine/runners/sandbox-env.ts`) as every other planner call; there is no stricter compiler-only credential isolation, so a keychain channel is as wide for a compiler batch as it is for a workflow planner call. Bridged values are redacted from diagnostics, and the capability receipt records no secret value.

### Effective roles by backend

The role vector is pinned and effect-verified per backend (REQ-017). A role that is missing, overridden, falls back, prompts interactively, or cannot be verified makes the backend unsupported for that role.

| Backend | Planner role | Implementer role |
|---|---|---|
| `opencode` | `--agent plan` | `--agent build` |
| `kilo-code` | `--agent plan` | `--agent code --auto` |
| `claude-code` | `--permission-mode plan` (Read, Glob, Grep, Plan only) | `--permission-mode acceptEdits` |
| `codex` | `--sandbox read-only --ask-for-approval never` exec, ambient config and rules ignored, ephemeral detached | `--sandbox workspace-write --ask-for-approval never` in the staged checkout |

A planner never gains canonical write authority. Candidates stay non-canonical until the authoritative generation commit; the fixed `tasks.md`, `brief-quality.json`, `spec.md`, and `plan.md` files are compatibility projections of that generation. See [WORKFLOW.md](./WORKFLOW.md) for the generation, permit, and disposition flow.

### Deterministic conformance vs opt-in live checks

Normal CI proves the conformance rows deterministically through the production factory. Subprocess shims speak each tool's real protocol terminal: `testing/integration/orchestrator/runner-capability-matrix.test.ts` (exact-version, protocol, and credential rows), `testing/integration/orchestrator/planner-effect-matrix.test.ts` (planner immutability, one nonce edit, zero unsupported spawn), and `src/engine/runners/cli-tools/contract-harness-effects.test.ts` (mutating planner, no-op or wrong implementer, fallback role). Unsupported rows are pinned by `src/engine/runners/compiler-unsupported-backends.test.ts`. Live authenticated checks (`testing/e2e/scenarios/real-cli-planner-implementer-smoke.test.ts`, gated on `SPLITBRIEF_REAL_CLI_E2E=1`) are opt-in drift evidence, never the admission proof. See [TESTING.md](./TESTING.md).

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

**`buildPlanPrompt({ spec, projectContext, skillsContext?, languageContext?, maxPromptBytes? })`** -- receives the approved spec (as a `PlanPromptSpec` with content and a `hasClarifications` flag) and writes `plan.md`. Defines how to build it. If the spec includes user clarifications, the output instruction tells the planner to reference those decisions.

**`buildTasksPrompt({ spec, plan, languageContext?, currentTasks? })`** -- receives spec and plan, produces `tasks.md` markdown. The prompt includes the full Task Brief v1 contract (nine semantic sections), critical rules for self-containment, and a format example. Output is parsed into `Task[]` by the task parser.

**`buildQuickPlanPrompt(feature, projectContext, languageContext?)`** -- collapses all phases into one call. Receives the feature and project context directly, emits `tasks.md` with no spec or plan document.

**`buildInstantPrompt(feature, projectContext, languageContext?)`** -- like quick but narrower. Tells the planner the change is trivial, caps output at 1-5 briefs, and skips spec/plan. Same output shape.

**Context availability by phase:** Research sees the feature text, project context (including repo map), and skills context. Spec sees feature + research output + language context. Plan sees spec + project context + skills context + language context. Tasks sees spec + plan + language context. Quick and instant see feature + project context + language context.

---

## What to read next

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** -- full config schemas and YAML examples for all runner kinds
- **[WORKFLOW.md](./WORKFLOW.md)** -- how the orchestrator drives the planner through phases
- **[ENGINE.md](./ENGINE.md)** -- how events flow from engine to UI
