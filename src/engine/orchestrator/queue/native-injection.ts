import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import type {
  BriefRecoveryController,
  QueueBriefInput,
  QueueResultV1,
  StateAuthorityReceipt,
} from '../../../core/schemas/brief-recovery.js';
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
  recovery?: RecoveryQueueBinding | undefined;
};

export type RecoveryQueueBinding = {
  controller: BriefRecoveryController;
  authority: StateAuthorityReceipt;
  source?: Exclude<QueueBriefInput['source'], 'native-injection'> | undefined;
  operationId?: string | null | undefined;
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

function recoveryInput(
  state: WorkflowState,
  message: QueuedMessage,
  text: string,
  binding: RecoveryQueueBinding,
  sessionId: string,
): QueueBriefInput | null {
  if (binding.authority.sessionId !== sessionId) return null;
  const recovery = state.briefRecovery;
  if (
    recovery === undefined ||
    recovery === null ||
    recovery.activeBrief === null ||
    !('nextInputSequence' in recovery)
  )
    return null;
  return {
    sessionId,
    epochId: recovery.epochId,
    inputId: message.id,
    sequence: recovery.nextInputSequence,
    kind: 'native-injection',
    source: 'native-injection',
    payload: text,
    base: recovery.activeBrief,
    operationId: binding.operationId ?? null,
  };
}

function queueWasRefused(result: QueueResultV1): boolean {
  return result.kind === 'conflict' || result.kind === 'refused';
}

function alreadyApplied(result: QueueResultV1): boolean {
  return result.kind === 'replayed' && result.input.state !== 'queued';
}

export async function dispatchNativeInjection(
  opts: DispatchNativeInjectionOptions,
): Promise<NativeInjectionResult> {
  const { message, planner, projectDir, sessionId, getState, setState, bus, signal, recovery } =
    opts;
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

    if (recovery !== undefined) {
      const input = recoveryInput(current, message, injectionText, recovery, sessionId);
      if (input === null) {
        return { status: 'not-delivered', reason: 'failed' };
      }
      const queueResult = await recovery.controller.queueBriefInput(input, recovery.authority);
      if (queueWasRefused(queueResult)) {
        return {
          status: 'not-delivered',
          reason: queueResult.kind === 'conflict' ? 'already-owned' : 'failed',
        };
      }
      if (alreadyApplied(queueResult)) {
        const latest = rebaseOnPersistedWorkflowState(ref, getState());
        const latestMessage = findQueuedMessage(latest, message.id);
        if (latestMessage === undefined) {
          return { status: 'not-delivered', reason: 'cleared' };
        }
        const delivered = transitionAndSave(ref, latest, {
          type: 'MARK_DELIVERED_NATIVE',
          id: message.id,
        });
        setState(delivered);
        return { status: 'delivered' };
      }
      throwIfAborted(signal);
    }

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
