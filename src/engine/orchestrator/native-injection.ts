import type { QueuedMessage, WorkflowState, OrchestratorCallbacks } from '../../types.js';
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
  if (!planner.capabilities.supportsMidStreamInjection) return;
  if (!planner.injectUserTurn) return;

  try {
    await planner.injectUserTurn(message.text, projectDir);
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
