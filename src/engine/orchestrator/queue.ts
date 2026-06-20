import { randomUUID } from 'node:crypto';
import type { Phase } from '../../core/schemas/enums.js';
import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import { isImplementerPhase, isLivePhase } from '../../core/phases.js';
import type { Planner } from '../planners/types.js';
import type { EventBus } from '../events/types.js';
import { mergePersistedMessageQueue, transitionAndSave } from './state-ops.js';
import { publishWarning } from './events.js';
import { appendMessage, saveState } from '../../core/state/persistence.js';
import { dispatchNativeInjection } from './native-injection.js';
import { warnError } from '../../lib/warn.js';
import { nowIso } from '../../utils/format-time.js';
import type { WriteSequencer } from './serial-executor.js';
import { formatQueuedMessagePreview } from '../../core/queue-preview.js';
import {
  isQueuedMessageClearable,
  isQueuedMessagePendingDelivery,
} from '../../core/queue-state.js';
import type { QueueClearResult, QueueSubmissionResult } from './types.js';

export const MAX_QUEUE_SIZE = 50;

export function enqueueUserMessage(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  text: string,
  phase: Phase,
  bus: EventBus,
  persistTranscript: boolean,
  opts: { enforcePhasePolicy?: boolean | undefined } = {},
): { state: WorkflowState; result: QueueSubmissionResult; message?: QueuedMessage | undefined } {
  const base = mergePersistedMessageQueue({ projectDir, sessionId }, state);
  if (opts.enforcePhasePolicy !== false && !canQueueInPhase(phase)) {
    const message = `Queue is only available while the planner is running; current phase is ${phase}.`;
    publishWarning({ bus, phase }, message);
    return { state: base, result: { status: 'rejected', reason: 'phase-unavailable', message } };
  }

  const pending = base.messageQueue.filter(isQueuedMessagePendingDelivery);
  if (pending.length >= MAX_QUEUE_SIZE) {
    const message = `Queue full (${MAX_QUEUE_SIZE} messages). Wait for the current phase to complete.`;
    publishWarning({ bus, phase }, message);
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
    persistTranscript,
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

export type QueueHandlerContext = {
  projectDir: string;
  sessionId: string;
  getState: () => WorkflowState | undefined;
  setState: (s: WorkflowState) => void;
  bus: EventBus;
};

export function createQueueHandler(
  opts: QueueHandlerContext & {
    persistTranscript: boolean;
    planner: Planner;
    serialize: WriteSequencer;
    signal?: AbortSignal | undefined;
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

          const result = enqueueUserMessage(
            projectDir,
            sessionId,
            state,
            text,
            phase,
            bus,
            persistTranscript,
          );
          setState(result.state);
          return { result: result.result, message: result.message, state: result.state };
        },
      );
      if (submitted.result.status === 'accepted' && submitted.message && submitted.state) {
        const enqueuedState = submitted.state;
        void dispatchNativeInjection({
          message: submitted.message,
          planner,
          projectDir,
          sessionId,
          getState: () => getState() ?? enqueuedState,
          setState,
          bus,
          ...(signal !== undefined && { signal }),
        }).catch((err) => warnError('queue-handler failed', err));
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

export function clearPendingQueue(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): { state: WorkflowState; count: number } {
  const base = mergePersistedMessageQueue({ projectDir, sessionId }, state);
  const pending = base.messageQueue.filter(isQueuedMessageClearable);
  if (pending.length === 0) return { state: base, count: 0 };

  const next = {
    ...base,
    messageQueue: base.messageQueue.filter((message) => !isQueuedMessageClearable(message)),
  };
  saveState({ projectDir, sessionId }, next);
  bus.publish({ type: 'queue_cleared', ts: Date.now(), phase: next.phase, count: pending.length });
  return { state: next, count: pending.length };
}

function canQueueInPhase(phase: Phase): boolean {
  return isLivePhase(phase) && !isImplementerPhase(phase);
}

export function createClearQueueHandler(ctx: QueueHandlerContext): () => QueueClearResult {
  const { projectDir, sessionId, getState, setState, bus } = ctx;
  return () => {
    const state = getState();
    if (!state) {
      return { status: 'unavailable', message: 'Cannot clear queue: no active workflow.' };
    }

    const result = clearPendingQueue(projectDir, sessionId, state, bus);
    setState(result.state);
    return { status: 'cleared', count: result.count };
  };
}

export function drainQueue(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): { state: WorkflowState; messages: QueuedMessage[] } {
  const base = mergePersistedMessageQueue({ projectDir, sessionId }, state);
  const pending = base.messageQueue.filter(isQueuedMessagePendingDelivery);
  if (pending.length === 0) return { state: base, messages: [] };

  const next = transitionAndSave({ projectDir, sessionId }, base, { type: 'DRAIN_QUEUE' });
  bus.publish({ type: 'queue_drained', ts: Date.now(), phase: next.phase, count: pending.length });

  return { state: next, messages: pending };
}

export function formatMessage(m: QueuedMessage): string {
  if (m.origin === 'clarification' && m.question) {
    return `[clarification answer during ${m.phase}]\nQ: ${m.question}\nA: ${m.text}\n[/clarification answer]`;
  }
  return `[user also says during ${m.phase}]\n${m.text}\n[/user also says]`;
}

export function formatDrainedMessages(messages: QueuedMessage[]): string {
  if (messages.length === 0) return '';
  const header = `\n\n---\n**User messages received while you were working** (${messages.length}):\n\n`;
  const body = messages.map((m, i) => `${i + 1}. ${formatMessage(m)}`).join('\n');
  return header + body + '\n---\n\n';
}
