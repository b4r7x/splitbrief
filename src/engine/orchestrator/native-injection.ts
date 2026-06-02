import type { QueuedMessage, WorkflowState } from '../../core/schemas/workflow.js';
import type { Planner } from '../planners/types.js';
import type { EventBus } from '../events/types.js';
import { transitionAndSave } from './state-ops.js';
import { publishWarningFromError } from './events.js';

export type DispatchNativeInjectionOptions = {
  message: QueuedMessage;
  planner: Planner;
  projectDir: string;
  sessionId: string;
  getState: () => WorkflowState;
  setState: (s: WorkflowState) => void;
  bus: EventBus;
};

export async function dispatchNativeInjection(opts: DispatchNativeInjectionOptions): Promise<void> {
  const { message, planner, projectDir, sessionId, getState, setState, bus } = opts;
  if (!planner.injectUserTurn) return;

  try {
    const injectionText =
      message.origin === 'clarification' && message.question
        ? `[clarification answer]\nQ: ${message.question}\nA: ${message.text}\n[/clarification answer]`
        : message.text;
    await planner.injectUserTurn(injectionText, projectDir);
    const next = transitionAndSave({ projectDir, sessionId }, getState(), {
      type: 'MARK_DELIVERED_NATIVE',
      id: message.id,
    });
    setState(next);
    bus.publish({
      type: 'message_injected_native',
      ts: Date.now(),
      phase: next.phase,
      id: message.id,
    });
  } catch (err) {
    publishWarningFromError({ bus, phase: getState().phase }, 'native injection failed', err);
  }
}
