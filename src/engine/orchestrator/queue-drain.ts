import type { WorkflowState, OrchestratorCallbacks, QueuedMessage } from '../../types.js';
import { transitionAndSave } from './helpers.js';
import { emit } from './events.js';

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
