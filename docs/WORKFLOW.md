# SPLITBRIEF — Workflow

The state machine reference. Every phase, every transition, what triggers each one, what code runs.

Source of truth: `src/core/state/machine.ts` (reducer), `src/core/phases.ts` (phase taxonomy), `src/core/schemas/enums.ts` (Phase / WorkflowMode enums). Orchestrator entry: `src/engine/orchestrator/run/workflow.ts` → `src/engine/orchestrator/run/phases.ts`.

For terminology (planner, implementer, runner kinds, sessions, queue, awaiting-continue), read `docs/CONCEPTS.md` first.

---

## Batching, admission, and disposition

**Finite batching.** The Task Brief compiler compiles the manifest in
deterministic four-item batches, at most 64 real dispatches per operation, and
each batch runs in a fresh detached session scope that cannot read, replace,
expire, resume, or report into the workflow planner session. Every planner mode
crosses the same admission boundary: standard and speckit run the compiler's
detached batches, and quick stays single-call while accepting only a
current-call result.

**Tiered admission.** The Task Brief compiler admits backends across tiers: the
tested version yields a full capability receipt; other detected versions of
supported backends are admitted with runtime-drift evidence and a run warning;
unsupported candidates (`copilot`, `cursor`, `command-code`, `shell`, `agent`)
receive a typed
fail-closed refusal (`task_compiler_capability_unsupported`). Runtime guards
(envelopes, terminal contract, dispatch ledger, post-run mutation detection)
are the enforcement surface.

**Two-way disposition.** Every new, retry, rewind, and resume planning path
returns exactly one of `ready-for-tasks` or `terminal`. Readiness is never
inferred from cancellation, failure, task count, score, artifact existence,
phase, or process exit. A terminal result never enters execution.

---

## 1. The state machine

Primary state is the `phase` field — one of 15 values from the `Phase` enum. Two boolean-like sub-states overlay any phase:

- **`awaitingContinue`** — the current call was aborted mid-stream (single Ctrl-C). The workflow stays in its current phase, holding for the user to continue or cancel.
- **`rewindPending`** — a `/revise-spec` or `/revise-plan` command was issued. Contains `{ target: 'spec' | 'plan', comment?: string }`. The planning runner reads it on restart and takes the rewind fast-path. Cleared via `CLEAR_REWIND_PENDING` before the approval gate.

A third overlay, **`pendingRecovery`**, carries a `RecoveryIssue` when the task loop hits an unrecoverable error. The phase stays where the stop occurred; the recovery overlay gates further progress until the user picks an action.

### 1.1 Phase diagram

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> researching : START

    researching --> specifying : RESEARCH_DONE

    specifying --> reviewing_spec : SPEC_DONE

    reviewing_spec --> planning : APPROVE_SPEC
    reviewing_spec --> idle : REJECT_SPEC
    reviewing_spec --> clarifying : SPEC_CLARIFY_START

    clarifying --> constitution_check : SPEC_CLARIFY_DONE

    constitution_check --> planning : CONSTITUTION_CHECK_PASS
    constitution_check --> idle : CONSTITUTION_CHECK_FAIL

    planning --> reviewing_plan : PLAN_DONE
    planning --> reviewing_briefs : BRIEF_ADMISSION_OPENED

    reviewing_plan --> reviewing_briefs : BRIEF_ADMISSION_OPENED
    reviewing_plan --> analyzing : ANALYZE_START
    reviewing_plan --> idle : REJECT_PLAN

    analyzing --> reviewing_plan : PLAN_DONE

    reviewing_briefs --> implementing : BEGIN_IMPLEMENTATION
    reviewing_briefs --> idle : REJECT_BRIEFS

    implementing --> validating_task : TASK_SENT
    implementing --> analyzing : ANALYZE_START
    implementing --> final_review : ALL_DONE

    validating_task --> implementing : VALIDATION_PASS
    validating_task --> implementing : VALIDATION_FAIL (attempt < max)
    validating_task --> escalating : VALIDATION_FAIL (attempt >= max)

    implementing --> implementing : HINT_SUCCESS (intermediate retry)
    escalating --> implementing : HINT_SUCCESS / FULL_SUCCESS

    final_review --> complete : REVIEW_DONE
    complete --> [*]
```

The diagram shows phase-level transitions only. `awaitingContinue`, `rewindPending`, and `pendingRecovery` are sub-states that overlay any phase — they don't appear as nodes.

### 1.2 Complete transition table

Verified against the `transition()` reducer in `src/core/state/machine.ts` and the `phaseActions` map.

| From | Action | To | Side effects |
|------|--------|----|-------------|
| `idle` | `START` | `researching` | — |
| `researching` | `RESEARCH_DONE` | `specifying` | — |
| `specifying` | `SPEC_DONE` | `reviewing-spec` | — |
| `reviewing-spec` | `APPROVE_SPEC` | `planning` | — |
| `reviewing-spec` | `REJECT_SPEC` | `idle` | Workflow ends |
| `reviewing-spec` | `SPEC_CLARIFY_START` | `clarifying` | Speckit only |
| `clarifying` | `SPEC_CLARIFY_DONE` | `constitution-check` | — |
| `constitution-check` | `CONSTITUTION_CHECK_PASS` | `planning` | — |
| `constitution-check` | `CONSTITUTION_CHECK_FAIL` | `idle` | Clears `awaitingContinue`; carries `reason` |
| `planning` | `PLAN_DONE` | `reviewing-plan` | Attaches `tasks` to state |
| `planning` / `reviewing-plan` / `reviewing-briefs` | `BRIEF_ADMISSION_OPENED` | `reviewing-briefs` | Resets `currentTaskIndex` and `attempt` to 0 |
| `reviewing-plan` | `REJECT_PLAN` | `idle` | Workflow ends |
| `reviewing-plan` | `ANALYZE_START` | `analyzing` | Speckit post-planning audit |
| `analyzing` | `PLAN_DONE` | `reviewing-plan` | Re-attaches `tasks` to state |
| `reviewing-briefs` | `BEGIN_IMPLEMENTATION` | `implementing` | Resets `currentTaskIndex` and `attempt` to 0 |
| `reviewing-briefs` | `REJECT_BRIEFS` | `idle` | Workflow ends before any implementer write |
| `implementing` | `ANALYZE_START` | `analyzing` | Speckit post-planning audit |
| `implementing` | `START_TASK` | `implementing` | Sets task to `in_progress`, resets `attempt` to 0 |
| `implementing` | `TASK_SENT` | `validating-task` | — |
| `validating-task` | `VALIDATION_PASS` | `implementing` | Marks task `done`, advances `currentTaskIndex`, resets `attempt` |
| `validating-task` | `VALIDATION_FAIL` (attempt < maxRetries) | `implementing` | Increments `attempt` |
| `validating-task` | `VALIDATION_FAIL` (attempt >= maxRetries) | `escalating` | — |
| `validating-task` | `ESCALATE` | `escalating` | — |
| `implementing` | `HINT_SUCCESS` | `implementing` | Marks task `escalated`, advances index. Used by successful intermediate-model retry while still in the implementing phase. |
| `escalating` | `HINT_SUCCESS` | `implementing` | Marks task `escalated`, advances index |
| `escalating` | `HINT_FAIL` | `escalating` | Falls through to full escalation |
| `escalating` | `FULL_SUCCESS` | `implementing` | Marks task `escalated`, advances index |
| `implementing` / `validating-task` / `escalating` | `SKIP_TASK` | *(same)* | Marks task `skipped`, advances `currentTaskIndex` |
| `implementing` / `validating-task` / `escalating` | `RESET_TASK` | `implementing` | Sets task to `pending`, rewinds `currentTaskIndex` to that task's index, resets `attempt`. Tasks after it keep their status. |
| `implementing` | `ALL_DONE` | `final-review` | — |
| `final-review` | `REVIEW_DONE` | `complete` | — |

`maxRetries` defaults to 3 (configurable via `workflow.maxRetries`).

**Cross-phase actions from `phaseActions` not shown above:** `RESEARCH_DONE` is also allowed from `idle`, `specifying` and `planning`. `SPEC_CLARIFY_START` is allowed from `idle`, `researching`, `reviewing-spec`, and `planning`. `PLAN_DONE` is also allowed from `researching`, `specifying` and `reviewing-plan`. `BRIEF_ADMISSION_OPENED` is allowed from `planning`, `reviewing-plan` and `reviewing-briefs`. `ANALYZE_START` is allowed from `reviewing-plan` and `implementing`. Every planning producer exits in `reviewing-plan`, and `BRIEF_ADMISSION_OPENED` is the single door into `reviewing-briefs` for all three modes. These permit the orchestrator to skip or re-enter phases depending on mode and backend capability without the reducer rejecting the action.

### 1.3 Anytime actions

These fire from any phase. They modify sub-state without changing `phase`.

| Action | Effect |
|--------|--------|
| `CANCEL` | Sets `phase: 'idle'`, clears `awaitingContinue`. Used by explicit cancellation paths, not by the TUI double Ctrl-C exit. |
| `ABORT_TURN` | Sets `awaitingContinue: true`. Reducer accepts it in any phase; the TUI dispatches it only for `isLivePhase()` phases. |
| `CONTINUE_TURN` | Sets `awaitingContinue: false`. User pressed Enter. |
| `SET_PLANNER_SESSION_ID` | Stores backend session handle for resume. |
| `ENQUEUE_USER_MSG` | Appends message to `messageQueue`. |
| `MARK_INJECTING_NATIVE` | Marks a queued message as currently being delivered to the live native session. |
| `MARK_DELIVERED_NATIVE` | Marks a queued message as delivered to the live native session and no longer pending. |
| `MARK_NATIVE_DELIVERY_FAILED` | Moves an injecting message back to pending delivery. |
| `DRAIN_QUEUE` | Timestamps pending-undelivered messages with `drainedAt`. |
| `CLEAR_QUEUE` | Removes pending or injecting undelivered messages from the queue. Delivered and already-drained messages remain as history. |
| `SET_PENDING_RECOVERY` | Sets `pendingRecovery` to the provided `RecoveryIssue`. |
| `MARK_RECOVERY_APPLYING` | Records selected recovery action and timestamp on `pendingRecovery`. |
| `PAUSE_PENDING_RECOVERY` | Sets `pendingRecovery.status` to `'paused'`. |
| `RESOLVE_PENDING_RECOVERY` | Removes `pendingRecovery` after the selected recovery path is handled. |
| `REWIND_TO_SPEC` | Sets `phase: 'specifying'`, clears `tasks`, resets `currentTaskIndex` and `attempt` to 0, clears `awaitingContinue`, sets `rewindPending: { target: 'spec', comment? }`. |
| `REWIND_TO_PLAN` | Sets `phase: 'planning'`, clears `tasks`, resets `currentTaskIndex` and `attempt` to 0, clears `awaitingContinue`, sets `rewindPending: { target: 'plan', comment? }`. |
| `CLEAR_REWIND_PENDING` | Removes `rewindPending`. |

Two task-scoped actions also apply in `implementing` and `escalating`: `UPDATE_TASK_CODE` stores partial implementer output on a task, `CLEAR_TASK_CODE` removes it.

---

## 2. Phase taxonomy

From `src/core/phases.ts`. Each phase has four properties derived from the source sets.

| Phase | Role | Cancellable | Resumable | Live |
|-------|------|:-----------:|:---------:|:----:|
| `idle` | — | no | no | no |
| `researching` | planner | yes | no | yes |
| `specifying` | planner | yes | no | yes |
| `reviewing-spec` | planner | no | yes | no |
| `clarifying` | planner | no | no | no |
| `constitution-check` | planner | no | no | no |
| `planning` | planner | yes | yes | yes |
| `reviewing-plan` | planner | no | yes | no |
| `reviewing-briefs` | planner | no | yes | no |
| `analyzing` | planner | no | no | no |
| `implementing` | implementer | yes | yes | yes |
| `validating-task` | implementer | no | no | no |
| `escalating` | implementer | yes | no | yes |
| `final-review` | planner | yes | yes | yes |
| `complete` | — | no | no | no |

**Role** — `phaseRole()`: implementer for `implementing`, `validating-task`, `escalating`; planner for everything else (cost accounting adds `final-review` to the implementer bucket via `phaseCostRole()`).

**Cancellable** — single Ctrl-C aborts the active model call. This matches `isLivePhase()` in `src/core/phases.ts`.

**Resumable** — `splitbrief resume` can pick up here. `RESUMABLE_PHASES` in `src/core/phases.ts` is exactly `reviewing-spec`, `planning`, `reviewing-plan`, `reviewing-briefs`, `implementing`, `final-review`. Every other phase is resumable only through the `awaitingContinue` override below; terminal phases (`idle`, `complete`) never are.

**Live** — streaming output is happening. Phases where the planner or implementer is actively generating: `researching`, `specifying`, `planning`, `implementing`, `escalating`, `final-review`.

**Who runs `final-review`** — the review seat, which is the `reviewer` runner from `.splitbrief/config.yaml` when one is configured and the planner's own runner when none is (`resolveReviewerRunner`, `src/core/config/accessors/reviewer-runner.ts`). It is the only call the reviewer makes; every other model call in this state machine, escalation included, stays on the planner. The phase's `phaseRole()` is still `planner` and `phaseCostRole()` is still `implementer` — those classifications did not move, so per-phase cost attribution is unchanged. During the phase the transcript and the composer live status name the seat actually running — the reviewer's tool and model when one is configured, today's wording when none is — and the sidebar carries a reviewer row whenever one is configured. A reviewer that fails does not hand the review back to the planner — the phase records a failed review, stays in `final-review` instead of transitioning `REVIEW_DONE`, and still builds the run summary.

**Planner markdown headers** — `planner_text` events with `content: 'markdown'` prepend a phase label before the rendered markdown body. During `researching`, the label is the literal `RESEARCH` (codebase research output, not the later Task Brief). `specifying` uses `SPEC`, `planning` uses `PLAN`, and `escalating` uses `ESCALATION`. Task Brief markdown is produced later in `planning` and at the `reviewing-briefs` gate, not during the research phase.

**Override:** `awaitingContinue: true` makes any phase resumable regardless of the table above. The user explicitly aborted and is expected to return.

---

## 3. Mode dispatch

Mode dispatch: `src/engine/orchestrator/planning/run.ts`. Mode determines how many planner calls run and which approval gates activate. All three modes stay in the product; the question a mode answers is how much ceremony precedes the briefs, not which features are available.

| Mode | Planner calls | Phases visited | Default approval | Artifacts |
|------|:------------:|----------------|:----------------:|-----------|
| `quick` | 1 | idle → implementing | `none` | tasks.md |
| `standard` | 4 | idle → researching → specifying → reviewing-spec → planning → reviewing-plan → reviewing-briefs → implementing | `spec` | research, spec.md, plan.md, tasks.md |
| `speckit` | 6-7 | idle → researching → specifying → reviewing-spec → clarifying → constitution-check → planning → reviewing-plan → analyzing → implementing → reviewing-briefs → implementing | `all` | research, spec.md, clarifications.md, constitution-check.json, plan.md, tasks.md, analyze.json |

**The retired `instant` mode.** `instant` was merged into `quick`; it is no longer a mode you can select. The string still parses everywhere it was persisted — `WorkflowModeSchema` (`src/core/schemas/enums.ts`) preprocesses `instant` to `quick` — so old configs, old `--mode instant` invocations, and session state written before the merge all keep loading. Reading `instant` prints a deprecation notice: a config warning from `validateConfig`, a `--mode` warning on stderr from `resolveEffectiveConfig`, and a feedback line from the runtime `/mode` handler. One persisted wire format is retained for back-compatibility only, so pre-merge sessions still replay: the `instant_plan_received` event. Nothing produces it any more.

Speckit runs pre-review quality preparation while in `reviewing-plan`. After it succeeds, `ANALYZE_START` enters `analyzing`, `PLAN_DONE` returns to `reviewing-plan`, and `BRIEF_ADMISSION_OPENED` opens `reviewing-briefs`.

**When the single call produces no briefs** (`quick`). The single planner call is never repeated: there is no automatic zero-task retry or repair. If it returns no Task Briefs, a coded, transcript-safe warning (`planner_returned_zero_tasks`) is published stating that the failed attempt contributes no Brief generation; the attempt writes no planning artifact. The planning result is terminal. The run never falls through to the multi-phase path, which would silently change the selected mode and its cost.

### Selecting a mode

Every entry point that runs the planner reaches all three modes. Resolution happens in `resolveMode()` (`src/core/config/runtime/resolve.ts`), highest precedence first:

| Source | Scope | Notes |
|--------|-------|-------|
| `--mode <mode>` | one invocation | Accepted by `start`, `spec`, `resume`, and `continue`. The value is parsed against the three-mode enum; anything else aborts the command with `Invalid mode: <value>. Must be one of: quick, standard, speckit`. |
| Saved mode in `state.json` | the resumed run | Written when the run first resolved its mode. `resume` / `continue` reuse it; passing `--mode` overrides it for that resume and prints a warning. |
| `workflow.mode` in `.splitbrief/config.yaml` | the project | What `/mode` and the mode selector write. |
| `standard` | — | Built-in default when nothing else is set. |

`splitbrief spec` takes the same flag with the same validation and the same precedence. The mode decides how much planning happens before the command stops: `quick` makes one planner call, `standard` and `speckit` run the multi-call pipeline. `spec` never implements, so the approval gates below do not apply to it — it writes the artifacts its mode produces and exits. In particular `spec --mode speckit` produces the **standard** artifact set (`research.md`, `spec.md`, `plan.md`, `tasks.md`): the speckit-only artifacts (`clarifications.md`, `constitution-check.json`, `analyze.json`) are orchestrator-side and the 6-7-call row in the table above describes `start`, not `spec`.

**Where the mode is visible when the choice is made.** On the home screen the crew block above the composer (`src/features/home/components/seat-block.tsx`) prints one labelled row per seat — `PLAN`, `BUILD`, `REVIEW`, each followed by that seat's identity (`Claude Code CLI · Claude Sonnet 4`) — and closes with a status line carrying the mode, then the optional skill count and detection notice, then the `/crew to change` hint. The mode in force is therefore on screen while the feature is being typed; when the block is too short for a row per seat it collapses to a single line, and when the status line is too narrow the optional parts drop before the mode or the hint do. `/mode` with no argument opens the mode selector (`src/features/settings/mode-selector.tsx`), which lists all three with their planner-call and approval counts and marks the current one; `/mode <name>` sets it without opening the overlay. Both persist `workflow.mode` to `.splitbrief/config.yaml`. On the command line, `--mode` is listed in `splitbrief start --help` and `splitbrief spec --help`, and `spec` names the resolved mode alongside the planner identity on the line it prints before planning starts. Once planning begins the orchestrator publishes `mode_resolved` carrying the resolved mode and approval level.

### Approval gates

Controlled by `workflow.approve`: `none` | `spec` | `plan` | `all` | `default`. Each mode has a default; `default` follows that mode default. Override via `--approve <level>` on the CLI.

- `none` — skip spec/plan document gates. quick default. Briefs review still runs in modes that produce reviewable briefs.
- `spec` — gate on supporting spec. standard default.
- `plan` — gate on plan only.
- `all` — gate on spec and plan. speckit default.

The brief quality gate (`src/engine/spec/brief-quality.ts`) runs for all three modes after the Task Brief is produced and before `implementing`. It writes `brief-quality.json` and publishes `brief_quality_passed` or `brief_quality_failed`. In `standard` and `speckit`, an error-level report feeds the linter's issues back to the planner as regeneration feedback, up to `workflow.maxRetries` attempts; when the retries are exhausted and a briefs gate runs, the run still enters `reviewing-briefs` with the last quality report in hand rather than failing. This applies to every error-level issue, not only `empty_task_list`.

An unrepaired error-level report is not a planning failure wherever a human still reviews the briefs: the run proceeds to `reviewing-briefs` with the last quality report in hand, and the reviewer decides what happens to them — edit, revise, retry or reject. Where no briefs gate runs — `quick` mode, `--approve none`, and therefore every headless run that does not ask for a gate — there is no reviewer to decide, so an unrepaired error-level report ends planning as a failed run naming the first brief error instead of entering `implementing`. At the briefs gate the report is re-measured over the briefs read back from `tasks.md`, so an edit made outside the TUI is measured before it can be approved and an error-level brief is refused rather than admitted. A user cancellation or abort keeps cancellation semantics.

Next to it, the brief readiness gate (`src/engine/orchestrator/planning/brief-readiness-gate.ts`) runs over the Task Briefs at briefs approval and again after brief edits. It writes `brief-readiness.json` and publishes `brief_readiness_passed` or `brief_readiness_blocked`. `READINESS BLOCKED` records a readiness diagnostic and requires re-evaluation or a user edit. It never authorizes a quality override (see [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md)).

Briefs review is separate from `workflow.approve`: `standard` and `speckit` enter `reviewing-briefs` only after the initial quality check and any bounded repair pass, so the user can review `tasks.md` before implementation.

### Mode advisor

`adviseMode()` in `src/engine/orchestrator/planning/mode-advisor.ts` is a deterministic keyword/pattern classifier. No LLM call. It classifies the feature prompt into a risk tier (`trivial` → quick, `small` → quick, `normal` → standard, `high` → speckit) and produces a `ModeAdviceKind`: `none`, `downgrade`, `upgrade`, or `missing-context`.

The `trivial` tier does one thing beyond suggesting `quick`: `runPlanningPhase` passes `trivial: true` into the quick planning phase for that run, and `buildQuickPlanPrompt()` then tells the planner to skip the codebase-structure review and cap the run at one to five Task Briefs. The contract sections (Scope, Escalation, Evidence) are still required; only their length is relaxed.

Upgrade and downgrade advice fire only when `confidence >= 0.65`. Missing-context fires below that threshold when the prompt is obviously vague.

The advisor never auto-switches the mode. It publishes a `mode_advice` event and the footer displays the suggestion.

### Clarification questions

All three modes extract planner `<!-- Q:{...} -->` markers and show the interactive `QuestionPrompt` panel above the composer (`collectAndPersistClarifications` in `src/engine/orchestrator/clarifications.ts`); the marker itself never appears in the transcript, in any mode. Known CLI runners preserve explicit markers across stream chunks, so a marker split between chunks still invokes the question flow once. Arbitrary prose questions are not inferred. The five-question cap holds everywhere.

Question IDs are unique for the planning run. The collector keeps the first question for an ID across planner callbacks and continuation turns, then applies the five-question cap to the distinct IDs. A later question with an ID already seen in that run is ignored.

`standard` and `speckit` collect clarifications mid-plan, after the phase's planner call, and regenerate the affected planning artifacts with the answers before moving on — existing behavior, unchanged by this feature.

`quick` asks after its single planner call completes, once tasks are already drafted: each answer is persisted under `## Clarifications` in `spec.md` and queued as a `QueuedMessage` (`origin: 'clarification'`) for the next planner invocation, with a native-inject attempt against the live planner session where the runner supports it. There is no automatic re-plan — `quick` stays one planner call; the answers ride along as queued context rather than triggering a second call.

Skipping, cancelling, or superseding a question lets the workflow proceed; no mode blocks on an answer that never comes.

---

## 4. Abort / continue / queue

Four user actions during a live phase:

| Action | Trigger | Effect |
|--------|---------|--------|
| Queue message | Type + Enter | During live planner phases, appends to `messageQueue`. Current call continues. Planners with `injectUserTurn()` also receive the message immediately. Still-pending delivery entries drain at the next safe-point. |
| Abort turn | Ctrl-C (single) | `AbortController.abort()`. Current call terminates. Partial response preserved in `session.jsonl` with `interrupted: true`. Dispatches `ABORT_TURN` → `awaitingContinue: true`. |
| Exit workflow | Ctrl-C twice within 2s | Exits after state is saved. The TUI unmounts; the saved state may be resumable later with `splitbrief continue <session-id>`. |
| Continue | Enter (from awaiting-continue) | Dispatches `CONTINUE_TURN` → `awaitingContinue: false`. Next planner call includes queued messages and partial context. |

**Queue scope.** Planner-only. Mid-task interjection at the implementer, validation, or escalation level is rejected instead of being queued or injected into the planner, because small local models lose coherence when their task prompt is perturbed mid-call.

**Abort scope.** Live model-call phases only: `researching`, `specifying`, `planning`, `implementing`, `escalating`, and `final-review`. Validation is resumable from saved state, but it is not a live input phase.

**Queue lifecycle.** `ENQUEUE_USER_MSG` appends. Native delivery moves through `MARK_INJECTING_NATIVE` to `MARK_DELIVERED_NATIVE`, or back to pending with `MARK_NATIVE_DELIVERY_FAILED`. `DRAIN_QUEUE` timestamps pending-undelivered messages. `CLEAR_QUEUE` removes pending or injecting undelivered messages. On the next safe-point the orchestrator reads pending-undelivered queue entries, folds contents into the next prompt as `[user also says: ...]`, and drains.

Queue submissions return accepted/rejected results. Rejections include planner-unavailable phases and the 50-message cap; both publish a bounded warning. The UI shows feedback near the composer. `/queue show` reports pending-undelivered messages. `/queue clear` clears pending or injecting undelivered messages from the live workflow queue when a live clear handler is available, and otherwise reports unavailable.

**Esc Esc interrupts (two-press ladder).** On the workflow screen, the first Esc arms an intent — `interrupt` while a live phase runs, or `cancel` while a question prompt is open or the workflow is already interrupted (`abortStore.arm(...)` in `src/app/keys.ts`); a second Esc fires it. The armed intent auto-clears after 2 seconds. The first Esc Esc is a hard interrupt: the in-flight call aborts, the runner's process group is terminated (graceful signal first, force-kill after a grace window), and the workflow enters a visible `interrupted` state — spinners stop and the byline reads the interim `interrupted — finishing current step…` until the continuation prompt parks at the next call boundary (immediately, for a live in-flight call), then `interrupted — Enter retry · type to steer`. The composer stays active while interrupted: submitting typed text resumes the workflow with that text as steering instructions; submitting an empty message (plain Enter) retries the interrupted call. Esc Esc is ignored — it arms nothing and no byline changes — during the `validating-task`, `analyzing`, and `constitution-check` phases (per-task validation, the per-task git commit, speckit's analyze step, and speckit's constitution-check gate), since none of these is in the live-phase set (`isLivePhase` in `src/core/phases.ts`); the interim `finishing current step…` byline above already covers the one dead zone that is inside a live phase, the gap between runner calls, where the press still arms and parks at the next call boundary. A second Esc Esc while interrupted cancels the entire workflow. With an overlay open, Esc closes the topmost overlay instead. See [SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md) §Global keys for the full key map.

---

## 5. Rewind

Source: `src/engine/orchestrator/planning/rewind.ts`.

### /revise-spec [comment]

Dispatches `REWIND_TO_SPEC`. Reducer sets `phase: 'specifying'`, clears `tasks`, resets `currentTaskIndex` and `attempt`, clears `awaitingContinue`, sets `rewindPending: { target: 'spec', comment? }`.

On the next planning restart, `handleRewindSpec` detects `rewindPending`:
- If `comment` is non-empty: calls `planner.regenerate()` with `buildRegeneratePrompt({ artifactType: 'spec', currentContent: currentSpec, feedback: comment })`. Writes regenerated spec.md.
- If `comment` is empty: skips regeneration.
- Either way: dispatches `SPEC_DONE` → `reviewing-spec`. Presents the spec approval gate. On approval: dispatches `APPROVE_SPEC` → `planning`. Regenerates plan and tasks from the new spec. Runs `PLAN_DONE` → `reviewing-plan`, then briefs approval.

The regenerated document follows the same admission rule as the initial document. This covers replacement spec and plan artifacts: invalid Markdown is rejected before the file write or `artifact_written` event, so the previous artifact remains available for the current workflow.

### /revise-plan [comment]

Dispatches `REWIND_TO_PLAN`. Reducer sets `phase: 'planning'`, clears `tasks`, resets counters, clears `awaitingContinue`, sets `rewindPending: { target: 'plan', comment? }`.

`handleRewindPlan` detects `rewindPending`:
- If `comment` is non-empty: calls `planner.regenerate()` on the plan artifact. Writes regenerated plan.md. Spec is preserved.
- If `comment` is empty: skips regeneration.
- Re-derives tasks from the plan. Dispatches `PLAN_DONE`. Runs plan approval gate (if enabled), then briefs approval.

### /redo-task \<id\>

Dispatches `RESET_TASK`. Sets the target task to `pending`, rewinds `currentTaskIndex` to that task's index, resets `attempt` to 0, sets `phase: 'implementing'`. No `rewindPending` — the task loop re-picks the task on its next iteration. Tasks after the target keep their existing status.

| Slash command | Reducer action | `rewindPending` | Regenerates? |
|---------------|---------------|:---------------:|:------------:|
| `/revise-spec` + comment | `REWIND_TO_SPEC` | `{ target: 'spec', comment }` | spec → plan → tasks |
| `/revise-spec` (no comment) | `REWIND_TO_SPEC` | `{ target: 'spec' }` | plan → tasks (spec kept) |
| `/revise-plan` + comment | `REWIND_TO_PLAN` | `{ target: 'plan', comment }` | plan → tasks |
| `/revise-plan` (no comment) | `REWIND_TO_PLAN` | `{ target: 'plan' }` | tasks only |
| `/redo-task <id>` | `RESET_TASK` | not set | no |

`rewindPending` is cleared via `CLEAR_REWIND_PENDING` before the approval gate runs.

---

## 6. Resume

`splitbrief resume` reads `.splitbrief/active` to find the session and loads `state.json` through the v4 state operations API. If either is missing, malformed, future-versioned, or the phase is not resumable, resume refuses with an error. A v3 state is promoted to v4 on load.

### Resumable phases

`reviewing-spec`, `planning`, `reviewing-plan`, `reviewing-briefs`, `implementing`, `final-review` (the `RESUMABLE_PHASES` set in `src/core/phases.ts`). Plus any phase with `awaitingContinue: true`.

### Non-resumable phases

Every other phase — `researching`, `specifying`, `clarifying`, `constitution-check`, `analyzing`, `validating-task`, `escalating` — unless `awaitingContinue: true`. The terminal phases `idle` and `complete` are never resumable. If the process died mid-generation without `awaitingContinue`, the stream is lost and the feature must restart.

### Recovery on resume

If state has `pendingRecovery`, resume shows that recovery issue before dispatching any work. Selecting `pause-run` keeps `.splitbrief/active` intact so the same decision appears on next resume.

An unresolved recovery also makes the stop audible: when the task loop re-enters a state that still carries `pendingRecovery`, it publishes a transcript-safe `warning` with `code: 'recovery_pending_unresolved'` naming the reason, the recovery status (`awaiting-user`, `paused`, or `applying`) and the available actions, then stops without running any task. The issue is neither cleared nor re-entered. In headless `--json` mode the same state fails the command with exit code 1 for **every** status — a paused or applying recovery no longer exits 0 having done nothing.

### Planner context rebuild

Resume uses the capability matrix:

1. Backend has `supportsSessionResume: true` and `plannerSessionId` is set → reuse the native session (Claude Code: `--session-id`).
2. Backend rejects the session (expired, unknown) → emit `session_expired`, notify user, fall through.
3. Rebuild from `session.jsonl`: read transcript messages, use latest compact summary entry plus later messages. Pass as initial context to fresh planner call.
4. If no transcript exists and step 1 failed → no transcript context is available. `applyRebuiltContext()` publishes a warning and continues with the Task Brief transport plus any supporting spec/plan artifacts.

Pending queue entries remain in `state.json`. Resume excludes still-pending queued user messages from stateless transcript rebuild so they are not duplicated, but `resetWorkflow(resume)` reconstructs queue depth from those pending entries so the footer and `/queue show` still reflect them.

In-flight tasks: tasks marked `in_progress` at save time are re-attempted from `attempt: 0`. They are re-run from the Task Brief with refreshed `currentCode`.

---

## 7. Escalation and recovery

When a task fails validation `maxRetries` times:

0. **Intermediate tier** — only when `escalation.intermediateProvider` is set and `escalation.enabled` is not `false`: a paid mid-tier API model retries the task. Success → task `done`.
1. **Hint escalation** — if planner has `supportsHintEscalation`: short hint to implementer, one retry. Success → task `done`.
2. **Full escalation** — planner writes the code directly. Success → task `escalated`.
3. **Recovery** — if all tiers fail, `pendingRecovery` is set. The phase stays where the stop occurred.

Recovery reasons: `implementation-error`, `validation-failed`, `retry-exhausted`, `runner-unauthenticated`, `runner-usage-limit`, `context-overflow`, `user-edit-conflict`, `approval-promotion-conflict`, `budget-paused`, `budget-exceeded`, `dependency-blocked`.

Budget-paused recovery can come from crossing `workflow.budgetPauseThreshold` or from paid/API usage whose model pricing is unknown. Unknown local-only usage does not dollar-pause by itself; it remains visible as local/unpriced.

Recovery actions:

| Action | Effect |
|--------|--------|
| `retry-same-worker` | Clears recovery, resets task to `pending`, reruns in fresh context |
| `route-bigger-worker` | Clears recovery, reruns task with named larger profile |
| `switch-seat` | `runner-usage-limit` only: moves the seat to another ready detected tool and re-prepares the session on it |
| `continue` | Allowed for budget-pause below max or safe unrelated user edits only |
| `skip-current-task` | Records evidence, marks task `skipped`, advances index |
| `pause-run` | Keeps issue pending and session resumable |
| `abort-workflow` | Exits through normal shutdown |
| `planner-split-rebase` | Legacy/manual only; new prompts do not offer it, and old states block with `planner-proposal-required` |

Recovery statuses: `awaiting-user` → `applying` (via `MARK_RECOVERY_APPLYING`) → cleared (via `RESOLVE_PENDING_RECOVERY`). Or `awaiting-user` → `paused` (via `PAUSE_PENDING_RECOVERY`) → resumable on next `splitbrief resume`.

---

## 8. A standard run, step by step

```
 1. splitbrief start "add email validator"
 2. CLI loads .splitbrief/config.yaml → configStore
 3. CLI checks .splitbrief/active → error if present.
    Generate session ID, create .splitbrief/sessions/<id>/, write .splitbrief/active.
 4. routerStore → screen: workflow. useWorkflow starts.

 5. runWorkflow() begins. initializeWorkflow emits workflow_started.
    Mode advisor runs — deterministic classifier, publishes mode_advice if applicable.
    Repo map built from codebase config.

 6. phase: idle → START → researching
    Planner streams codebase research. Markdown planner text renders with a `RESEARCH` header.
    Output → session.jsonl + workflow store → UI.
    Planner session ID captured → SET_PLANNER_SESSION_ID → state.json.

 7. phase: researching → RESEARCH_DONE → specifying
    Planner writes supporting spec.md. The artifact must be non-empty Markdown
    with a heading before review or downstream use. Empty or heading-free output
    fails admission and does not feed the next phase.

 8. phase: specifying → SPEC_DONE → reviewing-spec
    callbacks.onApprovalNeeded('spec', specPath)
      approve  → re-read spec.md; if edited on disk, regenerate plan + tasks
                 from the edited spec, then APPROVE_SPEC
      edit     → open the external editor on spec.md, then re-prompt the gate
      comment  → planner.regenerate() → loop back to reviewing-spec
      reject   → REJECT_SPEC → idle. Workflow ends.

 9. phase: reviewing-spec → APPROVE_SPEC → planning
    Planner compiles plan and Task Brief transport. Writes plan.md and tasks.md.
    plan.md must meet the same minimum before downstream use or review. Invalid
    plan output is not used to derive or review Task Briefs.

10. phase: planning → PLAN_DONE → reviewing-plan
    In standard mode, plan gate is auto-advanced (approve level is 'spec').

11. phase: reviewing-plan → BRIEF_ADMISSION_OPENED → reviewing-briefs (standard)
    Brief quality gate runs. Writes brief-quality.json. An error-level result feeds
    the linter's issues back through planner regeneration, up to maxRetries
    attempts; when they are exhausted the run still enters reviewing-briefs with
    the last report in hand.

12. phase: reviewing-briefs
    callbacks.onApprovalNeeded('briefs', tasksPath)
    Approval reads tasks.md from disk and re-runs the quality gate over what it
    read, so brief-quality.json describes the briefs about to run; an error-level
    report re-prompts the gate instead of being approved.
    Ctrl+E/e/edit/E/edit-file opens tasks.md in the external editor
    resolved as VISUAL, non-terminal EDITOR, detected GUI editor from safe absolute PATH, macOS open, terminal EDITOR, then vi.

 13. phase: reviewing-briefs → BEGIN_IMPLEMENTATION → implementing
     Prompt-input cost prediction published. Cost gate checked. Runtime output,
     retries, validation reruns, escalation, and unknown paid pricing are tracked
     as the run proceeds.
     Before the first task, the validation baseline is probed: each enabled stage
     runs once (the test probe is narrowed to the first task's affected file) and
     publishes `validation_baseline` running/done rows, so the run shows proof of
     life instead of silent waiting. Stages already red before any task ran are
     recorded as pre-existing failures.

14. Per task:
      implementing → START_TASK (task in_progress, attempt 0)
      implementer.implement(taskPrompt) → code written to disk
      A direct-writing implementer edits the run's isolation directory instead of
      the project — where it works is set by `workflow.isolation`
      (worktree by default; see CONFIGURATION.md §5)
      implementing → TASK_SENT → validating-task
      typecheck → lint → tests (stops at the first failure attributable to the task)
        pass → VALIDATION_PASS → implementing (next task)
        fail → VALIDATION_FAIL → implementing (attempt++, retry)
        fail (attempt >= maxRetries) → VALIDATION_FAIL → escalating
          HINT_SUCCESS / HINT_FAIL / FULL_SUCCESS → implementing

15. implementing (last task) → ALL_DONE → final-review
    Drift report computed. The review seat reads the diff against Task Brief and spec.

16. final-review → REVIEW_DONE → complete
    summary.json written. .splitbrief/active cleared. Session done.
```

During live model-call phases, single Ctrl-C enters `awaitingContinue`; double Ctrl-C exits. Messages typed during live planner phases queue; only still-pending delivery entries drain at the next safe-point. `/revise-spec` and `/revise-plan` rewind to the appropriate phase. `/redo-task` replays a single task.

---

## 9. WorkflowState shape

Source: `src/core/schemas/workflow.ts` (Zod), `src/core/state/machine.ts` (`createInitialState`). State version: 4.

```typescript
type WorkflowState = {
  stateVersion: 4
  stateRevision: number                    // CAS revision
  phase: Phase
  feature: string
  currentTaskIndex: number
  attempt: number
  tasks: Task[]
  plannerSessionId: string | null
  startedAt: string                       // ISO 8601
  tokenUsage: TokenUsage
  awaitingContinue: boolean               // true after single Ctrl-C
  messageQueue: QueuedMessage[]           // user messages typed during live phases

  // Optional overlays
  rewindPending?: { target: 'spec' | 'plan'; comment?: string }
  pendingRecovery?: RecoveryIssue
  discoveredValidation?: DiscoveredValidation

  // Runner identity (set once at workflow start)
  plannerTool?: string
  plannerModel?: string
  implementerTool?: string
  implementerModel?: string
}

type QueuedMessage = {
  id: string
  text: string
  queuedAt: string                        // ISO 8601
  phase: Phase
  deliveredViaNative: boolean
  nativeDeliveryState: 'pending' | 'injecting' | 'delivered'
  drainedAt?: string
  origin?: 'user-input' | 'clarification'
  question?: string
}
```

`createInitialState(feature)` returns a minimal state: `phase: 'idle'`, `currentTaskIndex: 0`, `attempt: 0`, `tasks: []`, `plannerSessionId: null`, `tokenUsage` zeroed, `awaitingContinue: false`, `messageQueue: []`. All optional fields are absent.

---

## See also

- `docs/CONCEPTS.md` — terminology
- `docs/MENTAL-MODEL.md` — the concept without code
- `docs/HOW-IT-WORKS.md` — same flow with file paths and data flow diagrams
- `docs/ENGINE.md` — orchestrator internals, EventBus, engine/UI communication
- `docs/TASK-CONTRACT.md` — brief quality gate rules, evidence vocabulary, drift detection
- `docs/CONFIGURATION.md` — all config keys including `workflow.*`
- `docs/SLASH-COMMANDS-REFERENCE.md` — all slash commands including `/revise-spec`, `/revise-plan`, `/redo-task`, `/mode`
