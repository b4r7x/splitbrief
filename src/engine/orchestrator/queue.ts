import { randomUUID } from 'node:crypto';
import type { Phase } from '../../core/schemas/enums.js';
import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import type { OrchestratorCallbacks } from './types.js';
import type { Planner } from '../planners/types.js';
import { transitionAndSave } from './state-ops.js';
import { emit } from './events.js';
import { appendMessage } from '../../core/state/persistence.js';
import { dispatchNativeInjection } from './native-injection.js';
import { warnError } from '../../lib/warn.js';

export const MAX_QUEUE_SIZE = 50;

export function createQueueHandler(
  projectDir: string,
  sessionId: string,
  getState: () => WorkflowState | undefined,
  setState: (s: WorkflowState) => void,
  callbacks: OrchestratorCallbacks,
  persistTranscript: boolean,
  planner: Planner,
): (text: string, phase: Phase) => void {
  return (text: string, phase: Phase) => {
    const state = getState();
    if (!state) return;

    const pending = state.messageQueue.filter(m => !m.drainedAt);
    if (pending.length >= MAX_QUEUE_SIZE) {
      callbacks.onEvent({ type: 'warning', ts: Date.now(), message: `Queue full (${MAX_QUEUE_SIZE} messages). Wait for the current phase to complete.` });
      return;
    }

    const message: QueuedMessage = {
      id: randomUUID(),
      text,
      queuedAt: new Date().toISOString(),
      phase,
      deliveredViaNative: false,
    };

    const next = transitionAndSave(projectDir, sessionId, state, { type: 'ENQUEUE_USER_MSG', message });
    setState(next);
    emit(projectDir, sessionId, next, 'message_queued', undefined, { id: message.id, phase });
    appendMessage(projectDir, sessionId, { role: 'user', text, queuedAt: message.queuedAt }, persistTranscript);
    callbacks.onEvent({ type: 'message-queued', ts: Date.now(), id: message.id, phase });

    dispatchNativeInjection(message, planner, projectDir, sessionId, next, setState, callbacks)
      .catch(err => warnError('native-injection failed', err));
  };
}

export function drainQueue(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  callbacks: OrchestratorCallbacks,
): { state: WorkflowState; messages: QueuedMessage[] } {
  const pending = state.messageQueue.filter(m => !m.drainedAt);
  if (pending.length === 0) return { state, messages: [] };

  const next = transitionAndSave(projectDir, sessionId, state, { type: 'DRAIN_QUEUE' });
  emit(projectDir, sessionId, next, 'queue_drained', undefined, { count: pending.length });
  callbacks.onEvent({ type: 'queue-drained', ts: Date.now(), count: pending.length });

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
