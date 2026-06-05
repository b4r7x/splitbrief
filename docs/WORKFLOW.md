# diptych — Workflow

The state machine reference. Every phase, every transition, what triggers each one, what code runs.

Source of truth: `src/core/state/machine.ts` (reducer), `src/core/phases.ts` (phase taxonomy), `src/core/schemas/enums.ts` (Phase / WorkflowMode enums). Orchestrator entry: `src/engine/orchestrator/run/run.ts` → `src/engine/orchestrator/run/phases.ts`.

For terminology (planner, implementer, runner kinds, sessions, queue, awaiting-continue), read `docs/CONCEPTS.md` first.

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
    idle --> implementing : START_QUICK / START_INSTANT

    researching --> specifying : RESEARCH_DONE

    specifying --> reviewing_spec : SPEC_DONE

    reviewing_spec --> planning : APPROVE_SPEC
    reviewing_spec --> idle : REJECT_SPEC
    reviewing_spec --> clarifying : SPEC_CLARIFY_START

    clarifying --> constitution_check : SPEC_CLARIFY_DONE

    constitution_check --> planning : CONSTITUTION_CHECK_PASS
    constitution_check --> idle : CONSTITUTION_CHECK_FAIL

    planning --> reviewing_plan : PLAN_DONE

    reviewing_plan --> reviewing_briefs : BRIEFS_READY
    reviewing_plan --> idle : REJECT_PLAN

    implementing --> reviewing_briefs : BRIEFS_READY
    implementing --> validating_task : TASK_SENT
    implementing --> analyzing : ANALYZE_START
    implementing --> final_review : ALL_DONE

    reviewing_briefs --> implementing : APPROVE_BRIEFS
    reviewing_briefs --> idle : REJECT_BRIEFS

    analyzing --> implementing : ANALYZE_DONE

    validating_task --> implementing : VALIDATION_PASS
    validating_task --> implementing : VALIDATION_FAIL (attempt < max)
    validating_task --> escalating : VALIDATION_FAIL (attempt >= max)

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
| `idle` | `START_QUICK` | `implementing` | Sets `tasks`, resets `currentTaskIndex` and `attempt` to 0 |
| `idle` | `START_INSTANT` | `implementing` | Sets `tasks`, resets `currentTaskIndex` and `attempt` to 0 |
| `researching` | `RESEARCH_DONE` | `specifying` | — |
| `specifying` | `SPEC_DONE` | `reviewing-spec` | — |
| `reviewing-spec` | `APPROVE_SPEC` | `planning` | — |
| `reviewing-spec` | `REJECT_SPEC` | `idle` | Workflow ends |
| `reviewing-spec` | `SPEC_CLARIFY_START` | `clarifying` | Speckit only |
| `clarifying` | `SPEC_CLARIFY_DONE` | `constitution-check` | — |
| `constitution-check` | `CONSTITUTION_CHECK_PASS` | `planning` | — |
| `constitution-check` | `CONSTITUTION_CHECK_FAIL` | `idle` | Clears `awaitingContinue`; carries `reason` |
| `planning` | `PLAN_DONE` | `reviewing-plan` | Attaches `tasks` to state |
| `reviewing-plan` | `BRIEFS_READY` | `reviewing-briefs` | Sets `tasks`, resets `currentTaskIndex` and `attempt` to 0 |
| `reviewing-plan` | `REJECT_PLAN` | `idle` | Workflow ends |
| `implementing` | `BRIEFS_READY` | `reviewing-briefs` | Sets `tasks`, resets `currentTaskIndex` and `attempt` to 0 |
| `reviewing-briefs` | `APPROVE_BRIEFS` | `implementing` | Resets `currentTaskIndex` and `attempt` to 0 |
| `reviewing-briefs` | `REJECT_BRIEFS` | `idle` | Workflow ends before any implementer write |
| `implementing` | `ANALYZE_START` | `analyzing` | Speckit post-planning audit |
| `analyzing` | `ANALYZE_DONE` | `implementing` | — |
| `implementing` | `START_TASK` | `implementing` | Sets task to `in_progress`, resets `attempt` to 0 |
| `implementing` | `TASK_SENT` | `validating-task` | — |
| `validating-task` | `VALIDATION_PASS` | `implementing` | Marks task `done`, advances `currentTaskIndex`, resets `attempt` |
| `validating-task` | `VALIDATION_FAIL` (attempt < maxRetries) | `implementing` | Increments `attempt` |
| `validating-task` | `VALIDATION_FAIL` (attempt >= maxRetries) | `escalating` | — |
| `validating-task` | `ESCALATE` | `escalating` | — |
| `escalating` | `HINT_SUCCESS` | `implementing` | Marks task `done`, advances index |
| `escalating` | `HINT_FAIL` | `escalating` | Falls through to full escalation |
| `escalating` | `FULL_SUCCESS` | `implementing` | Marks task `escalated`, advances index |
| `implementing` / `validating-task` / `escalating` | `SKIP_TASK` | *(same)* | Marks task `skipped`, advances `currentTaskIndex` |
| `implementing` / `validating-task` / `escalating` | `RESET_TASK` | `implementing` | Sets task to `pending`, rewinds `currentTaskIndex` to that task's index, resets `attempt`. Tasks after it keep their status. |
| `implementing` | `ALL_DONE` | `final-review` | — |
| `final-review` | `REVIEW_DONE` | `complete` | — |

`maxRetries` defaults to 3 (configurable via `workflow.maxRetries`).

**Cross-phase actions from `phaseActions` not shown above:** `RESEARCH_DONE` is also allowed from `idle` and `planning`. `START_QUICK` and `START_INSTANT` are allowed from `idle` and `researching`. `SPEC_CLARIFY_START` is allowed from `idle`, `researching`, `reviewing-spec`, and `planning`. `PLAN_DONE` is also allowed from `reviewing-plan`. `BRIEFS_READY` is allowed from `reviewing-plan` and `reviewing-briefs`. `ANALYZE_START` is allowed from `reviewing-plan`. These permit the orchestrator to skip or re-enter phases depending on mode and backend capability without the reducer rejecting the action.

### 1.3 Anytime actions

These fire from any phase. They modify sub-state without changing `phase`.

| Action | Effect |
|--------|--------|
| `CANCEL` | Sets `phase: 'idle'`, clears `awaitingContinue`. Used by explicit cancellation paths, not by the TUI double Ctrl-C exit. |
| `ABORT_TURN` | Sets `awaitingContinue: true`. Reducer accepts it in any phase; the TUI dispatches it only for `isLivePhase()` phases. |
| `CONTINUE_TURN` | Sets `awaitingContinue: false`. User pressed Enter. |
| `SET_PLANNER_SESSION_ID` | Stores backend session handle for resume. |
| `ENQUEUE_USER_MSG` | Appends message to `messageQueue`. |
| `MARK_DELIVERED_NATIVE` | Marks a queued message as delivered to the live native session. |
| `DRAIN_QUEUE` | Timestamps all un-drained messages with `drainedAt`. |
| `CLEAR_QUEUE` | Removes all drained messages from the queue. |
| `SET_PENDING_RECOVERY` | Sets `pendingRecovery` to the provided `RecoveryIssue`. |
| `MARK_RECOVERY_APPLYING` | Records selected recovery action and timestamp on `pendingRecovery`. |
| `PAUSE_PENDING_RECOVERY` | Sets `pendingRecovery.status` to `'paused'`. |
| `CLEAR_PENDING_RECOVERY` | Removes `pendingRecovery`. |
| `RESOLVE_PENDING_RECOVERY` | Removes `pendingRecovery` (same effect as clear; semantic distinction). |
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
| `clarifying` | planner | no | yes | no |
| `constitution-check` | planner | no | yes | no |
| `planning` | planner | yes | no | yes |
| `reviewing-plan` | planner | no | yes | no |
| `reviewing-briefs` | planner | no | yes | no |
| `analyzing` | planner | no | yes | no |
| `implementing` | implementer | yes | yes | yes |
| `validating-task` | implementer | no | yes | no |
| `escalating` | implementer | yes | yes | yes |
| `final-review` | planner | yes | yes | yes |
| `complete` | — | no | no | no |

**Role** — `phaseRole()`: implementer for `implementing`, `validating-task`, `escalating`; planner for everything else (cost accounting adds `final-review` to the implementer bucket via `phaseCostRole()`).

**Cancellable** — single Ctrl-C aborts the active model call. This matches `isLivePhase()` in `src/core/phases.ts`.

**Resumable** — `diptych resume` can pick up here. All review/gate phases plus `analyzing`, `implementing`, `validating-task`, `escalating`, `final-review`. Generative phases (`researching`, `specifying`, `planning`) are not resumable — if the process dies mid-stream, the stream is lost and the feature must restart.

**Live** — streaming output is happening. Phases where the planner or implementer is actively generating: `researching`, `specifying`, `planning`, `implementing`, `escalating`, `final-review`.

**Override:** `awaitingContinue: true` makes any phase resumable regardless of the table above. The user explicitly aborted and is expected to return.

---

## 3. Mode dispatch

Mode selection: `src/engine/orchestrator/planning/run.ts` → `resolveMode()`. Mode determines how many planner calls run and which approval gates activate.

| Mode | Planner calls | Phases visited | Default approval | Artifacts |
|------|:------------:|----------------|:----------------:|-----------|
| `instant` | 1 | idle → implementing | `none` | tasks.md |
| `quick` | 1 | idle → implementing | `none` | tasks.md |
| `standard` | 4 | idle → researching → specifying → reviewing-spec → planning → reviewing-plan → reviewing-briefs → implementing | `spec` | research, spec.md, plan.md, tasks.md |
| `speckit` | 6-7 | idle → researching → specifying → reviewing-spec → clarifying → constitution-check → planning → reviewing-plan → reviewing-briefs → analyzing → implementing | `all` | research, spec.md, clarifications.md, constitution-check.json, plan.md, tasks.md, analyze.json |

`full` is a legacy alias for `speckit` at the CLI/config boundary.

### Approval gates

Controlled by `workflow.approve`: `none` | `spec` | `plan` | `all` | `default`. Each mode has a default; `default` follows that mode default. Override via `--approve <level>` on the CLI.

- `none` — skip spec/plan document gates. instant/quick default. Briefs review still runs in modes that produce reviewable briefs.
- `spec` — gate on supporting spec. standard default.
- `plan` — gate on plan (implies spec gate too).
- `all` — gate on spec and plan. speckit default.

The brief quality gate (`src/engine/spec/brief-quality.ts`) runs for all four modes after the Task Brief is produced and before `implementing`. It writes `brief-quality.json` and publishes `brief_quality_passed` or `brief_quality_failed`. Error-level issues block the transition.

Briefs review is separate from `workflow.approve`: `standard` and `speckit` enter `reviewing-briefs` after the quality gate so the user can review `tasks.md` before implementation.

### Mode advisor

`adviseMode()` in `src/engine/orchestrator/planning/mode-advisor.ts` is a deterministic keyword/pattern classifier. No LLM call. It classifies the feature prompt into a risk tier (`trivial` → instant, `small` → quick, `normal` → standard, `high` → speckit) and produces a `ModeAdviceKind`: `none`, `downgrade`, `upgrade`, or `missing-context`.

Upgrade and downgrade advice fire only when `confidence >= 0.65`. Missing-context fires below that threshold when the prompt is obviously vague.

The advisor never auto-switches the mode. It publishes a `mode_advice` event and the footer displays the suggestion. On downgrade it also publishes `mode_downgrade_advised` for backward compatibility.

---

## 4. Abort / continue / queue

Four user actions during a live phase:

| Action | Trigger | Effect |
|--------|---------|--------|
| Queue message | Type + Enter | Appends to `messageQueue`. Current call continues. Planners with `injectUserTurn()` also receive the message immediately. Drained at next safe-point. |
| Abort turn | Ctrl-C (single) | `AbortController.abort()`. Current call terminates. Partial response preserved in `session.jsonl` with `interrupted: true`. Dispatches `ABORT_TURN` → `awaitingContinue: true`. |
| Exit workflow | Ctrl-C twice within 2s | Exits after state is saved. The TUI unmounts; the saved state may be resumable later with `diptych continue <session-id>`. |
| Continue | Enter (from awaiting-continue) | Dispatches `CONTINUE_TURN` → `awaitingContinue: false`. Next planner call includes queued messages and partial context. |

**Queue scope.** Planner-only. Mid-task interjection at the implementer level is disallowed — small local models lose coherence when their task prompt is perturbed mid-call.

**Abort scope.** Live model-call phases only: `researching`, `specifying`, `planning`, `implementing`, `escalating`, and `final-review`. Validation is resumable from saved state, but it is not a live input phase.

**Queue lifecycle.** `ENQUEUE_USER_MSG` appends. `MARK_DELIVERED_NATIVE` flags a message as delivered to the native session. `DRAIN_QUEUE` timestamps all un-drained messages. `CLEAR_QUEUE` removes drained entries. On the next safe-point the orchestrator reads the queue, folds contents into the next prompt as `[user also says: ...]`, and drains.

**Esc does not abort.** Esc closes overlays and the command palette. Abort is Ctrl-C only — deliberate modifier-press makes accidents less likely.

---

## 5. Rewind

Source: `src/engine/orchestrator/planning/rewind.ts`.

### /revise-spec [comment]

Dispatches `REWIND_TO_SPEC`. Reducer sets `phase: 'specifying'`, clears `tasks`, resets `currentTaskIndex` and `attempt`, clears `awaitingContinue`, sets `rewindPending: { target: 'spec', comment? }`.

On the next planning restart, `handleRewindSpec` detects `rewindPending`:
- If `comment` is non-empty: calls `planner.regenerate()` with `buildRegeneratePrompt('spec', currentSpec, comment)`. Writes regenerated spec.md.
- If `comment` is empty: skips regeneration.
- Either way: dispatches `SPEC_DONE` → `reviewing-spec`. Presents the spec approval gate. On approval: dispatches `APPROVE_SPEC` → `planning`. Regenerates plan and tasks from the new spec. Runs `PLAN_DONE` → `reviewing-plan`, then briefs approval.

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

`diptych resume` reads `.diptych/active` to find the session, loads `state.json`. If either is missing, version-mismatched, or the phase is not resumable, resume refuses with an error.

### Resumable phases

`reviewing-spec`, `clarifying`, `constitution-check`, `reviewing-plan`, `reviewing-briefs`, `analyzing`, `implementing`, `validating-task`, `escalating`, `final-review`. Plus any phase with `awaitingContinue: true`.

### Non-resumable phases

`researching`, `specifying`, `planning` (without `awaitingContinue`). If the process died mid-generation, the stream is lost. The feature must restart.

### Recovery on resume

If state has `pendingRecovery`, resume shows that recovery issue before dispatching any work. Selecting `pause-run` keeps `.diptych/active` intact so the same decision appears on next resume.

### Planner context rebuild

Resume uses the capability matrix:

1. Backend has `supportsSessionResume: true` and `plannerSessionId` is set → reuse the native session (Claude Code: `--session-id`, Agent SDK: `options.resume`).
2. Backend rejects the session (expired, unknown) → emit `session_expired`, notify user, fall through.
3. Rebuild from `session.jsonl`: read transcript messages, use latest compact summary entry plus later messages. Pass as initial context to fresh planner call.
4. If `persistTranscript: false` and step 1 failed → no transcript context is available. `applyRebuiltContext()` publishes a warning and continues with Task Brief transport plus any supporting spec/plan as handoff.

In-flight tasks: tasks marked `in_progress` at save time are re-attempted from `attempt: 0`. They are re-run from the Task Brief with refreshed `currentCode`.

---

## 7. Escalation and recovery

When a task fails validation `maxRetries` times:

1. **Hint escalation** — if planner has `supportsHintEscalation`: short hint to implementer, one retry. Success → task `done`.
2. **Full escalation** — planner writes the code directly. Success → task `escalated`.
3. **Recovery** — if all tiers fail, `pendingRecovery` is set. The phase stays where the stop occurred.

Recovery reasons: `implementation-error`, `validation-failed`, `retry-exhausted`, `context-overflow`, `user-edit-conflict`, `approval-promotion-conflict`, `budget-paused`, `budget-exceeded`, `dependency-blocked`.

Recovery actions:

| Action | Effect |
|--------|--------|
| `retry-same-worker` | Clears recovery, resets task to `pending`, reruns in fresh context |
| `route-bigger-worker` | Clears recovery, reruns task with named larger profile |
| `continue` | Allowed for budget-pause below max or safe unrelated user edits only |
| `skip-current-task` | Records evidence, marks task `skipped`, advances index |
| `pause-run` | Keeps issue pending and session resumable |
| `abort-workflow` | Exits through normal shutdown |
| `planner-split-rebase` | Legacy/manual only; new prompts do not offer it, and old states block with `planner-proposal-required` |

Recovery statuses: `awaiting-user` → `applying` (via `MARK_RECOVERY_APPLYING`) → cleared (via `CLEAR_PENDING_RECOVERY` or `RESOLVE_PENDING_RECOVERY`). Or `awaiting-user` → `paused` (via `PAUSE_PENDING_RECOVERY`) → resumable on next `diptych resume`.

---

## 8. A standard run, step by step

```
 1. diptych start "add email validator"
 2. CLI loads .diptych/config.yaml → configStore
 3. CLI checks .diptych/active → error if present.
    Generate session ID, create .diptych/sessions/<id>/, write .diptych/active.
 4. routerStore → screen: workflow. useWorkflow starts.

 5. runWorkflow() begins. initializeWorkflow emits workflow_started.
    Mode advisor runs — deterministic classifier, publishes mode_advice if applicable.
    Repo map built from codebase config.

 6. phase: idle → START → researching
    Planner streams codebase research. Output → session.jsonl + workflow store → UI.
    Planner session ID captured → SET_PLANNER_SESSION_ID → state.json.

 7. phase: researching → RESEARCH_DONE → specifying
    Planner writes supporting spec.md.

 8. phase: specifying → SPEC_DONE → reviewing-spec
    callbacks.onApprovalNeeded('spec', specPath)
      approve  → APPROVE_SPEC
      comment  → planner.regenerate() → loop back to reviewing-spec
      reject   → REJECT_SPEC → idle. Workflow ends.

 9. phase: reviewing-spec → APPROVE_SPEC → planning
    Planner compiles plan and Task Brief transport. Writes plan.md and tasks.md.

10. phase: planning → PLAN_DONE → reviewing-plan
    In standard mode, plan gate is auto-advanced (approve level is 'spec').

11. phase: reviewing-plan → BRIEFS_READY → reviewing-briefs
    Brief quality gate runs. Writes brief-quality.json.

12. phase: implementing → BRIEFS_READY → reviewing-briefs
    callbacks.onApprovalNeeded('briefs', tasksPath)
    Approval reads tasks.md from disk, reparses, re-runs quality gate.

13. phase: reviewing-briefs → APPROVE_BRIEFS → implementing
    Cost prediction published. Cost gate checked.

14. Per task:
      implementing → START_TASK (task in_progress, attempt 0)
      implementer.implement(taskPrompt) → code written to disk
      implementing → TASK_SENT → validating-task
      typecheck → lint → tests (stops on first failure)
        pass → VALIDATION_PASS → implementing (next task)
        fail → VALIDATION_FAIL → implementing (attempt++, retry)
        fail (attempt >= maxRetries) → VALIDATION_FAIL → escalating
          HINT_SUCCESS / HINT_FAIL / FULL_SUCCESS → implementing

15. implementing (last task) → ALL_DONE → final-review
    Drift report computed. Planner reviews diff against Task Brief and spec.

16. final-review → REVIEW_DONE → complete
    summary.json written. .diptych/active cleared. Session done.
```

During live model-call phases, single Ctrl-C enters `awaitingContinue`; double Ctrl-C exits. Messages typed during live planner phases queue and drain at the next safe-point. `/revise-spec` and `/revise-plan` rewind to the appropriate phase. `/redo-task` replays a single task.

---

## 9. WorkflowState shape

Source: `src/core/schemas/workflow.ts` (Zod), `src/core/state/machine.ts` (`createInitialState`). State version: 3.

```typescript
type WorkflowState = {
  stateVersion: number
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

  // Speckit-only
  clarifications?: Array<{ id: string; question: string; answer: string }>
  constitutionFailureReason?: string
  analysisResult?: AnalyzeResult
}

type QueuedMessage = {
  id: string
  text: string
  queuedAt: string                        // ISO 8601
  phase: Phase
  deliveredViaNative: boolean
  drainedAt?: string
  origin?: 'user-input' | 'clarification'
  question?: string
  questionId?: string
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
