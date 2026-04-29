# diptych — Workflow

The workflow is the heart of diptych: a deterministic state machine that moves a feature from a one-line description to validated code, while staying interactive — the user can observe, steer, and interrupt at any point without losing work.

This document has three parts:

1. **How it works** — the authoritative description of the workflow. Covers the state machine, the interaction model (abort / queue / continue), session persistence, and per-backend behaviour.
2. **Still open** — edge cases and implementation questions that have not yet been resolved. Short by design.
3. **See also** — pointers to adjacent docs.

For terminology (planner, implementer, runner kinds, modes, tasks, queue, awaiting-continue, capability matrix), read `docs/CONCEPTS.md` first.

---

## Part 1 — How it works

### 1.1 The state machine

All phases and transitions live in `src/core/state/machine.ts`. The primary state is the `phase` enum; the secondary state is the `awaitingContinue: boolean` flag, which indicates the phase was aborted mid-call and is holding for the user.

#### Phase transitions

| From phase | Action | To phase | Notes |
|------------|--------|---------|-------|
| `idle` | `START` | `researching` | Normal `start` |
| `idle` | `START_INSTANT` | `implementing` | `--mode instant`; tasks provided directly, no spec/plan/research artifacts |
| `idle` | `START_QUICK` | `implementing` | `--mode quick`; tasks provided directly |
| `researching` | `RESEARCH_DONE` | `specifying` | |
| `specifying` | `SPEC_DONE` | `reviewing-spec` | |
| `reviewing-spec` | `APPROVE_SPEC` | `planning` | |
| `reviewing-spec` | `REJECT_SPEC` | `idle` | Workflow ends |
| `reviewing-spec` *(speckit)* | `SPEC_CLARIFY_START` | `clarifying` | Marker phase; conversational planners gather questions inline during `specifying` |
| `clarifying` *(speckit)* | `SPEC_CLARIFY_DONE` | `constitution-check` | Writes `clarifications.md` |
| `constitution-check` *(speckit)* | `CONSTITUTION_CHECK_PASS` | `planning` | Writes `constitution-check.json`; planning proceeds |
| `constitution-check` *(speckit)* | `CONSTITUTION_CHECK_FAIL` | `idle` | Hard violation; workflow aborts. Reason persisted in `constitution-check.json` and emitted as a `warning` event |
| `planning` | `PLAN_DONE` | `reviewing-plan` | Tasks attached to action |
| `reviewing-plan` | `APPROVE_PLAN` | `reviewing-briefs` | In `standard` mode, the plan gate is auto-dispatched before brief review |
| `reviewing-plan` | `REJECT_PLAN` | `idle` | |
| `implementing` | `BRIEFS_READY` | `reviewing-briefs` | Task Brief transport parsed and quality-gated before implementation |
| `reviewing-briefs` | `APPROVE_BRIEFS` | `implementing` | Approval reads and validates persisted `tasks.md`; parse or quality errors keep the gate open |
| `reviewing-briefs` | `REJECT_BRIEFS` | `idle` | Workflow ends before any implementer write |
| `implementing` *(speckit)* | `ANALYZE_START` | `analyzing` | Speckit-only post-planning audit |
| `analyzing` *(speckit)* | `ANALYZE_DONE` | `implementing` | Writes `analyze.json`; coverage below `workflow.speckit.minCoverage` (default `0.9`) emits a `warning` event but does not block |
| `implementing` | `START_TASK` | `implementing` | Sets task `in_progress`, resets attempt counter |
| `implementing` | `TASK_SENT` | `validating-task` | Implementer response received |
| `validating-task` | `VALIDATION_PASS` | `implementing` (next task) | Task marked `done`, index++ |
| `validating-task` | `VALIDATION_FAIL` (attempt < max) | `implementing` | Retry with attempt++ |
| `validating-task` | `VALIDATION_FAIL` (attempt ≥ max) | `escalating` | |
| `escalating` | `HINT_SUCCESS` | `implementing` (next task) | Task `done` |
| `escalating` | `HINT_FAIL` | `escalating` | Fall through to direct escalation |
| `escalating` | `FULL_SUCCESS` | `implementing` (next task) | Task `escalated` |
| `escalating` | `FULL_FAIL` | `implementing` (next task) | Task `failed` |
| `implementing` (last task done) | `ALL_DONE` | `final-review` | |
| `final-review` | `REVIEW_DONE` | `complete` | |
| *(any)* | `CANCEL` | `idle` | Double Ctrl-C / exit |
| *(any)* | `ABORT_TURN` | *(same phase)* + `awaitingContinue: true` | Single Ctrl-C; partial preserved |
| *(any)* | `CONTINUE_TURN` | *(same phase)* + `awaitingContinue: false` | User typed or pressed Enter on awaiting-continue |
| *(any)* | `SET_PLANNER_SESSION_ID` | *(same)* | Captures backend session handle for resume |
| *(any)* | `ENQUEUE_USER_MSG` | *(same)* | Appends to `messageQueue` |
| *(any)* | `DRAIN_QUEUE` | *(same)* | Clears `messageQueue` after it's folded into next prompt |
| *(any)* | `SET_PENDING_RECOVERY` | *(same)* | Adds a durable recovery overlay; phase remains where the stop occurred |
| *(any)* | `MARK_RECOVERY_APPLYING` | *(same)* | Records the selected recovery action and timestamp |
| *(any)* | `PAUSE_PENDING_RECOVERY` | *(same)* | Keeps the issue pending and resumable with `status: paused` |
| *(any)* | `CLEAR_PENDING_RECOVERY` / `RESOLVE_PENDING_RECOVERY` | *(same)* | Removes the recovery overlay after a safe action succeeds |

`maxRetries` defaults to 3 and is configurable via `workflow.maxRetries`.

#### Slash-command actions

Full reference: `docs/SLASH-COMMANDS.md`.

`/revise-spec [comment]` dispatches `REWIND_TO_SPEC` (sets `phase: 'specifying'`, clears tasks, sets `rewindPending: { target: 'spec', comment? }`). On the next workflow restart, `runPlanningPhase` detects `rewindPending` and takes the rewind fast-path: if `comment` is non-empty it calls `planner.regenerate(buildRegeneratePrompt('spec', currentSpec, comment), 'spec', …)` (identical to the approval-gate regeneration path), then presents the spec approval gate. If `comment` is empty it skips regeneration and goes directly to the spec approval gate. Either way, `rewindPending` is cleared via `CLEAR_REWIND_PENDING` before the gate. Similarly `/revise-plan [comment]` dispatches `REWIND_TO_PLAN` (target `'plan'`): fast-path regenerates only the plan (spec preserved), then re-derives tasks and presents the plan approval gate (in `speckit` mode, or whenever it is explicitly enabled) or proceeds directly. `/redo-task <id>` dispatches `RESET_TASK` (sets task status to `pending`, rewinds `currentTaskIndex`); no `rewindPending` is set — the task loop re-picks it up on its next iteration without replanning.

| Action | `rewindPending` | Planning re-runs? | `planner.regenerate` called? |
|--------|-----------------|-------------------|-----------------------------|
| `REWIND_TO_SPEC` + comment | `{ target: 'spec', comment }` | Yes (fast-path) | Yes — spec artifact |
| `REWIND_TO_SPEC` no comment | `{ target: 'spec' }` | Yes (fast-path, skip regen) | No |
| `REWIND_TO_PLAN` + comment | `{ target: 'plan', comment }` | Yes (fast-path) | Yes — plan artifact |
| `REWIND_TO_PLAN` no comment | `{ target: 'plan' }` | Yes (fast-path, skip regen) | No |
| `RESET_TASK` | not set | No | No |

### 1.2 Mode dispatch

Mode selection happens in `src/engine/orchestrator/planning/run.ts`.

Before dispatching, `adviseMode()` (`src/engine/orchestrator/planning/mode-advisor.ts`) runs a deterministic keyword/pattern classifier (no LLM) and produces a `ModeAdviceKind`: `none`, `downgrade`, `upgrade`, or `missing-context`. Risk tiers are `trivial → instant`, `small → quick`, `normal → standard`, `high → speckit`. Upgrade and downgrade advice fire only when `confidence >= 0.65`; missing-context can fire below that threshold when the prompt is obviously vague. The advisor **never auto-switches the mode** — it only publishes a `mode_advice` event and stores the result for the footer to display. On downgrade it additionally publishes the legacy `mode_downgrade_advised` event for backward compatibility.

- `instant` — one planner call. Produces a Task Brief plus `tasks.md` transport for a trivial change, with no supporting spec/plan artifacts and no approval gates. `START_INSTANT` transitions straight into the task loop.
- `quick` — one planner call (`planner.quickPlan(...)`) that produces the Task Brief transport only. No supporting spec / plan files, no approval gates. `START_QUICK` transitions straight into the task loop.
- `standard` — four planner calls: research → supporting spec → plan → Task Brief transport. One approval gate on the supporting spec by default (`approve: spec`); the plan gate (`reviewing-plan`) is entered but auto-advanced. Standard then enters `reviewing-briefs` before implementation.
- `speckit` — seven planner calls: research → supporting spec → clarify → constitution-check → plan → analyze → Task Brief transport. Both document gates are active by default (`approve: all`), followed by `reviewing-briefs`. Fast-fails on constitution-check violations.

All four modes run the **brief quality gate** (`src/engine/spec/brief-quality.ts`) after the Task Brief is produced and before the workflow enters `implementing`. The gate writes `brief-quality.json` to the session directory (mode 0o600) and publishes a `brief_quality_passed` or `brief_quality_failed` event. If any task has an error-level issue the gate blocks the transition to `implementing`. In standard and speckit, the `reviewing-briefs` gate approves the persisted `.diptych/sessions/<id>/tasks.md` file, not stale in-memory tasks; missing `tasks.md` is rewritten once from current tasks and reparsed, while parse, empty-list, or quality errors keep the review gate open. See `docs/TASK-CONTRACT.md §Brief quality gate` for the full rule set.

`full` is a legacy alias for `speckit` at the CLI/config boundary.

Approval gates are governed by `workflow.approve` (`none` | `spec` | `plan` | `all` | `default`). Each mode has a default (instant/quick → `none`, standard → `spec`, speckit → `all`); `default` follows that mode default. Override via `--approve <level>` on the CLI or `workflow.approve` in config. The legacy `--auto` flag is now a synonym for `--approve none`. Resolution flows through the single `resolveApproveLevel()` helper in `src/core/config/runtime/resolve.ts` (per spec invariant §2: gate decisions never read `config.workflow.autoApprove*` directly).

The `/mode` slash command and `--mode` CLI flag both write into `config.workflow.mode`.

### 1.3 A normal `standard` run, step by step

```
1.  diptych start "add email validator"
2.  CLI loads .diptych/config.yml → configStore
3.  CLI checks .diptych/active → if present, error. Otherwise generate session-id
    (2026-04-14-add-email-validator, plus -N suffix on collision), create
    .diptych/sessions/<id>/, write .diptych/active
4.  routerStore → screen: workflow, feature, sessionDir
5.  <App/> mounts <WorkflowScreen/> which triggers useWorkflow
6.  runWorkflow() begins:
      initializeWorkflow
        └─ emit workflow_started → session.jsonl
      phase: researching  → planner.plan() begins streaming
        └─ planner may emit <!-- Q:{...} --> markers → clarifications
        └─ research output → session.jsonl (kind: message) + workflow store → UI
        └─ planner_session_id captured → SET_PLANNER_SESSION_ID → state.json
      phase: specifying   → planner writes supporting spec.md
      phase: reviewing-spec
        └─ callbacks.onApprovalNeeded('spec', specPath)
        └─ UI captures input: approve | comment | reject
           ├─ approve   → APPROVE_SPEC
           ├─ comment   → planner.regenerate('spec', prompt, …) loop back
           └─ reject    → REJECT_SPEC, workflow ends
      phase: planning     → planner compiles the Task Brief and writes tasks.md transport
      phase: reviewing-plan (speckit mode only blocks by default)
      phase: reviewing-briefs
        └─ callbacks.onApprovalNeeded('briefs', tasksPath)
        └─ approve reads tasks.md, parses it, and re-runs the quality gate
      phase: implementing (per task):
        └─ START_TASK
        └─ implementer.implement(taskPrompt) → code
        └─ apply code to disk
        └─ phase: validating-task
              ├─ tsc → lint → tests (stop on first fail)
              ├─ pass → VALIDATION_PASS → checkpoint/evidence → next task
              └─ fail → retry up to maxRetries
      phase: escalating (only on repeated failure):
        └─ hint escalation (if capability)
        └─ direct escalation
      phase: final-review  → planner reviews the entire diff against the Task Brief and any supporting spec
      phase: complete      → summary.json written, .diptych/active cleared
```

### 1.3.1 An `instant` run, step by step

`diptych start --mode instant "rename foo to bar"` follows the same bootstrap as a normal run up to `runWorkflow()`, then takes the `runInstantPlanning` path:

1. Single `planner.instantPlan()` call (or falls back to `planner.quickPlan` / `planner.plan` if the backend doesn't implement it).
2. Parse `tasks.md` from the response.
3. Dispatch `START_INSTANT` with the tasks → phase becomes `implementing`.
4. Task loop runs identically to other modes (per-task validation, retry, escalation, checkpoint/evidence recording, and optional product-level git behavior per `workflow.git.commitStrategy`).
5. Final review still runs (no spec to compare against, but the existing review path is shared).

Persisted artifacts: `tasks.md` transport, `session.jsonl`, `summary.json`. No supporting `spec.md`, `plan.md`, or `research.md`.

### 1.3.2 A `speckit` run, step by step

`diptych start --mode speckit "feature"` runs `runSpeckitPlanning`, which wraps the standard planning pipeline with three speckit-only phases (`clarifying`, `constitution-check`, `analyzing`):

1. **`clarifying`** (marker phase). Writes `clarifications.md` to the session folder. The actual question/answer round is collected inline by the conversational planner during `specifying`; this phase exists to make the speckit chain observable in the state machine and to host a placeholder artifact pointing back at the supporting spec.
2. **`constitution-check`**. Reads `.specify/memory/constitution.md` if present. If absent, the check passes silently. If present, calls `planner.review()` with the constitution prompt and parses strict-JSON `{ passed, violations: [{ principle, reason, severity }] }` output. Result is persisted to `constitution-check.json`. A `severity: 'hard'` violation (or `passed: false`) dispatches `CONSTITUTION_CHECK_FAIL`, emits a `warning` event with the reason, and returns the workflow to `idle`. Otherwise dispatches `CONSTITUTION_CHECK_PASS` and proceeds.
3. **Standard pipeline.** `runFullPlanning(opts)` runs research → supporting spec → plan → Task Brief transport. Approval gates are gated by `resolveApproveLevel({ mode, configApprove, cliOverride })` — `blocksSpecGate(level)` and `blocksPlanGate(level)` decide whether each gate runs. For `speckit` the default is `all` (both gates active).
4. **`analyzing`**. Reads the supporting `spec.md`, `plan.md`, and `tasks.md` transport from the session folder, calls `planner.review()` with the analyze prompt, and persists strict-JSON `{ specTaskCoverage, planTaskCoverage, orphanTasks, unaddressedSpecSections, warnings }` to `analyze.json`. If either coverage value falls below `workflow.speckit.minCoverage` (default `0.9`), emits an advisory `warning` event but does not block. Dispatches `ANALYZE_DONE` to enter `implementing`.
5. **Task loop and final review** run identically to other modes.

Persisted artifacts: `research.md`, supporting `spec.md`, `clarifications.md`, `constitution-check.json`, supporting `plan.md`, `tasks.md` transport, `analyze.json`, `session.jsonl`, `state.json`, `summary.json`.

### 1.4 Persistence timing

| Event | Writes | File |
|-------|--------|------|
| `diptych start` succeeds | Create session folder, write session-id | `.diptych/active` |
| Every phase transition | `saveState()` | `sessions/<id>/state.json` |
| Every emitted event | Append line (kind: `event`) | `sessions/<id>/session.jsonl` |
| Every planner/user text chunk (if `persistTranscript`) | Append line (kind: `message`) | `sessions/<id>/session.jsonl` |
| End of a planning phase | Write artifact | `sessions/<id>/{spec,plan,tasks}.md` |
| End of `clarifying` phase *(speckit)* | Write marker file | `sessions/<id>/clarifications.md` |
| End of `constitution-check` phase *(speckit)* | Write check result | `sessions/<id>/constitution-check.json` |
| End of `analyzing` phase *(speckit)* | Write coverage metrics | `sessions/<id>/analyze.json` |
| Successful task | Task status, evidence, optional checkpoint/commit metadata | `state.json`, `evidence.json`, optional git history |
| Recoverable stop | `pendingRecovery` issue, `recovery_prompted` event | `state.json` + `session.jsonl` |
| Recovery action | Selected action, action failure or resolution event | `state.json` + `session.jsonl`; skip also writes `evidence.json` |
| Single Ctrl-C during cancellable phase | Save state with `awaitingContinue: true`, append `kind: event, type: turn_aborted` | `state.json` + `session.jsonl` |
| Double Ctrl-C | Save state, clear `.diptych/active` | `state.json` + `.diptych/active` |
| End of run (any outcome) | `summary.json`, clear `.diptych/active` | `sessions/<id>/summary.json` |

### 1.5 Resume behaviour

`diptych resume` reads `.diptych/active` to find the target session folder, then loads `state.json`. If either is missing, version-mismatched, or `state.phase` is not in `RESUMABLE_PHASES`, resume refuses with a clear error.

If the saved state has `pendingRecovery`, resume shows that recovery issue before checking planner availability or dispatching any new worker. Selecting pause keeps `.diptych/active` intact so the same decision appears on the next resume.

**Resumable phases:** `reviewing-spec`, `reviewing-plan`, `reviewing-briefs`, `implementing`, `validating-task`, `escalating`, `final-review`. Plus any phase with `awaitingContinue: true` — these are always resumable regardless of phase because the user explicitly aborted and is expected to return.

**Non-resumable phases:** `researching`, `specifying`, `planning` *without* `awaitingContinue`. If a cold crash wiped the process mid-generation, the stream is lost and the only safe behaviour is to restart the feature.

**Planner conversational context on resume** uses the capability matrix:

1. If the backend has `supportsSessionResume: true` **and** `state.plannerSessionId` is set, attempt to reuse the native session. For Claude Code this means `claude --session-id <id>`. For Codex this means `codex exec resume --json <id> <prompt>` (`thread_id` captured from the `thread.started` JSONL event). For Agent SDK this means the `options.resume` argument to `query()`.
2. If the backend rejects the session id (expired, unknown, 4xx), emit `session_expired` to `session.jsonl`, notify the user with a short toast ("Previous planner conversation expired — rebuilding context from transcript"), and proceed to step 3.
3. **Rebuild context from `session.jsonl`**: read all `kind: "message"` lines, assemble a messages array of alternating user / assistant turns, and pass that as the initial context to the fresh planner call. For stateless `api` backends this is the *native* way to resume. For `cli` backends without `supportsSessionResume`, we prepend the rebuilt transcript as a `<!-- prior conversation -->` block in the prompt.
4. If `persistTranscript: false` and step 1 failed, there is no transcript to rebuild from. Emit `transcript_unavailable`, ask the user to confirm, and continue with the Task Brief transport plus any supporting `spec.md` / `plan.md` as the only handoff.

In-flight task state: tasks marked `in_progress` at save time are re-attempted from `attempt: 0`. Partial implementer output (if any was captured before abort) is in `session.jsonl` and is used as a hint in the retry prompt.

### 1.6 The interaction model — abort, queue, continue

Four user actions during a live phase, each with a distinct effect:

| Action | Key binding | Effect |
|--------|-------------|--------|
| **Queue message** | Type text + Enter | Append to `workflowStore.messageQueue`. Current call continues uninterrupted. For backends with `supportsMidStreamInjection`, the message is *also* dispatched in parallel as a native user turn into the live session. Drained at safe-point regardless. |
| **Abort turn** | Ctrl-C (single) | `AbortController.abort()` fires. Current planner/implementer call terminates. Partial response preserved in `session.jsonl` with `interrupted: true`. Workflow enters `awaitingContinue: true` in the same phase. TUI switches input mode; user can type. |
| **Exit workflow** | Ctrl-C twice within 2s | Save state, clear `.diptych/active`, exit process. Resume later with `diptych resume`. |
| **Continue** (from awaiting-continue) | Enter on empty input *or* Enter after typing | Exit awaiting-continue. Next planner call includes: (a) queued messages if any, (b) for Claude Code native session: next-turn `continue`, (c) for stateless backends: messages array `[originalPrompt, assistantPartial, (queuedMessages ∥ "continue")]`. |

**Esc has no role in the interaction model.** It closes overlays, pickers, and the command palette. It does *not* abort generation. This is a deliberate departure from Claude Code/OpenCode, driven by widely-reported accidental-press problems in those tools (Claude Code issues #6643, #3074; OpenCode #2324). The abort path is Ctrl-C, where deliberate modifier-press makes accidents far less likely.

**Queue scope.** The queue is planner-only. Mid-task interjection at the implementer level is explicitly disallowed — small local models (7B-27B) lose coherence when their self-contained task prompt is perturbed mid-call, and we have no good mechanism for them to distinguish "clarification" from "new task" safely. If the user needs to change direction during implementation, they abort the current task and use `/redo-task <id>` after updating the spec via `/revise-spec`.

**Abort scope.** All cancellable phases can be aborted, *including* `validating-task`. Aborting validation sends SIGTERM to the active child process (`tsc` / linter / test runner). This is safe because validation never mutates files that diptych owns — it only reads and reports.

**Partial response lifecycle.** When a call is aborted, whatever was streamed up to that point is written to `session.jsonl` as a normal `kind: "message"` line with `interrupted: true` appended. On continue, the resumption prompt is aware of the partial so the planner can pick up rather than starting over.

### 1.7 Mid-phase user interjection — complete flow

1. User types during live phase. UI appends to `workflowStore.messageQueue` and emits `message_queued` event.
2. On backends with `supportsMidStreamInjection` (Claude Code, agent-sdk), the message is also dispatched in parallel via a second call to the live session: `claude --session-id <id> "<queued>"`. Claude picks this up on its next model turn without waiting for our orchestrator.
3. Independently, on the next safe-point (end of current planner call), the orchestrator reads `messageQueue`, folds its contents into the next prompt as a dedicated `[user also says: ...]` block, dispatches `DRAIN_QUEUE`, and proceeds.
4. Entries drained from the queue are logged to `session.jsonl` as `kind: "message", role: "user"` with `queuedAt` and `drainedAt` timestamps for audit.

**Clarification answers go through the same queue.** When the planner asks a question via `<!-- Q:{...} -->` and the user answers, the answer is (a) stored in the `## Clarifications` section of `spec.md` when a supporting spec exists, and (b) pushed through the same queue so it reaches the planner's live session immediately on capable backends. This closes the pre-existing gap where clarification answers only affected the *next* planner call. Clarification answers are also routed through the queue (see Queue & Interjection in CONCEPTS.md); on Claude Code, the answer arrives mid-stream; on stateless backends, at the next phase boundary.

### 1.8 Escalation and recovery stops

1. Task fails validation `maxRetries` times.
2. If the planner has `supportsHintEscalation`: call `planner.escalateHint(...)` → short hint → implementer retries once with hint → success or fall through.
3. Otherwise or after hint failure: `planner.escalateFull(...)` → planner writes the code directly. A passing full escalation marks the task `escalated`.
4. If retry/escalation cannot produce a passing task, the task loop persists `pendingRecovery` instead of marking the task failed and silently advancing.

Recovery is a persisted overlay on the current workflow phase. It is created when diptych cannot safely proceed: no implementer profile fits the task context, retries/escalation are exhausted or throw, a user edit blocks apply/promotion/rollback, a dependency was failed or skipped, or a budget pause/exceeded boundary is reached.

Implemented recovery actions:

- `retry-same-worker` clears recovery, resets only the current task to `pending`, resets attempts, and reruns it in a fresh worker context.
- `continue` is allowed only for budget pause below max budget or safe unrelated user edits. It is never allowed for `budget-exceeded`.
- `skip-current-task` records skip evidence, marks the task `skipped`, advances the index, and lets dependency checks stop later tasks safely.
- `pause-run` keeps the issue pending and the active session resumable.
- `abort-workflow` exits through the normal intentional shutdown path without staging or committing.

Deferred recovery actions:

- `route-bigger-worker` is typed and can be offered when the issue names a larger profile, but execution is currently blocked with `route-bigger-not-ready`; the original `pendingRecovery` remains intact.
- `planner-split-rebase` is typed and shown as requiring approve/edit/reject of a proposal, but proposal generation/execution is currently blocked with `planner-proposal-required`; the original `pendingRecovery` remains intact.

Headless/JSON runs do not block for input. If the run leaves `pendingRecovery`, the CLI emits one machine-readable `recovery_required` JSON line with available actions and exits non-zero.

### 1.9 Evidence ledger

Every run produces a per-session evidence ledger at
`.diptych/sessions/<id>/evidence.json` (constant `EVIDENCE_FILE`, mode `0o600`).
The orchestrator appends to the ledger when each task reaches a terminal state
(`done`, `escalated`, `failed`, or `skipped` via `pre_task` hook denial), and
once more after the final review writes (or fails to write). The ledger captures
expected evidence (from `task.evidence` ++ `task.tests`) alongside observed
evidence strings produced by the orchestrator (`tsc passed`, `lint passed`,
`test passed`, `diff written for <file>`, `task reached done`,
`task reached escalated`, `final review written`, `skipped: <reason>`).

`Summary.evidenceSummary` carries a compact rollup (path, totals, escalated
count, failed count) so the summary screen can render counts without re-reading
the ledger; per-task detail is read from disk by UI that needs it. Full schema
and observed-evidence vocabulary live in `docs/TASK-CONTRACT.md`.

### 1.10 Deterministic drift report

Before the final planner review runs, the orchestrator computes a deterministic
drift report at `.diptych/sessions/<id>/drift-report.json`. It compares the Task
Brief against the actual git diff and the evidence ledger and emits findings for
out-of-scope file edits, missing target files, orphan diffs, out-of-bounds
matches, missing observed evidence, and failed tasks that nevertheless left
changes. The same report is rendered into the final-review prompt under
`## Deterministic Drift Report` so the planner reviewer sees the deterministic
signal alongside the diff. Out-of-bounds matching is literal substring matching
against changed file paths and the raw diff text, not regex or semantic
matching. A `drift_report` event publishes the result
(`passed`, `score`, `errorCount`, `warningCount`) for the workflow log. Detection
rules and severity weights live in `docs/TASK-CONTRACT.md`.

### 1.11 Cost/risk posture in the workflow TUI

The workflow screen surfaces the cost-aware compiler model through two complementary lines:

**Top status line** (`CostStatusLine`): `mode · spent · proj · budget · plan% · cache%` — high-level session-wide spend and projection, updated on every `cost_update` event.

**Footer** (`InputFooter`): `Task N/M · mode <mode> · risk <level> · $X.XX expected` — per-task progress, current risk tier (from the advisor classifier), and the pre-flight cost prediction. When the implementer is unpriced (local/subscription), `local` replaces the dollar amount — no fake savings are shown.

Advisor signal: `formatAdvisoryText()` renders below the main footer line when the advisor recommends a mode change (e.g. `advisor: consider quick · trivial edit` or `advisor: no done criteria · standard may drift`). The advisor never auto-switches the mode.

**Summary screen**: After the run, the summary header reads:
`Planner compiled N Task Briefs · Implementer completed M locally · K escalated`

The summary also shows:
- `Brief quality` row: `quality <score>` (errors/warnings count) or `quality n/a` for old sessions
- `Drift` row: drift score and warning/error counts (only present when `drift-report.json` was written)
- `Evidence` section: `N/M validated` from the evidence ledger

`Summary.briefQuality`, `Summary.driftSummary`, and `Summary.costPrediction` carry these rollups so the screen renders without re-reading artifact files (backward-compatible — all optional).

## Auto-snapshots

Users can enable automatic snapshots at key orchestrator boundaries via the `snapshots.auto` config keys:

- `snapshots.auto.preTask: true` — snapshot before each task starts
- `snapshots.auto.postTask: true` — snapshot after each task completes successfully (failed tasks do not trigger this)
- `snapshots.auto.preFinalReview: true` — snapshot before the final planner review runs

All auto-triggers are off by default. Manual snapshots are always available via `diptych snapshot create` regardless of config. Auto-snapshot failures emit a `warning` event and do not abort the run. Full config reference: [CONFIGURATION.md §snapshots](./CONFIGURATION.md#10-snapshots).

## Parallel Worktrees

Run multiple diptych sessions simultaneously using git worktrees:

```bash
diptych start --worktree feature-a "add user auth"
diptych start --worktree feature-b "refactor billing"
diptych worktree list
```

Each worktree is fully isolated at the filesystem and diptych-state level. Runtime isolation (ports, environment) is the user's responsibility. See [docs/WORKTREES.md](./WORKTREES.md) for the complete guide including the isolation gap and mitigations.

---

## Part 2 — Still open

No open questions remain after specs 001–009. See `docs/FUTURE.md` for deferred work.

---

## Part 3 — See also

- `docs/CONCEPTS.md` — terminology (sessions, queue, awaiting-continue, capability matrix)
- `docs/ARCHITECTURE.md` — code layers, persistence tables, capability matrix per backend
- `docs/FUTURE.md` — deferred scope: message-level rewind, Cursor-style snapshot undo, transcript compaction, parallel sessions
- `docs/STORES.md` — state management details (external stores, zero React Context)
- `docs/VISION.md` — project identity, anti-goals, strategic direction
