import type { Phase } from '../../../core/schemas/enums.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { QueuedMessage } from '../../../core/schemas/workflow/queue.js';
import { seatForRunningCall } from '../../../core/runners/seat-roles.js';
import type { Planner } from '../../planners/types.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import type { UserMessageInput } from '../../../core/types/user-input.js';
import { dispatchNativeInjection } from './native-injection.js';
import { warnError } from '../../../lib/warn.js';
import type { WriteSequencer } from '../../../utils/serial-executor.js';
import { messageSeat } from '../../../core/queue/state.js';
import { resolveReviewCadence } from '../../../core/config/runtime/resolve.js';
import type { QueueSubmissionResult, WorkflowContext } from '../types.js';
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
import type { QueueHandlerContext } from './types.js';
import { enqueueUserMessage } from './enqueue.js';

export function createQueueHandler(
  opts: QueueHandlerContext &
    Pick<WorkflowContext, 'config' | 'modelCache'> & {
      planner: Planner;
      serialize: WriteSequencer;
      signal?: AbortSignal | undefined;
    },
): (message: UserMessageInput, phase: Phase) => Promise<QueueSubmissionResult> {
  const { projectDir, sessionId, getState, setState, bus, planner, serialize, signal, steering } =
    opts;
  const ref = { projectDir, sessionId };
  const reviewNone = resolveReviewCadence(opts.config) === 'none';
  return async (message: UserMessageInput, phase: Phase) => {
    const attached = steering?.current() ?? null;
    const current = getState();
    const seat = messageSeat(
      phase,
      current?.pendingScheduledReview !== undefined,
      reviewNone,
      current?.tasks[current.currentTaskIndex] !== undefined,
    );
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
            reviewNone,
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
          if (seat === 'plan')
            void inject().catch((err) => warnError('Could not deliver your queued message', err));
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
                      config: opts.config,
                      modelCache: opts.modelCache,
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
                void inject().catch((err) =>
                  warnError('Could not deliver your queued message', err),
                );
            })
            .finally(() => releaseQueuedMessage(ref, enqueuedMessage.id, 'mid-call'));
          void delivery.then(pendingDelivery.resolve, pendingDelivery.reject);
        }
      }
      return submitted.result;
    } catch (err) {
      pendingDelivery?.resolve();
      warnError('Could not queue your message', err);
      return {
        status: 'rejected',
        reason: 'failed',
        message: 'Cannot queue message: workflow queue failed.',
      };
    }
  };
}
