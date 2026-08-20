import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import { isQueuedMessageClearable } from '../../../core/queue-state.js';
import type { QueueClearResult } from '../types.js';
import type { WriteSequencer } from '../serial-executor.js';
import type { QueueHandlerContext, QueueStateMutationOptions } from './types.js';

export function clearPendingQueue({
  projectDir,
  sessionId,
  state,
  bus,
}: QueueStateMutationOptions): { state: WorkflowState; count: number } {
  const ref = { projectDir, sessionId };
  const base = rebaseOnPersistedWorkflowState(ref, state);
  const pending = base.messageQueue.filter(isQueuedMessageClearable);
  if (pending.length === 0) return { state: base, count: 0 };

  const next = transitionAndSave(ref, base, { type: 'CLEAR_QUEUE' });
  bus.publish({ type: 'queue_cleared', ts: Date.now(), phase: next.phase, count: pending.length });
  return { state: next, count: pending.length };
}

export function createClearQueueHandler(
  ctx: QueueHandlerContext & { serialize: WriteSequencer },
): () => Promise<QueueClearResult> {
  const { projectDir, sessionId, getState, setState, bus, serialize } = ctx;
  return () =>
    serialize((): QueueClearResult => {
      const state = getState();
      if (!state) {
        return { status: 'unavailable', message: 'Cannot clear queue: no active workflow.' };
      }

      const result = clearPendingQueue({ projectDir, sessionId, state, bus });
      setState(result.state);
      return { status: 'cleared', count: result.count };
    });
}
