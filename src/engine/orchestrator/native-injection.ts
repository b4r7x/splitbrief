import type { QueuedMessage, WorkflowState } from '../../core/types/state-actions.js';
import type { OrchestratorCallbacks } from '../../core/types/events.js';
import type { Planner } from '../planners/types.js';
import { transitionAndSave } from './helpers.js';
import { emit } from './events.js';

export async function dispatchNativeInjection(
  message: QueuedMessage,
  planner: Planner,
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  setState: (s: WorkflowState) => void,
  callbacks: OrchestratorCallbacks,
): Promise<void> {
  if (!planner.injectUserTurn) return;

  try {
    const injectionText = message.origin === 'clarification' && message.question
      ? `[clarification answer]\nQ: ${message.question}\nA: ${message.text}\n[/clarification answer]`
      : message.text;
    await planner.injectUserTurn(injectionText, projectDir);
    const next = transitionAndSave(projectDir, sessionId, state, {
      type: 'MARK_DELIVERED_NATIVE',
      id: message.id,
    });
    setState(next);
    emit(projectDir, sessionId, next, 'message_injected_native', undefined, { id: message.id });
    callbacks.onEvent({ type: 'message-injected-native', ts: Date.now(), id: message.id });
  } catch {
    // Fire-and-forget — failure is not fatal, message stays in queue for drain
  }
}
