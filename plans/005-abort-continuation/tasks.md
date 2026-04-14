# 005 — Abort + Continuation — Tasks

## Phase 1 — State machine + types

### T001 — Add `awaitingContinue` to `WorkflowState`

**Files:** `src/core/types/schemas/workflow.ts`, `src/core/types/workflow.ts`, `src/core/state/machine.ts`

Add `awaitingContinue: z.boolean()` (required, default `false` on creation). Update `createInitialState` to set `awaitingContinue: false`. Bump state version if spec 004 has not already (coordinate with spec 009 migration).

### T002 — Add `ABORT_TURN` / `CONTINUE_TURN` actions

**File:** `src/core/state/machine.ts`

Extend `StateAction` union; add reducer cases per `plan.md`.

### T003 — Convert `RESUMABLE_PHASES` check to `isResumable(state)`

**Files:** `src/core/phases.ts`, `src/cli/commands/resume.ts`

Export a function `isResumable(state: WorkflowState): boolean` per `plan.md`. Update `resume.ts` to call it.

## Phase 2 — Abort propagation

### T004 — Abort helper in `src/utils/process.ts`

Add a subprocess spawn option: when an `AbortSignal` is passed, register a listener that sends SIGTERM on abort, SIGKILL after 2s. Unit test with a spawn of `sleep 30`.

### T005 — Thread `AbortSignal` into every planner/implementer invoke

**Files:** `src/engine/planners/base.ts`, `src/engine/implementers/base.ts`, `src/engine/claude-runner.ts`, `src/engine/streaming/openai-stream.ts`, `src/engine/streaming/spawn-collect.ts`, `src/engine/runners/command-based.ts`

Every code path that spawns a subprocess or fetches an HTTP URL must accept and forward `AbortSignal`. The orchestrator already holds the signal on `WorkflowContext` (`run.ts:33`) — just plumb.

### T006 — Chunk buffer flush on abort

**File:** `src/engine/planners/base.ts` (extend spec 003's `ChunkBuffer`)

On abort: flush buffer with reason `'aborted'` and an extra field `{ interrupted: true }` appended to the message entry. Partial content persists.

### T007 — Test abort cancels api-kind fetch

Spawn a fake HTTP server that sleeps 10s. Issue planner.plan(...) with an abort signal. After 100ms call `abort()`. Assert the fetch rejects with an `AbortError` within 500ms.

### T008 — Test abort cancels subprocess

Same pattern: run a planner with `kind: shell, command: sleep, args: ['30']`. Abort 100ms in. Assert the child process is gone within 2.5s (SIGTERM + SIGKILL fallback).

## Phase 3 — TUI handling

### T009 — Ctrl-C handler with double-press detection

**File:** `src/hooks/use-global-keys.ts`

Implement single-vs-double press logic per `plan.md`. Use a module-level or ref-held `lastCtrlC` timestamp.

### T010 — `isLivePhase` helper + phase-aware Ctrl-C routing

**File:** `src/core/phases.ts`

Export `isLivePhase(phase): boolean` listing phases where a call is actively running. Use in the Ctrl-C handler to decide abort-turn vs. exit.

### T011 — Explicit Esc-ignore for phase abort

**File:** `src/hooks/use-global-keys.ts` (or wherever Esc is routed)

Confirm Esc never dispatches a phase-abort action. If today an Esc path exists, remove it. Add an inline comment referencing this spec and `docs/WORKFLOW.md` §1.6.

### T012 — Awaiting-continue input mode

**File:** `src/screens/workflow.tsx`

When `state.awaitingContinue === true`, switch `inputModeStore` to "text enabled" with hint. On Enter (with or without text), dispatch `CONTINUE_TURN` and resume the phase via the continuation prompt helper (T013).

## Phase 4 — Continuation

### T013 — Create `src/engine/orchestrator/continuation.ts`

Export `buildContinuationPrompt(partial, userText, capabilities)` per `plan.md`. Returns either `{ kind: 'native-session', userMessage }` or `{ kind: 'rebuild', messages }`.

### T014 — Orchestrator handles continuation

**File:** `src/engine/orchestrator/run.ts` (or new helper)

After `CONTINUE_TURN` is dispatched, invoke the correct planner method with the continuation result:
- `kind: 'native-session'`: call `planner.plan` (or escalate, depending on phase) with the user message as prompt. The planner's existing `--session-id` plumbing (spec 004) ensures it lands in the live session.
- `kind: 'rebuild'`: prepend `messages` to the next prompt as an assistant/user pair.

### T015 — Update `diptych status` to show awaiting-continue

**File:** `src/cli/commands/status.ts`

Format: `phase: <phase>${state.awaitingContinue ? ' (awaiting continue)' : ''}`.

## Phase 5 — Tests

### T016 — Full flow test: abort + continue

In a fake planner harness, simulate mid-stream abort, assert:
- `state.awaitingContinue === true`.
- `session.jsonl` has a message entry with `interrupted: true`.
- TUI input mode is text-enabled.
- After dispatching `CONTINUE_TURN` with text "also use PG15", the planner's next `invokePlan` receives a prompt containing the continuation.

### T017 — Double-Ctrl-C test

Assert first Ctrl-C only sets awaiting-continue; second within 2s triggers `CANCEL`.

### T018 — Resume test for awaiting-continue state

Save state with `awaitingContinue: true, phase: 'researching'`. Run resume. Assert it succeeds (normally `researching` is non-resumable, but the awaiting flag overrides).

### T019 — Full test suite

`npm test`. Green.

## Phase 6 — Doc Sync

### T020 — Update `docs/WORKFLOW.md` §1.6

Confirm the "Four user actions" table matches implementation: key bindings, effects, partial-preservation behaviour. Add pointer to `src/engine/orchestrator/continuation.ts`.

### T021 — Update `docs/WORKFLOW.md` §1.1 state-machine table

Confirm `ABORT_TURN` and `CONTINUE_TURN` rows are present. Confirm `awaitingContinue` is documented as a secondary state field in the intro paragraph of §1.1.

### T022 — Update `docs/CONCEPTS.md` §"Awaiting-continue"

Confirm description matches implementation. Double-check the "(a) type text + Enter → queued → ..." flow is accurate (noting that the queue mechanism is the full spec 007 — 005 only handles single-abort-continue).

### T023 — Update `docs/ARCHITECTURE.md` data flow

Section "Data flow, one full task" step 10 mentions abort/Ctrl-C — confirm the double-press-to-exit detail matches implementation.
