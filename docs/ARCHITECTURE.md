# SPLITBRIEF — Architecture

How the code is organized and how data flows through the system. For *what* the system does, see `docs/CONCEPTS.md` and `README.md`. For the workflow state machine itself, see `docs/WORKFLOW.md`.

## Layers, from outside in

```
┌──────────────────────────────────────────────────────────────┐
│  CLI (commander)                                             │
│    — parse args, bootstrap stores, render <App/>            │
└──────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  Stores (useSyncExternalStore, module singletons)            │
│    — shared state, read by React and UI/CLI glue            │
└──────────────────────────────────────────────────────────────┘
           │                              │
           ▼                              ▼
┌────────────────────────┐   ┌───────────────────────────────┐
│  Engine (no React)     │   │  UI (React 19 + Ink 6)        │
│    — workflow logic,   │   │    app/ = shell + flat pages  │
│      planners,         │   │    — reads stores, renders    │
│      implementers,     │   │      event cards,             │
│      validation        │   │      captures keys            │
└───────────────────┬────┘   └───────────────────────────────┘
                    │                      ▲
                    │  publishes EngineEvent│ subscribes
                    └──────────────────────┘
                       via EventBus
                       tuiSink → workflow/actions.addEvent()
```

**Strict rules:**

- `src/engine/**` must not import from React, Ink, or any `src/features/`, `src/components/`, or `src/hooks/` path. The engine is runnable in a headless test process.
- `src/features/**` and `src/components/**` must not import from `src/cli/**`. UI is driven by stores, not by command handlers.
- `src/features/{a}/**` must not import from `src/features/{b}/**`. Cross-feature composition happens at the `src/app/` shell — `app/router.tsx` composes the page files and `app/root.tsx` mounts the tree; shared behavior lives in `src/components/`, `src/hooks/`, `src/utils/`, `src/core/`, or `src/stores/`. See [`STRUCTURE.md`](./STRUCTURE.md) and [`HOOKS.md`](./HOOKS.md).
- `src/stores/**` has no React or Ink imports and no engine value imports. Store modules may use `import type` for engine-owned types such as `EngineEvent`.

These rules are what let us run the full workflow under Vitest without bringing up Ink.

The full layer rules are in [LAYERS.md](./LAYERS.md).

---

The sections below are the inventory of the codebase, written for an agent with no prior context that needs to understand how the system fits together. For the design, start with [MENTAL-MODEL.md](./MENTAL-MODEL.md) → [HOW-IT-WORKS.md](./HOW-IT-WORKS.md) → [ENGINE.md](./ENGINE.md). Counts below may be stale.

---

## 1. System overview

SPLITBRIEF is an orchestrator of two coding tools: one plans and reviews, the other executes, and SPLITBRIEF holds the contract, the isolation, the validation, the retry, the consult, and the evidence between them. It composes two roles around a strict workflow:

1. **Planner** — an expensive, capable model (Claude / GPT / Codex / Claude-Code CLI / etc.) that ingests the feature request, explores the repo, and compiles a Task Brief: a structured list of `Task` objects, one per slice, each naming the files it writes plus scope, validation, and evidence.
2. **Implementer** — the weaker model of the pair, carried either by a tool CLI configured with a cheap model or by a model behind an OpenAI-compatible API. Both transports are first-class. It executes one task at a time against its self-contained brief; the checks that judge the result are SPLITBRIEF's: the plan's checks, and the reviewer checks: the project gate that the plan names, which SPLITBRIEF runs under the reviewer command policy.

The review seat (`Reviewer`) is the optional `reviewer:` runner; with none configured the planner holds it, and with `reviewer: none` no seat holds it (`resolveReviewerRunner`). It reviews the run diff in stateless calls. It answers no consult: the planner answers every consult, the consult of a fix task included.

The repository layers many supporting subsystems on top of that core loop:

- **One planning session** — every run plans in one typed session that answers a plan `checkPlan` validates, and goes through a shared `runWorkflow` orchestrator. There are no workflow modes.
- **EventBus** — single pub/sub port; sinks include the TUI store, an append-only JSONL log, the logger, the in-memory call-evidence record, an NDJSON-on-stdout sink for `--json` or a plain-text stdout sink for `--plain`, an observer sink (`_eventSink`), and a workflow-hook dispatcher.
- **Plan checks** — `checkPlan`, plus the context fit when a Prompt budget is set, admit a plan; a failing plan goes back to the planner once, and one plan card (`reviewing-plan`) asks for human approval unless `workflow.approve: none`. The final deterministic `drift-report.json` / `drift_report` event is produced during final review; there is no per-task drift-chain accumulation.
- **Snapshots** — working-tree snapshots stored under `.splitbrief/sessions/<id>/snapshots/` with a baseline + delta layout. A blob name is the SHA-256 of the file's relative path (`encodeSnapshotPath`). The run ledger, `snapshots/run-ledger.json`, is what `/run accept` and `/run reject confirm` operate on for a run without a workspace; a workspace run uses Apply and its backup instead ([SLASH-COMMANDS-REFERENCE.md](./SLASH-COMMANDS-REFERENCE.md#run-acceptreject)).
- **Run workspace and Apply** create and retain one run directory. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#run-workspace-and-apply) owns the data flow; [WORKFLOW.md](./WORKFLOW.md#apply) owns the Apply sequence. The implementer boundary and audit stay with the implementers.
- **Protected-path confirmation** checks attempt changes inside the workspace. See [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#protected-path-confirmation).
- **Hooks** — `pre_*` (sync) and `post_*` / `on_*` (fire-and-forget) commands declared in config and dispatched on matching events.

The original layering rules still hold: engine never imports React, features never import each other, stores have no React/Ink imports and no engine value imports, zero runtime classes, zero barrels, ESM `.js` suffixes everywhere.

---

## 2. Directory tree of `src/`

The tree below groups by responsibility and is not exhaustive; test files (`*.test.ts` / `*.test.tsx`) are colocated with their source and not listed individually.

```
src/
├── app/                           App shell + FLAT pages (composition layer)
├── cli.ts                         Top-level entry; registers workflow + utility subcommands
├── cli/                           Non-React CLI handlers
├── core/                          SPLITBRIEF-domain (no React, no engine)
├── engine/                        Workflow logic — zero React imports
├── stores/                        useSyncExternalStore module-state
├── features/                      TUI feature slices — components/hooks/helpers
├── components/                    Shared UI (cross-feature)
├── hooks/                         Shared React hooks (cross-feature)
├── lib/                           Third-party adapters
└── utils/                         Pure helpers (no domain)
```

Sectioned picker display now lives in the picker display-window/ListViewport path: `computeListDisplayWindow` computes header/gap/item slots, and `ListViewport` renders them.

Two modules are load-bearing for the seat surfaces:

- The seat identity module — the single seat vocabulary: the seat ids `plan` / `build` / `review` and the identity string (`Claude Code CLI · Claude Sonnet 4`, one ` · ` separator) that Settings, Setup, home and the workflow sidebar render from. Transcript activity headers, task-start rows and Build progress use the same formatter with the model and axis words recorded for their call.
- `pickerViewStore` — the picker's selection/filter state, a store rather than component state, so the page and the feature read the same view.

---

## 3. Layer rules (verified to still hold)

| Layer | Rule | Status |
|---|---|---|
| `src/utils/` | pure / generic / no domain (canonical-json is the model) | holds |
| `src/lib/` | third-party adapters (Node fs, simple-git, terminal escapes) | holds |
| `src/core/` | SPLITBRIEF domain — schemas, paths, phase taxonomy, sessions; **no React, no engine** | holds |
| `src/engine/` | orchestrator, planners, implementers, runners, hooks, snapshots, providers, parsers, streaming, spec, detection; **no React, no Ink, no `src/features/` / `src/components/` / `src/hooks/`** | holds |
| `src/features/<name>/` | feature-local screen/picker/overlay + components/hooks/helpers; **never imports another feature** | holds |
| `src/components/` | shared UI primitives (cross-feature only) | holds |
| `src/stores/` | `useSyncExternalStore` module-state; **no React, no Ink, no engine value imports**; `import type` from engine is allowed for shared event/detection types | holds |
| `src/hooks/` | shared React hooks (cross-feature only) | holds |
| `src/cli/` | commander handlers; bootstrap stores then render `<App/>` | holds |
| `src/cli.ts` | top-level CLI registration only | holds |

`engine → React` and `features/{a} → features/{b}` violations are caught by the pre-merge greps documented in [`INVARIANTS.md`](./INVARIANTS.md). No `index.ts` or `index.tsx` files exist anywhere in `src/`.

---

## 4. The planning session

Every run plans in one typed planning session; there are no workflow modes. `workflow.mode` is a retired key that loads with one notice, and the CLI has no `--mode` flag.

| Step | Code | Artifact |
|---|---|---|
| Questions (at most 2 rounds) | `runPlanSession` (`planning/plan-session.ts`) | `state.pendingPlannerConversation` |
| Typed plan through `requestTyped` and `PlanAnswerSchema` | `runPlanningSession` (`planning/session.ts`) | — |
| `checkPlan` plus the context fit, one repair | `checkFullPlan` (`planning/compile.ts`), `checkPlan` | — |
| Compile | `compilePlan` (`planning/compile.ts`), `taskFromSpec` | `plan.json`, `plan.md`, `tasks.md`; `PLAN_COMPILED` |
| Plan card (`approve: plan`) | `runPlanApproval` (`planning/approval.ts`) | `plan_approved` / `plan_regenerated` / `plan_rejected` |

There is no brief-quality pass, no brief-readiness gate and no briefs gate: the briefs are compiled from a checked plan. An older run parked in the retired chain continues as one planning session (`runPlanningPhases`, `run/phases.ts`). Full flow: [WORKFLOW.md §3](./WORKFLOW.md#3-the-planning-session).

---

## 5. Event bus + sinks

Single `EventBus` port, synchronous fan-out, per-sink crash isolation. Three engine sinks are always on; the others depend on how the run starts. `attachRunSinks` wires them.

| Sink | Trigger | Purpose |
|---|---|---|
| `createJsonlSink` | always | appends to `.splitbrief/sessions/<id>/session.jsonl` |
| `createLoggerSink` | always | writes each event through the process logger |
| `createCallEvidenceSink` | always | keeps the run's per-call usage record in memory, so the summary reads what the run observed |
| `tuiSink` option (`addTuiEvent`) | interactive runs | bounds every event for the TUI and forwards it to `workflow/actions.addEvent` |
| `createStdoutJsonSink` | `--json` headless | one NDJSON record `{ "type": "event", "data": <event> }` per event on stdout |
| `createStdoutTextSink` | `--plain` headless | one plain line per phase, task, review and completion on stdout; `warning` and `info` events also go to stderr, a `debug` event does not |
| `_eventSink` option | a caller passes it | an observer sink for the caller |
| `createHookSink` | `config.hooks` declared | dispatches matching `post_*` / `on_*` hooks, `on_halt` among them (`recovery_prompted`) |

Pre-hooks (`pre_*`) are *not* sink-driven — they run synchronously at the orchestrator call site via `runPreHooks()` so they can block the action.

### EngineEvent Variants

The event schema defines the type-dispatched event contract as `EngineEventSchema` (the `EngineEvent` alias is `z.infer`d from it). Every `EngineEvent` carries `ts: number`; most carry `phase: Phase`. The phase-less variants are `snapshot_restored`, `snapshot_restore_conflict`, `run_rejected`, `apply_started`, `apply_finished`, and `approval_mode_changed`. The grouped summary below is a navigation aid; use the source contract for the exact, exhaustive event list and field shapes. For key event shapes with full field definitions, see [ENGINE.md](./ENGINE.md).

**Workflow lifecycle (7):**
`workflow_started`, `workflow_resumed`, `workflow_complete`, `workflow_cancelled`, `workflow_config`, `run_failed` — the error that stopped the run, with the `step` it retries and the `message` that `state.lastFailure` records; the run view keeps the message as `failure` until `workflow_resumed` — and `turn_interrupted` — the pause event. It carries `source` (`user` | `watchdog`), `at`, where the stop landed — `mid-step` inside a call, `boundary` where it cut nothing: between two briefs, before a review, or at a gate — `step`, the step the stop parked, as `interruptedStep.step` records it, and `kept`, the files a brief cut mid-step wrote that are still changed, its declared files first, as `interruptedStep.kept` records them (absent when it kept none). Every park publishes it: a stop from the stop sheet (`parkStoppedRun`), a stop inside a planner call, a park in place and a pause between briefs. The transcript uses one warning callout label: `Stopped at T003`, `Stopped at the plan`, or `Stopped before T004` for a boundary stop. A boundary park that only changes a seat carries `cause: 'seat-change'` and shows no `Stopped` row, because the seat change row that follows says what happened. An unknown step reads `Stopped mid-turn`. The callout has no body line. The live and at-rest bylines use the same words, from `stopPoint`. The byline under the composer says what continues it. A cut call that continues in the same process, by a steer, a ctrl+⏎ send or a Resume, publishes no `workflow_resumed`: the run did not stop, so the transcript shows no `Run continued` row and a steered review stays one review. Its next `runner_call_started` is where the run's time counts again (`activeTimeOf`).

`paused_external_changes` no longer replays. Older sessions lose that detail; their state and evidence still open at rest.

**Recovery:**

`recovery/builders/apply.ts` builds the `apply-conflict` and `apply-partial` halts. An `apply-conflict` halt offers `retry-same-worker` and `end-run`. An `apply-partial` halt offers `retry-same-worker` and `restore-backup`. [APPROVAL-AND-RECOVERY.md](./APPROVAL-AND-RECOVERY.md#recovery) owns their policy and behavior.

The state actions are `RECORD_WORKSPACE`, `ACCEPT_AS_IS`, `APPLY_REVIEW_START`, `APPLY_RECHECK_START`, `APPLY_START`, `APPLY_DONE` and `APPLY_RESTORED`. `CLOSE_RUN` also accepts `as: 'discarded'`. `RECORD_REJECT` drops the paths a reject that left files behind put back from the stop's `interruptedStep.kept`. It sets each passed task that booked one of those paths back to `pending`. When the first such task comes before the current one, the run moves back before it and clears its `pendingRecovery`. Their effects are in [WORKFLOW.md](./WORKFLOW.md#apply).

The old file-halt enums and event schemas remain readers for saved sessions. [Retired file halts](./APPROVAL-AND-RECOVERY.md#retired-file-halts) describes continuation.

`recovery_prompted`, `recovery_action_selected`, `recovery_action_failed`, `recovery_resolved`. The selected, failed and resolved events carry an optional `seat` (`plan` | `build` | `review`), the seat the halt stopped. A `recovery_action_selected` event also carries an optional `reviewNone: true` when the pass that follows runs with REVIEW None, so the transcript words the picked action as the panel did. A prompt carries no top-level `seat`. It carries the halt (`issue`) and the step the run resumes at (`at`), which the run view folds (`reduceHalt`); a prompt written before them carries neither. Its optional `headlineSpans` record each span's text and optional seat, formatted from the complete issue at publication. The transcript replays those spans without rebuilding the issue or finding seat words inside formatted text. Older prompts without spans keep their recorded headline in the secondary text tone.

**Planner stream:**
`planner_status`, `planner_text`, `planner_heartbeat`

**Review lifecycle (3):**

`review_started`, `review_step` (the review's current step: `verdict`), `review_completed`. `runFinalReviewPhase` publishes both scopes, `task` and `final`, with one completion per start. A `preReview` halt publishes neither. Both events carry the review seat's `tool`, optional `model`, and nonempty effort `axes`. Task scope also carries `afterTaskId`; final scope omits it. The planner holds the review seat when no reviewer is configured.

`review_completed` carries `duration` in milliseconds and a verdict: `pass`, `pass-with-notes`, `fail`, `no-verdict`, or `stopped`. The first three carry `findings`, with `blocking`, `minor`, and `outOfScope` counts from the derived outcome. When a criterion remains unverified, `findings` also carries `unverifiedCriteria`, the count of criteria no check verified; each one fails the review. The count is positive and optional, and a review with none unverified omits it, so older event logs keep their display. Failed calls use `no-verdict`; stops use `stopped`; both omit findings. Neither review event fires a hook. The review seat publishes no `planner_status`.

**Planning milestones (24):**
`spec_approved`, `spec_rejected`, `spec_regenerated`, `plan_card_opened` (the plan card opened and waits; `plan_approved`, `plan_rejected` and `plan_regenerated` close it), `plan_approved`, `plan_rejected`, `plan_regenerated`, `briefs_approved`, `briefs_rejected`, `rewind_to_spec`, `rewind_to_plan`, `all_tasks_done`, `drift_report`, `drift_chain_detected`, `snapshot_created`, `snapshot_restored`, `snapshot_restore_conflict`, `apply_started` and `apply_finished` (the start and the end of an Apply, whatever its outcome; a window that shows the run counts the Apply clock between them), `run_rejected`, `mode_resolved`, `mode_advice`, `instant_plan_received`, `artifact_written`. `run_rejected` records `/run reject confirm` on a run that wrote the checkout: `restored` (every file it put back or removed), `removed` (the part of `restored` the run had created), `conflicted` (the paths it left as the user changed them), `missing` (the files with no saved copy) and `savedTo` (the folder that holds what it replaced). It is the reject's transcript row (`rejectCheckoutRun`). The plan card publishes `plan_approved` when it is approved, `plan_regenerated` when it sends a correction back to the planner, and `plan_rejected` when End run closes the run there (`runPlanApproval`, `planning/approval.ts`). `artifact_written` announces `plan.md` and `tasks.md` as one card each, with the file's path, line count and an excerpt (`publishArtifactWritten`). Replay only: `spec_*`, `briefs_*`, `rewind_to_*`, `snapshot_restored`, `snapshot_restore_conflict`, `mode_resolved`, `mode_advice`, `instant_plan_received` and `drift_chain_detected` have no producer now and stay so older logs replay. The `brief_quality_*` and `brief_readiness_*` events no longer replay. Older sessions lose that detail.

**Task lifecycle:**
`tasks_planned` (the ordered brief list, published at loop entry and after each structural change: `tasks` with `id`, `title`, `index`, `file`, `action`, and `total`), `task_started`, `task_completed`, `task_skipped`, `task_retry`, `task_escalating`, `task_replaced`, `tasks_inserted`, `task_touched_not_suggested` (the files a completed brief changed that no brief suggested), `task_reset`, `task_tokens`, `task_review_needed` (replay only: the per-task review gate is deleted), `review_fix_started`. Replay only: `task_scope_widened`, `hint_failed`, `task_full_fail`

**Consult / seat:**
`consult_answered` (one row per answer: the task, reason, action, diagnosis and any new ids, revision or check ids; a rewrite or a split with reason `failed` or `blocked` shows its row once its `task_replaced` or `tasks_inserted` follows), `consult_bound_spent` (replay only: no producer now), `seat_retry`, `seat_wait_started` (with `wait`, the saved wait), `seat_wait_ended` (the wait is over: its deadline passed, its seat moved, or the steered call of its seat started; with `kept: true` when a stop or a steer cut it and the saved wait stays), `no_progress_cut`, `seat_answer_refused` (rowless: the planner's or the reviewer's first typed answer broke its contract, with `seat` and the `reasons` the repair call carries), `seat_switched` (published when a seat switch commits, and on resume for a crew change made between runs with cause `crew-changed` and labelled `from`/`to`: `seat`, `from`, `to`, `cause`, `auto`, `configRevision`)

**Implementer (3):**
`implementer_generate_running`, `implementer_generate_done`, `implementer_generate_failed`

**Validation / escalation / git (9):**
`task_validating` (a brief entered its validation, then each of its plan checks starts: `taskId` and, per check, `check` with `id`, `command` and an optional `scenario`; no transcript row, the build block and the byline name the running check), `review_checks` (why no reviewer check runs before a final review: `status` `off` when `validation.end_checks` is false, `none` when the plan names no project gate; a final review that runs the gate publishes none), `full_suite` (one event per check state: its `id`, `command`, `moment` — `pre-review` | `base` | `brief` | `plan`, where `base` is a gate command at the run base, run beside the build, `brief` is a fix brief's check, run once per brief gate with no base re-run, and `plan` is a plan or task check run before the final review or by a brief's own checks during the build — an optional `scenario` on a render check, `taskId` on a plan check a brief's own checks run during the build, and `status` `running` | `done` | `not-run` | `refused` | `stopped`, with pass/fail and duration on done, the `own`, `ownLeft`, `deferred` and `others` counts and the `deferredTo` task ids on a judged brief done event, the `newFailures`, `preExisting` and `notVerified` counts on a red reviewer check done (on a red base done in an older run), with `newKeys` and `preExistingKeys` naming the first three failing tests of each side when the split is verified, `waitsOnBase` on the running event of a red check that waits on the run base: a reviewer check on the base run of its id, a plan or task check on the gate command of the same command text, and a `detail` on not-run and refused or, on a red reviewer check done, the reason a failure is not verified at the run base; an event without `id` is an older session's full-suite `stage`; the engine publishes `stopped` only for a base command that the end of the run loop cut; for every other command it is the transcript's own settle for a command that a stop cut, and a base command outlives a steer, a cut seat call and a continue in the same process), `checks_run` (the per-check results of a brief gate, a consult `verify` included, and of the plan and task checks before the final review, once per task that owns them; it fires `post_validation` with `taskId` and `results`), Replay only: `validate`, `escalate`; historical `git_commit`, `git_checkpoint` and `git_branch_created` events remain readable, and current execution never publishes them

A judged plan or task check in a fix brief also emits a `full_suite` done event. It has no running event or duration. Its `own` count names the carried failures. Its `ownLeft` count names those still present that no unfinished sibling fix task also carries. Its `deferred` count names the present ones such a sibling carries, and `deferredTo` names those siblings. Its `others` count names every unmatched re-run key. A green re-run shows the ownership verdict too. An older session's `proven` flag is ignored.

A diagnostic key includes its path, position and message. Match exact keys first, then pair unmatched diagnostics by message identity, with only the position removed. Pair each key once. Test failures match by name. A red passes when no own failure remains (`judgeFixCheck`). An own failure that an unfinished fix task of the same cycle also carries is left to that task (`fixCheckKeys`). That task carries the failure when it carries the same key from a red of the same command (`finding.commands`), under any check id. A task saved with no command matches by check id only. Failures the task does not own do not gate it. When every own failure of a carried check is a test failure, the gate runs the stack's test runner on the own test files only. Keys come from the full process capture. An incomplete capture gives one placeholder key. The command must pass.

**Clarifications / queue / messages (9):**
`clarifications_collected` and `clarification_answered` (replay only: no producer now), `planner_questions_asked` (the `questions` of a planner round, published before the run waits for the answer; the next `user_message` answers it), `message_queued`, `message_injected_native`, `queue_drained`, `queue_cleared`, `user_message`, `steerable_call`

`user_message` carries `qa` when the question panel answered a round, and the round's `questions` when the user answered it in words: a composer reply after `esc`, a reply from the instruction composer, or a typed correction at rest. `recordAnswers` sets `questions`; the transcript shows one `Answered · <n> questions` block with one `· <question>` line per question and `You → <reply>` once under all of them (`repliedQuestionsRowBlock`); `qa` keeps the numbered pairs (`answeredQuestionsRowBlock`). A log without the field replays the reply as a plain user row.

`message_queued` and `queue_drained` carry optional `seat` and `taskId` fields. `seat` is a `CrewSeatId`: `plan`, `build`, or `review`. BUILD events name the running brief with `taskId`. `commitQueueMessagesDrained` and `drainQueue` include these fields when callers supply them. `drainQueueForReview` publishes `queue_drained` with seat `review` when it drains messages.

`message_queued` also carries optional `steerable: boolean`. The queue sets it to `true` when it captures a matching steerable call. The transcript uses this saved value for delivery timing. It also carries optional `starting: true` when BUILD has not started the brief. The pending row then reads `read when its call starts`.

`queue_drained` also has optional `via: 'mid-call'` for delivery into a running call. `steerable_call` has optional `seat: CrewSeatId` and `taskId: string`. Both fields are absent when no steerable call is attached. The lifecycle store resets this live capability on run start and hydration.

Older logs without these fields still render. `message_injected_native` keeps its existing fields and occurs only in plan phases. `QueuedMessage` adds optional `possibleDuplicate: boolean` and `deliveredMidCall: true`; older saved states still load.

**Attachments (2):**
`planner_attachments_dropped`, `build_images_as_paths` (one event per BUILD correction delivery with images when the seat takes no images: `taskId`, `count`)

**Cost (1):**
`cost_update`

**Workspace (1):**
`workspace_closed` — row-less. `removeClosedRunWorkspace` publishes it when End run, Discard or Apply closes a workspace run, also when the removal fails. Once a run's log holds it, the transcript drops the earlier `workspace_kept` warning.

**Protected-write approval:**
`approval_prompted`, `approval_granted`, `approval_rejected`. Replay only: `approval_mode_changed` (no producer now) and `approval_sticky_recorded` (sticky grants are deleted)

**Runner calls (13):**
`runner_call_started`, `runner_call_runtime_status`, `runner_call_text_delta`, `runner_call_usage`, `runner_call_tool_use`, `runner_call_activity`, `runner_call_session_id`, `runner_call_warning`, `runner_call_error`, `runner_call_completed`, `runner_call_stalled`, `runner_call_stall_cleared`, `runner_call_heartbeat`. Each carries the call's context fields and a `sequence` number. `projectRunnerCallEvents` projects a seat call's stream into them. The summary reads its per-call usage from them.

**Session replay (2):**
`replay_started`, `replay_complete` — published only by `readRunEvents`, which wraps a `session.jsonl` read back into an `EngineEvent[]` for `loadEvents`. See [ENGINE.md](./ENGINE.md#replay).

**Generic (4):**
`info` — a status line: a `message` and the optional `category` / `code` pair below; the planning session publishes `The revised plan passes its checks.` when a plan that went back to the planner passes, and the transcript renders it under the `SPLITBRIEF` label. The send-back itself publishes no event: it writes `plan_send_back` to the debug log.

`debug` — a state that the run handled by itself: a `message` and the optional `category` / `code` pair. The transcript paints no row for it and `--plain` writes no stderr line; the session log and `--json` keep it. `publishDebug` publishes it. Examples with a code: `planner` / `planner_session_expired` (the planner's thread expired, and the planning call runs again on a fresh session with the rebuilt transcript) · `planner_session_refused` (the planner tool refused the resumed thread as too long, and the planning call runs again the same way); with either code the transcript also drops the error activity and the warning activity of the call that runs again (`reissuedPlannerCallDiagnostics`), `recovery` / `stale_file_halt_resolved` (Continue resolved a saved halt on a retired reason). Without a code: a structured compaction that fell back to a freeform summary, a failed auto-compaction, a saved brief index that named a passed brief, the fallback from the isolation worktree to a staged copy, and the cause of a failed native injection.

`warning`, `error` — both carry an optional `category` / `code` pair naming what produced them. Each `publishWarning` / `publishError` call site sets its pair; examples: `recovery` / `retry_exhausted` · `review_failed` · `review_input_too_large` · `recovery_pending_unresolved`, `skills` / `skills_truncated` (a selected skill's `SKILL.md` body did not fit the 16 000-character skills budget and is named by path instead) · `skills_unresolved` (a skill id the run saved no longer resolves, or a selected skill's file cannot be read), `validation` / `validation_format_failed` (the formatting of the brief's changed files failed; the checks ran anyway), `workspace` / `workspace_kept` (a halted run kept its workspace for Continue; a stop that the user asked for writes the notice to the debug log instead). A format pass that rewrote files of the brief publishes no event: it writes `validation_formatted`, with the file names, to the debug log. The `error` of a usage-limit halt also carries `resetAt`, the ISO instant the halt records; its message names no clock, and the transcript row spells the reset when it renders.

### Exhaustive switch in conversation row rendering

The event row dispatch is the canonical scrollable conversation dispatcher and uses `assertNever(event)` in its `default` arm. Row-less event membership lives in `event-rows/visibility.ts`; planner markdown routing in `event-rows/planner-text.ts`; implementer/validate/escalate execution rows in `event-rows/execution.ts`.

`eventRowBlock(event, ...)` returns a lazy row block or `null` for silent events. Role and status are represented by row tones and explicit text, not by persistent left gutters.

Adding a new EngineEvent variant without adding it to this switch is a compile error.

### Headless mode

`splitbrief start --json` skips Ink, replaces `tuiSink` with `createStdoutJsonSink`, and stubs workflow host callbacks non-interactively. Each event reaches stdout as `{ "type": "event", "data": <event> }`, so a consumer selects `.type == "event"` and reads `.data.type`. `--plain` uses `createStdoutTextSink` instead. In both modes the plan card is approved unattended (it confirms none of the plan's protected writes), planner questions stop the run (with an `input_required` record under `--json`), and recovery exits non-zero. A write to a protected path is denied with `APPROVAL_REQUIRED`. `createJsonlSink` still writes the normal structured `session.jsonl` log.

---

## 6. Persistence layout

All per-session state lives under `.splitbrief/sessions/<session-id>/`.

```
.splitbrief/
├── active                          JSON receipt {version: 1, sessionId, generation} (the lock)
├── config.yaml                     Project config (version: 3 — the only accepted version)
├── reviews/<stamp>/                `splitbrief review` output: review.json + review.md, change.diff for a CLI reviewer (no session)
├── probes/<tool>-<date>.jsonl      `splitbrief doctor --probe-seat` records
└── sessions/
    └── <session-id>/
        ├── state.json              Mutable WorkflowState (overwritten every transition)
        ├── session.jsonl           Append-only EngineEvent log
        ├── lockfile.json           Session lockfile (pid + heartbeat)
        ├── tasks.md                Markdown briefs rendered from the plan tasks
        ├── plan.json               The checked plan (PLAN_JSON_FILE)
        ├── plan.md                 The plan card's body, rendered from plan.json
        ├── spec.md / research.md   Older runs only
        ├── review.json             The typed review record (ReviewVerdict, outcome, verification)
        ├── review.md               Final-review markdown, rendered from review.json
        ├── clarifications.md       Older runs only
        ├── constitution-check.json Older runs only
        ├── analyze.json            Older runs only
        ├── evidence.json           Evidence ledger (briefHash-tagged)
        ├── drift-report.json       Final deterministic drift report for the whole run/diff
        ├── drift-chains.json       Older runs only (no drift chains are scored now)
        ├── brief-quality.json      Older runs only (a new run writes none)
        ├── summary.json            Final aggregates (written at the end of each pass, carrying the
        │                            derived run status and phase; a resume drops the old stop)
        ├── seats.json               The crew the run last ran with
        ├── readiness.json          The start readiness report
        ├── review-packet.json/.md  The run's evidence summary, written after the final review
        ├── draft.json              The unsent composer draft
        ├── renders/<check-id>/     Render check output
        └── snapshots/
            ├── .lock               Per-session snapshot lock (~60s stale TTL)
            ├── run-ledger.json     Run snapshot ids + accept/reject decision
            ├── baseline/           Full-tree copy on first snapshot
            │   ├── manifest.json
            │   └── files/<encoded-path>
            └── <snapshot-id>/      ISO-8601 with `:` and `.` → `-`,
                ├── manifest.json   e.g. `2026-04-26T14-30-00-000Z`
                └── files/<encoded-path>   (delta — only changed files)
```

Also relative to project root, **outside** `.splitbrief/`:

- `$XDG_STATE_HOME/splitbrief/trees/<hash>/<slug>/` is the run worktree. See [workspace data flow](./HOW-IT-WORKS.md#run-workspace-and-apply) for its location rules.
- `./.splitbrief/skills/`, `./.claude/skills/`, `./.agents/skills/`, `~/.splitbrief/skills/`, `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.config/opencode/skills/`, `AGENTS.md` — skill sources, read-only to SPLITBRIEF. The order is the discovery precedence order (project before global, first root wins per skill id and per skill name); the list lives in `PROJECT_SKILL_SCAN_PATHS` and `GLOBAL_SKILL_SCAN_PATHS`.

Single source of truth for continuing a run: `state.json` + the session folder it lives in. A version 3 state migrates to version 4 through `mapV3StateToV4`. If `state.json` is missing or has any other `stateVersion`, `resume` refuses; so does a run whose `state.json` records `closed`. Everything else is picked up at `resumeStep`. `session.jsonl` is the fallback context source for backends without native session resume.

**Concurrency.** Different sessions can run in one project directory. Each session has one driver and records its PID and heartbeat in `lockfile.json`. `deriveRunStatus` uses that record for liveness. `.splitbrief/active` holds a default selection as a JSON receipt. SPLITBRIEF also reads older plain-text session IDs.

Path encoding: a snapshot blob name is the SHA-256 hex of the file's relative path (`encodeSnapshotPath` in `engine/snapshots/path-codec.ts`). The encoding is one-way; the manifest's `fileEntries[].path` holds the original path.

---

## 7. Runner abstraction (4 kinds)

The `kind` discriminant is required in every planner / reviewer / implementer config. Factory: `createPlanner(config, options)` / `createReviewer(config, options)` / `createImplementer(config, options)` are async and dispatch on `kind` through memoized dynamic imports. The `reviewer:` block is optional; with none configured the planner holds the review seat, and the string `reviewer: none` means that no seat reviews.

| `kind` | Implementer write mode | Examples |
|---|---|---|
| `cli` | `direct` | claude-code, codex, opencode, copilot (hidden), kilo-code, cursor, command-code, antigravity |
| `api` | `extracted-code` | ollama, lm-studio, llama-cpp (any OpenAI-compatible) |
| `shell` | `extracted-code` | arbitrary subprocess, stdin-prompt → stdout-response, no shell/network sandbox |
| `agent` | `direct` | subprocess that writes files directly, no stdout extraction or shell/network sandbox |

Each backend implements `Planner` / `Implementer` via a `base.ts`-built shared pipeline; only `invoke*` differs per backend. The orchestrator branches on `PlannerCapabilities` (declared per backend), never on backend identity. See [Planner capabilities](./PLANNERS-AND-IMPLEMENTERS.md#planner-capabilities) for the full capability table and fallback strategy.

The two implementer write modes are peers. Both write into the same run workspace and receive the same brief, validation and final review. [HOW-IT-WORKS.md](./HOW-IT-WORKS.md#run-workspace-and-apply) defines the data flow.

---

## 8. Public API surface

The functions other code depends on. All paths absolute under `src/`.

### `core/evidence/brief-hash.ts`

```ts
export function hashTaskBrief(tasks: Task[]): string
```

The hash covers the planned brief only. Each task loses the fields the run writes onto it: `status`, `currentCode`, `currentCodeByFile`, `contextCodeByFile` and `checkResults`. The rest is serialized as canonical JSON and hashed with SHA-256 (hex).

### `core/schemas/snapshot.ts`

```ts
export const SnapshotPhaseSchema: z.ZodEnum<['planning', 'implementing', 'reviewing', 'manual']>
export type SnapshotPhase

export const SnapshotFileEntrySchema: z.ZodObject<{
  path: string; hash: string; encodedName: string; mode?: number;
}>
export type SnapshotFileEntry

export const SnapshotManifestSchema: z.ZodObject<{
  version: 1; id: string; sessionId: string; name?: string;
  createdAt: string; phase: SnapshotPhase; taskIndex?: number;
  fileHashes: Record<string, string>;
  fileEntries: SnapshotFileEntry[];
  symlinks?: { path: string; target: string }[];
  trackedFileCount: number;
}>
export type SnapshotManifest

export const RunSnapshotKindSchema: z.ZodEnum<['pre-task', 'post-task', 'pre-final-review', 'accepted-run']>
export const RunSnapshotLedgerSchema: z.ZodObject<{
  version: 1; sessionId: string; runSnapshotIds: string[];
  runSnapshotKinds?: Record<string, RunSnapshotKind>;
  accepted: boolean; rejected: boolean;
  putBack?: { restored: string[]; removed: string[] };
  createdAt: string; updatedAt: string;
}>
export type RunSnapshotLedger
```

A manifest written before file modes were recorded has no `mode`. `RunSnapshotLedgerSchema` is the shape of `snapshots/run-ledger.json`. `putBack` sums what every `/run reject confirm` of the run put back (`removed` is the part of `restored` the run had created); the closed block of a rejected run reads it.

### `engine/snapshots/` (path-codec, manifest, files, lock, create)

```ts
// path-codec.ts
export function encodeSnapshotPath(rel: string): string  // sha256 hex blob name; one-way (no decode)
export function generateSnapshotId(now?: Date): string
// manifest.ts
export async function writeManifest(projectDir, sessionId, manifest): Promise<void>
export async function readManifest(projectDir, sessionId, snapshotId): Promise<SnapshotManifest>
export async function listSnapshotIds(projectDir, sessionId): Promise<string[]>
export async function hasBaseline(projectDir, sessionId): Promise<boolean>
export async function listSnapshots(projectDir, sessionId): Promise<{ manifests: SnapshotManifest[]; corruptedIds: string[] }>
// files.ts
export async function hashFile(filePath): Promise<string | null>      // sha256 hex; null on read error
export async function collectTrackedFiles(projectDir): Promise<string[]>  // honours .gitignore + ALWAYS_EXCLUDED
// lock.ts
export async function acquireSnapshotLock(projectDir, sessionId): Promise<() => Promise<void>>
// create.ts
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<CreateSnapshotResult>
```

`ALWAYS_EXCLUDED` is `INTERNAL_SKIP_DIRS` from `core/paths.ts` — `['.git', '.splitbrief', 'node_modules', '.trees']` — non-negotiable; see invariants.

### `core/evidence/ledger-state.ts`

```ts
export function createEvidenceLedger(input: CreateEvidenceLedgerInput): EvidenceLedger
//  Each task entry is seeded unstamped (briefHash: null). input.briefHash sets the top-level hash only.
export function findOrSeed(ledger: EvidenceLedger, task: Task): EvidenceTask
//  Stamps the entry it returns with hashTaskBrief([task]), on every call.
export function getOrCreateLedger(
  input: CreateEvidenceLedgerInput,
  existing: EvidenceLedger | null,
): EvidenceLedger
```

### `core/evidence/same-brief.ts`

```ts
export function sameCurrentBrief(entry: EvidenceTask, task: Task): boolean
```

The one rule that joins a ledger entry to a brief of the current plan. The closed run block (`features/workflow/closed/projections.ts`) and the summary's file attribution (`engine/orchestrator/summary/build.ts`) call it.

1. A `pending` brief joins only a `pending` entry.
2. An `in_progress` brief joins an `in_progress` or a `failed` entry. The ledger books a retried attempt `failed`.
3. Then a stamped entry joins when its `briefHash` equals `hashTaskBrief([task])`.
4. An unstamped entry joins when its title and its file equal the brief's title and anchor file (`suggestedFiles[0]`).

### `core/evidence/ledger-storage.ts`

```ts
export function evidenceLedgerPath(ref: SessionRef): string
export function writeEvidenceLedger(ref, ledger): void
export function mutateEvidenceLedger(ref, mutate): EvidenceLedger
export function readEvidenceLedger(ref): EvidenceLedger | null
```

The ledger state module owns ledger construction and state updates. The ledger storage module owns path resolution, locking, and read/write/mutate APIs.

### `engine/orchestrator/evidence/`

```ts
// task.ts

export function recordLocalTaskEvidence(input): EvidenceLedger
export function recordRetryOrEscalationEvidence(input): EvidenceLedger
export function recordSkippedTaskEvidence(input): EvidenceLedger

// approval.ts
export function recordRejectionEvidence(input): EvidenceLedger

// reporting.ts
export function recordFinalReviewEvidence(input): EvidenceLedger
export function buildRejectionContext(ledger): string
export function buildEvidenceSummary(ledger): NonNullable<Summary['evidenceSummary']>

// ledger.ts
export function loadOrCreateLedger(input): EvidenceLedger

// persistence.ts
export async function persistTaskEvidence(input): Promise<void>

// decisions.ts
export function persistRejectionEvidence(input): void
export function persistApprovalEvidence(input): void
```

No `record*` takes a brief hash. Each one routes through `findOrSeed`, which stamps the entry with the hash of its own brief, `hashTaskBrief([task])`.

---

## 9. CLI Commands

[`CLI-REFERENCE.md`](./CLI-REFERENCE.md) is the canonical flag and option reference.

| Command | Subcommands | Purpose |
|---|---|---|
| `splitbrief start` | — | Begin a new workflow. Args: `[feature] [files...]`. Flags: `--planner`, `--implementer`, `--reviewer`, `--json`, `--plain`. `--mode` and `--approve` are removed and fail with a pointer. Writes the `.splitbrief/active` receipt `{ "version": 1, "sessionId", "generation" }`. |
| `splitbrief spec` | — | Runs the planning session and exits; writes `plan.json`, `plan.md` and `tasks.md`. |
| `splitbrief init` | — | Interactive setup; writes `.splitbrief/config.yaml`. |
| `splitbrief status` | — | Print a summary of the active run's state: feature, phase, brief position, start time, session, seats and brief counts. Read-only; doesn't acquire the lock. |
| `splitbrief resume` | — | Open the named or default run. An interactive terminal can observe an owned run or continue it from `resumeStep` once ownership is available. A version 3 `state.json` migrates to version 4 (`mapV3StateToV4`). Refuses a missing `state.json`, any other version, and a closed run. |
| `splitbrief doctor` | — | Run readiness checks for config, tools, models, hooks, and project state. `--probe-seat <seat>` makes one paid call through the plan, build or review seat and appends a record to `.splitbrief/probes/<tool>-<date>.jsonl`. |
| `splitbrief continue [session-id]` | — | Continue a named run from its saved state. `--action <skip\|retry\|restore\|switch-seat:…\|accept-as-is\|end-run>` answers its pending recovery first; `end-run` closes the run and stops there. `--action <apply\|apply-as-is\|discard>` settles a run that is ready to apply. |
| `splitbrief review` | — | One reviewer call over the working-tree diff, or over the diff against `--base <ref>`. It opens no session and runs no planning. Writes `review.json` and `review.md` to `.splitbrief/reviews/<stamp>/`. A CLI reviewer reads the diff from `change.diff` in that folder. |

---

## 10. Runtime commands (full list, 22)

The registry holds 22 commands in five categories. A removed command, such as `/mode`, `/revise-spec`, `/revise-plan` or `/approval`, prints a one-line pointer when typed (`REMOVED_COMMANDS` lists them all). The commands are defined in one module per category and concatenated by `createRuntimeCommands`. The `kind` field is `'noarg'` (no args) or `'arg'` (positional input); every command declares a `category` from `COMMAND_CATEGORIES`, which is the order the command palette groups them in. Commands are callable from composer `/` input and the command palette. Aliases resolve to their canonical command and may pin an argument; no command declares one today.

**Navigate**

| Runtime command | Description |
|---|---|
| `/help` | Show help overlay |
| `/palette` | Open command palette |
| `/skills` | Skills for every seat |
| `/sessions` | Browse past sessions |
| `/settings` | Crew, fallback, validation, workflow |
| `/home` | Return to home screen |
| `/quit` | Exit application |

**Crew**

| Runtime command | Description |
|---|---|
| `/crew [plan\|build\|review]` | Who fills each seat — opens Settings on the Crew section, or straight on that seat's picker |
| `/refresh` | Re-detect available tools |

**Workflow**

| Runtime command | Description |
|---|---|
| `/run <accept\|reject>` | Apply or discard this run, or undo its Apply |
| `/queue [show\|clear]` | Show or clear the message queue |
| `/stop` | Open stop and session options |
| `/resume` | Continue a paused or stopped run |
| `/steer <text>` | Send a correction now; a running call stops first |
| `/end` | Close the run, saving unapplied changes |

**View**

| Runtime command | Description |
|---|---|
| `/scroll <top\|bottom\|page-up\|page-down>` | Scroll the workflow conversation |
| `/activity` | Expand or collapse the last folded rows |
| `/sidebar` | Show or hide the workflow sidebar |
| `/tasks` | Show the brief list |
| `/usage` | Show tokens, estimate and rates |

**Input & output**

| Runtime command | Description |
|---|---|
| `/copy [message\|brief\|path\|command\|cost]` | Copy a reviewed value to the clipboard |
| `/image <path> \| list \| remove <index\|id>` | Attach, list or remove images for the next planner call |

---

## 11. Configuration schema additions

`.splitbrief/config.yaml` is written as `version: 3`, and no other version loads. The full schema is `ConfigSchema`. The optional sections below are recognized:

```yaml
palette:
  customActions:               # command-palette spec: add project-specific palette entries
    - id: my-action            # unique id (string, min 1 char)
      label: My Action         # display label
      description: Optional    # optional description shown in palette
      command: /usage          # runtime command to invoke (must start with '/')
```

All sections are optional; absence means the documented default is used. The `palette.customActions` array is empty by default. Existing config sections (`planner`, `implementer`, the optional `reviewer`, `validation`, `workflow.{approve,git,isolation,...}`, `hooks`, `approval`) are unchanged in shape. The retired `workflow.max_retries`, `escalation` and `codebase` keys still load with one notice each and are ignored.

---

## 12. Test suite shape

Colocated test files (`foo.test.ts` next to `foo.ts`). Engine tests are headless; stores reset in `beforeEach`. Agent-implementer tests spawn real subprocesses (slow, ~30s per test).

Full verification: `npm run test-ci` (format:check, typecheck, lint, test:coverage, e2e, invariants, then skills:check). Targeted verification uses `npm test -- <path>` for unit files and `npm run test:integration -- <path>` for integration files.

---

## 13. Critical invariants — the "do not break" list

Enforced by hooks, type system, exhaustive switches, or pre-merge greps. Breaking any of these silently corrupts state or causes exponential I/O.

1. **NEVER commit, NEVER stage** — `.claude/hooks/block-git-commits.sh` (`PreToolUse` hook, exit code 2) blocks `git add` / `git stage` / `git commit` (and `git -c …` variants) on any line of a multi-line command. The user reviews and commits.
2. **`.git/`, `.splitbrief/`, `node_modules/`, `.trees/` MUST be excluded from snapshots / drift / file collection, at any depth, and a directory the project ignores is never entered.** `INTERNAL_SKIP_DIRS` (`core/paths.ts`), re-exported as `ALWAYS_EXCLUDED` from `engine/snapshots/files.ts` and honoured by `collectTrackedFiles`. Including `.splitbrief/` causes exponential snapshot growth (snapshots-of-snapshots); including `.trees/` pulls any user-created worktree checkout into the project's snapshots and diffs. The run's own isolation worktree needs no exclusion entry at all: it lives outside the project root entirely, under `$XDG_STATE_HOME/splitbrief/trees/<hash>/<slug>/` (default `~/.local/state/splitbrief/trees/...`), where a project-rooted walker never reaches it.
3. **`findOrSeed` stamps each ledger entry with its own brief's hash.** Every `record*` call routes through `findOrSeed` (`core/evidence/ledger-state.ts`), which writes `hashTaskBrief([task])` onto the entry it returns. No caller threads a hash into a `record*` call. A seed records no work, so it carries `briefHash: null`.
4. **`TaskStatus` value is `'done'` NOT `'completed'`.** The enum is `['pending', 'in_progress', 'done', 'failed', 'escalated', 'skipped']` (`core/schemas/enums.ts`). `task_completed` is the *event* name; the *status* string is `'done'`.
5. **Drift runs only in the review phase.** `analyzeBriefDrift` (`engine/orchestrator/drift/analyze.ts`) runs from `engine/orchestrator/review/inputs.ts` each time the review phase runs: before each final review and, with `workflow.review: task`, before each task review; no exit of `runSingleTask` carries drift state, and there is no drift-chain analysis.
6. **Engine MUST NOT import React, Ink, or anything from `src/features/`, `src/components/`, `src/hooks/`.** This is what makes the workflow runnable headlessly under Vitest.
7. **Zero runtime classes.** Production source uses functions and module-scoped state; test fixtures may contain class syntax when that is the behavior under test.
8. **Zero barrels.** No re-export-only `index.ts` anywhere in `src/`; currently there are no `index.ts` or `index.tsx` files in `src/`.
9. **ESM `.js` suffix on every internal import.** `'./foo.js'` not `'./foo'`. Required for Node 22 ESM resolution.
10. **Conversation row exhaustive switch handles EVERY EngineEvent variant.** `eventRowBlock` ends with `default: return assertNever(event)`. Adding a variant without updating it is a TypeScript error.
11. **One driver per session.** Separate sessions can run in the same project. The default session receipt and each session's ownership have separate lifecycles.
12. **Snapshot path encoding.** Blob filenames always go through `encodeSnapshotPath` (a one-way `sha256` hash) — never bare-join slashes. Encoding is not reversible; the original path is recovered from the manifest's `fileEntries[].path`, never decoded.
13. **Sanctioned `as` / `!` only.** Production code may not use unsafe assertions outside the named modules listed in `CLAUDE.md`.
14. **No pinned overlay widths.** Every overlay, picker and panel sizes itself through `overlayRect`; the density table is the only place a width number lives. Enforced by `scripts/check-invariants.ts` gate 46 (`docs/INVARIANTS.md` row 46): `maxWidth=` under `src/app src/features src/components/overlays`, the retired width constants (`getResponsivePanelWidth`, `getClampedTerminalWidth`, `PICKER_WIDTHS`, `SUB_PANEL_MAX_WIDTH`, `MAX_PANEL_WIDTH`, `SETUP_PANEL_WIDTH`, `PALETTE_MAX_WIDTH`) anywhere under `src`, and `isSmall` in the width-choice path list must each stay at 0. Content-density branches that survive (`workflow/components/header.tsx`) are deliberately outside that path list.

---

## Where to start reading code

Quickest path for a fresh agent:

1. The CLI entry — see what commands exist.
2. `registerStartCommand` → `runInteractiveStart` — see the bootstrap flow.
3. `runWorkflow` → `initializeWorkflow` → `runPlanningPhases` — see the top-level loop.
4. `runPlanningSession` and `runPlanApproval` — see the planning session and the plan card.
5. `runTaskLoop` and `runSingleTask` (entry) with internal helpers such as `gateAttemptChanges` and the rollback helpers — see the per-task loop with auto-snapshot and evidence integration.
6. `EngineEventSchema` — see the full event vocabulary.
7. The path constants of `core` — see every path the system writes.

For UI specifically: `App` → the router → `WorkflowScreen` → `ConversationFlow` → `eventRowBlock`.
