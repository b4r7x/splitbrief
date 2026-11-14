import { isQueuePhase, isLivePhase } from '../../../core/phases/roles.js';
import { formatQueuedMessagePreview } from '../../../core/queue/preview.js';
import {
  messageSeat,
  isQueuedMessagePendingFirstDelivery,
  queuedUserMessage,
} from '../../../core/queue/state.js';
import { noWordsRefusal } from '../../../core/recovery/typed-words.js';
import type { QueuedMessage } from '../../../core/schemas/workflow/queue.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { resumeStep } from '../../../core/sessions/run/status.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import { recordUserMessage } from '../transcript/user-message.js';
import type { QueueSubmissionResult } from '../types.js';
import { type EnqueueUserMessageOptions, MAX_QUEUE_SIZE } from './types.js';

export function enqueueUserMessage({
  projectDir,
  sessionId,
  state,
  message: input,
  phase,
  bus,
  reviewNone,
  enforcePhasePolicy = true,
  steerable,
}: EnqueueUserMessageOptions): {
  state: WorkflowState;
  result: QueueSubmissionResult;
  message?: QueuedMessage | undefined;
} {
  const base = rebaseOnPersistedWorkflowState({ projectDir, sessionId }, state, {
    keepUnsaved: true,
  });
  if (enforcePhasePolicy && !isQueuePhase(phase)) {
    return {
      state: base,
      result: {
        status: 'rejected',
        reason: 'phase-unavailable',
        message: 'The queue takes a message only while a run is live.',
      },
    };
  }

  const seat = messageSeat(
    phase,
    base.pendingScheduledReview !== undefined,
    reviewNone,
    base.tasks[base.currentTaskIndex] !== undefined,
  );
  if (enforcePhasePolicy && seat === null && isLivePhase(phase)) {
    return {
      state: base,
      result: {
        status: 'rejected',
        reason: 'phase-unavailable',
        message: noWordsRefusal(resumeStep(base, reviewNone)),
      },
    };
  }

  const pending = base.messageQueue.filter(isQueuedMessagePendingFirstDelivery);
  if (pending.length >= MAX_QUEUE_SIZE) {
    return {
      state: base,
      result: {
        status: 'rejected',
        reason: 'queue-full',
        message: `Queue full (${MAX_QUEUE_SIZE} messages). Wait for the current phase to complete.`,
      },
    };
  }

  const message = queuedUserMessage(input, phase);

  const next = transitionAndSave({ projectDir, sessionId }, base, {
    type: 'ENQUEUE_USER_MSG',
    message,
  });
  recordUserMessage({ projectDir, sessionId, bus, phase }, input, { queuedMessage: message });
  const preview = formatQueuedMessagePreview(message);
  const brief = seat === 'build' ? next.tasks[next.currentTaskIndex] : undefined;
  const taskId = brief?.id;
  const starting = seat === 'build' && brief?.status === 'pending' ? true : undefined;
  bus.publish({
    type: 'message_queued',
    ts: Date.now(),
    phase: next.phase,
    id: message.id,
    ...(seat !== null && { seat }),
    ...(taskId !== undefined && { taskId }),
    ...(starting !== undefined && { starting }),
    ...(steerable !== undefined && { steerable }),
    ...(preview.length > 0 && { preview }),
  });
  return {
    state: next,
    result: { status: 'accepted', messageId: message.id, ...(preview.length > 0 && { preview }) },
    message,
  };
}
