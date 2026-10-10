import { randomUUID } from 'node:crypto';
import type { Phase } from '../../../core/schemas/enums.js';
import type { QueuedMessage, WorkflowState } from '../../../core/schemas/workflow.js';
import { isImplementerPhase, isLivePhase } from '../../../core/phases.js';
import { phaseStage } from '../../../core/rail-stages.js';
import { seatForRunningCall } from '../../../core/runners/seat-roles.js';
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
import { isQueuedMessagePendingFirstDelivery } from '../../../core/queue-state.js';
import type { QueueSubmissionResult } from '../types.js';
import { deliverToRunningCall } from '../../calls/steering.js';
import { absorbBuildCorrectionsById } from './build-corrections.js';
import {
  claimQueuedMessage,
  commitQueueMessagesDrained,
  readQueueForPrompt,
  releaseQueuedMessage,
} from './drain.js';
import { trackMidCallDelivery } from './mid-call.js';
import { formatMessageInput } from './prompt.js';
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
  steerable,
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

  const pending = base.messageQueue.filter(isQueuedMessagePendingFirstDelivery);
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
  const seat = phaseStage(phase);
  const taskId = seat === 'build' ? next.tasks[next.currentTaskIndex]?.id : undefined;
  bus.publish({
    type: 'message_queued',
    ts: Date.now(),
    phase: next.phase,
    id: message.id,
    ...(seat !== null && { seat }),
    ...(taskId !== undefined && { taskId }),
    ...(steerable !== undefined && { steerable }),
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
  const { projectDir, sessionId, getState, setState, bus, planner, serialize, signal, steering } =
    opts;
  const ref = { projectDir, sessionId };
  return async (message: UserMessageInput, phase: Phase) => {
    const attached = steering?.current() ?? null;
    const seat = phaseStage(phase);
    const call =
      attached !== null && seat !== null && seatForRunningCall(attached) === seat ? attached : null;
    const pendingDelivery = call === null ? undefined : Promise.withResolvers<void>();
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
            ...(call !== null && { steerable: true }),
          });
          if (pendingDelivery !== undefined && result.message !== undefined) {
            claimQueuedMessage(ref, result.message.id, 'mid-call');
            trackMidCallDelivery(ref, result.message.id, pendingDelivery.promise);
          }
          setState(result.state);
          return { result: result.result, message: result.message, state: result.state };
        },
      );
      if (submitted.result.status === 'accepted' && submitted.message && submitted.state) {
        const enqueuedState = submitted.state;
        const enqueuedMessage = submitted.message;
        const inject = () =>
          serialize(async () =>
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
          );
        if (call === null) {
          if (seat === 'plan') void inject().catch((err) => warnError('queue-handler failed', err));
        } else if (pendingDelivery !== undefined) {
          const delivery = Promise.resolve()
            .then(() => {
              const turn = {
                id: enqueuedMessage.id,
                text: formatMessageInput(enqueuedMessage),
                ...(enqueuedMessage.images.length > 0 && { images: enqueuedMessage.images }),
                ...(enqueuedMessage.attachedInputs.length > 0 && {
                  attachedInputs: enqueuedMessage.attachedInputs,
                }),
              };
              return deliverToRunningCall(call, turn);
            })
            .then(async (outcome) => {
              await serialize(() => {
                releaseQueuedMessage(ref, enqueuedMessage.id, 'mid-call');
                const current = rebaseOnPersistedWorkflowState(ref, getState() ?? enqueuedState, {
                  keepUnsaved: true,
                });
                if (!current.messageQueue.some((message) => message.id === enqueuedMessage.id))
                  return;
                const buildTask = current.tasks.find((task) => task.id === call.taskId);
                if (
                  outcome === 'uncertain' ||
                  (outcome === 'delivered' && seat === 'build' && buildTask === undefined)
                ) {
                  setState(
                    transitionAndSave(ref, current, {
                      type: 'MARK_POSSIBLE_DUPLICATE',
                      id: enqueuedMessage.id,
                    }),
                  );
                } else if (outcome === 'delivered') {
                  const taskId = call.taskId ?? undefined;
                  if (seat === 'build' && buildTask !== undefined) {
                    const correction = absorbBuildCorrectionsById({
                      ...ref,
                      state: current,
                      ids: [enqueuedMessage.id],
                      taskId: buildTask.id,
                      bus,
                      via: 'mid-call',
                    });
                    setState(correction.state);
                  } else if (seat === 'plan') {
                    const next = transitionAndSave(ref, current, {
                      type: 'MARK_DELIVERED_NATIVE',
                      id: enqueuedMessage.id,
                      via: 'mid-call',
                    });
                    setState(next);
                    bus.publish({
                      type: 'queue_drained',
                      ts: Date.now(),
                      phase: next.phase,
                      count: 1,
                      ids: [enqueuedMessage.id],
                      seat,
                      ...(taskId !== undefined && { taskId }),
                      via: 'mid-call',
                    });
                  } else {
                    const read = readQueueForPrompt({
                      ...ref,
                      state: current,
                      ids: [enqueuedMessage.id],
                    });
                    const drained = commitQueueMessagesDrained({
                      ...ref,
                      state: read.state,
                      messages: read.messages,
                      bus,
                      seat: 'review',
                      taskId,
                      via: 'mid-call',
                      destination: 'reviewer',
                    });
                    setState(drained.state);
                  }
                }
              });
              if (outcome === 'deferred' && seat === 'plan')
                void inject().catch((err) => warnError('queue-handler failed', err));
            })
            .finally(() => releaseQueuedMessage(ref, enqueuedMessage.id, 'mid-call'));
          void delivery.then(pendingDelivery.resolve, pendingDelivery.reject);
        }
      }
      return submitted.result;
    } catch (err) {
      pendingDelivery?.resolve();
      warnError('queue-handler failed', err);
      return {
        status: 'rejected',
        reason: 'phase-unavailable',
        message: 'Cannot queue message: workflow queue failed.',
      };
    }
  };
}
