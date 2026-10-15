# Planners and implementers

How the two roles and their three seats are created, what interfaces they expose, how the four runner kinds work, and how to add a new backend.

---

## Two roles, three seats, one factory

Two roles — planner and implementer — fill three seats: plan, build, and review. All three seats are created by `src/engine/runners/factory.ts`:

- `createPlanner(config, { preparedConfig, preparationId, gates, slot, initialSessionId?, ... })` returns a `Planner`
- `createImplementer(config, { preparedConfig, preparationId, gates, slot, ... })` returns an `Implementer`
- `createReviewer(config, { preparedConfig, preparationId, gates, slot, ... })` returns a `Reviewer`

Every option object is required. `config` and `preparedConfig` must be the same object returned by execution preparation; the factory rejects a different configuration even when its runner has the same tool, provider, endpoint, or command identity. The selected slot lets the implementer factory derive named-profile configuration from that prepared snapshot.

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

Non-CLI gates reuse the validation or admitted invocation already produced during that preparation; execution does not turn cached discovery into a second authority decision. Every gate is also bound to its exact role: planner, reviewer, or named implementer profile. New workflows and resumes prepare the planner, every configured implementer profile, and the reviewer when a `reviewer` block is configured. `spec` prepares only the planner.

The reviewer joins that list when — and only when — `.splitbrief/config.yaml` carries a `reviewer` block: `prepareExecution()` adds it as a candidate under slot `{ role: 'reviewer' }`, and a failed admission is a blocker naming the Reviewer. With no block, `resolveReviewerRunner()` hands the seat to the planner and the planner instance is reused unchanged, so there is nothing extra to admit.

Entry points express policy differences while sharing this boundary. Interactive CLI starts, Home, and Setup use disclosure/approval policy. JSON starts use headless policy, which denies unverified authentication unless the caller explicitly enables it. Resume reauthorizes the existing session's required runner contexts without creating another session.

---

## The Planner interface

Defined in `src/engine/planners/types.ts`. Every planner implements:

```typescript
interface Planner extends RunnerRuntime {          // RunnerRuntime: isAvailable(), getVersion()
  typedCall(ctx: TypedCallContext): TypedSeatCall   // the binding requestTyped calls, the consult included
  review(prompt, projectDir, callbacks): Promise<{ text: string; usage: TokenDelta | null }>
  summarize(messages, opts?): Promise<{ text: string; usage: TokenDelta | null }>
  summarizeStructured?(messages, opts?): Promise<{ text: string; structured: StructuredSummary | null; usage: TokenDelta | null }>
  injectUserTurn?(opts): Promise<PlannerUserTurnResult>
  resolvePlanningContext?(signal?): Promise<ApiRuntimeContext> // a seat that reads no files of its own
  unavailabilityReason?(): string | undefined
  readonly capabilities: PlannerCapabilities
}
```

`typedCall()` is the planner's only planning entry. The planning session (`src/engine/orchestrator/planning/session.ts`) calls it through `requestTyped` with `PlanAnswerSchema`, so each turn returns typed questions or a typed plan; `requestTyped` uses the tool's native schema flag (`--json-schema`, `--output-schema`, `response_format`) where it has one, and repairs a malformed answer once. `runPhase()` and `regenerate()` are deleted: there is no per-document planner call and no artifact regeneration.

The consult of a plan task is a typed call on this same interface: `askPlannerSession` (`src/engine/orchestrator/planner-session.ts`) sends `buildConsultPrompt` (`src/engine/spec/prompts/consult.ts`) through `typedCall` with the `ConsultAnswer` schema, read-only, and the answer moves the task on. The consult of a fix task (`task.fix`) goes to the review seat instead (see [Which calls the reviewer makes](#which-calls-the-reviewer-makes)); `consultSeat` (`src/engine/orchestrator/consult/request.ts`) chooses the seat. The planner never writes the implementation. The review is a typed call too: `runReviewerCall` (`src/engine/orchestrator/review-call.ts`) sends it through `requestTyped` and the seat's `typedCall`. The untyped `review()` call remains for the conformance harness (`src/engine/runners/cli-tools/contract-harness-effects.ts`).

`PlannerUserTurnResult` distinguishes `{ status: 'delivered', usage }` from `{ status: 'not-delivered', reason: 'not-ready' }`. Usage may be null after successful delivery. The queue retains a not-ready correction for a later prompt and acknowledges only the IDs that prompt actually carried; arrivals during regeneration stay pending.

The planning prompt follows one chain. `planTurnText` (`src/engine/orchestrator/planning/session.ts`) builds the repo map and composes `buildPlanSessionPrompt` (`src/engine/spec/prompts/plan-session.ts`) from the feature, the project context, the language and skills context, and any earlier planning of an older run. `planFullTurn` restates that prompt for a turn that is not on a native session. The session sends each turn through `requestTyped` (`src/engine/runners/typed-output.ts`), which calls the seat's `typedCall`.

**Continuation per seat.** A step cut by Stop now is continued, not restarted from a blob. The step's own prompt is always stated. For the reviewer and the implementer the continuation trails it (`composeContinuation`, `src/engine/spec/prompts/continuation.ts`). The planning session issues its call again: the plan prompt in full (`planFullTurn`), with the operator's steer as a note, on the native session where the tool has one (`claude-code`, `codex` after its own thread id is captured). A cut typed answer leaves no partial to carry, and an unanswered question round takes the steer as its answer. The reviewer re-issues its whole deterministic prompt, rebuilt from disk, with the note appended; it is one shot by constitution and never resumes or keeps a session, whichever seat holds it. A plan-task consult resumes the planner's saved thread where the tool supports it, exactly as a planning turn does. A review-seat consult is one stateless call, so it sends its full prompt again. The implementer restarts the brief on `buildPrompt`, with the partial and a line naming the declared files that already changed since the task started; the attempt count does not move.

The `tasks[]` the plan compiles to is the durable contract. `plan.json` is the plan; `plan.md` and `tasks.md` are its renderings for human review. `splitbrief spec` runs the same planning session without a build.

---

## The Reviewer interface

Defined in `src/engine/reviewers/types.ts`. The review seat is one stateless, read-only call:

```typescript
interface Reviewer {
  review(prompt, projectDir, callbacks): Promise<{ text: string; usage: TokenDelta | null }>
  typedCall(ctx: TypedCallContext): TypedSeatCall   // the binding a typed review call reaches this seat through
}
```

It is deliberately narrower than `Planner` — a reviewer cannot run the planning session, resume a session, or write files. It returns the verdict and the implementer fix work in one answer. A `Planner` satisfies it structurally, which is what lets the planner hold the seat unadapted when no `reviewer` block is configured.

The port carries no identity fields on purpose. No runner backend knows its own tool or model, so the identity in a failed-review message comes from the config accessor that resolved the seat (`resolveReviewerRunner`), not from the runner object.

`createReviewer()` builds the seat on the planner backends: it resolves the runner, then hands `loadPlanner()` a config whose planner slot holds the reviewer. A configured `effort`, `variant`, or `temperature` a backend cannot deliver is dropped with the same stderr warning the planner gets.

### Which calls the reviewer makes

BUILD repair cycles after final review use the selected implementer.

The review seat has three call types. The first is the plan call before each review: the reviewer reads the project and chooses the reviewer checks that verify the change (`runReviewChecks`, `src/engine/orchestrator/review-checks.ts`). The second is the review of the run diff at the configured cadence. `runFinalReviewPhase()` dispatches it through `runReviewerCall()` (`src/engine/orchestrator/review-call.ts`). The answer returns the verdict, fix tasks, rejections, verification requests and question. The final review makes no planner call. The third is the consult of a fix task. When a fix task stays red after its local retry, is `blocked` or is stale, the review seat answers its consult, because the reviewer judged the change and wrote the fix. This repair consult runs on the review seat through `runReviewerCall()`: one stateless call with the full consult prompt and the findings' `failureKeys` and `redKeys`. Its usage goes to the reviewer bucket, and it spends from the one run consult allowance (`plannerCalls`). With no `reviewer:` block the planner holds the review seat. Planning, the consults of plan tasks, every decision-confirm, summarization and injected user turns stay on the planner.

The check-choice call carries the run's request as the planner read it, the plan criteria, task briefs, decisions and later operator instructions. A task review receives the request and only its tasks, their criteria, applicable decisions and their operator instructions. The final check choice receives every brief and decision. Both check selection and the verdict use the same plan data and renderer.

When the plan has render checks and the review seat accepts images, the review call attaches at most 4 PNGs of each render check: every `frame.png` first, then the other PNGs, each group in path order (`reviewRenders`, `src/engine/orchestrator/review-renders.ts`). The cap applies to each check, so a scenario that writes many PNGs does not stop the images of the other checks. The prompt names each PNG it does not attach. A render criterion stays unverified only when no image of its check reached the reviewer.

A REVIEW account refusal or long-reset limit raises a Seat down halt. The halt reads the fallback of record, including a fallback saved during the run. Set it in Settings › Fallback, or write it in `.splitbrief/config.yaml`. The [automatic-switch conditions](./APPROVAL-AND-RECOVERY.md#seat-down) apply once per run and seat.

With no `reviewer` block, REVIEW uses PLAN's runner and fallback. A REVIEW switch writes its own `reviewer` block and leaves `planner` unchanged. An explicit reviewer uses only its own fallback, including none. A manual switch keeps that fallback. An automatic switch makes the old CLI runner the fallback; an old non-CLI runner leaves none.

A review that ends as failed records `reviewStatus: 'failed'`, the reviewer's display name in the error and the final-review evidence. The summary still runs. SPLITBRIEF does not silently hand the review to PLAN.

---

## Planner capabilities

The orchestrator reads capabilities, not backend identity, to decide what's possible. This replaces if-chains on backend type.

| Capability | What it gates |
|---|---|
| `supportsConversationalPlanning` | Gates nothing: no engine path reads it. Every planner can return questions in the planning session's typed answer |
| `supportsSessionResume` | Backend exposes a reusable thread handle it reports itself (Claude `--resume`, Codex exec resume) |
| `supportsEffort` | Backend honors effort/reasoning hints (thinking budget, `reasoning_effort`) — narrowly, that it accepts the `effort: EffortLevel` field on the wire. It is not the seat's effort channel: a tool that carries effort as an opencode `--variant` preset or inside its model id has a real channel while this capability stays false. `seatEffortChannel` (`src/core/runners/capabilities.ts`) is what answers the wider question; see [CONFIGURATION.md](./CONFIGURATION.md) common generation fields. |
| `supportsImages` | Backend can accept image attachments (vision models) |
| `supportsSelfSummarisation` | Planner can summarize its own prior transcript for compaction |

Two presets exist for common patterns:

- `CONVERSATIONAL_CAPS` -- every capability. Used by the Claude Code planner only; other CLI tools use `ONE_SHOT_API_CAPS` with `supportsSessionResume` / `supportsEffort` overridden from their adapter.
- `ONE_SHOT_API_CAPS` -- conversational planning off, session resume off, effort/images off. Used verbatim by API backends, and as the override base by every non-Claude CLI tool.

When a capability is missing, the orchestrator falls back. No session resume means context is rebuilt from the JSONL log. No conversational planning means no inline Q&A. No image support means attachments are dropped with a `planner_attachments_dropped` event.

---

## Planner base pipeline

`src/engine/planners/base.ts` -- `createPlannerBase(config)`.

Wraps a backend-specific `invokePlan()` function as the seat's `typedCall` binding. Each call:
- Creates a transcript buffer (16KB, flushed to `session.jsonl`)
- Injects `priorMessages` into the first call of the planning session, and never again. API backends receive them as an OpenAI messages array (`consumesPriorMessages: true`); CLI backends get them in the prompt
- Converts the backend response into `RunnerCallResult` immediately, then accumulates token usage from the typed call result
- Returns the answer from the completed terminal result only; stdin/stdout adapters never reopen files that a backend wrote

An `api` planner reads no files of its own, so it declares `resolvePlanningContext` and the planning session's prompt carries an explicit evidence packet in place of the project context (`apiPlanningPacket`, `src/engine/orchestrator/planning/api-packet.ts`, built by `buildApiPlanningContext`, `src/engine/planners/api-context.ts`): the project instructions, the current source of every path the request or the earlier planning names, ranked repo-map files in the room left, and a named list of what was not read. The whole prompt is measured against the model's context; a missing, unreadable or oversized required section refuses before any call and halts as `planner-call-failed` with the `insufficient-context` diagnosis. A tool that reads files on its own still reads them.

**Native session continuity.** A backend that resumes its own thread keeps it across the calls of a run. Claude Code captures the id **as it streams** (`onSessionId`, through `invokeCliAdapter`), not after the call returns, so a call cut halfway still leaves a thread the next call resumes. The CLI planner keeps the same in-memory `SessionResumeState` and passes only an id the tool itself reported — codex resumes its own thread id, never the SPLITBRIEF session id, which is not a tool thread at all.

Planner backend invoke functions return `RunnerCallResult`. Use `toInvokeResult()` only at outer legacy postprocess/extraction boundaries that explicitly need `{ text, usage }`; do not collapse typed call results before they reach the planner base. New adapters must emit typed call results directly and set `backendKind` (`api`, `cli`, `shell`, or `agent`). Call contexts record `axes: seatAxisWords(runner)` from the runner that executes the call, alongside its runner name and model. Planner, reviewer, escalation, summary, compaction and implementer calls keep this snapshot through projection and collection. Older calls without `axes` still parse.

---

## The Task Brief

Defined in `src/core/schemas/task.ts`. The schema is the persisted transport for Product Task Brief v1. Nine semantic sections:

| Section | Schema fields | Markdown header in `tasks.md` |
|---|---|---|
| Identity | `id`, `title`, `action`, `suggestedFiles`, `dependsOn` | YAML frontmatter, with `file` or `files` for paths. |
| Intent | `description` | `### Description` |
| Scope | `scope.inBounds`, `scope.outOfBounds`, `scope.approvedOutOfBounds` | `### Scope` |
| Code Context | `signature`, `currentCode`, `typeDefs`, `pattern` | `### Signature`, `### Current Code`, `### Type Definitions`, `### Pattern` |
| Implementation Plan | `implementationSteps` | `### Implementation Steps` |
| Validation | `tests` | `### Tests` |
| Constraints | `constraints` | `### Constraints` |
| Escalation | `escalation` | `### Escalation` |
| Evidence | `evidence` | `### Evidence` |

The planner does not write `tasks.md`. SPLITBRIEF compiles each plan task with `taskFromSpec` in `src/engine/spec/plan-tasks.ts`.
It renders the briefs as Markdown in `tasks.md` with `formatTasks` in `src/engine/spec/formatter.ts`.
Each brief has one YAML frontmatter block, then sections with `###` headings.

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

The implementer sees only its own brief. It has no access to the plan or other tasks.

---

## The Implementer interface

The implementer is the **weaker model** of the pair. Which transport carries that model is a user choice, and two of them are equally supported:

- a **tool CLI running a smaller model** -- `codex`, `claude-code`, or any other admitted CLI pointed at a smaller model. Write mode `direct`.
- a **model behind an OpenAI-compatible API** -- a local Ollama or LM Studio daemon, or a custom endpoint you declare. Write mode `extracted-code`.

Neither is the fallback for the other. Both get the same brief, the same prompt contract, the same run workspace and the same validation treatment (see below). SPLITBRIEF does not favour a transport.

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

The implementer seat carries both effort channels to the wire, not just the flag one. `src/engine/implementers/cli.ts` hands the seat's `effort` and `variant` to the adapter's build-args input. Six adapters emit: `claude-code`, `copilot` and `command-code` emit `--effort <level>`; `codex` emits `-c model_reasoning_effort=<level>`; `kilo-code` emits `--variant <name>` after the `--model` pair, and so does `opencode` below 2.0.0; from 2.0.0 on `opencode` rejects `--variant`, so its adapter spells the variant into the model as `--model <provider/model>#<name>`, keyed on the release the start gate admitted. An adapter without a given channel ignores that field, so the caller never branches on tool. The full channel matrix lives in [CONFIGURATION.md](./CONFIGURATION.md) under the `effort` field.

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
| Works in | the run workspace; API bundle targets or one legacy shell target | the run workspace, the brief's `files` (see below) |
| Approval applies | exact target paths before writes; API preflights the whole candidate set | after the call, over the attempt's whole changed set in the workspace |
| Empty result | extraction error | `no-staged-change` outcome + `implementer_wrote_nothing` warning |

### Isolation and Apply

Every implementer works in the run workspace selected by `workflow.isolation`: a `direct` implementer edits files there itself, and SPLITBRIEF writes an `extracted-code` implementer's output there. With `worktree` or `staged-copy` that workspace is not the user's checkout. With `none` (checkout mode) the workspace is the checkout itself, for every transport (`cli`, `agent`, `api`, `shell`). The default isolation is a **git worktree created once per run** -- one directory for the whole run, not a copy per task. Installed Node dependencies are linked into it, so SPLITBRIEF can run the plan's checks and the reviewer checks there; other toolchains are covered in [CONFIGURATION.md](./CONFIGURATION.md#implementer-isolation).

Every attempt of every writer kind acquires the run workspace (`runImplementation`, `src/engine/orchestrator/task/run-implementation.ts`; retries in `src/engine/orchestrator/escalation/step.ts`), and `workflow.isolation` picks its strategy -- see [CONFIGURATION.md](./CONFIGURATION.md#implementer-isolation). An `extracted-code` write is checked against the protected paths before it lands (`approveWrite`).

When an attempt ends, its changed set is computed against the snapshot that attempt took when it acquired the workspace, not when the workspace was created -- git status/diff when the workspace is a real worktree, a whole-tree hash diff when it is not (`getChangedFilesSinceSnapshot`, `src/engine/orchestrator/approval/file-snapshots/capture.ts`). The protected-write gate runs over that set inside the workspace (`gateAttemptChanges`, `src/engine/orchestrator/task/attempt-gate.ts`); a denied file is restored from the attempt snapshot. Nothing is promoted per brief: the briefs' work accumulates in the workspace, the checks and the final review assess it there, and the reviewed result reaches the user's real project directory once, at Apply. [WORKFLOW.md §Apply](./WORKFLOW.md#apply) owns how Apply merges and writes.

The run-scoped handle (`createRunIsolation`, `src/engine/orchestrator/isolation/create.ts`) opens the workspace once per run and reuses it across tasks, retries, stops and process restarts, identified by its record and directory. Each acquisition takes its own snapshot, so a later attempt reports only its own edits, and an attempt's cleanup reverts only that attempt. Disposing the handle never removes the workspace: an open or ready run keeps it, and Discard or End run write `run.patch` before they remove it.

In checkout mode the handle creates no worktree and keeps no workspace record; the run records `workspace.kind: 'checkout'` once. Each attempt still takes its own snapshot, and an attempt's cleanup reverts only that attempt in the checkout. Each revert first saves the bytes it replaces under `.splitbrief/sessions/<id>/reverted/<stamp>/`. Nothing is promoted and there is no Apply: validation and the final review assess the checkout, and a passing review closes the run.

A worktree isolates files, not the machine. It shares refs, git config, and hooks with the real repository, and it shares ports, databases, and environment with everything else running. It is not a security boundary.

An isolation strategy that copies the project instead of checking it out must exclude build output and report artifacts as well as the VCS, dependency, and SPLITBRIEF directories. The staged copy derives its file list from git's own ignore rules, so gitignored `dist/`, `coverage/`, and tool output never enter the copy -- otherwise it would move hundreds of megabytes per run.

The brief gate runs in the run workspace. With `review: end`, an ordinary brief runs no check. With `review: task`, each task runs its own checks and its due checks. The final review runs the registered checks, then the reviewer checks: the reviewer chooses the reviewer checks that verify the change, and SPLITBRIEF runs them under the reviewer command policy (`validation.end_checks`). Only a red reviewer check re-runs with the same command text on a disposable run base copy outside the checkout. A failure also red there is pre-existing and goes to no brief. A timeout, or a red with no failure keys, is never pre-existing: it is not verified at the run base, and the reviewer decides. The first reviewer check with new failures stops the list. The reviewer returns the fix work for every new failure. A reviewer command a fix check ran leaves the pending list only after it passes or fails and the review records a verdict. The plan call must choose the pending commands first, with the same text. The plan holds at most 6 commands. The review section names each remaining command as not run; it stays pending. The implementer's ability to run checks on its own work is a first-pass-rate improvement, not the source of truth about correctness.

### Prompt contract per mode

`formatImplementerSystemPreamble(languageContext, writesFiles, isolationDir, outputContract, inPlace)` (`src/engine/spec/prompts/system.ts`) selects the backend’s output contract. In checkout mode (`inPlace`) the direct-writer preamble says the implementer writes "directly in the user's checkout. Your edits land in the user's project as you make them." Otherwise it names the isolation directory and says the changes are promoted afterwards. API `file-bundle-v1` gets a strict JSON-bundle preamble; the comparison below describes legacy extraction and direct writing. The Task Brief body underneath it is the same in both modes -- description, signature, type definitions, pattern, implementation steps, tests, scope, escalation, evidence, constraints (`buildTaskSections`, `src/engine/spec/prompt-formatter.ts`). When the run selected skills, their `## Active Project Skills` block (`ProjectContext.skillsContext`, built once per run) sits between the project line and the task, on the first attempt and on every retry.

| Preamble carries | `extracted-code` | `direct` |
|---|---|---|
| Language and import conventions | yes | yes |
| Output rules (whole file, no fences, no prose) | yes | n/a -- the model edits files |
| Worked example in the target language | yes | n/a |
| Workspace -- stay inside the absolute isolation directory: read, search, write and run shell commands only there, and never look for other copies of the project | n/a -- the model runs no tools | yes |
| Git -- read-only commands only (status, diff, log, show); no commit, branch, tag, checkout, switch, stash, reset, restore, rebase, merge, add, config or hooks change | n/a | yes |
| Dependencies -- already installed; no package-manager install, ci, add, remove or update (npm, pnpm, yarn, bun) | n/a | yes |
| File scope -- where to start and which files it may never touch | n/a -- the single declared file is written for it | yes -- start from the suggested files; edit another project file the change needs and name it with the reason; never touch dependency manifests, lockfiles, CI configuration, env or key files, `.git` or `.splitbrief` unless the brief asks |
| Stop conditions -- when to finish and when to escalate instead of improvising | via the brief's Escalation section | yes, restated as a hard rule for an agent that can keep going |
| Check ownership -- SPLITBRIEF runs the checks after the hand-back and its verdict is the authority; the implementer runs no test, typecheck, lint or other check command, not even the tests it writes | n/a | yes |
| Reporting format -- what to say about what it changed, including `Also changed (not suggested): <file> — <reason>` | n/a -- the file *is* the answer | yes |

The last four rows are what makes `direct` reviewable. An agent that writes files on its own can wander, keep working past the task, or finish silently; the preamble is where those are bounded. The workspace, git and dependency rows are hygiene, not a boundary: the isolation worktree shares refs, stash, hooks and config with the user's repository, its `node_modules` is a symlink into the real checkout so an install writes outside isolation, and a tool that ignores its cwd is not stopped by a prompt (ADR-4).

---

## Implementer base pipeline

`src/engine/implementers/pipeline/run.ts` -- `createImplementerBase(config)`.

Wraps a backend-specific `invoke()` with:

1. **Build prompt** -- `formatTaskPrompt()` (`src/engine/spec/prompt-formatter.ts`) assembles the task sections and takes the write mode, so the closing instruction matches how the model is expected to answer. For modify tasks, `currentCode` is resolved through a tiered context strategy. A direct writer gets only the read-only code of the task's `contextFiles`: it edits the files where they live and reads them itself, so only `extracted-code` writers and the `file-bundle-v1` contract carry the bodies of the files they write.
2. **Prepend system preamble** -- `formatImplementerSystemPreamble(languageContext, writesFiles, projectDir, outputContract)`; the mode-specific preamble described above, naming the call's `projectDir` (the isolation directory for a direct writer, never `context.dir`). API backends send it as a separate system message instead of prepending (`prependSystemPreamble: false`).
3. **Call backend `invoke()`** -- the actual model call. `InvokeOpts.callContext` identifies the runner call for adapters that can emit typed events directly. `InvokeOpts.sandboxEnv` carries the isolation directory's environment when the run is isolated. Without it, every backend that starts a process builds `createRunnerSandboxEnv` for the directory it runs in, so no runner inherits the SPLITBRIEF environment ([AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md#child-environment)).
4. **Process output:**
   - API `file-bundle-v1`: parse the entire completed response, approve and baseline-check declared candidates, apply text files, then publish aggregate metrics only after whole-bundle success. Partial application retains its exact effects in task evidence and fails the attempt.
   - Legacy `extracted-code` for shell/command backends: extract code from response via `extractCode()`, run through the write gate (`approveWrite`), apply to disk via `applyCode()`, compute diff. Between approval and apply, a plausibility guard (`src/engine/implementers/pipeline/extracted-code.ts`) refuses a marker-less modify response that would keep less than half of a baseline file of at least five non-empty lines: the file is left untouched and the task fails with the kept-of-had line counts plus a literal SEARCH/REPLACE template, so the retry has an exact-patch escape hatch.
   - `direct` (`extractsCode: false`): detect file changes via `detectChanges()` against the baseline captured before the call. The isolated workspace declares which baseline that is rather than letting the detector sniff the directory: a linked worktree carries git metadata but is seeded with your uncommitted work, so it is compared by file-content hashes, and a retry that rewrites the file the previous attempt already wrote is seen as a change. No change at all is a `no-staged-change` failure, not a silent success: the detector's negative result carries the distinct `reason: 'no-files-changed'`, and the pipeline publishes one coded warning (`category: implementer`, `code: implementer_wrote_nothing`) naming the runner and the task. The warning lands in `session.jsonl` and in the review packet's warnings list, while the retry and consult behaviour stays exactly as before — the task still fails. Three calls may change nothing (`allowNoChange`): the first attempt of an appended review fix task, whose code is already on disk; the first call that continues a cut attempt whose declared files already changed since the brief started; and an attempt that delivers your answer or correction to the kept work (`deliversAnswer`): the answer to a decision-confirm question, or a correction sent while the checks ran. Such a call completes, publishes no warning, and marks its `implementer_generate_done` event `noChange: true`. A stderr usage limit still outranks it.
5. **Publish result** -- `publishDone` with diff metrics (lines added/removed, duration) or `publishFailed`.

For retries, `buildRetryPrompt()` prepends the error message with escalating framing -- attempt 1 says "fix it", attempt 2 says "rephrase", attempt 3 says "try a completely different approach". Configured temperature increases by `retryTemperatureStep` per attempt only affect transports that support the field; current API requests omit it.

The implementer base normalizes backend output into `RunnerCallResult` before processing files. A non-completed status returns a failed `ImplementerResult` with partial output and usage preserved; user aborts, timeouts, truncation, refusals, unsupported tools, and incomplete streams are not collapsed into generic success/failure strings.

**Call deadlines.** No subprocess seat call (`cli`, `shell`, `agent`; planner, implementer and reviewer) has a default deadline, interactive or headless, because the length of a seat call is the operator's to judge. The watchdog warns after 5 minutes of no output (`idleWarnMs`), and the call continues; the user stops it with Esc. `timeout` and `idleKillMs` are opt-in limits, and they apply on every subprocess path, `shell` and `agent` planners and reviewers included. An `api` seat keeps its deadlines: 120 s to the first response, 60 s of stream idle, and the role total (`TIMEOUTS.implementerMs`, 20 minutes, for BUILD; `TIMEOUTS.reviewerMs`, 10 minutes, for PLAN and REVIEW; `src/core/pipeline-spec/timeouts.ts`). A deadline that fires is a `timeout` outcome, not a crash. Two timeouts or idle cuts in a row on the same brief stop the run with a `runner-timeout-repeated` recovery rather than consulting the planner over an oversized slice (`TIMEOUTS.consecutiveTimeoutsHalt`).

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

A consult runs on the planner's runner and is recorded as planner usage, like every other strong-side call. The `escalation*` fields remain for records written before the consult replaced the hint rung and are never newly spent; `splitSeatTokenTotals` also folds those legacy buckets back onto one planner seat for pricing. A record written before those fields pooled escalation cache into the planner buckets; there the escalation fields are simply absent, and that pooled amount is never counted a second time as escalation.

Live booking (`addUsage`) and the replay of recorded calls (`addRunnerCallUsageToTokenUsage`) run the same category rules, so a reconciled run cannot drift from the run that produced it. Seat coverage is set by the first evidence on an empty seat and degrades to `partial` where later evidence disagrees; a seat that already carries counters but no coverage is a legacy record and stays unknown rather than borrowing a new call's word.

All of these fields are **additive within state v4** (`WORKFLOW_STATE_VERSION = 4`): they are optional, so a `state.json` or `summary.json` written before them parses unchanged and no migration runs. The one non-optional back-compatibility rule predates them — `reviewerInput` / `reviewerOutput` default to `0` for state written before reviewer accounting existed. New optional fields deliberately do **not** default, because a default would be exactly the reported zero they must stay distinguishable from.

`reconcileTokenUsageWithSessionLog` (`src/engine/orchestrator/summary/usage-reconcile.ts`) replays `session.jsonl` when the ledger lost a call: a seat the ledger books alone takes the higher of booked and observed, the planner/reviewer pool takes only the shortfall the log shows, and coverage takes the log's word where it has one. Reconciling an already-reconciled record changes nothing.

Pricing follows the seat: with a `reviewer` block, the reviewer's tokens are priced at the reviewer runner's rates and shown as their own line in the run summary; without one, they are priced at the planner's rates and folded into the planner line, exactly as before.

CLI runners report usage through their protocol terminal: codex through its `turn.completed` record, claude-code and opencode through their streamed terminal events. Codex's `input_tokens` counts cached input, so the normalizer excludes `cached_input_tokens` from the reported input total and surfaces it as `cacheReadTokens`; claude-code's terminal `result` line takes precedence over mid-stream deltas. A CLI runner that completes without reporting usage records zero implementer tokens — by design for structurally unpriced runners, and never fabricated.

Per-task usage is recorded as `TaskTokenUsage`, which tracks: implementer tokens, escalation tokens, retry count, cost, model used, context fit classification (`fits` / `tight` / `overflow`), and the `currentCodeContextMode` that was selected. Alongside the combined `implementerTokens` / `escalationTokens` it carries the optional directional counters `implementerInputTokens` / `implementerOutputTokens` / `escalationInputTokens` / `escalationOutputTokens` and the optional `*ReasoningTokens`. These come only from a delta the ledger actually knows — the difference between the run totals before and after the task — never from a share of the run. A record written before them keeps its combined count alone: its split is unknown, not zero, and is not imputed.

A runner completing a task without reporting usage is recorded as zero tokens and surfaced, not hidden: `recordTaskUsage` (`src/engine/orchestrator/tokens.ts`) publishes exactly one warning with `category: 'usage'` and `code: 'implementer_usage_not_reported'`, naming the runner and the task, when neither the implementer nor the escalation delta is non-zero. The warning lands in `session.jsonl` and in the review packet's warnings list. A consulted task that spent planner tokens does not warn. SPLITBRIEF never invents a price or synthesises token counts for a runner that reported none — a CLI runner staying structurally unpriced is by design, and this warning is what makes a run that did real work distinguishable from a run whose runner reported nothing.

**Legacy prompt allocation** (`src/engine/spec/token-budget.ts`):

```
budget = contextLength - systemPromptTokens - taskBodyTokens - (contextLength * 0.25)
```

The legacy fallback is `DEFAULT_UNKNOWN_CONTEXT_LENGTH = 32768` in `src/core/tokens/context-length.ts`. API bundle routing retains full supplied file contents and reserves bundle output instead of shrinking them through this allocation. API dispatch separately resolves configured context, observed active context or the 8192 application default, then applies the measured input margin and output reserve described in [CONFIGURATION.md](./CONFIGURATION.md).

A boot-probed window applies only to the default implementer profile — the profile the probe ran for. A sibling profile uses its own model/configuration metadata; an API profile without known active or configured capacity uses the API application fallback.

A CLI runner under `model: auto` — or with the model omitted — is resolved at preparation to the model the tool itself has selected on this host (`readHostModelSelection`, `src/engine/runners/host-model-selection.ts`), and the prepared config carries that id, so the window is that model's. When the tool exposes no readable selection, the seat stays on automatic selection, no `--model` flag is added, and the window is the smallest the bundled catalog guarantees for that tool (`resolveRunnerContextWindow`, `src/engine/providers/model/context-window.ts`).

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

Spawns a CLI tool as a subprocess. Supported tools: `claude-code`, `codex`, `opencode`, `copilot`, `kilo-code`, `cursor`, `command-code`, `antigravity`.

Every planner call declares its transport before dispatch: the current call's final response (`stdout-final`) or an exact declared-file lease. The candidate is that call's authoritative final output; session files, project-root artifacts, markdown-linked paths, prose mentions, stderr, and earlier attempts are evidence at most, never content. Claude Code continues a session it already minted with `--resume`. Output is parsed line by line via each tool's protocol parser; a configured `outputFormat` cannot replace a structured terminal contract.

The implementer writes files directly (`writesFiles: 'direct'`) inside the run's isolation directory, and change detection runs there. Claude Code uses the shared `invokeCliAdapter()` transport. A CLI configured with a smaller model than the planner's is one of the two canonical implementer setups -- see [Write modes](#write-modes).

#### Mid-call steering

Mid-call steering sends a message into a running seat call after the current tool result. The current tool continues without interruption.

`createSteeringPort` holds one running call; `deliverToRunningCall` sends a message to that call (`src/engine/calls/steering.ts`). The transport attaches the call when it can take input (`src/engine/runners/cli-tools/process-invoke.ts`). It detaches the call when admission closes (`src/engine/runners/cli-tools/process-invoke.ts`).

- `delivered`: the tool acknowledged the message in this call. This confirms delivery, not that the model followed the message.
- `deferred`: no steerable call exists, admission closed, or the tool rejected the message. Delivery waits until after the call.
- `uncertain`: the transport attempted delivery but cannot confirm acknowledgement. Delivery after the call can duplicate the message.

Only calls with a steering port and a supported tool version change transport (`src/engine/runners/cli-tools/process-invoke.ts`). Other calls keep byte-identical arguments, prompt bytes, and stdin handling. Planner callbacks and implementer options carry the optional port (`src/engine/planners/types.ts`, `src/engine/implementers/types.ts`).

| Tool or kind | Transport and acknowledgement | Proven release |
|---|---|---|
| `claude-code` ≥ 2.1.296 | SPLITBRIEF adds `--input-format stream-json --replay-user-messages` and sends the prompt as one JSON line. SPLITBRIEF holds stdin open until the first `result`. The user-message echo acknowledges delivery. A late line admitted before stdin closes runs as a follow-up turn; the last `result` ends the call. The parser sums usage across turns (`src/engine/runners/cli-tools/claude-code.ts`, `createStreamParser`, `src/engine/streaming/parse-stream-json.ts`). | 2.1.296 |
| `opencode` ≥ 2.0.0 | Each call starts an `opencode serve --hostname 127.0.0.1 --port 0` sidecar. `run --server` connects with `OPENCODE_PASSWORD`. SPLITBRIEF sends `POST /api/session/<id>/prompt` with `{text, delivery:"steer"}`. After the message leaves the inbox, the transport confirms delivery by looking up its id in the session while the run stays alive. It sends `GET /api/session/<id>/message/<msg_id>` and checks that the returned `data.id` matches. SPLITBRIEF reaps the sidecar on every exit path (`createOpencodeSteering`, `src/engine/runners/cli-tools/opencode-steering.ts`). | 2.0.26 |
| `codex` | SPLITBRIEF does not support Codex mid-call steering and will never support it. `codex exec` has no mid-call input. The sandbox links only `~/.codex/auth.json` to the host file (`src/engine/runners/sandbox-state-bridge.ts`). The seat takes the message after the call, in the correction pass (`src/engine/runners/cli-tools/codex.ts`). | Not supported |
| Every other tool: `cursor`, `copilot`, `kilo-code`, `antigravity`, `command-code`; `api`, `shell`, `agent` | No mid-call steering transport. The seat takes the message after the call, in the correction pass. | None |

#### Canonical CLI runner matrix

Runtime source of truth: `src/core/runners/cli-tool-catalog.ts` (`CLI_TOOL_CATALOG`, `CLI_TOOL_TRUST`). This section is the canonical support matrix for admitted CLI runners. Parity is enforced by `testing/docs/planners-and-implementers.test.ts`.

Each admitted tool carries a `testedVersion` and a `minimumAdmittedVersion` — the upstream CLI release the flag, subcommand, and output contract were last verified against, and the oldest release admitted. `detectAvailableCliTools` (`src/engine/detection/detect.ts`) probes the installed version via the adapter-declared version command. Admission is forward-compatible: only versions below the minimum are incompatible; newer releases are admitted, and malformed or unproven versions remain unverified. It does not print a startup stderr warning for unselected tools.

When you adjust a tool's adapter to track an upstream CLI change, bump that tool's `testedVersion` in the catalog and update this matrix.

##### Admitted support summary

| `tool` | command | roles | tested version | version scheme | evidence as-of | model policy (planner / implementer) | model discovery | billing | typed output |
|---|---|---|---|---|---|---|---|---|---|
| `claude-code` | `claude` | planner, implementer | 2.0.0 | `semver` | 2026-07-31 | optional / optional | `native-aliases-and-custom` | subscription-included | native from 2.1.287 |
| `codex` | `codex` | planner, implementer | 0.40.0 | `semver` | 2026-07-31 | optional / optional | `capability-gated-native` | subscription-included | strict-native from 0.157.1 |
| `opencode` | `opencode` | planner, implementer | 2.0.14 | `semver` | 2026-09-22 | optional / optional | `native-cli` (`opencode api GET /api/model`; `opencode models --verbose` below 2.0.0) | provider-dependent | fallback |
| `copilot` | `copilot` | planner, implementer | 1.0.77 | `semver` | 2026-09-02 | optional / optional | `native-cli` (`copilot help config`) | subscription-included | fallback |
| `kilo-code` | `kilo` | planner, implementer | 0.1.0 | `semver` | 2026-07-31 | optional / optional | `native-cli` | provider-dependent | fallback |
| `cursor` | `cursor-agent` | planner, implementer | 2026.08.25-3e8eec8 | `calver` | 2026-08-27 | optional / optional | `native-cli` (`--list-models`) | subscription-included | fallback |
| `command-code` | `cmd` | planner, implementer | 1.39.2 | `semver` | 2026-09-01 | optional / optional | `native-cli` (`--list-models`) | subscription-included | fallback |
| `antigravity` | `agy` | planner, implementer | 1.2.9 | `semver` | 2026-09-23 | optional / optional | `native-cli` (`agy models`) | subscription-included | native from 1.2.14 |

**Command Code's row was captured from the real binary on 2026-09-01 against `cmd` 1.39.2**, replacing the hand-authored fixtures that stood in for it. The raw `cli-conformance` leg passes; the production leg records `OMIT` because the conformance sandbox gives the child a fresh `HOME` and never bridges host CLI session state, so a `session`-auth tool reaches the CLI unauthenticated. That gap is the harness's, not the adapter's — the adapter's own argv was replayed against the authenticated binary and its terminal `result` frame parses. See `testing/fixtures/command-code/README.md` for the recorded evidence and the remaining gap.

`cursor` executable aliases are `cursor-agent` / `agent`. Command Code's binary is `cmd` with no alternate alias, and its credentials come from `cmd login`; there is no API-key environment channel. Every `cmd` start checks for a new release and installs it in the background unless the argv names `--no-auto-update`, so both of its probes, `cmd status --json` and `cmd --list-models`, carry that flag. Antigravity's binary is `agy`, `agy --version` prints a bare semver (`1.2.9`, captured 2026-09-23 — `agy --help` prints no version at all), and `agy models` is both its auth probe and its model listing: one `<id>\t<display name>` row per effort variant (`gemini-3.8-flash-high`), merged into one picker row per model. Both runs of `agy models` have a 10-second budget instead of the shared 5-second probe budget: `agy` waits on Google's `loadCodeAssist` and `fetchAvailableModels` calls before it lists, and its own logs show 6 of 394 listings above 5 seconds. The model id is the effort (`effortChannel: 'model-id'`): `agy --effort` only selects one of those ids, so the seat sends `--model <id>` and no `--effort`, and the picker's effort row steps between the ids. The crew rows and the run record state the level the id spells: `Google Antigravity CLI · Gemini 3.8 Flash · high`. The reviewer seat uses planner backends (the same admission set).

##### Typed seat output

`requestTyped` (`src/engine/runners/typed-output.ts`) asks one seat for one JSON answer. SPLITBRIEF validates the answer with its own Zod schema, never with the tool's claim.

- `claude-code` and `antigravity` get `--json-schema <inline JSON>`.
- `codex` gets `--output-schema <file>`: a private 0600 file that is removed after the call.
- Codex sends that schema in OpenAI strict mode. A live probe on 0.157.1 returned HTTP 400 (`invalid_json_schema`) for a key missing from `required`. An object with no `properties` returned HTTP 400 too. Codex is `strict-native`: the root must be an object, and every object must declare `properties`, require every key and set `additionalProperties: false`. An optional value uses a `null` union. Nested `anyOf` unions are supported when every branch satisfies these rules. The 2026-10-06 live probe accepted `anyOf` of closed objects and rejected `oneOf` with HTTP 400, "'oneOf' is not permitted". `isStrictJsonSchema` (`src/engine/runners/strict-json-schema.ts`) rejects `oneOf`, `allOf` and `not`. Consult answer schemas use `z.union` to emit nested `anyOf` and take the native transport. Schemas that fail these rules, including optional keys and root unions, take the prompt fallback on the Codex seat.
- A native tool uses its flag only from the release whose `--help` and live probe recorded it, the `typed output` column above. An older release gets the prompt fallback. A release that readiness did not read keeps the flag.
- The `api` kind gets `response_format: json_schema`, without `strict`: the contracts have optional keys, which strict mode rejects.
- Every other tool, and the `shell` and `agent` kinds, gets the sentence "Reply with exactly one JSON object that matches this schema: … No prose after it." on the end of the prompt.
- The answer is the object that parses and ends last: a fenced block that opens an object, or an object outside every fence. A later brace span that does not parse is skipped when it reads as prose, such as `{above}`. A later span that opens like JSON (`{"` or `{}`) and does not parse makes the answer invalid, so it gets the repair call. Two bare objects at the end are ambiguous.
- A planner typed call is a turn on its planning thread. A reviewer typed call is one read-only call with no session. The call binding carries the seat as `ActiveRunnerRole` (`planner`, `reviewer`, `implementer`), and the helper and the recovery issue read it from there. The binding in `src/engine/planners/base.ts` maps `reviewer` to the `review` call role, and the recovery builder maps the seat to its crew id.
- A planner or reviewer answer that fails gets one repair call. A planner on a resumable tool continues its planning thread, the session that the planner itself holds and that gave the answer; a reviewer always starts a new call; an implementer gets no repair.
- An `api` endpoint that rejects `response_format` with HTTP 400, with a detail that names `response_format`, gets one more request with the sentence instead. That retry has its own call id and is not the repair call. Another status, or a 400 that does not name the field, fails as a planner call. An endpoint that accepts `response_format` but rejects the schema itself with a 400 that names the field also gets the sentence, so that schema defect does not surface. SPLITBRIEF does not remember the rejection, so every typed call to that endpoint, the repair included, sends the rejected request first.
- A second invalid answer is the recovery reason `seat-protocol-error`.

##### Posture, trust, and auth

The auth-channel column describes catalog staging capabilities, not selectable methods proven for an installed invocation. The enforcement matrix is currently empty: explicit `session` or `api-key` is refused, while an omitted selection uses host CLI configuration. See [AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md).

| `tool` | direct write (planner / implementer) | shell | network | automatic approval (implementer) | sandbox (planner / implementer) | auth channels | credential env |
|---|---|---|---|---|---|---|---|
| `claude-code` | no / yes | yes / yes | yes / yes | `--permission-mode acceptEdits` | none / cli-managed (see below) | session (host account on macOS, see below), api-key | `ANTHROPIC_API_KEY` (api-key channel) |
| `codex` | no / yes | yes / yes | yes / yes | `--sandbox workspace-write` | mode-dependent / cli-managed | session, api-key | `OPENAI_API_KEY` (api-key channel) |
| `opencode` | no / yes | yes / yes | yes / yes | — | none / none | provider-dependent | every `*_API_KEY` of the parent |
| `copilot` | no / yes | yes / yes | yes / yes | `--allow-all` | none / none | session | `GH_TOKEN`, `GITHUB_TOKEN` |
| `kilo-code` | no / yes | yes / yes | yes / yes | `--auto` | none / none | provider-dependent | every `*_API_KEY` of the parent |
| `cursor` | no / yes | yes / yes | yes / yes | `--force` | none / none | `api-key-or-session`: session (host-cli-state), api-key | `CURSOR_API_KEY` (api-key channel) |
| `command-code` | no / yes | yes / yes | yes / yes | `--yolo` | none / none | session | — |
| `antigravity` | no / yes | yes / yes | yes / yes | `--dangerously-skip-permissions` | none / none | session | — |

Session channels use `host-cli-state` bridging where noted in the catalog. SPLITBRIEF never copies credentials into argv. Subscription-included tools bill through the vendor login; provider-dependent tools inherit the upstream model provider's billing posture.

The bridge copies files, so a channel whose credential is an OS keychain item reaches a staged runner another way. A channel declares those platforms in `hostKeychainPlatforms` (`src/core/runners/cli-tool-catalog.ts`), which today names macOS for the Claude Code, Cursor Agent CLI and Antigravity `session` channels: the subscription session lives in the login keychain, whose search list resolves through `HOME` and whose item is keyed on `USER`. `cliAuthChannelHostStateAccess()` maps that to `host-account`, and `createSandboxEnv()` then leaves `HOME`/`USER` at their host values and bridges no file — every other redirect stays. Readiness never infers such a credential from files: it runs the tool's own status command and reports what the child answers. See [docs/API-KEYS.md](./API-KEYS.md).

**Claude Code implementer sandbox.** The `claude-code` implementer argv ends with `--settings <JSON>` (`implementerBaseArgs`, `src/engine/runners/cli-tools/claude-code.ts`). The JSON sets `sandbox.enabled`, `sandbox.failIfUnavailable` and `permissions.blockReadsOutsideWorkingDirectories` to `true`, and `sandbox.allowUnsandboxedCommands` to `false` ([sandboxing](https://code.claude.com/docs/en/sandboxing), [settings reference](https://code.claude.com/docs/en/settings-reference)). Claude Code's default for `failIfUnavailable` is `false`: a sandbox that cannot start prints a warning, and the commands run without it. SPLITBRIEF sets `true`, so a sandbox that cannot start stops the seat at startup and never runs its commands unconfined. Claude Code then runs every Bash command of the seat under its own OS sandbox: Seatbelt on macOS, bubblewrap on Linux. The CLI process itself is not sandboxed, so its login, keychain and API traffic do not change. The planner and reviewer seats do not get these settings. Measured with Claude Code 2.1.280 on macOS, in a linked worktree:

- **Writes** reach the worktree and Claude Code's temp directory (`/tmp/claude-<uid>` on macOS, shared by every Claude Code session of that user). A write to the home directory, to another `/tmp` path or through the `node_modules` link fails with `Operation not permitted`. A Write or Edit call outside the worktree is refused by the permission layer. Claude Code also keeps the main repository's shared `.git` directory writable from a linked worktree, except `hooks/` and `config` (documented, not measured here), so git refs and the stash stay reachable.
- **Reads.** The Read, Grep and Glob tools refuse every path outside the worktree, the `node_modules` link included. Shell reads under home directories fail outside the worktree (`ls ~/Projects`: `Operation not permitted`). Toolchains under the home directory, such as `~/.nvm`, stay readable, and so do paths outside home directories, such as `/tmp`.
- **`node_modules`.** The worktree's `node_modules` is a link into the checkout, outside the working directory. The adapter adds the link target to `sandbox.filesystem.allowRead`, so `tsc` and `vitest` run. The target stays read-only: vitest still passes without its `node_modules/.vite` cache, and an install cannot write into the checkout.
- **Attached global skills.** Each root the run names in `skillRoots` goes to `permissions.additionalDirectories` and `sandbox.filesystem.allowRead`, so the Read, Grep and Glob tools and the shell may read a listed reference there. The same root goes to `sandbox.filesystem.denyWrite` and to the `permissions.deny` rules `Edit(//<root>)` and `Edit(//<root>/**)`, so a skill that is one file is closed too: `acceptEdits` accepts an edit in a working directory, and a deny rule wins over it, for the Write tool too. The roots are the attached global skills plus any project skill git ignores, which no isolation copy holds. The Claude Code planner and reviewer vectors — the consult runs on the planner vector — get the same `permissions` and `sandbox.filesystem` entries under their own `--settings`, since a read outside the working directory needs a prompt `-p` cannot answer; they get no sandbox. With no such root the JSON is unchanged and the planner vectors carry no `--settings`.
- **Network.** The sandbox allows no domain, and `-p` denies the approval prompt, so `npm install` and `curl` fail with `deny network-outbound`.
- **Shell approval.** `sandbox.autoAllowBashIfSandboxed` defaults to `true`, so sandboxed commands run under `acceptEdits` without an allow rule. Without the sandbox, `acceptEdits` under `-p` denies `npx tsc` unless the user's own Claude Code settings allow it.
- **No sandbox.** When the sandbox cannot start (Linux without `bubblewrap` and `socat`, WSL1), Claude Code stops at startup with `Error: sandbox required but unavailable: sandbox is enabled but …`, and SPLITBRIEF halts the brief on that line. Readiness catches the common case first: on Linux, when an implementer profile is `cli` `claude-code`, the check `runners.sandbox.claude-code` looks for `bwrap` and `socat` on the absolute `PATH` entries, as the seat does, and names each one that is missing (`buildClaudeSandboxChecks`, `src/core/readiness/checks/claude-sandbox.ts`). It blocks `splitbrief start` when that profile is the default implementer and warns for any other profile. `splitbrief spec` and `splitbrief review` call no implementer, so they skip it. Its fix is to install `bubblewrap` and `socat` (for example `sudo apt-get install bubblewrap socat`); on Ubuntu 24.04 and later, `bwrap` also needs an AppArmor profile that allows user namespaces. macOS needs nothing, since `sandbox-exec` is built in. The check does not start the sandbox, so a `bwrap` that is installed but refused by AppArmor still reaches the startup halt. Without `failIfUnavailable`, Claude Code prints `⚠ Sandbox disabled: sandbox is enabled but …` instead and runs on; that warning line never halts the brief. Both lines are read from the 2.1.281 binary and not measured on Linux. Inside an outer Seatbelt sandbox, every Bash command fails with exit 71 (`sandbox_apply: Operation not permitted`), and no command is retried outside the sandbox.
- **Configuration.** `--settings` is a protected flag, and a configured `--settings`, `--add-dir` or permission flag is rejected. `--settings` wins over the user, project and local Claude Code settings for a boolean key. It cannot remove an array entry: `sandbox.excludedCommands`, `sandbox.filesystem.allowWrite` and `permissions.additionalDirectories` from those files merge into the policy and can widen it.
- **Version.** `blockReadsOutsideWorkingDirectories` needs Claude Code 2.1.257 or later, and the catalog still admits 2.0.0. When the start gate admitted an older release, the adapter omits the key, and reads outside the worktree are not fenced. When the release is unknown, the adapter keeps the key. Claude Code 2.1.280 skips an unknown key under `sandbox` or `permissions` and still applies the others (measured).

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

Swap `tool` and `model` for any admitted CLI. Omit `model`, or write `model: auto`, to follow the CLI's own selection: at preparation SPLITBRIEF reads the model that tool has selected on this machine from the tool's own config or state and passes it as `--model` (the five readable sources are tabled in [CONFIGURATION.md](./CONFIGURATION.md)). The YAML keeps saying `auto`, which is the operator's intent, while the run's own record — `workflow_config`, `seats.json`, the task start — names the resolved id. `cursor`, `copilot` and `command-code` expose no selection file, so they keep the tool's own default and readiness carries a warning saying so. Tools with `backend-default` or `auto-only` model policy (none in the current admitted set) accept model absence or `auto` and reject an explicit model ID or `customModels` before spawn.

##### Blocked admission candidates (OMIT)

These researched CLIs have **blocked verdicts** — they do not appear in the admitted support table above and have no first-class catalog ID until their admission gate passes.

| candidate | verdict | as-of | evidence | route when gate passes |
|---|---|---|---|---|
| — | — | — | — | — |

No CLI candidate currently sits on an OMIT verdict. `CURSOR_CLI_ADMISSION_VERDICT`, `COMMAND_CODE_CLI_ADMISSION_VERDICT` and `ANTIGRAVITY_CLI_ADMISSION_VERDICT` are all `PASS` in `cli-tool-catalog.ts`. Candidate runtime adapter sources must remain absent while a verdict is OMIT. No unverified-auth override can promote an omitted candidate.

##### Excluded researched candidates

These candidates have **dated blocked verdicts** — no first-class ID, descriptor, adapter, or picker row. `EXCLUDED_CLI_TOOL_IDS` (`src/core/runners/cli-tool-catalog.ts`) lists them all. `kiro`, `gemini`, `cline` and `qwen` are the custom-only tools (`CUSTOM_ONLY_CLI_TOOL_IDS`): run them as a `shell` or `agent` runner. `auggie` and `junie` are excluded with no catalog entry.

| candidate | verdict | as-of | reason |
|---|---|---|---|
| `kiro` | DEFER | 2026-07-31 | Blocker 1: written Kiro/AWS permission confirming official-CLI orchestration is permitted for paid individual subscriptions. Blocker 2: credentialed stable-2.x staged fixture (target 2.16.0) proving prompt transport, scoped direct writes, text parsing, auth isolation, exit behavior, cancellation, and model-selection boundary. Catalog reason: SPLITBRIEF has no structured session-scoped model and output adapter for it. |
| `gemini` | REJECT | 2026-06-18 | Legacy consumer Gemini CLI entitlement ended 2026-06-18 for free, Google AI Pro, and Google AI Ultra accounts. Consumer-plan users should use the conditional Antigravity route. Enterprise licenses and paid API keys remain on the separate Gemini API provider path — not this legacy CLI. |
| `auggie` | DEFER | 2026-07-31 | Indie plan exists, but official docs state non-interactive mode may be disabled by customer agreement; unattended entitlement smoke test required. |
| `junie` | DEFER | 2026-07-31 | Headless flow documents `JUNIE_API_KEY` on usage-based billing; paid-plan subscription entitlement for headless tasks is not explicitly documented. |
| `qwen` | REJECT | 2026-07-31 | Qwen Code Coding Plan Pro ($50/month) terms prohibit automated scripts and non-interactive/batch scenarios. Not positioned for SPLITBRIEF implementer use. |
| `cline` | FUTURE | 2026-07-31 | Strong generic/BYOK CLI contract; no subscription-backed consumer plan. Possible future generic implementer, outside the current scope. |

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

The implementer extracts code from stdout (`writesFiles: 'extracted-code'`). The planner reads its answer from stdout.

### agent

`src/engine/planners/agent.ts`, `src/engine/implementers/agent.ts`

Like shell, but the subprocess writes files to disk directly instead of returning code in stdout. `createChangeDetector()` (`src/engine/change-detection.ts`) compares the workspace after the call with a baseline captured before it (`captureChangeDetectorBaseline`): the changed files with their contents and modes when the directory has `.git`, else a hash of every tracked file. A call that changed nothing fails with `no-files-changed`.

The planner reads its answer from stdout, like the shell planner. A saved custom command (`customCommands`) with `contract: direct` writes its answer to one declared file instead (see [Planner artifact ownership](#planner-artifact-ownership)). The implementation stays with BUILD.

The implementer uses `writesFiles: 'direct'` with that change detection.

---

## Planner artifact ownership

A planner call produces a candidate, not a canonical artifact. Every call declares its transport before dispatch. `stdout-final` derives the candidate from the current call's authoritative final response only. Earlier messages, partials, tool-call text, stderr, and prior attempts are evidence at most. `declared-file` hands the child one host-prepared, invocation-unique lease; acceptance requires that exact regular file, a bounded no-follow read, unchanged ancestry and identity, and a matching receipt. Missing, pre-existing, sibling, same-basename, traversal, absolute, symlinked, path-swapped, non-UTF-8, or oversized files fail. There is no `auto` source, source priority, prose sniffing, or filesystem search.

Planner mode does not grant artifact authority. A `--agent plan`, `--permission-mode plan`, or `--sandbox read-only` flag bounds what the tool may do; it does not prove what the process could reach, what its output means, or that an artifact is fresh. The production-factory conformance harness (`src/engine/runners/cli-tools/contract-harness.ts`, driven by `scripts/cli-conformance.ts`) is what can prove the effective role, containment, and final-response contract. Writes are observed after the fact by post-run mutation detection (`src/engine/orchestrator/planning/mutation-guard.ts`), which fails the planning call on unexpected filesystem mutations.

### Effective roles by backend

The role vector is pinned and effect-verified per backend. A role that is missing, overridden, falls back, prompts interactively, or cannot be verified makes the backend unsupported for that role.

| Backend | Planner role | Implementer role |
|---|---|---|
| `opencode` | `--agent plan` | `--agent build` |
| `kilo-code` | `--format json --agent plan` | `--format json --agent code --auto` |
| `claude-code` | `--permission-mode plan` (Read, Glob, Grep, Plan only) | `--permission-mode acceptEdits` |
| `codex` | `--sandbox read-only --ask-for-approval never` exec, ambient config and rules ignored; a planning call's thread is kept on disk for the `exec resume` of the next one, and every other call is `--ephemeral` | `--sandbox workspace-write --ask-for-approval never` in the staged checkout |
| `cursor` | `--print --output-format stream-json --mode plan --trust --workspace <projectDir>` | `--print --output-format stream-json --force --trust --workspace <projectDir>` |
| `copilot` | `-p --plan --allow-all-tools --no-ask-user --output-format json` | `-p --allow-all --output-format json` |
| `command-code` | `-p --output-format json --trust --skip-onboarding --permission-mode plan` | `-p --output-format json --trust --skip-onboarding --yolo` |
| `antigravity` | `-p --mode plan --add-dir <projectDir> --output-format stream-json` | `-p --dangerously-skip-permissions --add-dir <projectDir> --output-format stream-json` |

**Workspace.** Every seat is spawned with its directory as the cwd. A tool that keeps its workspace apart from its cwd also gets that directory on a flag: `codex --cd`, `cursor --workspace`, `agy --add-dir`. Without `--add-dir`, or with a relative `--add-dir .`, `agy -p` has no workspace, and on 1.2.9 its model ran the shell in `~/.gemini/antigravity-cli/scratch` (upstream antigravity-cli issues #231, #253, #507, #598). With the workspace, agy also loads that directory's `AGENTS.md` and `GEMINI.md`; `codex` can skip such files with `--ignore-rules`, but agy has no flag for this. `WORKSPACE_FLAGS` in `testing/integration/orchestrator/cli-adapter-contract.test.ts` pins the flag per tool, and the cwd leg of `scripts/cli-conformance.ts` ([EXTENDING.md](./EXTENDING.md#rawproduction-transaction-cli)) measures where the live tool writes. On 2026-09-23 `claude-code`, `opencode`, `command-code` and `antigravity` passed it; `codex`, `cursor`, `copilot` and `kilo-code` could not be measured on that host.

**Output protocol.** Every admitted tool is spawned in a machine-readable output mode and parsed into the same protocol events, so tool calls, assistant text and token usage arrive while the call is still running rather than in one block at the end. A `tool-use` event carries `stage: 'started'` when the call begins and `stage: 'done'` or no stage when it completes (`src/engine/runners/cli-tools/contract.ts`); the idle watchdog measures the gaps between frames, so a streaming tool is never mistaken for a stalled one.

| Backend | Output flag | Parser | Text deltas | Tool calls | Usage | Session id |
|---|---|---|---|---|---|---|
| `opencode` | `--format json` | `streaming/parse-opencode.ts` | per text part | started + done | yes | yes |
| `kilo-code` | `--format json` (both roles) | `streaming/parse-opencode.ts` | per text part | started + done | yes | yes |
| `claude-code` | `--output-format stream-json --verbose --include-partial-messages` | `streaming/parse-stream-json.ts` | token deltas | started + done | yes | yes |
| `codex` | `--json` | `codexProtocolEvents` (`cli-tools/codex.ts`) | per completed item | started + done | yes | yes |
| `cursor` | `--output-format stream-json` | `parseCursorRecord` (`cli-tools/cursor.ts`) | per assistant message | started + done | yes | yes |
| `copilot` | `--output-format json` (both roles) | `streaming/parse-copilot.ts` | per assistant message | done only (unverified live) | yes | yes |
| `command-code` | `--output-format json` | `commandCodeProtocolEvents` (`cli-tools/command-code.ts`) | no — final text only | done only | final only | yes |
| `antigravity` | `--output-format stream-json` (both roles) | `streaming/parse-antigravity.ts` | token deltas (`text_delta`) | started + done | yes | yes |

Antigravity's `stream-json` evidence exists for agy 1.2.7 and 1.2.9 only, while `minimumAdmittedVersion` stays 1.2.2.

Claude Code reports the end of a tool in a `user` record that carries the `tool_result`. That record closes the tool. So while a Claude `Bash` command runs, the freshness line can name it: `No output for m:ss · running <command>`.

Claude Code's `system` frames never reach a transcript as text (`parseSystemProgress`, `src/engine/streaming/parse-stream-json.ts`). Most are its own bookkeeping: `init`, the `hook_*` frames, `status`, `thinking_tokens` and the background `task_*` frames. Each of those becomes a runner heartbeat (`runner_call_heartbeat`), at most one a second per call (`createRunnerCallRecorder`, `src/engine/calls/recorder.ts`), since Claude Code sends them in bursts. A heartbeat moves the Build progress block's freshness clock, so a seat that thinks for minutes does not read as silent. It paints no row and stays out of `session.jsonl`. The frames an operator needs become warnings or errors, which the seat's activity shows as `Warn` or `Err` rows and `session.jsonl` keeps:

| Frame | Code | Message |
|---|---|---|
| `api_retry` | `claude_api_retry` | `<error> (HTTP <status>): retry <attempt> of <max_retries> in <delay>` |
| `model_fallback`, `model_refusal_fallback`, `model_consent_fallback` | `claude_fallback` | `<original model> → <fallback model> (<trigger>)`, such as `(overloaded)`, or `(refusal: <category>)`; Claude Code's own notice when it names no trigger |
| `model_refusal_no_fallback` | `claude_refusal` | `<model> refused (<category>): <explanation>` |
| `permission_denied` | `claude_permission_denied` | `<tool> denied (<decided by>): <reason>` |
| `notification` coloured `warning` or `error` | `claude_notice` | its text; in stream-json mode Claude Code sends its own terminal warnings this way, such as the effort cap |
| `informational` at `warning` level | `claude_notice` | its content, such as a model the organization restricts |

A notification without a warning colour and an `info`, `notice` or `suggestion` banner are bookkeeping too. Hook feedback is a `notice` banner, and a warning has no lower severity to show it at.

A top-level `rate_limit_event` is telemetry while its `status` is `allowed` or unread — it becomes a heartbeat, and an `overageStatus` of `rejected` does not change that. An `allowed_warning` or `rejected` status becomes a `claude_rate_limit` warning with severity `warning` or `error` and a message such as `seven_day rate limit approaching (resets Nov 3, 16:30)` (the recovery panel's 24-hour clock, always dated because the transcript replays the text on other days: `formatStoredReset`, `src/core/recovery/reset-clock.ts`) or `rate limit reached`. The severity reaches the call's activity row (`Warn` / `Err`) and `session.jsonl`, and the frame never fabricates a terminal result — the `result` frame remains the authority for how the call ended (`src/engine/streaming/parse-stream-json.ts`).

Antigravity's per-step `usage` is the usage of that response step and its `result` usage is the turn total, so step usage is emitted as a delta and the terminal usage is taken from the explicit result — the accumulator never counts a turn twice.

**Final response.** For `codex`, `cursor`, `opencode` and `kilo-code` the final response is the messages after the last tool call (`lastMessageGroupText`, `src/engine/runners/cli-tools/final-group.ts`). Each message starts on its own line after a blank one, so a `VERDICT:` line or a `### Verdict` heading never lands mid-line behind narration. A turn that ends on a tool call has no such group, and its last message stands in for it, never the whole stream. The live transcript does not print that final text again when it differs from the streamed messages only by those line breaks (`onlyAddsLineBreaks`, `src/engine/streaming/final-text.ts`). For `claude-code` the final response is the last main-loop message behind the messages a `max_tokens` stop cut before it (`src/engine/runners/cli-tools/claude-reply-parser.ts`). claude-code resumes a cut in a new message that can call tools, so that chain continues through tool calls and closes on any other stop. A `result` record without text keeps the last message and its chain, or the last earlier message with text when the last one has none. Narration outside the chain streams live and stays out of the call's text. The call's text budget warns (`runner_call_text_limit`) only when the text the call ends with was cut, never for narration a final text replaced. A call keeps its first 256 tool results in its result, and the feed still receives every tool completion after them.

A planner never gains canonical write authority. Its typed answer stays a candidate until it passes `checkPlan` and `compilePlan` writes it; `plan.json` is the plan, and the fixed `plan.md` and `tasks.md` files are renderings of `plan.json`. See [WORKFLOW.md](./WORKFLOW.md) for the planning session and the disposition flow.

---

## Adding a new backend

Step by step:

1. **Add the ID to its catalog**: a CLI tool goes in `CLI_TOOL_CATALOG` (`src/core/runners/cli-tool-catalog.ts`), an API provider in `API_PROVIDER_CATALOG` (`src/core/providers/api-provider-catalog.ts`). A meta runner goes in `META_PROVIDER_IDS` (`src/core/schemas/enums.ts`), which composes `PROVIDER_IDS` from the catalog tuples.

2. **Create the planner module** at `src/engine/planners/<name>.ts`. Export a `create<Name>Planner()` function that calls `createPlannerBase()` with:
   - `invokePlan` -- your backend-specific call
   - `invokeOneShot` -- the one-shot call for reviews and summaries; can be the same function as `invokePlan`
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
  timeout?: number           // ms; opt-in, no default on cli/shell/agent seats
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
  validation: { endChecks?: boolean; testCommand?: string; render?: string; ... } // typecheck, lint, test, typecheckCommand, lintCommand: retired, one notice each
  workflow: {
    mode?: unknown               // retired: loads with one notice, ignored
    approve?: ApproveLevel       // plan | none (all, spec, default load as plan with one notice)
    maxRetries?: unknown         // retired: loads with one notice, ignored; the lineage attempt bound replaces it
    compactionThreshold?: number
    git?: { createBranch?: boolean } // retired commitStrategy input is stripped
    // taskReview, briefReview, speckit and driftChainThreshold are retired keys (one notice each)
  }
  escalation?: unknown           // retired: loads with one notice, ignored; the planner's consult replaces the intermediate tier
  approval?: { enabled?: boolean; tiers?: unknown /* retired: one notice, ignored */; feedRejectionsToPlanner?: boolean; ... }
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

**Detection** happens two ways. `detectPromptLanguage(projectDir)` probes the project root for manifest files: `Cargo.toml` (Rust), `go.mod` (Go), `pyproject.toml` (Python), then `package.json` (TypeScript if the `typescript` dependency exists, JavaScript otherwise). The plan's own `validation.language` becomes `state.discoveredValidation.language` once the plan compiles.

**Who receives it:** the planning session prompt carries the `LanguageContext`. For non-JavaScript/TypeScript projects, language context is injected as a visible `Language Context` section in the prompt. For JS/TS projects it is omitted (the prompt defaults already assume JS/TS conventions).

**Adding a new language:** add a case to `buildLanguageContext()` mapping the normalized name to a `LanguageContext` struct, add the name to `normalizeLanguage()`, add a code-fence mapping in `codeFenceLanguage()`, and add a manifest check to `detectPromptLanguage()` if applicable.

---

## Planner prompt builders

`src/engine/spec/prompts/`

The planning session has one prompt builder and a few turn builders, all in `plan-session.ts`.
The check and skill rules live in `tasks.ts` as `GATES_ARE_SPLITBRIEFS` and `SKILLS_WITH_EVERY_BRIEF`.

**`buildPlanSessionPrompt({ feature, projectContext, languageContext, build, skillsContext?, codebaseContext?, earlierPlanning? })`** -- the first turn of the planning session. `projectContext` includes the repo map. `build` names the implementer model and the context it was measured at, so the planner sizes tasks for it. `earlierPlanning` carries the documents an older run's planning chain wrote. The prompt asks for `{ result }` against `PlanAnswerSchema`: up to 3 questions with defaults, or a plan.

**Turn builders** -- `planAnswersTurn` (the user's answers), `planRepairTurn` (the failed check messages and codes, with the plan that failed), `planRevisedTurn` (a correction from the plan card or a saved rewind, with the reviewed `plan.json`), and `planFullTurn` (the whole prompt plus the conversation so far, for a planner without a native session).

---

## Auth method research

The research record behind [AUTH-METHOD-MATRIX.md](./AUTH-METHOD-MATRIX.md). That user doc states the result; this section keeps the measurements, the unused controls and the open design.

### Enforcement evidence

The runtime enforcement matrix `CLI_AUTH_ENFORCEMENT_EVIDENCE` is empty. No real session/API method switch is proven. `enforceCliAuthInvocation` requires positive evidence for the exact tool, platform and installed version before dispatching an explicit `session` or `api-key` choice. Without it the invocation is refused; omit the selection to use the host CLI configuration. The picker offers no method switch for these rows. A stored login, staged environment or model listing does not establish which billing method a call used.

The measurements below record the staging behavior researched before that enforcement gate was added. They explain why no method was admitted; they are not instructions to configure an explicit method today.

### Measurement environment

macOS (`darwin`), Node 22.22.2, repository baseline `e6ffb1bc`. Every capture is a `--version` or `--help`/help-topic invocation with no prompt and no subcommand that reads or writes credentials. No generation was run, no secret file was read, no login state was touched. Where a control is documented only in a tool's help text and was not exercised, this document says so rather than assuming the text.

Versions are the build on this host; the parenthesised value is `compatibility.testedVersion` in `src/core/runners/cli-tool-catalog.ts`. A control observed on a newer build is not evidence for `minimumAdmittedVersion`.

#### Installed builds measured

| Tool | Executable (installed / catalog tested) | Declared channels | Current method choice offered | Verdict |
|---|---|---|---|---|
| `claude-code` | `~/.local/bin/claude` — 2.1.273 (2.0.0) | `session`, `api-key` | no | host-configured |
| `codex` | `…/node/v22.22.2/bin/codex` — 0.154.0 (0.40.0) | `session`, `api-key` | no | host-configured |
| `cursor` | `~/.local/bin/cursor-agent` — 2026.09.08-6caf4ff (2026.08.25-3e8eec8) | `session`, `api-key` | no | host-configured |
| `opencode` | `~/.opencode/bin/opencode` — 2.0.4 (0.5.0) | `provider-dependent` | no | host-configured |
| `kilo-code` | `/opt/homebrew/bin/kilo` — 7.0.49 (0.1.0) | `provider-dependent` | no | host-configured |
| `copilot` | `~/.local/bin/copilot` — 1.0.83 (1.0.77) | `session` | no | host-configured |
| `command-code` | `…/node/v22.22.2/bin/cmd` — 1.54.1 (1.39.2) | `session` | no | host-configured |
| `antigravity` | `~/.local/bin/agy` — 1.2.4 (1.2.2) | `session` | no | host-configured |

Every tool declares `roles: ['planner', 'implementer']`; the reviewer seat reuses the planner runner (`resolveReviewerRunner`). The channel set is the tool's `auth.channels` in `cli-tool-catalog.ts`; "method choice offered" requires invocation-enforcement evidence, not merely multiple declared channels. The custom-only tools (`kiro`, `gemini`, `cline`, `qwen`) and the other excluded candidates (`auggie`, `junie`) are not admitted and have no row.

### Follow-up: per-provider key narrowing for OpenCode 2

This is a named follow-up. It is not built. Today an OpenCode or Kilo seat gets every `*_API_KEY` of the parent, so a model on one provider can read the keys of every other provider.

The design:

1. SPLITBRIEF cannot map a model's provider to its key variable by itself. The model id names the provider (`providerID`, for example `kimi-code-plan-global` in `kimi-code-plan-global/<model>`). Only the tool knows which variable that provider reads.
2. `opencode auth list --standalone --format json` (OpenCode 2, measured 0.6 s on 2.0.14) prints one object per provider: `id`, `name` and `connections`. An `env` connection names its variable, for example `KIMI_API_KEY`, and never its value. The listing names an `env` connection only while that variable is set, so the oracle runs with the staged environment that carries every `*_API_KEY`.
3. At dispatch, after the CLI start-trust gate has admitted the executable, SPLITBRIEF runs the oracle once with that trusted executable. It keeps the variables of the configured model's provider id and removes every other `*_API_KEY` from the prebuilt environment. `createRunnerSandboxEnv` cannot do this, because the trust gate lives at dispatch, not in the environment builder.
4. If the oracle fails or times out, the dispatch fails closed with a named reason. It does not fall back to every key in silence.
5. The cost is one extra trusted spawn per OpenCode dispatch.

The limits, where the current rule stays:

- **Kilo Code:** `kilo auth list` (7.0.49) prints provider display names, not provider ids, so no model maps to a variable.
- **OpenCode 1.x:** it rejects `--standalone` and prints the boxed listing, which has no provider ids either.
- **A seat with no model:** OpenCode then picks its own default model, so the provider is unknown.

### Controls that exist in the installed builds but are not used

These are the only per-invocation method controls found in any installed tool's help. None is emitted today, and none is proven; each is recorded so a later card can evaluate it instead of rediscovering it.

- **`claude --bare`** (2.1.273) is the one documented native enforcement in the whole set: "Anthropic auth is strictly `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings` (OAuth and keychain are never read)." It would make the `claude-code` `api-key` channel enforceable — but it also disables hooks, LSP, plugin sync, auto-memory and `CLAUDE.md` auto-discovery, so adopting it is a behavior change to the planner seat, not a flag flip. It is absent from `CLAUDE_BASE_ARGS`, and its presence in `minimumAdmittedVersion` 2.0.0 is unknown.
- **`cursor-agent --api-key <key>`** supplies a key for the invocation and is documented as equivalent to `CURSOR_API_KEY`. The help says nothing about what happens when it is absent or rejected, so it is an input, not proof of precedence.
- **`codex -c <key=value>` with `--strict-config`** can override any `~/.codex/config.toml` key for one invocation and error on keys this build does not recognise. Whether a method-selecting key exists under that mechanism was not established: settling it means running Codex against a staged config, which is more than a help capture.
- **`copilot`'s `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` precedence** proves the environment beats the stored login when the environment holds a token. It says nothing about the reverse case — an empty environment falls back to the stored login by design — so it cannot enforce a *selected* method.
- **`cmd --local-only`** and **`codex --oss` / `--local-provider`** are route switches. `cli-tool-catalog.ts` already records that `cmd --help` names no API-key environment variable, which is why Command Code declares a `session` channel only.
- **`agy --help`** (1.2.4, historical capture) exposed no authentication flag, variable or login subcommand. Current [upstream authentication docs](https://antigravity.google/docs/cli/install/#using-a-gemini-api-key), checked 2026-09-17, describe a Gemini API-key mode using a settings change plus `GEMINI_API_KEY`. SPLITBRIEF still admits only the host-configured session channel; no per-invocation method switch or fallback behavior has been proven for this adapter.

### Limits of the measurements

Single host, macOS only. Linux and Windows file-staging postures are read from declarations, not measured here. Antigravity is the exception: its credential bridge is admitted only on macOS, and other platforms remain unsupported with unknown authentication. Every row reflects the installed build named in the table; the catalog's `minimumAdmittedVersion` is older than every one of them, and no claim here extends downward to it. Nothing was proven by generation, by reading a credential file, or by changing a login.

---

## What to read next

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** -- full config schemas and YAML examples for all runner kinds
- **[WORKFLOW.md](./WORKFLOW.md)** -- how the orchestrator drives the planner through phases
- **[ENGINE.md](./ENGINE.md)** -- how events flow from engine to UI
