# 005 — Abort + Continuation

## Problem

Today a single Ctrl-C kills the entire workflow: the current call is aborted, `shutdownWorkflow` runs, state is saved, process exits. Users who want to leave a quick note mid-run without losing their live planner session have no path — they must either wait for an approval gate or accept a full cold restart.

There is also no recovery for interrupted planner generation phases (`researching`, `specifying`, `planning`): these are not resumable (see `src/core/phases.ts:25-28`). Users pressing Ctrl-C mid-generation lose the entire phase and must restart it from scratch.

## Goal

Introduce the Ctrl-C-based interaction model described in `docs/WORKFLOW.md` §1.6:

- **Single Ctrl-C** = abort current turn. Aborts the live planner/implementer call, preserves partial response in `session.jsonl`, transitions `awaitingContinue: true` in the same phase. Workflow does not exit.
- **Double Ctrl-C** (within 2 seconds) = exit workflow. Saves state, clears `.diptych/active`, exits.
- **Esc** = only closes overlays/pickers. Never aborts.

All generation-heavy phases become resumable via this flow — partial output is on disk, session state has `awaitingContinue`, user can `tiny-spec resume` hours later and decide what to do.

## User stories

- **As a user realizing mid-spec that I forgot to mention a constraint**, I press Ctrl-C once, type "btw, use PostgreSQL 15", press Enter, and the planner continues with that context.
- **As a user accidentally running a workflow in the wrong directory**, I press Ctrl-C twice quickly and the workflow exits cleanly with state saved.
- **As a user whose terminal crashed mid-research**, after reboot I run `diptych resume` and see exactly what the planner had output up to the crash.

## Functional requirements

**FR-001.** Add `awaitingContinue: boolean` to `WorkflowState` schema and type. Default `false`.

**FR-002.** Add three state-machine actions:
- `ABORT_TURN` — sets `awaitingContinue: true`. Phase unchanged.
- `CONTINUE_TURN` — sets `awaitingContinue: false`. Phase unchanged.
- (Existing `CANCEL` unchanged — used by double-Ctrl-C.)

**FR-003.** Every planner/implementer call propagates an `AbortSignal` down to the underlying transport:
- `api` kind: pass `signal` to `fetch`.
- `cli`/`shell`/`agent` kinds: on abort, send SIGTERM to the child process; SIGKILL after 2s if still alive.
- `agent-sdk`: use the SDK's built-in `AbortSignal` support.

**FR-004.** TUI captures Ctrl-C via `useGlobalKeys`:
- First Ctrl-C during an active phase: fire `AbortController.abort()` on the current call. Dispatch `ABORT_TURN`. Switch input mode to "awaiting" (user can type text + Enter to queue, or Enter on empty input to continue).
- Second Ctrl-C within 2000ms of the first: dispatch `CANCEL`, call `shutdownWorkflow`, process exits.
- Ctrl-C when not in an active phase (e.g. user is at approval gate, no call in flight): single Ctrl-C = exit (acts as today).

**FR-005.** TUI never abort-escapes on the Esc key. The `useGlobalKeys` handler explicitly ignores Esc in the context of workflow phases — Esc goes only to overlay-close handlers.

**FR-006.** Partial message preservation:
- When an abort fires during a planner stream, the `ChunkBuffer` (spec 003) flushes its accumulated text to `session.jsonl` as `kind: 'message', role: 'assistant', interrupted: true`.
- The partial response is available for continuation prompts (FR-008).

**FR-007.** Abort scope includes `validating-task` phase. SIGTERM is sent to the running `tsc` / linter / test subprocess. No state mutation risk because validation only reads files.

**FR-008.** Continue action: when user exits `awaitingContinue` (by typing or pressing Enter on empty):
- For Claude Code (`supportsSessionResume: true`): the next turn is issued via `--session-id <id>` with user message (or literal `"continue"` if user gave no text).
- For stateless backends: the next call's prompt includes the partial response and the user's continuation text. Example (api kind): `messages: [originalPrompt, { role: 'assistant', content: partial }, { role: 'user', content: userContinuation || 'continue' }]`.

**FR-009.** `RESUMABLE_PHASES` gains every cancellable phase when `awaitingContinue: true`. Concretely: `resume` reads `state.json`, and if `awaitingContinue === true`, resume is allowed regardless of phase. The existing list `reviewing-spec | reviewing-plan | implementing | validating-task | escalating | final-review` still applies for the non-awaiting case.

**FR-010.** `diptych status` shows `awaitingContinue` visibly (e.g. `phase: specifying (awaiting continue)`).

## Success criteria

- Single Ctrl-C during `specifying` aborts the Claude stream in <2s, `state.json` shows `awaitingContinue: true, phase: 'specifying'`, partial text visible in `session.jsonl` with `interrupted: true`.
- Double Ctrl-C exits the workflow.
- Esc during any phase does not abort.
- Resume after single Ctrl-C picks up in the same phase with `awaitingContinue` cleared after first user action.
- Continue-without-new-message produces a sensible next turn (Claude: session continues; api: "continue" user message).
- All tests pass; new tests for Ctrl-C timing, abort propagation per backend, partial preservation.

## Non-goals

- Queueing mid-phase user messages (that is spec 007 — but this spec plumbs the partial-preservation and state transitions that 007 builds on).
- Mid-stream parallel injection (spec 007, specifically `supportsMidStreamInjection`).
- Explicit `/pause` slash command (we ruled that out in design — Ctrl-C + queue covers the use cases).
- Changing `Esc` behaviour in overlays (stays as-is; Esc still closes overlays).
- Reverting partial planner output if the user decides to reject after continuing (out of scope — partial stays in log as historical record).
