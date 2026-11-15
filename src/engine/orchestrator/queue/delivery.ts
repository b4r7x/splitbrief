import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import type { QueuedMessage } from '../../../core/schemas/workflow/queue.js';
import type { messageSeat } from '../../../core/queue/state.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { warnError } from '../../../lib/warn.js';
import type { WriteSequencer } from '../../../utils/serial-executor.js';
import { deliverToRunningCall, type RunningCall, type SteerOutcome } from '../../calls/steering.js';
import { transitionAndSave } from '../state-ops/transition.js';
import { rebaseOnPersistedWorkflowState } from '../state-ops/head.js';
import type { WorkflowContext } from '../types.js';
import { absorbBuildCorrectionsById } from './build-corrections.js';
import { commitQueueMessagesDrained, readQueueForPrompt, releaseQueuedMessage } from './drain.js';
import { formatMessageInput } from './prompt.js';
import type { QueueHandlerContext } from './types.js';

type MidCallDelivery = Pick<QueueHandlerContext, 'getState' | 'setState' | 'bus'> &
  Pick<WorkflowContext, 'config' | 'modelCache'> & {
    ref: SessionRef;
    call: RunningCall;
    seat: ReturnType<typeof messageSeat>;
    message: QueuedMessage;
    enqueuedState: WorkflowState;
    serialize: WriteSequencer;
    /** The planner fallback for a message the running call deferred. */
    inject: () => Promise<unknown>;
  };

/**
 * Sends a queued message into the running call of its seat, then records what the call did with
 * it. A deferred message of the plan seat goes to the planner fallback.
 */
export function deliverMidCall(input: MidCallDelivery): Promise<void> {
  const { ref, call, seat, message } = input;
  return Promise.resolve()
    .then(() => {
      const turn = {
        id: message.id,
        text: formatMessageInput(message),
        ...(message.images.length > 0 && { images: message.images }),
        ...(message.attachedInputs.length > 0 && { attachedInputs: message.attachedInputs }),
      };
      return deliverToRunningCall(call, turn);
    })
    .then(async (outcome) => {
      await input.serialize(() => recordDeliveryOutcome(input, outcome));
      if (outcome === 'deferred' && seat === 'plan')
        void input.inject().catch((err) => warnError('Could not deliver your queued message', err));
    })
    .finally(() => releaseQueuedMessage(ref, message.id, 'mid-call'));
}

function recordDeliveryOutcome(input: MidCallDelivery, outcome: SteerOutcome): void {
  const { ref, call, seat, message, bus, setState } = input;
  releaseQueuedMessage(ref, message.id, 'mid-call');
  const current = rebaseOnPersistedWorkflowState(ref, input.getState() ?? input.enqueuedState, {
    keepUnsaved: true,
  });
  if (!current.messageQueue.some((queued) => queued.id === message.id)) return;
  const buildTask = current.tasks.find((task) => task.id === call.taskId);
  if (
    outcome === 'uncertain' ||
    (outcome === 'delivered' && seat === 'build' && buildTask === undefined)
  ) {
    setState(transitionAndSave(ref, current, { type: 'MARK_POSSIBLE_DUPLICATE', id: message.id }));
  } else if (outcome === 'delivered') {
    const taskId = call.taskId ?? undefined;
    if (seat === 'build' && buildTask !== undefined) {
      const correction = absorbBuildCorrectionsById({
        ...ref,
        state: current,
        ids: [message.id],
        taskId: buildTask.id,
        bus,
        config: input.config,
        modelCache: input.modelCache,
        via: 'mid-call',
      });
      setState(correction.state);
    } else if (seat === 'plan') {
      const next = transitionAndSave(ref, current, {
        type: 'MARK_DELIVERED_NATIVE',
        id: message.id,
        via: 'mid-call',
      });
      setState(next);
      bus.publish({
        type: 'queue_drained',
        ts: Date.now(),
        phase: next.phase,
        count: 1,
        ids: [message.id],
        seat,
        ...(taskId !== undefined && { taskId }),
        via: 'mid-call',
      });
    } else {
      const read = readQueueForPrompt({ ...ref, state: current, ids: [message.id] });
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
}
