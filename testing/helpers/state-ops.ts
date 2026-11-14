import type { QueuedMessage } from '../../src/core/schemas/workflow/queue.js';
import type { WorkflowState } from '../../src/core/schemas/workflow/state.js';
import { ensureSessionDir } from '../../src/core/sessions/spec-files.js';
import { createInitialState } from '../../src/core/state/machine.js';
import { plainUserMessage } from '../../src/core/types/user-input.js';
import { createTempDir } from './temp-dir.js';

export function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('state-ops-test');
  const sessionId = 'sess-state-ops';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

export function makeState(overrides?: Partial<WorkflowState>): WorkflowState {
  return { ...createInitialState('test'), phase: 'implementing', ...overrides };
}

export function makeQueuedMessage(): QueuedMessage {
  return {
    id: 'msg-one',
    ...plainUserMessage('queued while planner was running'),
    queuedAt: '2026-05-27T04:00:00.000Z',
    phase: 'researching',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
  };
}
