# Planners and implementers

How the two roles and their three seats are created, what interfaces they expose, how the four runner kinds work, and how to add a new backend.

---

## Two roles, three seats, one factory

Two roles — planner and implementer — fill three seats: plan, build, and review. All three seats are created by `src/engine/runners/factory.ts`:

- `createPlanner(config, { preparedConfig, preparationId, gates, slot, initialSessionId?, ... })` returns a `Planner`
- `createImplementer(config, { preparedConfig, preparationId, gates, slot, ... })` returns an `Implementer`
- `createReviewer(config, { preparedConfig, preparationId, gates, slot, ... })` returns a `Reviewer`

Every option object is required. `config` and `preparedConfig` must be the same object returned by execution preparation; the factory rejects a different configuration even when its runner has the same tool, provider, endpoint, or command identity. The selected slot lets the implementer factory derive named-profile and intermediate configuration from that prepared snapshot.

Factory dispatch is async and lazy. Backend modules load via memoized dynamic imports (`lazy()` wrapper), so startup only imports the configured kind. If you set `kind: api` for your planner, the `cli`, `shell`, and `agent` modules never load.

The factory reads `config.planner.kind` and `config.implementer.kind` to pick a backend. Each backend is a thin module that calls `createPlannerBase()` or `createImplementerBase()` with a backend-specific invoke function and a capabilities struct.

### Execution preparation and runner gates

Local execution is admitted by `prepareExecution()` in `src/engine/runners/prepare-execution/prepare-execution.ts`, not by the discovery cache or picker state. It parses and recursively freezes the exact effective config, evaluates the runner contexts required by the command, and returns one prepared bundle containing the readiness report, configuration, `preparationId`, session reference, and generic `gates`. Factories reject a gate whose preparation, slot, kind, or safe runner identity does not match that bundle.

`gates` is an exhaustive per-kind union:

| `kind` | Authority carried into execution |
|---|---|
| `cli` | Fresh exact-context trust, compatibility, authentication, and executable receipt. The executable identity is resolved again before session creation and revalidated immediately before each spawn. |
| `api` | The current provider credential and endpoint-policy validation, bound to the provider and endpoint origin. |
| `shell` | The current configured-command trust/admission result. |
| `agent` | The current configured-command trust/admission result. |

Non-CLI gates reuse the validation or admitted invocation already produced during that preparation; execution does not turn cached discovery into a second authority decision. Every gate is also bound to its exact role: planner, intermediate escalation runner, or named implementer profile. New workflows and resumes prepare the planner, every configured implementer profile, and the configured intermediate runner when enabled. `spec` prepares only the planner.

The reviewer joins that list when — and only when — `.splitbrief/config.yaml` carries a `reviewer` block: `prepareExecution()` adds it as a candidate under slot `{ role: 'reviewer' }`, and a failed admission is a blocker naming the Reviewer. With no block, `resolveReviewerRunner()` hands the seat to the planner and the planner instance is reused unchanged, so there is nothing extra to admit.

Entry points express policy differences while sharing this boundary. Interactive CLI starts, Home, and Setup use disclosure/approval policy. JSON starts use headless policy, which denies unverified authentication unless the caller explicitly enables it. Resume reauthorizes the existing session's required runner contexts without creating another session.

---

## The Planner interface

Defined in `src/engine/planners/types.ts`. Every planner implements:

```typescript
interface Planner extends RunnerRuntime {
  runPhase({ call, projectDir, inputs, callbacks }): Promise<PhaseCallResult>
  regenerate(prompt, artifactType, projectDir, callbacks): Promise<RegenerateResult>
  escalateHint(task, error, projectDir, callbacks, languageContext?): Promise<EscalationResult>
  escalateFull(task, error, projectDir, callbacks, languageContext?): Promise<EscalationResult> // legacy interface; never dispatched by escalation
  review(prompt, projectDir, callbacks): Promise<{ text: string; usage: TokenDelta | null }>
  summarize(messages, projectDir?): Promise<string>
  summarizeStructured?(messages, previousSummary?, projectDir?): Promise<{ text: string; structured: StructuredSummary | null }>
  injectUserTurn?(options): Promise<PlannerUserTurnResult>
  readonly capabilities: PlannerCapabilities
}
```

`runPhase()` is **one** planner call: one prompt, one document, one owned artifact. `call` is `research | spec | plan | tasks`; the orchestrator's step loop (`src/engine/orchestrator/planning/steps.ts`) decides which calls a mode makes and in what order, persists each artifact as it lands, and hands the next call whatever it needs through `inputs`. A planner never sequences a mode for itself, so a run that stops between two calls loses nothing.

`escalateHint()` supplies assistance for an implementer retry. Its prompt includes language-matched Similar Issues examples. The legacy `escalateFull()` interface remains available to old integrations, but new workflow execution never dispatches that rung. `regenerate()` revises artifacts after user comments, and `review()` performs the final review.

`PlannerUserTurnResult` distinguishes `{ status: 'delivered', usage }` from `{ status: 'not-delivered', reason: 'not-ready' }`. Usage may be null after successful delivery. The queue retains a not-ready correction for a later prompt and acknowledges only the IDs that prompt actually carried; arrivals during regeneration stay pending.

`PhaseInputs` is everything one call reads — `feature`, the `research` / `spec` / `plan` text the caller read back from disk, `projectContext`, `languageContext`, the optional `skillsContext` / `codebaseContext`, a `promptPrefix` (drained queue, recorded rejections), a `promptSuffix` (the continuation block a stateless seat needs), a `continuationTurn` that replaces the built prompt for a seat already holding this step's session, `priorMessages` and `attachments` for the first call of the process, and `quickPlan: { trivial }` when the `tasks` call is compiling briefs straight from the feature.

**Continuation per seat.** A step cut by Stop now is continued, not restarted from a blob. The step's own prompt is always stated; the continuation trails it (`composeContinuation`, `src/engine/spec/prompts/continuation.ts`). A planner holding a native session (`claude-code`, `codex` after its own thread id is captured) gets one extra user turn on that session — the steer plus *Continue the `<call>` step and output the complete `<artifact>` again* — because the conversation already carries the prompt. A stateless planner gets the rebuilt step prompt with the partial and the steer on the end. The reviewer re-issues its whole deterministic prompt, rebuilt from disk, with the note appended; it is one shot by constitution and never resumes a session. The implementer restarts the brief on `buildPrompt`, with the partial and a line naming the declared files that already changed since the task started; the attempt count does not move.

`PhaseCallResult` is what one call produced:

```typescript
interface PhaseCallResult {
  text: string
  usage: TokenDelta | null
  artifact: PhaseResult
  tasks?: Task[]   // the `tasks` call only
}
```

The `tasks[]` array is the durable contract. `research.md`, `spec.md` and `plan.md` are supporting documents for human review — quick mode writes none of them.

`runDocumentPhases()` (`src/engine/planners/document-phases.ts`) runs a mode's document calls back to back with no state, no gates and no durability. `splitbrief spec` is its only caller; every real run goes through the orchestrator's step loop instead.

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

`createReviewer()` builds the seat on the planner backends: it resolves the runner, then hands `loadPlanner()` a config whose planner slot holds the reviewer. A configured `effort`, `variant`, or `temperature` a backend cannot deliver is dropped with the same stderr warning the planner gets.

### Which calls the reviewer makes

BUILD repair cycles after final review use the selected implementer. These bounded repairs are distinct from planner takeover.

Exactly one: the final review of the run diff, dispatched from `runFinalReviewPhase()` (`src/engine/orchestrator/final-review.ts`) through `runReviewerCall()` (`src/engine/orchestrator/review-call.ts`). Every other strong-side call stays on the planner — the planning phases, `regenerate`, `escalateHint`, `summarize` / `summarizeStructured`, and `injectUserTurn`. `runPlannerReview` is still the planner's own review helper and still serves the speckit analysis and planning-regeneration call sites; the reviewer has its own call path rather than changing that one.

A reviewer that fails mid-call is reported, not replaced: `reviewStatus: 'failed'`, the reviewer's display name in the error, final-review evidence recorded, summary still produced. There is deliberately no automatic fallback to the planner.

---

## Planner capabilities

The orchestrator reads capabilities, not backend identity, to decide what's possible. This replaces if-chains on backend type.

| Capability | What it gates |
|---|---|
| `supportsConversationalPlanning` | Planner can emit inline clarification questions during planning |
| `supportsHintEscalation` | Planner can produce a short hint for an implementer retry |
| `supportsSessionResume` | Backend exposes a reusable thread handle it reports itself (Claude `--resume`, Codex exec resume) |
| `supportsEffort` | Backend honors effort/reasoning hints (thinking budget, `reasoning_effort`) — narrowly, that it accepts the `effort: EffortLevel` field on the wire. It is not the seat's effort channel: a tool that carries effort as an opencode `--variant` preset or inside its model id has a real channel while this capability stays false. `seatEffortChannel` (`src/core/runners/capabilities.ts`) is what answers the wider question; see [CONFIGURATION.md](./CONFIGURATION.md) common generation fields. |
| `supportsImages` | Backend can accept image attachments (vision models) |
| `supportsSelfSummarisation` | Planner can summarize its own prior transcript for compaction |

Two presets exist for common patterns:

- `CONVERSATIONAL_CAPS` -- everything except `supportsHintEscalation`. Used by the Claude Code planner only; other CLI tools use `ONE_SHOT_API_CAPS` with `supportsSessionResume` / `supportsEffort` overridden from their adapter.
- `ONE_SHOT_API_CAPS` -- conversational planning off, session resume off, effort/images off, hint escalation on. Used verbatim by API backends, and as the override base by every non-Claude CLI tool.

When a capability is missing, the orchestrator falls back. No session resume means context is rebuilt from the JSONL log. No conversational planning means no inline Q&A. No image support means attachments are dropped with a `planner_attachments_dropped` event.

---

## Planner base pipeline

`src/engine/planners/base.ts` -- `createPlannerBase(config)`.

Wraps a backend-specific `invokePlan()` function as `runPhase` (`src/engine/planners/run-phase.ts`), which selects the prompt builder for the call it was handed:

| `call` | Prompt | Artifact |
|---|---|---|
| `research` | `buildResearchPrompt()`, with the repo map as a `<repo-map>` block | `research.md` |
| `spec` | `buildSpecPrompt()`, reading `inputs.research` | `spec.md` |
| `plan` | `buildPlanPrompt()`, reading `inputs.spec` | `plan.md` |
| `tasks` | `buildTasksPrompt()`, or `buildQuickPlanPrompt()` when `inputs.quickPlan` is set | `tasks.md` |

Each call:
- Calls `callbacks.onPhase()` so the UI can update
- Creates a transcript buffer (16KB, flushed to `session.jsonl`)
- Injects `inputs.priorMessages` into the first call this planner instance makes, and never again. API backends receive them as an OpenAI messages array (`consumesPriorMessages: true`); CLI backends get a prompt-level prefix. `inputs.attachments` are delivered the same way, on the first call only.
- Converts the backend response into `RunnerCallResult` immediately, then accumulates token usage from the typed call result
- Returns the phase artifact text from the completed terminal result only; stdin/stdout adapters never reopen files that a backend wrote

Quick mode is the `tasks` call with `inputs.quickPlan` set: same machinery, one invocation instead of four. When the mode advisor classified the prompt as `trivial`, `quickPlan.trivial` is true and the prompt drops its codebase-review step and caps the brief count.

**Native session continuity.** A backend that resumes its own thread keeps it across the calls of a run. Claude Code captures the id **as it streams** (`onSessionId`, inside `runClaudePlannerStream`), not after the call returns, so a call cut halfway still leaves a thread the next call resumes. The CLI planner keeps the same in-memory `SessionResumeState` and passes only an id the tool itself reported — codex resumes its own thread id, never the SPLITBRIEF session id, which is not a tool thread at all.

Planner backend invoke functions return `RunnerCallResult`. Use `toInvokeResult()` only at outer legacy postprocess/extraction boundaries that explicitly need `{ text, usage }`; do not collapse typed call results before they reach the planner base. New adapters must emit typed call results directly and set `backendKind` (`api`, `cli`, `shell`, or `agent`).

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
1. Update imports to include the guard function
2. Add `describe('isProviderId')` block with positive and negative cases

### Tests
- `isProviderId('ollama')` returns true
- `isProviderId('bogus')` returns false

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

- a **tool CLI running a smaller model** -- `codex`, `claude-code`, or any other admitted CLI pointed at a smaller model. Write mode `direct`.
- a **model behind an OpenAI-compatible API** -- a local Ollama or LM Studio daemon, or a custom endpoint you declare. Write mode `extracted-code`.

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

`implement()` executes a single task. `retry()` re-executes with error context; configured temperature changes apply only when the transport supports them. `unavailabilityReason()` -- optional, mirroring the Planner interface -- returns a human-readable cause for the most recent `isAvailable()` returning false (e.g. "the endpoint is unreachable"), which the unavailable-implementer recovery carries when the runner can state one.

The implementer seat carries both effort channels to the wire, not just the flag one. `src/engine/implementers/cli.ts` hands the seat's `effort` and `variant` to the adapter's build-args input. Six adapters emit: `claude-code`, `copilot` and `command-code` emit `--effort <level>`; `codex` emits `-c model_reasoning_effort=<level>`; `opencode` and `kilo-code` emit `--variant <name>` after the `--model` pair. An adapter without a given channel ignores that field, so the caller never branches on tool. The full channel matrix lives in [CONFIGURATION.md](./CONFIGURATION.md) under the `effort` field.

The arg-vector preflight (`src/engine/runners/arg-vector-preflight.ts`) replays **long flags** against the installed binary's own help output, so a flag the local build does not know is a pre-spawn failure rather than a mid-task one. Codex is the exception and is **not** covered: its effort is the short `-c` plus a bare `key=value` token, and the preflight compares neither half, so a codex build that stopped accepting `model_reasoning_effort` would fail mid-task instead.

### Write modes

`ImplementerCapabilities` has one field:

```typescript
type ImplementerCapabilities = {
  writesFiles: 'extracted-code' | 'direct'
}
```

It records **who holds the pen**, not which path is preferred.

API profiles can receive a bounded explicit set of up to 32 declared text targets for `create` or `modify`. `requiredWriteModeForTask` rejects unsafe, duplicate, ancestor-overlapping or wildcard targets and requires every scope path to name an explicit target. Wider directory/glob scope, extra undeclared paths and unsupported actions still require a direct writer. `assessProfile` distinguishes backend output contracts: API uses `file-bundle-v1`, while legacy shell extraction remains single-file-only. API routing estimates the actual bundle prompt with whole contents of all supplied target baselines and a bundle output reserve; it does not reduce files to function excerpts to force a fit. Runtime capture and dispatch still check actual file kinds, baseline safety, model capacity and response limits.

| | `extracted-code` | `direct` |
|---|---|---|
| Writes the file | SPLITBRIEF | the implementer |
| Kinds | `api`, `shell` | `cli`, `agent` |
| Model answers with | API: strict text-file bundle; shell: complete single-file contents | edits already made on disk |
| Change detection | returned text is compared against captured target baselines | `detectChanges()` against a baseline captured before the call |
| Works in | project directory; API bundle targets or one legacy shell target | the run's isolation directory, the brief's `files` (see below) |
| Approval applies | exact target paths before writes; API preflights the whole candidate set | at promotion, over the whole changed set |
| Empty result | extraction error | `no-staged-change` outcome + `implementer_wrote_nothing` warning |

### Isolation and promotion

A `direct` implementer edits files itself, so it is handed its own working directory instead of the user's checkout. The default isolation is a **git worktree created once per run** -- one directory for the whole run, not a copy per task. Project dependencies are reachable inside it, so the implementer can run the project's own typecheck, lint, and tests against its own work.

Isolation is scoped to direct writers (ADR-4). The task loop acquires a workspace only when the implementer's write mode is `direct` (`runImplementation`, `src/engine/orchestrator/task/run-implementation.ts`), so an `extracted-code` implementer writes through SPLITBRIEF into the project directly and `workflow.isolation` never applies to it -- see [CONFIGURATION.md](./CONFIGURATION.md) §5. Escalation is the one exception: a retry always acquires a workspace (`src/engine/orchestrator/escalation/step.ts`), and for an `extracted-code` implementer that acquisition bypasses the configured strategy and stages the retry in a temporary copy of the project.

When a task ends, the changed set is computed against the baseline captured when that task acquired the workspace, not when the isolation directory was created -- git status/diff when the isolation directory is a real checkout, a whole-tree hash diff when it is not (`getChangedFilesSinceSnapshot`, `src/engine/orchestrator/approval/file-snapshots/capture.ts`). The set is gated for approval and then **promoted into the user's real project directory**. Promotion is hash-guarded: a file whose content changed between the approval read and the write is not overwritten, it is reported as a conflict and the whole promotion is refused (`promoteStagedChanges`, `src/engine/orchestrator/approval/staged-project.ts`). Changes always land in the real project -- that is the point of the mechanism.

The run-scoped handle (`createRunIsolation`, `src/engine/orchestrator/isolation/create.ts`) keeps the isolation directory alive across tasks and retries. A worktree workspace is reused between acquisitions through a marker carrying the session id, and each acquisition takes a fresh baseline so a later task reports only its own edits. The worktree is disposed when the run ends: if nothing unpromoted remains it is removed with force and its branch deleted, otherwise it is retained -- it holds work that was never promoted -- and the run reports the retention.

A worktree isolates files, not the machine. It shares refs, git config, and hooks with the real repository, and it shares ports, databases, and environment with everything else running. It is not a security boundary.

An isolation strategy that copies the project instead of checking it out must exclude build output and report artifacts as well as the VCS, dependency, and SPLITBRIEF directories. The staged copy derives its file list from git's own ignore rules, so gitignored `dist/`, `coverage/`, and tool output never enter the copy -- otherwise it would move hundreds of megabytes per run.

Whichever mode ran, validation happens in the real project directory after promotion. The implementer's ability to run checks on its own work is a first-pass-rate improvement, not the source of truth about correctness.

### Prompt contract per mode

`formatImplementerSystemPreamble(languageContext, writesFiles, outputContract)` (`src/engine/spec/prompts/system.ts`) selects the backend’s output contract. API `file-bundle-v1` gets a strict JSON-bundle preamble; the comparison below describes legacy extraction and direct writing. The Task Brief body underneath it is the same in both modes -- description, signature, type definitions, pattern, implementation steps, tests, scope, escalation, evidence, constraints (`buildTaskSections`, `src/engine/spec/prompt-formatter.ts`).

| Preamble carries | `extracted-code` | `direct` |
|---|---|---|
| Language and import conventions | yes | yes |
| Output rules (whole file, no fences, no prose) | yes | n/a -- the model edits files |
| Worked example in the target language | yes | n/a |
| File scope -- which files it may touch and which it may not | n/a -- the single declared file is written for it | yes -- every path under Files, plus the Scope bullets |
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
   - API `file-bundle-v1`: parse the entire completed response, approve and baseline-check declared candidates, apply text files, then publish aggregate metrics only after whole-bundle success. Partial application retains its exact effects in task evidence and fails the attempt.
   - Legacy `extracted-code` for shell/command backends: extract code from response via `extractCode()`, run through tiered approval (`approveWrite`), apply to disk via `applyCode()`, compute diff. Between approval and apply, a plausibility guard (`src/engine/implementers/pipeline/extracted-code.ts`) refuses a marker-less modify response that would keep less than half of a baseline file of at least five non-empty lines: the file is left untouched and the task fails with the kept-of-had line counts plus a literal SEARCH/REPLACE template, so the retry has an exact-patch escape hatch.
   - `direct` (`extractsCode: false`): detect file changes via `detectChanges()` against the baseline captured before the call. The isolated workspace declares which baseline that is rather than letting the detector sniff the directory: a linked worktree carries git metadata but is seeded with your uncommitted work, so it is compared by file-content hashes, and a retry that rewrites the file the previous attempt already wrote is seen as a change. No change at all is a `no-staged-change` failure, not a silent success: the detector's negative result carries the distinct `reason: 'no-files-changed'`, and the pipeline publishes one coded warning (`category: implementer`, `code: implementer_wrote_nothing`) naming the runner and the task. The warning lands in `session.jsonl` and in the review packet's warnings list, while the retry and escalation behaviour stays exactly as before — the task still fails.
5. **Publish result** -- `publishDone` with diff metrics (lines added/removed, duration) or `publishFailed`.

For retries, `buildRetryPrompt()` prepends the error message with escalating framing -- attempt 1 says "fix it", attempt 2 says "rephrase", attempt 3 says "try a completely different approach". Configured temperature increases by `retryTemperatureStep` per attempt only affect transports that support the field; current API requests omit it.

The implementer base normalizes backend output into `RunnerCallResult` before processing files. A non-completed status returns a failed `ImplementerResult` with partial output and usage preserved; user aborts, timeouts, truncation, refusals, unsupported tools, and incomplete streams are not collapsed into generic success/failure strings.

**Call deadlines.** A CLI implementer call runs under a deadline of `config.timeout ?? TIMEOUTS.implementerMs` — 20 minutes (`src/engine/implementers/cli.ts`, `src/core/pipeline-spec/timeouts.ts`), which is also the cap the `timeout` config field accepts. The reviewer's one call runs under `TIMEOUTS.reviewerMs`, 10 minutes (`src/engine/planners/cli.ts`, the `review` role); every other planner call has no deadline of its own, because a planning turn's length is the operator's to judge. A deadline that fires is a `timeout` outcome, not a crash, and two of them in a row on the same brief stop the run with an `runner-timeout-repeated` recovery rather than escalating an oversized slice to the planner (`TIMEOUTS.consecutiveTimeoutsHalt`).

---

## Token accounting

Token usage is tracked as `TokenDelta` (`src/core/schemas/tokens.ts`):

```typescript
type TokenDelta = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreateTokens?: number
  reasoningTokens?: number
  counterCoverage?: RunnerCallCounterCoverage
  providerTotals?: { input?: number; output?: number }
}
```

Deltas are normalized in `src/engine/calls/usage.ts`, which handles delta, cumulative, and final samples consistently. Accumulated usage is published through `cost_update` events.

### Unknown is not zero

The five counters are disjoint where the provider reports all of them: `inputTokens` is ordinary input without cache, `outputTokens` is ordinary output without reasoning. `counterCoverage` (`src/core/runner-call-contract.ts`) says which of the five the provider actually reported — `reported`, `partial` or `missing` per category — and `providerTotals` keeps the inclusive totals the provider sent (`prompt_tokens`, `completion_tokens`) as metadata, never as further counters to add up.

An absent optional counter means the provider never reported it. It is not a zero, and nothing in the pipeline turns it into one: a missing reasoning count leaves the seat's `*Reasoning` field absent, while a reported `0` creates that field at `0`. An absent `counterCoverage` on a historical record means legacy-unknown, not "nothing reported". Pricing may still know the cost of generation from `providerTotals.output` without a reasoning breakdown, because one output rate covers the whole total; a missing cache split, where the cache rates differ, is incomplete pricing rather than a rate to guess.

### Session totals

Session totals (`TokenUsage`) carry four categories, not three: `planner*`, `implementer*`, `escalation*`, and `reviewer*`. Each category owns the same five counters — `Input`, `Output`, the optional `CacheRead` / `CacheCreate` / `Reasoning` — plus an optional `*Coverage`, the same five-category coverage object per role. `usageCategoryForRunnerCallRole()` (`src/engine/orchestrator/tokens.ts`) routes the `'review'` call role into the `reviewer` bucket; `'planner'`, `'summary'`, and `'compaction'` stay on the planner.

The `*Output` fields stay ordinary output. `totalOutputTokens()` and the seat's billing projection (`SeatTokenTotals.output`, `src/core/providers/seat-totals.ts`) add the known reasoning to it **exactly once**; `SeatTokenTotals.reasoning` repeats that known part for display, and a caller that adds it to `output` bills those tokens twice.

Escalation runs on the planner's runner but keeps its own `escalationCacheRead` / `escalationCacheCreate` / `escalationReasoning`, so new evidence stays attributable to the escalator. `splitSeatTokenTotals` folds the two back onto one planner seat for pricing. A record written before those fields pooled escalation cache into the planner buckets; there the escalation fields are simply absent, and that pooled amount is never counted a second time as escalation.

Live booking (`addUsage`) and the replay of recorded calls (`addRunnerCallUsageToTokenUsage`) run the same category rules, so a reconciled run cannot drift from the run that produced it. Seat coverage is set by the first evidence on an empty seat and degrades to `partial` where later evidence disagrees; a seat that already carries counters but no coverage is a legacy record and stays unknown rather than borrowing a new call's word.

All of these fields are **additive within state v4** (`WORKFLOW_STATE_VERSION = 4`): they are optional, so a `state.json` or `summary.json` written before them parses unchanged and no migration runs. The one non-optional back-compatibility rule predates them — `reviewerInput` / `reviewerOutput` default to `0` for state written before reviewer accounting existed. New optional fields deliberately do **not** default, because a default would be exactly the reported zero they must stay distinguishable from.

`reconcileTokenUsageWithSessionLog` (`src/engine/orchestrator/summary/usage-reconcile.ts`) replays `session.jsonl` when the ledger lost a call: a seat the ledger books alone takes the higher of booked and observed, the planner/reviewer pool takes only the shortfall the log shows, and coverage takes the log's word where it has one. Reconciling an already-reconciled record changes nothing.

Pricing follows the seat: with a `reviewer` block, the reviewer's tokens are priced at the reviewer runner's rates and shown as their own line in the run summary; without one, they are priced at the planner's rates and folded into the planner line, exactly as before.

CLI runners report usage through their protocol terminal: codex through its `turn.completed` record, claude-code and opencode through their streamed terminal events. Codex's `input_tokens` counts cached input, so the normalizer excludes `cached_input_tokens` from the reported input total and surfaces it as `cacheReadTokens`; claude-code's terminal `result` line takes precedence over mid-stream deltas. A CLI runner that completes without reporting usage records zero implementer tokens — by design for structurally unpriced runners, and never fabricated.

Per-task usage is recorded as `TaskTokenUsage`, which tracks: implementer tokens, escalation tokens, retry count, cost, model used, context fit classification (`fits` / `tight` / `overflow`), and the `currentCodeContextMode` that was selected. Alongside the combined `implementerTokens` / `escalationTokens` it carries the optional directional counters `implementerInputTokens` / `implementerOutputTokens` / `escalationInputTokens` / `escalationOutputTokens` and the optional `*ReasoningTokens`. These come only from a delta the ledger actually knows — the difference between the run totals before and after the task — never from a share of the run. A record written before them keeps its combined count alone: its split is unknown, not zero, and is not imputed.

A runner completing a task without reporting usage is recorded as zero tokens and surfaced, not hidden: `recordTaskUsage` (`src/engine/orchestrator/tokens.ts`) publishes exactly one warning with `category: 'usage'` and `code: 'implementer_usage_not_reported'`, naming the runner and the task, when neither the implementer nor the escalation delta is non-zero. The warning lands in `session.jsonl` and in the review packet's warnings list. An escalated task that spent planner tokens does not warn. SPLITBRIEF never invents a price or synthesises token counts for a runner that reported none — a CLI runner staying structurally unpriced is by design, and this warning is what makes a run that did real work distinguishable from a run whose runner reported nothing.

**Legacy prompt allocation** (`src/engine/spec/token-budget.ts`):

```
budget = contextLength - systemPromptTokens - taskBodyTokens - (contextLength * 0.25)
```

The legacy fallback is `DEFAULT_UNKNOWN_CONTEXT_LENGTH = 32768` in `src/core/tokens/context-length.ts`. API bundle routing retains full supplied file contents and reserves bundle output instead of shrinking them through this allocation. API dispatch separately resolves configured context, observed active context or the 8192 application default, then applies the measured input margin and output reserve described in [CONFIGURATION.md](./CONFIGURATION.md).

A boot-probed window applies only to the default implementer profile — the profile the probe ran for. A sibling profile uses its own model/configuration metadata; an API profile without known active or configured capacity uses the API application fallback.

A CLI runner under `model: auto` — or with the model omitted — resolves to no model id, so its window is the smallest the bundled catalog guarantees for that tool (`resolveRunnerContextWindow`, `src/engine/providers/model/context-window.ts`); automatic selection never adds a `--model` flag.

Routing between configured profiles is by capability, never by price: `compareProfileRouteRank` (`src/engine/orchestrator/context-routing/decision.ts`) ranks the capable profiles by context window, smallest sufficient window first, then by name. A routed selection names the profile and the fit it was chosen on: `Selected profile <name> (fits, estimated N/M tokens)`.

The window the router decides is the one the prompt budget uses: `configForProfile()` (`src/engine/orchestrator/task/routing.ts`) copies the decided `contextLength` into the config handed to the selected implementer when the profile declares none — a window the profile declared for itself is never overridden — so the wire carries the routed window rather than an unbudgeted whole-file prompt.

Token estimation uses a per-model-family character-to-token ratio (`src/core/tokens/estimate.ts`): Claude models use 3.5, GPT uses 4.0, DeepSeek/Qwen/Llama/etc. use family-specific ratios. When a model ID is available (e.g., during implementer profile routing), the calibrated ratio produces more accurate estimates — reducing unnecessary escalations from overestimates and overflow failures from underestimates. Callers without model context (repomap budget, planner base) default to 4.0 chars/token.

The 25% reserve is for output. The remaining budget goes to `currentCode`. If the whole file doesn't fit, the prompt formatter tries these modes in order:

1. **whole-file** -- entire file content
2. **function-level** -- imports + target function only (extracted via signature name)
3. **truncated-middle** -- first half + `// ... truncated ...` + last half
4. **none** -- no code context

---

## Model catalog lanes

models.dev serves `api` runners only. A CLI tool's picker rows come from its own listing (`confirmed` / `stale`), from claude-code's local option cache, and — until a list lands — from the bundled `KNOWN_MODELS` aliases (`bundled-suggestion`); `buildRightRows` (`src/features/runners/model-catalog/rows.ts`) hides bundled rows when a live lane is present, except the persisted model and custom rows. An `api` runner also renders models.dev rows (`catalog-suggestion`) beside its runtime list. `resolveModelCatalog` (`src/engine/providers/model/catalog.ts`) still classifies bundled membership — the hide is a picker filter, not an engine-catalog drop.

Pricing lookup keeps its ladder — cached models.dev first, then runtime metadata, then the bundled catalog (`resolvePricing` in `src/engine/providers/pricing-resolver.ts`) — and applies to api-priced runners. A CLI tool's context window comes from its own listing or the bundled table (`resolveRunnerContextWindow` in `src/engine/providers/model/context-window.ts`); an `api` runner's window keeps models.dev ahead of runtime metadata and the bundled catalog.

---

## Four runner kinds in practice

### cli

`src/engine/planners/cli.ts`, `src/engine/implementers/cli.ts`

Spawns a CLI tool as a subprocess. Supported tools: `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`.

Every planner call declares its transport before dispatch: the current call's final response (`stdout-final`) or an exact declared-file lease. The candidate is that call's authoritative final output; session files, project-root artifacts, markdown-linked paths, prose mentions, stderr, and earlier attempts are evidence at most, never content. Claude Code continues a session it already minted with `--resume`. Output is parsed line by line via each tool's protocol parser; a configured `outputFormat` cannot replace a structured terminal contract.

The implementer writes files directly (`writesFiles: 'direct'`) inside the run's isolation directory, and change detection runs there. Claude Code gets a special path through `runClaudeOneShot()`. A CLI configured with a smaller model than the planner's is one of the two canonical implementer setups -- see [Write modes](#write-modes).

#### Canonical CLI runner matrix

Runtime source of truth: `src/core/runners/cli-tool-catalog.ts` (`CLI_TOOL_CATALOG`, `CLI_TOOL_TRUST`). This section is the canonical support matrix for admitted CLI runners. Parity is enforced by `testing/docs/planners-and-implementers.test.ts`.

Each admitted tool carries a `testedVersion` and a `minimumAdmittedVersion` — the upstream CLI release the flag, subcommand, and output contract were last verified against, and the oldest release admitted. `detectAvailablePlanners` (`src/engine/detection/detect.ts`) probes the installed version via the adapter-declared version command. Admission is forward-compatible: only versions below the minimum are incompatible; newer releases are admitted, and malformed or unproven versions remain unverified. It does not print a startup stderr warning for unselected tools.

When you adjust a tool's adapter to track an upstream CLI change, bump that tool's `testedVersion` in the catalog and update this matrix.

##### Admitted support summary

| `tool` | command | roles | tested version | version scheme | evidence as-of | model policy (planner / implementer) | model discovery | billing |
|---|---|---|---|---|---|---|---|---|
| `claude-code` | `claude` | planner, implementer | 2.0.0 | `semver` | 2026-07-31 | optional / optional | `native-aliases-and-custom` | subscription-included |
| `codex` | `codex` | planner, implementer | 0.40.0 | `semver` | 2026-07-31 | optional / optional | `capability-gated-native` | subscription-included |
| `opencode` | `opencode` | planner, implementer | 0.5.0 | `semver` | 2026-07-31 | optional / optional | `native-cli` | provider-dependent |
| `copilot` | `copilot` | planner, implementer | 1.0.77 | `semver` | 2026-09-02 | optional / optional | `native-cli` (`copilot help config`) | subscription-included |
| `kilo-code` | `kilo` | planner, implementer | 0.1.0 | `semver` | 2026-07-31 | optional / optional | `native-cli` | provider-dependent |
| `cursor` | `cursor-agent` | planner, implementer | 2026.08.25-3e8eec8 | `calver` | 2026-08-27 | optional / optional | `native-cli` (`--list-models`) | subscription-included |
| `command-code` | `cmd` | planner, implementer | 1.39.2 | `semver` | 2026-09-01 | optional / optional | `native-cli` (`--list-models`) | subscription-included |
| `antigravity` | `agy` | planner, implementer | 1.2.2 | `semver` | 2026-09-14 | optional / optional | `native-cli` (`agy models`) | subscription-included |

**Command Code's row was captured from the real binary on 2026-09-01 against `cmd` 1.39.2**, replacing the hand-authored fixtures that stood in for it. The raw `cli-conformance` leg passes; the production leg records `OMIT` because the conformance sandbox gives the child a fresh `HOME` and never bridges host CLI session state, so a `session`-auth tool reaches the CLI unauthenticated. That gap is the harness's, not the adapter's — the adapter's own argv was replayed against the authenticated binary and its terminal `result` frame parses. See `testing/fixtures/command-code/README.md` for the recorded evidence and the remaining gap.

`cursor` executable aliases are `cursor-agent` / `agent`. Command Code's binary is `cmd` with no alternate alias, and its credentials come from `cmd login`; there is no API-key environment channel. Antigravity's binary is `agy`, `agy --version` prints a bare semver (`1.2.2`, captured 2026-09-14 — `agy --help` prints no version at all), and `agy models` is both its auth probe and its model listing: one `<id>\t<display name>` row per effort variant (`gemini-3.8-flash-high`), merged into one picker row per model. The seat spends its effort on `--effort` (`effortChannel: 'effort-flag'`), not through the id suffix. The reviewer seat uses planner backends (the same admission set).

##### Posture, trust, and auth

The auth-channel column describes catalog staging capabilities, not selectable methods proven for an installed invocation. The enforcement matrix is currently empty: explicit `session` or `api-key` is refused, while an omitted selection uses host CLI configuration. See [AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md).

| `tool` | direct write (planner / implementer) | shell | network | automatic approval (implementer) | sandbox (planner / implementer) | auth channels | credential env |
|---|---|---|---|---|---|---|---|
| `claude-code` | no / yes | yes / yes | yes / yes | `--permission-mode acceptEdits` | none / none | session (host account on macOS, see below), api-key | `ANTHROPIC_API_KEY` (api-key channel) |
| `codex` | no / yes | yes / yes | yes / yes | `--sandbox workspace-write` | mode-dependent / cli-managed | session, api-key | `OPENAI_API_KEY` (api-key channel) |
| `opencode` | no / yes | yes / yes | yes / yes | — | none / none | provider-dependent | inherited from provider config |
| `copilot` | no / yes | yes / yes | yes / yes | `--allow-all` | none / none | session | `GH_TOKEN`, `GITHUB_TOKEN` |
| `kilo-code` | no / yes | yes / yes | yes / yes | `--auto` | none / none | provider-dependent | inherited from provider config |
| `cursor` | no / yes | yes / yes | yes / yes | `--force` | none / none | `api-key-or-session`: session (host-cli-state), api-key | `CURSOR_API_KEY` (api-key channel) |
| `command-code` | no / yes | yes / yes | yes / yes | `--yolo` | none / none | session | — |
| `antigravity` | no / yes | yes / yes | yes / yes | `--dangerously-skip-permissions` | none / none | session | — |

Session channels use `host-cli-state` bridging where noted in the catalog. SPLITBRIEF never copies credentials into argv. Subscription-included tools bill through the vendor login; provider-dependent tools inherit the upstream model provider's billing posture.

The bridge copies files, so a channel whose credential is an OS keychain item reaches a staged runner another way. A channel declares those platforms in `hostKeychainPlatforms` (`src/core/runners/cli-tool-catalog.ts`), which today names macOS for the Claude Code, Cursor Agent CLI and Antigravity `session` channels: the subscription session lives in the login keychain, whose search list resolves through `HOME` and whose item is keyed on `USER`. `cliAuthChannelHostStateAccess()` maps that to `host-account`, and `createSandboxEnv()` then leaves `HOME`/`USER` at their host values and bridges no file — every other redirect stays. Readiness never infers such a credential from files: it runs the tool's own status command and reports what the child answers. See [docs/API-KEYS.md](./API-KEYS.md).

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
| — | — | — | — | — |

No CLI candidate currently sits on an OMIT verdict. `CURSOR_CLI_ADMISSION_VERDICT`, `COMMAND_CODE_CLI_ADMISSION_VERDICT` and `ANTIGRAVITY_CLI_ADMISSION_VERDICT` are all `PASS` in `cli-tool-catalog.ts`. Candidate runtime adapter sources must remain absent while a verdict is OMIT. No unverified-auth override can promote an omitted candidate.

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

REST call to an OpenAI-compatible HTTP endpoint. Ollama, LM Studio and llama.cpp can fill PLAN, BUILD and REVIEW independently, as can an admitted custom endpoint. Every seat retains its own address and exact model ID.

Local server connections do not require a provider executable on PATH. Start the server externally and use Retry after correcting the connection. Discovery and admission never implicitly load or download models. Observed active context, maximum context and the configured application budget are separate values.

The planner uses `dispatchStreamCompletion()`, which streams the OpenAI-compatible chat-completions protocol. Prior messages are passed as a proper messages array (`consumesPriorMessages: true`). Token usage comes from the API response.

Every newly dispatched API BUILD call uses file-bundle-v1, including single-file tasks, retries, and continuation.

The API implementer retains `writesFiles: 'extracted-code'` because SPLITBRIEF applies the returned text. The backend selects the grammar before dispatch; response text never selects a fallback. Shell/command extracted output keeps `legacy-code-v1`, and direct writers keep `direct`. See [TASK-CONTRACT.md](./TASK-CONTRACT.md#api-build-file-bundles) for limits and partial-apply evidence. Application budgets and effective request options are described in [CONFIGURATION.md](./CONFIGURATION.md). Current API transport omits configured temperature and effort controls, including retry temperature increments.

PLAN receives an explicit packet of instructions, project metadata, required artifacts and supplied source text. Its manifest names included, excerpted, omitted, missing and unsupported sections. A path alone does not grant filesystem access. Missing, unsupported or oversized required context refuses the call; optional context may be visibly omitted. This is a text transport with no shell, search or autonomous tool loop.

REVIEW uses one complete packet and one stateless call. Required current diff, task/evidence and drift inputs must fit without silently dropping files. A missing drift artifact may be replaced by a complete fresh deterministic recomputation. Insufficient context or a transport/protocol failure enters non-verdict recovery; it is neither zero-blocker success nor a BUILD repair cycle. Adjust `/crew plan` or `/crew review` as indicated, resume and choose retry. Recovery preserves the diagnosis, with token estimates confined to explicitly opened details.

Availability is probed, not assumed. An api-kind implementer's `isAvailable()` contacts the provider's model list (`createProviderAvailability`, the same helper the api planner uses) and reports unavailable when the endpoint refuses the connection or returns an empty list. A local endpoint is not assumed reachable just because it is local. The probe fires once per task iteration at the task-loop availability gate, and the verdict is never cached across tasks, so a daemon started between task N and task N+1 is picked up on N+1.

### shell

`src/engine/planners/shell.ts`, `src/engine/implementers/shell.ts`

Arbitrary command run via `createCommandBasedPlanner()` / `createCommandBasedImplementer()`. The prompt is piped to stdin, output read from stdout. Config provides `command`, `args`, and `outputFormat`.

The implementer extracts code from stdout (`writesFiles: 'extracted-code'`). The planner detects artifact changes via git diff.

### agent

`src/engine/planners/agent.ts`, `src/engine/implementers/agent.ts`

Like shell, but the subprocess writes files to disk directly instead of returning code in stdout. Change detection via `createChangeDetector()` (git diff before/after).

The planner reads phase artifacts from the session directory. Historical full-escalation records remain readable; the workflow no longer dispatches planner code-writing takeover.

The implementer uses `writesFiles: 'direct'` with git-based change detection.

---

## Planner artifact ownership

A planner call produces a candidate, not a canonical artifact. Every call declares its transport before dispatch. `stdout-final` derives the candidate from the current call's authoritative final response only. Earlier messages, partials, tool-call text, stderr, and prior attempts are evidence at most. `declared-file` hands the child one host-prepared, invocation-unique lease; acceptance requires that exact regular file, a bounded no-follow read, unchanged ancestry and identity, and a matching receipt. Missing, pre-existing, sibling, same-basename, traversal, absolute, symlinked, path-swapped, non-UTF-8, or oversized files fail. There is no `auto` source, source priority, prose sniffing, or filesystem search.

Planner mode does not grant artifact authority. A `--agent plan`, `--permission-mode plan`, or `--sandbox read-only` flag bounds what the tool may do; it does not prove what the process could reach, what its output means, or that an artifact is fresh. The production-factory conformance harness (`src/engine/runners/cli-tools/contract-harness.ts`, driven by `scripts/cli-conformance.ts`) is what can prove the effective role, containment, and final-response contract. Writes are observed after the fact by post-run mutation detection (`src/engine/orchestrator/planning/mutation-guard.ts`), which fails the planning call on unexpected filesystem mutations.

### Effective roles by backend

The role vector is pinned and effect-verified per backend. A role that is missing, overridden, falls back, prompts interactively, or cannot be verified makes the backend unsupported for that role.

| Backend | Planner role | Implementer role |
|---|---|---|
| `opencode` | `--agent plan` | `--agent build` |
| `kilo-code` | `--agent plan` | `--agent code --auto` |
| `claude-code` | `--permission-mode plan` (Read, Glob, Grep, Plan only) | `--permission-mode acceptEdits` |
| `codex` | `--sandbox read-only --ask-for-approval never` exec, ambient config and rules ignored, ephemeral detached | `--sandbox workspace-write --ask-for-approval never` in the staged checkout |
| `cursor` | `--print --output-format stream-json --mode plan --trust` | `--print --output-format stream-json --force --trust` |
| `command-code` | `-p --output-format json --trust --skip-onboarding --permission-mode plan` | `-p --output-format json --trust --skip-onboarding --yolo` |
| `antigravity` | `-p --mode plan --print-timeout 10m` | `-p --dangerously-skip-permissions --print-timeout 20m` |

A planner never gains canonical write authority. Candidates stay non-canonical until the authoritative generation commit; the fixed `tasks.md`, `brief-quality.json`, `spec.md`, and `plan.md` files are compatibility projections of that generation. See [WORKFLOW.md](./WORKFLOW.md) for the generation, permit, and disposition flow.

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

Both `planner` and `implementer` are discriminated unions on the `kind` field. The four variants share generation-common fields and add kind-specific ones:

```typescript
// Shared across all four kinds
type GenerationCommon = {
  model: string
  customModels?: string[]
  contextLength?: number
  temperature?: number       // 0–2
  timeout?: number           // ms, max 1200000 (TIMEOUTS.implementerMs)
  effort?: EffortLevel
  variant?: string           // named preset for the `variant` effort channel
}

// Kind-specific fields (simplified)
type CliRunner    = { kind: 'cli';       tool: CliToolId; args?: string[] }
type ApiRunner    = { kind: 'api';       provider: string; service: string; offering: ApiOffering; apiBase: string; apiKey?: string }
type ShellRunner  = { kind: 'shell';     command: string; args?: string[] }
type AgentRunner  = { kind: 'agent';     command: string; args?: string[] }

type PlannerConfig      = (CliRunner | ApiRunner | ShellRunner | AgentRunner) & GenerationCommon
type ImplementerConfig  = (CliRunner | ApiRunner | ShellRunner | AgentRunner) & GenerationCommon
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
    mode?: WorkflowMode          // quick | standard | speckit
    approve?: ApproveLevel       // none | spec | plan | all | default
    maxRetries: number
    compactionThreshold?: number
    git?: { createBranch?: boolean } // retired commitStrategy input is stripped
    // ... plus taskReview, briefReview, driftChainThreshold
  }
  escalation?: { intermediateProvider?: string; intermediateModel?: string; enabled?: boolean }
  approval?: { enabled?: boolean; tiers?: TierMap; feedRejectionsToPlanner?: boolean; ... }
  codebase?: CodebaseConfig
  hooks?: HooksConfig
  // ... plus theme, sessions, palette
}
```

Factory dispatch reads `config.planner.kind` and `config.implementer.kind` and lazy-loads the matching backend module. The rest of the config flows through to the orchestrator, the validation pipeline and the prompt token budget.

---

## Language context

`src/engine/spec/prompts/language-context.ts`

The planner prompt builders adapt import conventions, type annotation style, and code-fence language to the target project. The `LanguageContext` struct carries five fields: `language`, `importConvention`, `typeAnnotationStyle`, `fileExtension`, `moduleSystem`. Built-in presets exist for TypeScript, JavaScript, Python, Go, and Rust; everything else gets generic defaults.

**Detection** happens two ways. `detectPromptLanguage(projectDir)` probes the project root for manifest files: `Cargo.toml` (Rust), `go.mod` (Go), `pyproject.toml` (Python), then `package.json` (TypeScript if the `typescript` dependency exists, JavaScript otherwise). Separately, `extractLanguageFromResearch()` parses the planner's research markdown output for a `**Language**: <name>` line -- this is the primary detection path in modes that run research (standard, speckit), since the research prompt asks the planner to identify the language. In quick mode, only `detectPromptLanguage()` is available.

**Which phases receive it:** spec, plan, tasks, and quick-plan prompts all accept an optional `LanguageContext`. Research does not -- it is the phase that produces the language signal. For non-JavaScript/TypeScript projects, language context is injected as a visible `Language Context` section in the prompt. For JS/TS projects it is omitted (the prompt defaults already assume JS/TS conventions).

**Adding a new language:** add a case to `buildLanguageContext()` mapping the normalized name to a `LanguageContext` struct, add the name to `normalizeLanguage()`, add a code-fence mapping in `codeFenceLanguage()`, and add a manifest check to `detectPromptLanguage()` if applicable.

---

## Planner prompt builders

`src/engine/spec/prompts/`

Each planning phase has a dedicated prompt builder. All builders produce a single string via the shared `buildPrompt()` helper, which assembles titled sections with headings. Signatures and what they receive:

**`buildResearchPrompt(feature, projectContext, skillsContext?)`** -- the first planner call. `projectContext` includes the repo map. The prompt asks the planner to read files, map architecture, identify relevant code, note constraints, and output a structured research report including validation toolchain and detected language.

**`buildSpecPrompt(feature, researchOutput, languageContext?)`** -- receives the research output and writes `spec.md`. Defines what to build (not how). Language context sections are injected for non-JS/TS projects.

**`buildPlanPrompt({ spec, projectContext, skillsContext?, languageContext?, maxPromptBytes? })`** -- receives the approved spec (as a `PlanPromptSpec` with content and a `hasClarifications` flag) and writes `plan.md`. Defines how to build it. If the spec includes user clarifications, the output instruction tells the planner to reference those decisions.

**`buildTasksPrompt({ spec, plan, languageContext?, currentTasks? })`** -- receives spec and plan, produces `tasks.md` markdown. The prompt includes the full Task Brief v1 contract (nine semantic sections), critical rules for self-containment, and a format example. Output is parsed into `Task[]` by the task parser.

**`buildQuickPlanPrompt(feature, projectContext, languageContext?, trivial?)`** -- collapses all phases into one call. Receives the feature and project context directly, emits `tasks.md` with no spec or plan document. With `trivial` set, the first instruction becomes "do not review the codebase structure first" and the prompt caps output at 1-5 briefs; the contract sections stay required either way.

**Context availability by phase:** Research sees the feature text, project context (including repo map), and skills context. Spec sees feature + research output + language context. Plan sees spec + project context + skills context + language context. Tasks sees spec + plan + language context. Quick sees feature + project context + language context.

---

## What to read next

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** -- full config schemas and YAML examples for all runner kinds
- **[WORKFLOW.md](./WORKFLOW.md)** -- how the orchestrator drives the planner through phases
- **[ENGINE.md](./ENGINE.md)** -- how events flow from engine to UI
