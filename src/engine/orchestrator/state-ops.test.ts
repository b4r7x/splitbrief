import { describe, expect, it } from 'vitest';
import type { QueuedMessage } from '../../core/schemas/workflow.js';
import { createInitialState, transition } from '../../core/state/machine.js';
import { saveState } from '../../core/state/persistence.js';
import { ensureSessionDir } from '../../core/paths-io.js';
import { createTempDir, cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { transitionAndSave } from './state-ops.js';

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('state-ops-test');
  const sessionId = 'sess-state-ops';
  ensureSessionDir(projectDir, sessionId);
  return { projectDir, sessionId };
}

function makeQueuedMessage(): QueuedMessage {
  return {
    id: 'msg-one',
    text: 'queued while planner was running',
    queuedAt: '2026-05-27T04:00:00.000Z',
    phase: 'researching',
    deliveredViaNative: false,
  };
}

describe('transitionAndSave', () => {
  it('applies transitions to the latest persisted state so queued messages are not lost', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      let staleState = createInitialState('feature');
      staleState = transition(staleState, { type: 'START' });
      saveState({ projectDir, sessionId }, { ...staleState, messageQueue: [makeQueuedMessage()] });

      const next = transitionAndSave({ projectDir, sessionId }, staleState, {
        type: 'RESEARCH_DONE',
      });

      expect(next.phase).toBe('specifying');
      expect(next.messageQueue).toEqual([expect.objectContaining({ id: 'msg-one' })]);
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
