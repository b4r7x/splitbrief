import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardIntegration, type TestGuard } from './guard.js';
import { createInitialState } from '../../src/state.js';
import { saveState, loadState } from '../../src/state-persistence.js';
import type { WorkflowState } from '../../src/types.js';
import { makeTask as makeTaskBase } from '../helpers/fixtures.js';

let g: TestGuard;

beforeAll(async () => {
  g = await guardIntegration();
});

function makeTask(id: string) {
  return makeTaskBase({ id, title: `Task ${id}`, file: `src/${id}.ts`, description: `Description for ${id}` });
}

describe('Resume with token preservation integration', () => {
  it('loaded state matches saved state exactly', { timeout: 10_000 }, async (t) => {
    if (g.skip) { t.skip(); return; }

    const tmpDir = await mkdtemp(join(tmpdir(), 'tiny-spec-resume-'));
    try {
      const tasks = [makeTask('t1'), makeTask('t2'), makeTask('t3'), makeTask('t4'), makeTask('t5')];

      const state: WorkflowState = {
        ...createInitialState('resume-feature'),
        phase: 'implementing',
        currentTaskIndex: 3,
        tasks,
        completedTasks: ['t1', 't2'],
        escalatedTasks: ['t3'],
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
      expect(loaded.phase).toBe('implementing');
      expect(loaded.currentTaskIndex).toBe(3);
      expect(loaded.feature).toBe('resume-feature');
      expect(loaded.completedTasks).toEqual(['t1', 't2']);
      expect(loaded.escalatedTasks).toEqual(['t3']);
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
