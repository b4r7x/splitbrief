import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import type { Planner } from '../planners/types.js';
import type { EventBus } from '../events/types.js';
import { transitionAndSave } from './state-ops.js';
import { publishEvent } from './events.js';

export async function dispatchNativeInjection(
  message: QueuedMessage,
  planner: Planner,
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  setState: (s: WorkflowState) => void,
  bus: EventBus,
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
    publishEvent(bus, { type: 'message_injected_native', ts: Date.now(), phase: next.phase, id: message.id });
  } catch {
    // Fire-and-forget — failure is not fatal, message stays in queue for drain
  }
}
