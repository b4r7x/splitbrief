import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import type { Planner } from '../planners/types.js';
import type { EventBus } from '../events/types.js';
import { addUsageAndSave, rebaseOnPersistedWorkflowState, transitionAndSave } from './state-ops.js';
import { publishRunnerCallEvent, publishWarningFromError } from './events.js';
import { isAbortError, throwIfAborted } from '../../utils/abort.js';
import { formatQueuedMessagePreview } from '../../core/queue-preview.js';

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
  | { status: 'not-delivered'; reason: 'unsupported' | 'aborted' | 'failed' | 'cleared' };

function findQueuedMessage(
  state: WorkflowState,
  id: string,
): WorkflowState['messageQueue'][number] | undefined {
  return state.messageQueue.find((queued) => queued.id === id);
}

export async function dispatchNativeInjection(
  opts: DispatchNativeInjectionOptions,
): Promise<NativeInjectionResult> {
  const { message, planner, projectDir, sessionId, getState, setState, bus, signal } = opts;
  if (!planner.injectUserTurn) return { status: 'not-delivered', reason: 'unsupported' };
  if (signal?.aborted) return { status: 'not-delivered', reason: 'aborted' };

  try {
    throwIfAborted(signal);
    const injecting = transitionAndSave({ projectDir, sessionId }, getState(), {
      type: 'MARK_INJECTING_NATIVE',
      id: message.id,
    });
    setState(injecting);
    const injectionText =
      message.origin === 'clarification' && message.question
        ? `[clarification answer]\nQ: ${message.question}\nA: ${message.text}\n[/clarification answer]`
        : message.text;
    const usage = await planner.injectUserTurn({
      text: injectionText,
      projectDir,
      ...(signal !== undefined && { signal }),
      callbacks: {
        onCallEvent: (event) => publishRunnerCallEvent({ bus, phase: getState().phase }, event),
      },
    });
    throwIfAborted(signal);
    const latest = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, getState());
    const queued = findQueuedMessage(latest, message.id);
    if (!queued) return { status: 'not-delivered', reason: 'cleared' };
    const booked = addUsageAndSave({ projectDir, sessionId, bus }, latest, 'planner', usage);
    const next = transitionAndSave({ projectDir, sessionId }, booked, {
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
    if (signal?.aborted || isAbortError(err)) return { status: 'not-delivered', reason: 'aborted' };
    const latest = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, getState());
    const queued = findQueuedMessage(latest, message.id);
    if (!queued) return { status: 'not-delivered', reason: 'cleared' };
    const next = transitionAndSave({ projectDir, sessionId }, latest, {
      type: 'MARK_NATIVE_DELIVERY_FAILED',
      id: message.id,
    });
    setState(next);
    publishWarningFromError({ bus, phase: getState().phase }, 'native injection failed', err);
    return { status: 'not-delivered', reason: 'failed' };
  }
}
