import { randomUUID } from 'node:crypto';
import type { Phase, QueuedMessage, WorkflowState } from '../../core/types/state-actions.js';
import type { OrchestratorCallbacks } from '../../core/types/events.js';
import type { Planner } from '../planners/types.js';
import { transitionAndSave } from './helpers.js';
import { emit } from './events.js';
import { appendMessage } from '../../core/state/persistence.js';
import { dispatchNativeInjection } from './native-injection.js';

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

    // Fire-and-forget: attempt native mid-stream injection for planners that support it.
    void dispatchNativeInjection(message, planner, projectDir, sessionId, next, setState, callbacks);
  };
}
