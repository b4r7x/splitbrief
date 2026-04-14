# 007 — Queue Mid-Phase Injection — Plan

## Data model

### `WorkflowState` extension

**File:** `src/core/types/schemas/workflow.ts`

Add `messageQueue: QueuedMessage[]`.

```ts
const QueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  queuedAt: z.string(),           // ISO
  phase: z.enum([...]),
  deliveredViaNative: z.boolean(),
  drainedAt: z.string().optional(),
});
```

Default `[]` on state creation.

### State-machine actions

**File:** `src/core/state/machine.ts`

Add:

```ts
| { type: 'ENQUEUE_USER_MSG'; message: QueuedMessage }
| { type: 'MARK_DELIVERED_NATIVE'; id: string }
| { type: 'DRAIN_QUEUE' }
| { type: 'CLEAR_QUEUE' }
```

Reducers:

```ts
case 'ENQUEUE_USER_MSG':
  return { ...state, messageQueue: [...state.messageQueue, action.message] };
case 'MARK_DELIVERED_NATIVE':
  return {
    ...state,
    messageQueue: state.messageQueue.map(m =>
      m.id === action.id ? { ...m, deliveredViaNative: true } : m
    ),
  };
case 'DRAIN_QUEUE': {
  const now = new Date().toISOString();
  return {
    ...state,
    messageQueue: state.messageQueue.map(m => m.drainedAt ? m : { ...m, drainedAt: now }),
  };
}
case 'CLEAR_QUEUE':
  return { ...state, messageQueue: state.messageQueue.filter(m => m.drainedAt) };
  // Only remove pending; keep drained as audit trail — but they don't affect next prompts.
```

### Event types

**File:** `src/core/types/events.ts`

Add `message_queued`, `message_injected_native`, `queue_drained` with payloads.

## Enqueue path

### TUI input bar

**File:** `src/components/input-bar/input-bar.tsx`, `src/hooks/use-workflow-review-input.ts`

Phase-aware submit:

```ts
function onSubmit(text: string) {
  if (!text.trim()) return;
  const phase = workflowStore.get().state.phase;
  if (isImplementerPhase(phase)) {
    feedbackStore.setError('Input disabled during task implementation. Use /redo-task after task finishes.');
    return;
  }
  if (isApprovalGate(phase) || state.awaitingContinue) {
    // existing flows handle these
    return existingHandler(text);
  }
  // Live planner phase — enqueue
  enqueueUserMessage(text);
}
```

`enqueueUserMessage(text)`:

```ts
function enqueueUserMessage(text: string) {
  const msg: QueuedMessage = {
    id: randomUUID(),
    text,
    queuedAt: new Date().toISOString(),
    phase: state.phase,
    deliveredViaNative: false,
  };
  dispatch({ type: 'ENQUEUE_USER_MSG', message: msg });
  emit('message_queued', { id: msg.id, phase: msg.phase });
  appendMessage({ role: 'user', text, phase: state.phase });  // spec 003

  // Attempt native injection (capability-gated)
  const caps = planner.capabilities;
  if (caps.supportsMidStreamInjection) {
    dispatchNativeInjection(msg).catch(err => {
      // Silent degrade
      warnStderr(`native injection failed: ${err}`);
    });
  }
}
```

### Native injection

**New module:** `src/engine/orchestrator/native-injection.ts`

```ts
export async function dispatchNativeInjection(msg: QueuedMessage, planner: Planner, state: WorkflowState): Promise<void> {
  if (!state.plannerSessionId) return;  // no live session to inject into
  const result = await planner.injectUserTurn?.(msg.text, state.plannerSessionId);
  if (result) {
    dispatch({ type: 'MARK_DELIVERED_NATIVE', id: msg.id });
    emit('message_injected_native', { id: msg.id });
  }
}
```

`Planner` interface gains an optional `injectUserTurn?(text, sessionId): Promise<void>`. Only backends with `supportsMidStreamInjection: true` implement it.

**Claude Code implementation** (`src/engine/planners/claude-code.ts`): spawn a fire-and-forget `claude --session-id <id> -p <text>` subprocess, do not await its stream. Claude server-side handles picking the message up on its next turn.

**agent-sdk implementation**: call the SDK's message-inject method.

## Drain path

### Safe-point detection

**File:** `src/engine/planners/base.ts` and `src/engine/orchestrator/run.ts`

Two boundaries:

1. **End of planner call** — after `invokePlan` / `invokeEscalate` / `regenerate` returns (at the same point the `ChunkBuffer` flushes — spec 003).
2. **Phase boundary** — after `transitionAndSave` fires with a phase-changing action (SPEC_DONE, PLAN_DONE, ALL_DONE, etc.).

Both places: call `drainQueue(state)` before the next planner invocation.

### `drainQueue` helper

**New module:** `src/engine/orchestrator/queue-drain.ts`

```ts
export function drainQueue(state: WorkflowState): { prepend: string; drained: QueuedMessage[] } {
  const pending = state.messageQueue.filter(m => !m.drainedAt);
  if (pending.length === 0) return { prepend: '', drained: [] };
  const block = pending
    .map(m => `[user also says during ${m.phase}]\n${m.text}\n[/user also says]`)
    .join('\n\n');
  return { prepend: block + '\n\n', drained: pending };
}
```

The caller dispatches `DRAIN_QUEUE` after using the prepend string.

### Prompt integration

Each planner invoke entry-point receives an optional `priorContext?: string` argument. Caller concatenates `drainPrepend + existingPrompt`. Already somewhat supported by spec 004's transcript rebuild — unify into a single "prior context" channel.

## UI surface

### Footer indicator

**File:** `src/components/workflow/cost-footer.tsx` (or a new small component)

Read `workflowStore.state.messageQueue.filter(m => !m.drainedAt).length`. When > 0, show `queue: N` next to the cost/time stats.

### `/queue show` and `/queue clear`

Register two new slash commands (same pattern as spec 006):
- `/queue show` — emits events with the queued messages as visible cards.
- `/queue clear` — dispatches `CLEAR_QUEUE`, emits `queue_cleared` event.

Both guarded to any phase where queue might exist.

## Dependencies

**Depends on:** 001 (capability flag), 003 (message append), 004 (plannerSessionId for native injection), 005 (awaiting-continue flow must not conflict).

**Consumed by:** 008 (clarification answers use enqueue + delivery).

## Risk

- **Queue never drains.** If user queues during a non-completing infinite loop, messages accumulate. Safety: size cap at 50 pending entries; new enqueue beyond cap is rejected with user-visible error.
- **Native injection arrives after orchestrator already drained.** Claude may inject the message and separately the prompt may include it — planner sees it twice. Acceptable; planner can deduplicate in reasoning. Document in spec.
- **Race between enqueue and drain.** Mitigated by atomic `dispatch` calls — state updates are serialized.
- **Inject succeeded but backend ignored.** We mark `deliveredViaNative: true` optimistically. If Claude actually dropped it, user only sees effect at next drain. Acceptable.

## Success verification

- Manual: type mid-phase on Claude Code → `session.jsonl` has `message_queued` + `message_injected_native` events. Claude's next stream text reflects the content.
- Manual: type mid-phase on Ollama → queue shows in footer, drained into next prompt at next phase boundary.
- Manual: implementer phase input → error toast, not enqueued.
- Manual: resume after enqueue+Ctrl-C — queue intact.
- Tests: see tasks.md.
