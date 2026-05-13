import { randomUUID } from 'node:crypto';
import type { Phase } from '../../core/schemas/enums.js';
import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import type { Planner } from '../planners/types.js';
import type { EventBus } from '../events/types.js';
import { transitionAndSave } from './state-ops.js';
import { publishWarning } from './events.js';
import { appendMessage } from '../../core/state/persistence.js';
import { dispatchNativeInjection } from './native-injection.js';
import { warnError } from '../../lib/warn.js';

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
  const pending = state.messageQueue.filter(m => !m.drainedAt);
  if (pending.length >= MAX_QUEUE_SIZE) {
    publishWarning(bus, phase, `Queue full (${MAX_QUEUE_SIZE} messages). Wait for the current phase to complete.`);
    return { state, queued: false };
  }

  const message: QueuedMessage = {
    id: randomUUID(),
    text,
    queuedAt: new Date().toISOString(),
    phase,
    deliveredViaNative: false,
  };

  const next = transitionAndSave(projectDir, sessionId, state, { type: 'ENQUEUE_USER_MSG', message });
  appendMessage(projectDir, sessionId, { role: 'user', phase, text, queuedAt: message.queuedAt }, persistTranscript);
  bus.publish({ type: 'message_queued', ts: Date.now(), phase: next.phase, id: message.id });
  return { state: next, queued: true, message };
}

export function createQueueHandler(
  projectDir: string,
  sessionId: string,
  getState: () => WorkflowState | undefined,
  setState: (s: WorkflowState) => void,
  bus: EventBus,
  persistTranscript: boolean,
  planner: Planner,
): (text: string, phase: Phase) => void {
  return (text: string, phase: Phase) => {
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
    dispatchNativeInjection(result.message, planner, projectDir, sessionId, result.state, setState, bus)
      .catch(err => warnError('native-injection failed', err));
  };
}

export function clearPendingQueue(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  bus: EventBus,
): { state: WorkflowState; count: number } {
  const pending = state.messageQueue.filter(m => !m.drainedAt);
  if (pending.length === 0) return { state, count: 0 };

  const next = transitionAndSave(projectDir, sessionId, state, { type: 'CLEAR_QUEUE' });
  bus.publish({ type: 'queue_cleared', ts: Date.now(), phase: next.phase, count: pending.length });
  return { state: next, count: pending.length };
}

export function createClearQueueHandler(
  projectDir: string,
  sessionId: string,
  getState: () => WorkflowState | undefined,
  setState: (s: WorkflowState) => void,
  bus: EventBus,
): () => number {
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
  const pending = state.messageQueue.filter(m => !m.drainedAt);
  if (pending.length === 0) return { state, messages: [] };

  const next = transitionAndSave(projectDir, sessionId, state, { type: 'DRAIN_QUEUE' });
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
