# 005 — Abort + Continuation — Plan

## Data model

### `WorkflowState` extension

**File:** `src/core/types/schemas/workflow.ts`

Add `awaitingContinue: boolean` to the state schema. Default `false` on state creation (`src/core/state/machine.ts:14-26`).

### State machine actions

**File:** `src/core/state/machine.ts`

Add union members:
```ts
| { type: 'ABORT_TURN' }
| { type: 'CONTINUE_TURN' }
```

Reducer:
```ts
case 'ABORT_TURN':
  return { ...state, awaitingContinue: true };
case 'CONTINUE_TURN':
  return { ...state, awaitingContinue: false };
```

Neither changes `phase`. Neither clears `attempt` or other phase-internal counters.

### `RESUMABLE_PHASES` logic

**File:** `src/core/phases.ts`

Current export is a static `Set<Phase>`. Replace with a function:

```ts
export function isResumable(state: WorkflowState): boolean {
  if (state.awaitingContinue) return true;
  return RESUMABLE_PHASES.has(state.phase);
}
```

Update `resume.ts` CLI handler to call `isResumable(state)` instead of `RESUMABLE_PHASES.has(state.phase)`.

## Abort propagation

### Signal threading

Every `runWorkflow` already accepts `signal?: AbortSignal` (`src/engine/orchestrator/run.ts:33`). It is passed into `WorkflowContext`. Verify during T005 that the signal reaches every planner/implementer call (some existing calls may not forward it).

### Per-backend abort implementation

- **api** (`src/engine/planners/api.ts`, `src/engine/implementers/api.ts`): `fetch(url, { signal, ... })`. Already uses fetch — just thread the signal.
- **cli** (Claude Code, codex, etc. — `src/engine/claude-runner.ts`, `src/engine/streaming/spawn-collect.ts`): `src/utils/process.ts` spawns subprocesses. Add `onAbort` handler that sends SIGTERM, then SIGKILL after 2s. Expose an `abortSignal` param to the spawn helper; wire it up to a signal listener.
- **shell / agent** (`src/engine/planners/shell.ts`, etc.): same subprocess path as cli — reuse the abort helper from `src/utils/process.ts`.
- **agent-sdk**: Anthropic Agent SDK accepts `AbortSignal` natively on its invocation methods. Thread through.

### Chunk flush on abort

**File:** `src/engine/planners/base.ts`

The `ChunkBuffer` introduced in spec 003 gets a new flush reason: `'aborted'`. When `AbortSignal` fires during a planner call, the buffer flushes its accumulated content with `interrupted: true` before the planner's error propagates up:

```ts
abortSignal?.addEventListener('abort', () => {
  buffer.flush('aborted', { interrupted: true });
});
```

The message appended to `session.jsonl` includes `interrupted: true` so readers (and future continuation prompts) can tell the content was truncated.

## TUI handling of Ctrl-C

### `useGlobalKeys` update

**File:** `src/hooks/use-global-keys.ts`

Today Ctrl-C presumably dispatches a single "cancel" action. Change to:

```ts
let lastCtrlC: number | null = null;

useInput((input, key) => {
  if (key.ctrl && input === 'c') {
    const now = Date.now();
    if (lastCtrlC && (now - lastCtrlC) < 2000) {
      // Second press → full exit
      abortController.abort();  // ensure any live call dies
      workflowStore.dispatch({ type: 'CANCEL' });
      shutdownWorkflow(...);
      exit();
    } else {
      // First press → abort current turn
      const phase = workflowStore.get().state.phase;
      if (isLivePhase(phase)) {
        abortController.abort();
        workflowStore.dispatch({ type: 'ABORT_TURN' });
      } else {
        // No live call — Ctrl-C as today
        shutdownWorkflow(...);
        exit();
      }
      lastCtrlC = now;
    }
  }
});
```

`isLivePhase(phase)` returns true for `researching | specifying | planning | implementing | validating-task | escalating | final-review`. Approval gates (`reviewing-*`) are interactive — Ctrl-C there just exits.

### Input mode during `awaitingContinue`

**File:** `src/screens/workflow.tsx` (or wherever input mode is decided)

When `state.awaitingContinue === true`, the TUI:

- Enables text input (normally disabled during live phases).
- Shows a subtle hint: `aborted at <phase> — type to add context, or Enter to continue`.
- On Enter (with or without text), dispatch `CONTINUE_TURN`, then resume the phase.

### Esc handling

**File:** `src/hooks/use-global-keys.ts`, overlay components

Confirm that Esc only routes to overlay-close handlers, never to phase-abort. Add a lint rule or explicit test if feasible.

## Continuation prompt construction

New module: `src/engine/orchestrator/continuation.ts`

```ts
export function buildContinuationPrompt(
  partialAssistant: string,
  userContinuation: string | null,
  capabilities: PlannerCapabilities,
): { kind: 'native-session'; userMessage: string } | { kind: 'rebuild'; messages: Array<{role, content}> } {
  const userMsg = userContinuation?.trim() || 'continue';
  if (capabilities.supportsSessionResume) {
    return { kind: 'native-session', userMessage: userMsg };
  }
  return {
    kind: 'rebuild',
    messages: [
      { role: 'assistant', content: partialAssistant },
      { role: 'user', content: userMsg },
    ],
  };
}
```

Orchestrator prepends the rebuilt messages to the normal resume context (from spec 004's `buildResumeContext`).

## Dependencies

**Depends on:** 002, 003 (buffer + session.jsonl), 004 (session resume handling for native path).

**Consumed by:** 007 (queue interacts with abort timing).

## Risk

- **Race on second Ctrl-C.** If the user presses Ctrl-C a third time, we might be mid-shutdown. Guard: `shutdownWorkflow` is idempotent (already is — can be called twice safely).
- **Partial response never reaches disk.** If the abort fires before any chunk was buffered, the message entry is skipped. Acceptable — `session.jsonl` just has `turn_aborted` event with no preceding message.
- **Subprocess SIGTERM ignored.** Some tools may trap SIGTERM. SIGKILL after 2s is the fallback. Accept occasional "zombie" child that exits eventually on its own.

## Success verification

- Manual: start a run, press Ctrl-C once, confirm TUI enters awaiting-continue state without exit.
- Manual: type a continuation, press Enter, confirm planner resumes.
- Manual: double Ctrl-C exits.
- Manual: Esc during `specifying` does NOT abort.
- Tests: see tasks T011-T016.
