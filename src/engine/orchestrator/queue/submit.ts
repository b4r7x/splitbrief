import { randomUUID } from 'node:crypto';
import type { Phase } from '../../../core/schemas/enums.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import { isImplementerPhase, isLivePhase } from '../../../core/phases.js';
import type { Planner } from '../../planners/types.js';
import { rebaseOnPersistedWorkflowState, transitionAndSave } from '../state-ops.js';
import { publishWarning } from '../events.js';
import { appendMessage } from '../../../core/sessions/log-writer.js';
import { dispatchNativeInjection, type RecoveryQueueBinding } from './native-injection.js';
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

function canQueueInPhase(phase: Phase): boolean {
  return isLivePhase(phase) && !isImplementerPhase(phase);
}

export function enqueueUserMessage({
  projectDir,
  sessionId,
  state,
  text,
  phase,
  bus,
  persistTranscript,
  enforcePhasePolicy = true,
}: EnqueueUserMessageOptions): {
  state: WorkflowState;
  result: QueueSubmissionResult;
  message?: QueuedMessage | undefined;
} {
  const base = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, state);
  if (enforcePhasePolicy && !canQueueInPhase(phase)) {
    const message = `Queue is only available while the planner is running; current phase is ${phase}.`;
    publishWarning({
      bus,
      phase,
      message,
      safety: {
        category: 'queue',
        code: 'phase_unavailable',
        transcriptSafe: true,
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
        transcriptSafe: true,
      },
    });
    return { state: base, result: { status: 'rejected', reason: 'queue-full', message } };
  }

  const message: QueuedMessage = {
    id: randomUUID(),
    text,
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
  appendMessage(
    { projectDir, sessionId },
    { role: 'user', phase, text, queuedAt: message.queuedAt, queueMessageId: message.id },
    { persistTranscript },
  );
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
    persistTranscript: boolean;
    planner: Planner;
    serialize: WriteSequencer;
    signal?: AbortSignal | undefined;
    recovery?: RecoveryQueueBinding | undefined;
  },
): (text: string, phase: Phase) => Promise<QueueSubmissionResult> {
  const {
    projectDir,
    sessionId,
    getState,
    setState,
    bus,
    persistTranscript,
    planner,
    serialize,
    signal,
    recovery,
  } = opts;
  return async (text: string, phase: Phase) => {
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
            text,
            phase,
            bus,
            persistTranscript,
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
            ...(recovery !== undefined && { recovery }),
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
