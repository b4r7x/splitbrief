import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardIntegration } from './guard.js';
import { createInitialState } from '../../src/core/state/machine.js';
import { saveState, loadState } from '../../src/core/state/persistence.js';
import { getCompletedTaskIds, getEscalatedTaskIds } from '../../src/core/state/selectors.js';
import type { WorkflowState } from '../../src/types.js';
import { makeTask } from '../helpers/fixtures.js';

describe('Resume with token preservation integration', () => {
  it('loaded state matches saved state exactly', { timeout: 10_000 }, async (t) => {
    const g = await guardIntegration();
    if (g.skip) { t.skip(); return; }

    const tmpDir = await mkdtemp(join(tmpdir(), 'tiny-spec-resume-'));
    try {
      const tasks = [
        makeTask({ id: 't1', title: 'Task t1', file: 'src/t1.ts', description: 'Description for t1', status: 'done' }),
        makeTask({ id: 't2', title: 'Task t2', file: 'src/t2.ts', description: 'Description for t2', status: 'done' }),
        makeTask({ id: 't3', title: 'Task t3', file: 'src/t3.ts', description: 'Description for t3', status: 'escalated' }),
        makeTask({ id: 't4', title: 'Task t4', file: 'src/t4.ts', description: 'Description for t4' }),
        makeTask({ id: 't5', title: 'Task t5', file: 'src/t5.ts', description: 'Description for t5' }),
      ];

      const state: WorkflowState = {
        ...createInitialState('resume-feature'),
        phase: 'implementing',
        currentTaskIndex: 3,
        tasks,
        tokenUsage: {
          plannerInput: 5000,
          plannerOutput: 2500,
          implementerInput: 12000,
          implementerOutput: 6000,
          escalationInput: 800,
          escalationOutput: 400,
        },
      };

      saveState(tmpDir, state);
      const loaded = loadState(tmpDir);

      expect(loaded).toBeTruthy();
      if (!loaded) throw new Error('expected loaded state');
      expect(loaded.phase).toBe('implementing');
      expect(loaded.currentTaskIndex).toBe(3);
      expect(loaded.feature).toBe('resume-feature');
      expect(getCompletedTaskIds(loaded)).toEqual(['t1', 't2']);
      expect(getEscalatedTaskIds(loaded)).toEqual(['t3']);
      expect(loaded.tasks.length).toBe(5);
      expect(loaded.tokenUsage.plannerInput).toBe(5000);
      expect(loaded.tokenUsage.plannerOutput).toBe(2500);
      expect(loaded.tokenUsage.implementerInput).toBe(12000);
      expect(loaded.tokenUsage.implementerOutput).toBe(6000);
      expect(loaded.tokenUsage.escalationInput).toBe(800);
      expect(loaded.tokenUsage.escalationOutput).toBe(400);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
