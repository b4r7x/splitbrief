import { describe, expect, it } from 'vitest';
import { makeUsage } from '#testing/helpers/factories/summary.js';
import { makeBusRecorder } from '#testing/helpers/orchestrator-factories.js';
import { makeQueuedMessage, makeState, setupProject } from '#testing/helpers/state-ops.js';
import { cleanupTempDir } from '#testing/helpers/temp-dir.js';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState, saveState } from '../../../core/state/persistence.js';
import { addUsageAndSave } from './usage.js';

describe('addUsageAndSave', () => {
  it('accumulates token usage into the new state and emits a cost-update event', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const state = makeState({ tokenUsage: makeUsage({ plannerInput: 100, plannerOutput: 50 }) });
      const { bus, events } = makeBusRecorder();

      const result = addUsageAndSave({ projectDir, sessionId, bus }, state, 'planner', {
        inputTokens: 200,
        outputTokens: 100,
      });

      expect(result.tokenUsage.plannerInput).toBe(300);
      expect(result.tokenUsage.plannerOutput).toBe(150);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'cost_update' });
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('returns the same state instance and emits nothing when usage is null', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const state = makeState();
      const { bus, events } = makeBusRecorder();

      const result = addUsageAndSave({ projectDir, sessionId, bus }, state, 'implementer', null);

      expect(result).toBe(state);
      expect(events).toHaveLength(0);
    } finally {
      cleanupTempDir(projectDir);
    }
  });

  it('rebases interleaved planner bookings on the latest ledger and workflow fields while merging queues', () => {
    const { projectDir, sessionId } = setupProject();
    try {
      const ref = { projectDir, sessionId };
      const { bus } = makeBusRecorder();
      const firstMessage = makeQueuedMessage();
      const secondMessage = { ...firstMessage, id: 'msg-two', text: 'another queued message' };
      const persisted = transition(createInitialState('feature'), { type: 'START' });
      saveState(ref, persisted);

      const stale = { ...persisted, messageQueue: [firstMessage, secondMessage] };
      addUsageAndSave({ ...ref, bus }, stale, 'planner', {
        inputTokens: 100,
        outputTokens: 25,
      });

      const afterFirst = loadState(ref);
      if (!afterFirst) throw new Error('expected first usage booking to persist');
      saveState(ref, { ...afterFirst, phase: 'planning', plannerSessionId: 'latest-planner' });

      const result = addUsageAndSave({ ...ref, bus }, stale, 'planner', {
        inputTokens: 200,
        outputTokens: 50,
      });
      const saved = loadState(ref);

      expect(result.tokenUsage.plannerInput).toBe(300);
      expect(result.tokenUsage.plannerOutput).toBe(75);
      expect(result.phase).toBe('planning');
      expect(result.plannerSessionId).toBe('latest-planner');
      expect(result.messageQueue.map((message) => message.id)).toEqual(['msg-one', 'msg-two']);
      expect(saved?.tokenUsage).toMatchObject({ plannerInput: 300, plannerOutput: 75 });
      expect(saved?.phase).toBe('planning');
      expect(saved?.plannerSessionId).toBe('latest-planner');
    } finally {
      cleanupTempDir(projectDir);
    }
  });
});
