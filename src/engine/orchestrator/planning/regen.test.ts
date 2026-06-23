import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialState, transition } from '../../../core/state/machine.js';
import { loadState } from '../../../core/state/persistence.js';
import { ensureSessionDir, writeSpecFile } from '../../../core/paths-io.js';
import { PLAN_FILE, SPEC_FILE } from '../../../core/paths.js';
import { cleanupTempDir, createTempDir } from '#testing/helpers/temp-dir.js';
import {
  makeBusRecorder,
  makeCallbacks,
  makePlanner,
  TEST_METADATA,
} from '#testing/helpers/orchestrator-factories.js';
import { REAL_TASKS_MD } from '#testing/helpers/planning-phase.js';
import { regeneratePlanAndTasks } from './regen.js';

let dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) cleanupTempDir(dir);
  dirs = [];
});

function setupProject(): { projectDir: string; sessionId: string } {
  const projectDir = createTempDir('regen-test');
  dirs.push(projectDir);
  const sessionId = 'sess-regen';
  ensureSessionDir(projectDir, sessionId);
  writeSpecFile({ projectDir, sessionId }, SPEC_FILE, '# Spec\n\nDraft.\n', null);
  writeSpecFile({ projectDir, sessionId }, PLAN_FILE, '# Plan\n\nDraft.\n', null);
  return { projectDir, sessionId };
}

function planningStateWithQueuedMessage() {
  let state = createInitialState('feature');
  state = transition(state, { type: 'START' });
  state = transition(state, { type: 'RESEARCH_DONE' });
  return {
    ...state,
    messageQueue: [
      {
        id: 'queued-1',
        text: 'include retry handling in regenerated briefs',
        queuedAt: new Date().toISOString(),
        phase: 'planning' as const,
        deliveredViaNative: false,
        nativeDeliveryState: 'pending' as const,
        origin: 'user-input' as const,
      },
    ],
  };
}

describe('regeneratePlanAndTasks', () => {
  it('leaves queued feedback pending when task regeneration fails after plan regeneration', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({ text: '# Plan\n\nRegenerated.\n', usage: null })
        .mockRejectedValueOnce(new Error('task regeneration failed')),
    });

    await expect(
      regeneratePlanAndTasks({
        projectDir,
        sessionId,
        planner,
        callbacks,
        bus,
        state: planningStateWithQueuedMessage(),
        metadata: TEST_METADATA,
      }),
    ).rejects.toThrow('task regeneration failed');

    const saved = loadState({ projectDir, sessionId });
    expect(saved?.messageQueue[0]?.drainedAt).toBeUndefined();
    expect(events.some((event) => event.type === 'queue_drained')).toBe(false);
  });

  it('commits queued feedback after plan and task regeneration both succeed', async () => {
    const { projectDir, sessionId } = setupProject();
    const { callbacks } = makeCallbacks();
    const { bus, events } = makeBusRecorder();
    const planner = makePlanner({
      review: vi
        .fn()
        .mockResolvedValueOnce({ text: '# Plan\n\nRegenerated.\n', usage: null })
        .mockResolvedValueOnce({ text: REAL_TASKS_MD, usage: null }),
    });

    const result = await regeneratePlanAndTasks({
      projectDir,
      sessionId,
      planner,
      callbacks,
      bus,
      state: planningStateWithQueuedMessage(),
      metadata: TEST_METADATA,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.state.messageQueue[0]?.drainedAt).toBeDefined();
    expect(events.some((event) => event.type === 'queue_drained' && event.count === 1)).toBe(true);
  });
});
