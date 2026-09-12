import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import { loadState } from '../../../core/state/persistence.js';
import type { Planner } from '../../planners/types.js';
import type { EventBus } from '../../events/types.js';
import {
  addUsageAndSave,
  rebaseOnPersistedWorkflowState,
  transitionAndSave,
} from '../state-ops.js';
import { claimQueuedMessage, releaseQueuedMessage } from './drain.js';
import { publishRunnerCallEvent, publishWarningFromError } from '../events.js';
import { isAbortError, throwIfAborted } from '../../../utils/abort.js';
import { formatQueuedMessagePreview } from '../../../core/queue-preview.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';

export type DispatchNativeInjectionOptions = {
  message: QueuedMessage;
  planner: Planner;
  projectDir: string;
  sessionId: string;
  getState: () => WorkflowState;
  setState: (s: WorkflowState) => void;
  bus: EventBus;
  signal?: AbortSignal | undefined;
};

export type NativeInjectionResult =
  | { status: 'delivered' }
  | {
      status: 'not-delivered';
      reason: 'unsupported' | 'aborted' | 'failed' | 'cleared' | 'already-owned';
    };

function findQueuedMessage(
  state: WorkflowState,
  id: string,
): WorkflowState['messageQueue'][number] | undefined {
  return state.messageQueue.find((queued) => queued.id === id);
}

function wasCleared(ref: { projectDir: string; sessionId: string }, id: string): boolean {
  const persisted = loadState(ref);
  return persisted !== null && !persisted.messageQueue.some((queued) => queued.id === id);
}

export async function dispatchNativeInjection(
  opts: DispatchNativeInjectionOptions,
): Promise<NativeInjectionResult> {
  const { message, planner, projectDir, sessionId, getState, setState, bus, signal } = opts;
  const ref = { projectDir, sessionId };
  if (!planner.injectUserTurn) return { status: 'not-delivered', reason: 'unsupported' };
  if (signal?.aborted) return { status: 'not-delivered', reason: 'aborted' };
  if (wasCleared(ref, message.id)) return { status: 'not-delivered', reason: 'cleared' };

  const current = rebaseOnPersistedWorkflowState(ref, getState());
  const queued = findQueuedMessage(current, message.id);
  if (!queued) return { status: 'not-delivered', reason: 'cleared' };
  if (!isQueuedMessagePendingDelivery(queued)) {
    return { status: 'not-delivered', reason: 'already-owned' };
  }
  if (!claimQueuedMessage(ref, message.id, 'native')) {
    return { status: 'not-delivered', reason: 'already-owned' };
  }

  try {
    throwIfAborted(signal);
    const injectionText =
      message.origin === 'clarification' && message.question
        ? `[clarification answer]\nQ: ${message.question}\nA: ${message.text}\n[/clarification answer]`
        : message.text;

    const injecting = transitionAndSave(ref, current, {
      type: 'MARK_INJECTING_NATIVE',
      id: message.id,
    });
    setState(injecting);
    const usage = await planner.injectUserTurn({
      text: injectionText,
      projectDir,
      ...(signal !== undefined && { signal }),
      callbacks: {
        onCallEvent: (event) => publishRunnerCallEvent({ bus, phase: getState().phase }, event),
      },
    });
    throwIfAborted(signal);
    if (wasCleared(ref, message.id)) {
      return { status: 'not-delivered', reason: 'cleared' };
    }
    const latest = rebaseOnPersistedWorkflowState(ref, getState());
    const latestMessage = findQueuedMessage(latest, message.id);
    if (!latestMessage) {
      return { status: 'not-delivered', reason: 'cleared' };
    }
    const booked = addUsageAndSave({ projectDir, sessionId, bus }, latest, 'planner', usage);
    const next = transitionAndSave(ref, booked, {
      type: 'MARK_DELIVERED_NATIVE',
      id: message.id,
    });
    setState(next);
    const preview = formatQueuedMessagePreview(message);
    bus.publish({
      type: 'message_injected_native',
      ts: Date.now(),
      phase: next.phase,
      id: message.id,
      ...(preview.length > 0 && { preview }),
    });
    return { status: 'delivered' };
  } catch (err) {
    const aborted = signal?.aborted || isAbortError(err);
    if (wasCleared(ref, message.id)) {
      return { status: 'not-delivered', reason: 'cleared' };
    }
    const latest = rebaseOnPersistedWorkflowState(ref, getState());
    const latestMessage = findQueuedMessage(latest, message.id);
    if (!latestMessage) {
      return { status: 'not-delivered', reason: 'cleared' };
    }
    const next = transitionAndSave(ref, latest, {
      type: 'MARK_NATIVE_DELIVERY_FAILED',
      id: message.id,
    });
    setState(next);
    if (aborted) return { status: 'not-delivered', reason: 'aborted' };
    publishWarningFromError({ bus, phase: getState().phase }, 'native injection failed', err);
    return { status: 'not-delivered', reason: 'failed' };
  } finally {
    releaseQueuedMessage(ref, message.id, 'native');
  }
}
