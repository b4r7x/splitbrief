import { randomUUID } from 'node:crypto';
import type { Phase } from '../../../core/schemas/enums.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import { isImplementerPhase, isLivePhase } from '../../../core/phases.js';
import type { Planner } from '../../planners/types.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import { publishWarning } from '../events.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { recordUserMessage } from '../transcript/user-message.js';
import { dispatchNativeInjection } from './native-injection.js';
import { warnError } from '../../../lib/warn.js';
import { nowIso } from '../../../utils/format-time.js';
import type { WriteSequencer } from '../serial-executor.js';
import { formatQueuedMessagePreview } from '../../../core/queue-preview.js';
import { isQueuedMessagePendingDelivery } from '../../../core/queue-state.js';
import type { QueueSubmissionResult } from '../types.js';
import {
  MAX_QUEUE_SIZE,
  type EnqueueUserMessageOptions,
  type QueueHandlerContext,
} from './types.js';

export function enqueueUserMessage({
  projectDir,
  sessionId,
  state,
  message: input,
  phase,
  bus,
  enforcePhasePolicy = true,
}: EnqueueUserMessageOptions): {
  state: WorkflowState;
  result: QueueSubmissionResult;
  message?: QueuedMessage | undefined;
} {
  const base = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, state, {
    keepUnsaved: true,
  });
  if (enforcePhasePolicy && !isLivePhase(phase) && !isImplementerPhase(phase)) {
    const message = `Queue is only available while a run is live; current phase is ${phase}.`;
    publishWarning({
      bus,
      phase,
      message,
      safety: {
        category: 'queue',
        code: 'phase_unavailable',
      },
    });
    return { state: base, result: { status: 'rejected', reason: 'phase-unavailable', message } };
  }

  const pending = base.messageQueue.filter(isQueuedMessagePendingDelivery);
  if (pending.length >= MAX_QUEUE_SIZE) {
    const message = `Queue full (${MAX_QUEUE_SIZE} messages). Wait for the current phase to complete.`;
    publishWarning({
      bus,
      phase,
      message,
      safety: {
        category: 'queue',
        code: 'queue_full',
      },
    });
    return { state: base, result: { status: 'rejected', reason: 'queue-full', message } };
  }

  const message: QueuedMessage = {
    id: randomUUID(),
    ...input,
    queuedAt: nowIso(),
    phase,
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
    origin: 'user-input',
  };

  const next = transitionAndSave({ projectDir, sessionId }, base, {
    type: 'ENQUEUE_USER_MSG',
    message,
  });
  recordUserMessage({ projectDir, sessionId, bus, phase }, input, { queuedMessage: message });
  const preview = formatQueuedMessagePreview(message);
  bus.publish({
    type: 'message_queued',
    ts: Date.now(),
    phase: next.phase,
    id: message.id,
    ...(preview.length > 0 && { preview }),
  });
  return {
    state: next,
    result: { status: 'accepted', messageId: message.id, ...(preview.length > 0 && { preview }) },
    message,
  };
}

export function createQueueHandler(
  opts: QueueHandlerContext & {
    planner: Planner;
    serialize: WriteSequencer;
    signal?: AbortSignal | undefined;
  },
): (message: UserMessageInput, phase: Phase) => Promise<QueueSubmissionResult> {
  const { projectDir, sessionId, getState, setState, bus, planner, serialize, signal } = opts;
  return async (message: UserMessageInput, phase: Phase) => {
    try {
      const submitted = await serialize(
        (): {
          result: QueueSubmissionResult;
          message?: QueuedMessage | undefined;
          state?: WorkflowState | undefined;
        } => {
          const state = getState();
          if (!state) {
            return {
              result: {
                status: 'rejected',
                reason: 'phase-unavailable',
                message: 'Cannot queue message: no active workflow.',
              } satisfies QueueSubmissionResult,
            };
          }

          const result = enqueueUserMessage({
            projectDir,
            sessionId,
            state,
            message,
            phase,
            bus,
          });
          setState(result.state);
          return { result: result.result, message: result.message, state: result.state };
        },
      );
      if (submitted.result.status === 'accepted' && submitted.message && submitted.state) {
        const enqueuedState = submitted.state;
        const enqueuedMessage = submitted.message;
        void serialize(async () =>
          dispatchNativeInjection({
            message: enqueuedMessage,
            planner,
            projectDir,
            sessionId,
            getState: () => getState() ?? enqueuedState,
            setState,
            bus,
            ...(signal !== undefined && { signal }),
          }),
        ).catch((err) => warnError('queue-handler failed', err));
      }
      return submitted.result;
    } catch (err) {
      warnError('queue-handler failed', err);
      return {
        status: 'rejected',
        reason: 'phase-unavailable',
        message: 'Cannot queue message: workflow queue failed.',
      };
    }
  };
}
