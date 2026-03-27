import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardIntegration, type TestGuard } from './guard.js';
import { createInitialState, saveState, loadState } from '../../src/state.js';
import type { Task, WorkflowState } from '../../src/types.js';

let g: TestGuard;

before(async () => {
  g = await guardIntegration();
});

function makeTask(id: string): Task {
  return {
    id,
    title: `Task ${id}`,
    action: 'create',
    file: `src/${id}.ts`,
    dependsOn: [],
    description: `Description for ${id}`,
    tests: [],
    constraints: [],
    status: 'pending',
  };
}

describe('Resume with token preservation integration', () => {
  it('loaded state matches saved state exactly', { timeout: 10_000 }, async (t) => {
    if (g.skip) return t.skip(g.skip);

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

      assert.ok(loaded, 'Expected state to be loaded');
      assert.equal(loaded.phase, 'implementing');
      assert.equal(loaded.currentTaskIndex, 3);
      assert.equal(loaded.feature, 'resume-feature');
      assert.deepEqual(loaded.completedTasks, ['t1', 't2']);
      assert.deepEqual(loaded.escalatedTasks, ['t3']);
      assert.equal(loaded.tasks.length, 5);
      assert.equal(loaded.tokenUsage.plannerInput, 5000);
      assert.equal(loaded.tokenUsage.plannerOutput, 2500);
      assert.equal(loaded.tokenUsage.implementerInput, 12000);
      assert.equal(loaded.tokenUsage.implementerOutput, 6000);
      assert.equal(loaded.tokenUsage.escalationInput, 800);
      assert.equal(loaded.tokenUsage.escalationOutput, 400);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
