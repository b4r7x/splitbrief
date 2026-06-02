import { randomUUID } from 'node:crypto';
import type { Phase } from '../../core/schemas/enums.js';
import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import type { Planner } from '../planners/types.js';
import type { EventBus } from '../events/types.js';
import { mergePersistedMessageQueue, transitionAndSave } from './state-ops.js';
import { publishWarning } from './events.js';
import { appendMessage } from '../../core/state/persistence.js';
import { dispatchNativeInjection } from './native-injection.js';
import { warnError } from '../../lib/warn.js';
import { nowIso } from '../../utils/format-time.js';
import type { StateSerializer } from './state-serializer.js';

export const MAX_QUEUE_SIZE = 50;

export function enqueueUserMessage(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  text: string,
  phase: Phase,
  bus: EventBus,
  persistTranscript: boolean,
): { state: WorkflowState; queued: boolean; message?: QueuedMessage | undefined } {
  const base = mergePersistedMessageQueue({ projectDir, sessionId }, state);
  const pending = base.messageQueue.filter((m) => !m.drainedAt);
  if (pending.length >= MAX_QUEUE_SIZE) {
    publishWarning(
      { bus: bus, phase: phase },
      `Queue full (${MAX_QUEUE_SIZE} messages). Wait for the current phase to complete.`,
    );
    return { state: base, queued: false };
  }

  const message: QueuedMessage = {
    id: randomUUID(),
    text,
    queuedAt: nowIso(),
    phase,
    deliveredViaNative: false,
  };

  const next = transitionAndSave({ projectDir, sessionId }, base, {
    type: 'ENQUEUE_USER_MSG',
    message,
  });
  appendMessage(
    { projectDir, sessionId },
    { role: 'user', phase, text, queuedAt: message.queuedAt },
    persistTranscript,
  );
  bus.publish({ type: 'message_queued', ts: Date.now(), phase: next.phase, id: message.id });
  return { state: next, queued: true, message };
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
    serialize: StateSerializer;
  },
): (text: string, phase: Phase) => void {
  const { projectDir, sessionId, getState, setState, bus, persistTranscript, planner, serialize } =
    opts;
  return (text: string, phase: Phase) => {
    serialize(async () => {
      const state = getState();
      if (!state) return;

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
      if (!result.message) return;
      await dispatchNativeInjection({
        message: result.message,
        planner,
        projectDir,
        sessionId,
        getState: () => getState() ?? result.state,
        setState,
        bus,
      });
    }).catch((err) => warnError('queue-handler failed', err));
  };
}

export function clearPendingQueue(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): { state: WorkflowState; count: number } {
  const base = mergePersistedMessageQueue({ projectDir, sessionId }, state);
  const pending = base.messageQueue.filter((m) => !m.drainedAt);
  if (pending.length === 0) return { state: base, count: 0 };

  const next = transitionAndSave({ projectDir, sessionId }, base, { type: 'CLEAR_QUEUE' });
  bus.publish({ type: 'queue_cleared', ts: Date.now(), phase: next.phase, count: pending.length });
  return { state: next, count: pending.length };
}

export function createClearQueueHandler(ctx: QueueHandlerContext): () => number {
  const { projectDir, sessionId, getState, setState, bus } = ctx;
  return () => {
    const state = getState();
    if (!state) return 0;

    const result = clearPendingQueue(projectDir, sessionId, state, bus);
    setState(result.state);
    return result.count;
  };
}

export function drainQueue(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): { state: WorkflowState; messages: QueuedMessage[] } {
  const base = mergePersistedMessageQueue({ projectDir, sessionId }, state);
  const pending = base.messageQueue.filter((m) => !m.drainedAt);
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
