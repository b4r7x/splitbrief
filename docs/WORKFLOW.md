# diptych — Workflow

The workflow is the heart of diptych: a deterministic state machine that moves a feature from a one-line description to committed, validated code, while staying interactive — the user can observe, steer, and interrupt at any point without losing work.

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
| `idle` | `START_QUICK` | `implementing` | `--mode quick`; tasks provided directly |
| `researching` | `RESEARCH_DONE` | `specifying` | |
| `specifying` | `SPEC_DONE` | `reviewing-spec` | |
| `reviewing-spec` | `APPROVE_SPEC` | `planning` | |
| `reviewing-spec` | `REJECT_SPEC` | `idle` | Workflow ends |
| `planning` | `PLAN_DONE` | `reviewing-plan` | Tasks attached to action |
| `reviewing-plan` | `APPROVE_PLAN` | `implementing` | In `standard` mode, auto-dispatched |
| `reviewing-plan` | `REJECT_PLAN` | `idle` | |
| `implementing` | `START_TASK` | `implementing` | Sets task `in_progress`, resets attempt counter |
| `implementing` | `TASK_SENT` | `validating-task` | Implementer response received |
| `validating-task` | `VALIDATION_PASS` | `implementing` (next task) | Task marked `done`, index++ |
| `validating-task` | `VALIDATION_FAIL` (attempt < max) | `implementing` | Retry with attempt++ |
| `validating-task` | `VALIDATION_FAIL` (attempt ≥ max) | `escalating` | |
| `escalating` | `HINT_SUCCESS` | `implementing` (next task) | Task `done` |
| `escalating` | `HINT_FAIL` | `escalating` | Fall through to full |
| `escalating` | `FULL_SUCCESS` | `implementing` (next task) | Task `escalated` |
| `escalating` | `FULL_FAIL` | `implementing` (next task) | Task `failed` |
| `implementing` (last task done) | `ALL_DONE` | `final-review` | |
| `final-review` | `REVIEW_DONE` | `complete` | |
| *(any)* | `CANCEL` | `idle` | Double Ctrl-C / full exit |
| *(any)* | `ABORT_TURN` | *(same phase)* + `awaitingContinue: true` | Single Ctrl-C; partial preserved |
| *(any)* | `CONTINUE_TURN` | *(same phase)* + `awaitingContinue: false` | User typed or pressed Enter on awaiting-continue |
| *(any)* | `SET_PLANNER_SESSION_ID` | *(same)* | Captures backend session handle for resume |
| *(any)* | `ENQUEUE_USER_MSG` | *(same)* | Appends to `messageQueue` |
| *(any)* | `DRAIN_QUEUE` | *(same)* | Clears `messageQueue` after it's folded into next prompt |

`maxRetries` defaults to 3 and is configurable via `workflow.maxRetries`.

#### Slash-command actions

`/revise-spec [comment]` dispatches `REWIND_TO_SPEC` (sets `phase: 'specifying'`, clears tasks, sets `rewindPending: { target: 'spec', comment? }`). On the next workflow restart, `runPlanningPhase` detects `rewindPending` and takes the rewind fast-path: if `comment` is non-empty it calls `planner.regenerate(buildRegeneratePrompt('spec', currentSpec, comment), 'spec', …)` (identical to the approval-gate regeneration path), then presents the spec approval gate. If `comment` is empty it skips regeneration and goes directly to the spec approval gate. Either way, `rewindPending` is cleared via `CLEAR_REWIND_PENDING` before the gate. Similarly `/revise-plan [comment]` dispatches `REWIND_TO_PLAN` (target `'plan'`): fast-path regenerates only the plan (spec preserved), then re-derives tasks and presents the plan approval gate (in `full` mode) or proceeds directly. `/redo-task <id>` dispatches `RESET_TASK` (sets task status to `pending`, rewinds `currentTaskIndex`); no `rewindPending` is set — the task loop re-picks it up on its next iteration without replanning.

| Action | `rewindPending` | Planning re-runs? | `planner.regenerate` called? |
|--------|-----------------|-------------------|-----------------------------|
| `REWIND_TO_SPEC` + comment | `{ target: 'spec', comment }` | Yes (fast-path) | Yes — spec artifact |
| `REWIND_TO_SPEC` no comment | `{ target: 'spec' }` | Yes (fast-path, skip regen) | No |
| `REWIND_TO_PLAN` + comment | `{ target: 'plan', comment }` | Yes (fast-path) | Yes — plan artifact |
| `REWIND_TO_PLAN` no comment | `{ target: 'plan' }` | Yes (fast-path, skip regen) | No |
| `RESET_TASK` | not set | No | No |

### 1.2 Mode dispatch

Mode selection happens in `src/engine/orchestrator/planning.ts`:

- `quick` — one planner call (`planner.quickPlan(...)`) that emits `tasks.md` only. No spec / plan files, no approval gates. `START_QUICK` transitions straight into the task loop.
- `standard` — four planner calls (research, spec, plan, tasks). One approval gate on the spec. The plan gate (`reviewing-plan`) is entered but auto-advanced.
- `full` — same four calls, both gates active.

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
      phase: specifying   → planner writes spec.md
      phase: reviewing-spec
        └─ callbacks.onApprovalNeeded('spec', specPath)
        └─ UI captures input: approve | comment | reject
           ├─ approve   → APPROVE_SPEC
           ├─ comment   → planner.regenerate('spec', prompt, …) loop back
           └─ reject    → REJECT_SPEC, workflow ends
      phase: planning     → planner writes plan.md + tasks.md
      phase: reviewing-plan (full mode only blocks)
      phase: implementing (per task):
        └─ START_TASK
        └─ implementer.implement(taskPrompt) → code
        └─ apply code to disk
        └─ phase: validating-task
              ├─ tsc → lint → tests (stop on first fail)
              ├─ pass → VALIDATION_PASS → git commit → next task
              └─ fail → retry up to maxRetries
      phase: escalating (only on repeated failure):
        └─ hint escalation (if capability)
        └─ full escalation
      phase: final-review  → planner reviews full diff against spec
      phase: complete      → summary.json written, .diptych/active cleared
```

### 1.4 Persistence timing

| Event | Writes | File |
|-------|--------|------|
| `diptych start` succeeds | Create session folder, write session-id | `.diptych/active` |
| Every phase transition | `saveState()` | `sessions/<id>/state.json` |
| Every emitted event | Append line (kind: `event`) | `sessions/<id>/session.jsonl` |
| Every planner/user text chunk (if `persistTranscript`) | Append line (kind: `message`) | `sessions/<id>/session.jsonl` |
| End of a planning phase | Write artifact | `sessions/<id>/{spec,plan,tasks}.md` |
| Successful task (per-task commits on) | `git commit` | Git history |
| Single Ctrl-C during cancellable phase | Save state with `awaitingContinue: true`, append `kind: event, type: turn_aborted` | `state.json` + `session.jsonl` |
| Double Ctrl-C | Save state, clear `.diptych/active` | `state.json` + `.diptych/active` |
| End of run (any outcome) | `summary.json`, clear `.diptych/active` | `sessions/<id>/summary.json` |

### 1.5 Resume behaviour

`diptych resume` reads `.diptych/active` to find the target session folder, then loads `state.json`. If either is missing, version-mismatched, or `state.phase` is not in `RESUMABLE_PHASES`, resume refuses with a clear error.

**Resumable phases:** `reviewing-spec`, `reviewing-plan`, `implementing`, `validating-task`, `escalating`, `final-review`. Plus any phase with `awaitingContinue: true` — these are always resumable regardless of phase because the user explicitly aborted and is expected to return.

**Non-resumable phases:** `researching`, `specifying`, `planning` *without* `awaitingContinue`. If a cold crash wiped the process mid-generation, the stream is lost and the only safe behaviour is to restart the feature.

**Planner conversational context on resume** uses the capability matrix:

1. If the backend has `supportsSessionResume: true` **and** `state.plannerSessionId` is set, attempt to reuse the native session. For Claude Code this means `claude --session-id <id>`. For Codex this means `codex exec resume --json <id> <prompt>` (`thread_id` captured from the `thread.started` JSONL event). For Agent SDK this means the `options.resume` argument to `query()`.
2. If the backend rejects the session id (expired, unknown, 4xx), emit `session_expired` to `session.jsonl`, notify the user with a short toast ("Previous planner conversation expired — rebuilding context from transcript"), and proceed to step 3.
3. **Rebuild context from `session.jsonl`**: read all `kind: "message"` lines, assemble a messages array of alternating user / assistant turns, and pass that as the initial context to the fresh planner call. For stateless `api` backends this is the *native* way to resume. For `cli` backends without `supportsSessionResume`, we prepend the rebuilt transcript as a `<!-- prior conversation -->` block in the prompt.
4. If `persistTranscript: false` and step 1 failed, there is no transcript to rebuild from. Emit `transcript_unavailable`, ask the user to confirm, and continue with `spec.md` / `plan.md` / `tasks.md` as the only handoff.

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

### 1.7 Mid-phase user interjection — full flow

1. User types during live phase. UI appends to `workflowStore.messageQueue` and emits `message_queued` event.
2. On backends with `supportsMidStreamInjection` (Claude Code, agent-sdk), the message is also dispatched in parallel via a second call to the live session: `claude --session-id <id> "<queued>"`. Claude picks this up on its next model turn without waiting for our orchestrator.
3. Independently, on the next safe-point (end of current planner call), the orchestrator reads `messageQueue`, folds its contents into the next prompt as a dedicated `[user also says: ...]` block, dispatches `DRAIN_QUEUE`, and proceeds.
4. Entries drained from the queue are logged to `session.jsonl` as `kind: "message", role: "user"` with `queuedAt` and `drainedAt` timestamps for audit.

**Clarification answers go through the same queue.** When the planner asks a question via `<!-- Q:{...} -->` and the user answers, the answer is (a) stored in the `## Clarifications` section of `spec.md` exactly as today, and (b) pushed through the same queue so it reaches the planner's live session immediately on capable backends. This closes the pre-existing gap where clarification answers only affected the *next* planner call. Clarification answers are also routed through the queue (see Queue & Interjection in CONCEPTS.md); on Claude Code, the answer arrives mid-stream; on stateless backends, at the next phase boundary.

### 1.8 Escalation flow

No change from today. See `src/engine/orchestrator/escalation.ts`.

1. Task fails validation `maxRetries` times.
2. If the planner has `supportsHintEscalation`: call `planner.escalateHint(...)` → short hint → implementer retries once with hint → success or fall through.
3. Otherwise or after hint failure: `planner.escalateFull(...)` → planner writes the code directly. Task marked `escalated` (successful) or `failed`.
4. Task loop advances either way. Escalation tokens accounted separately (`escalationInput`, `escalationOutput`).

---

## Part 2 — Still open

Short list of things that are *not* yet decided and do not have a clear-cut answer yet. When any of these is resolved, move it into Part 1 and update `docs/CONCEPTS.md` if new terms arise.

- **Queue prompt format.** How exactly do we fold queued messages into the next planner prompt? A `[user also says: ...]` block at the top? Interleaved in chronological order with the original prompt? Needs empirical testing.
- **Mid-stream injection UX on Claude Code.** When the user queues a message and we inject it as a native turn, Claude's response may arrive *while* we're still streaming the prior turn. The TUI needs a clear visual separator ("user interjected →", then planner's new chunk). Not yet designed.
- **Failure semantics of parallel mid-stream dispatch.** If the parallel native-session inject fails (Claude network error), do we fall back to queue-only, or retry the dispatch? Probably queue-only fallback, but needs implementation.
- **`diptych status` for an aborted session.** Should it show `phase: specifying (awaiting continue)` or just `awaiting-continue`? Cosmetic but affects users' mental model.

---

## Part 3 — See also

- `docs/CONCEPTS.md` — terminology (sessions, queue, awaiting-continue, capability matrix)
- `docs/ARCHITECTURE.md` — code layers, persistence tables, capability matrix per backend
- `docs/FUTURE.md` — deferred scope: full message-level rewind, Cursor-style snapshot undo, transcript compaction, parallel sessions
- `docs/STORES.md` — state management details (external stores, zero React Context)
- `docs/VISION.md` — project identity, anti-goals, strategic direction
