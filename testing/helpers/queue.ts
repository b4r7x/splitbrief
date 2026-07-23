import type { WorkflowState, QueuedMessage } from '../../src/core/schemas/workflow.js';
import { createInitialState, transition } from '../../src/core/state/machine.js';
import { ensureSessionDir } from '../../src/core/paths-io.js';
import { createTempDir } from './temp-dir.js';

export function setupProject(dirs: string[]): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('message-queue-test');
  dirs.push(projectDir);
  const sessionId = 'sess-msg-queue';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

export function makeResearchingState(): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START' });
  return state;
}

export function makeStateWithQueue(
  messages: Omit<QueuedMessage, 'deliveredViaNative' | 'nativeDeliveryState'>[],
): WorkflowState {
  let state = createInitialState('test-feature');
  state = transition(state, { type: 'START' });
  const fullMessages: QueuedMessage[] = messages.map((m) => ({
    ...m,
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
  }));
  return { ...state, messageQueue: fullMessages };
}

export function makeMessage(text = 'test message'): QueuedMessage {
  return {
    id: 'msg-test',
    text,
    queuedAt: new Date().toISOString(),
    phase: 'researching',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
  };
}
