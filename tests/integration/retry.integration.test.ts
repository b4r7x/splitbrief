import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { guardIntegration, type TestGuard } from './guard.js';
import { createInitialState, transition } from '../../src/state.js';
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

describe('Retry flow integration', () => {
  it('exhausting retries transitions to escalating', { timeout: 10_000 }, async (t) => {
    if (g.skip) return t.skip(g.skip);

    const tasks = [makeTask('t1'), makeTask('t2')];
    let state: WorkflowState = {
      ...createInitialState('retry-test'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
      attempt: 0,
    };

    // attempt < maxRetries keeps retrying; attempt >= maxRetries escalates
    // maxRetries=3: attempts 0,1,2 retry (increment), attempt 3 escalates
    for (let i = 0; i < 3; i++) {
      state = transition(state, { type: 'TASK_SENT' });
      assert.equal(state.phase, 'validating-task');
      state = transition(state, { type: 'VALIDATION_FAIL' }, 3);
      assert.equal(state.phase, 'implementing', `Attempt ${i} should stay implementing`);
      assert.equal(state.attempt, i + 1);
    }

    // 4th attempt: attempt=3 >= maxRetries=3, should escalate
    state = transition(state, { type: 'TASK_SENT' });
    assert.equal(state.phase, 'validating-task');
    state = transition(state, { type: 'VALIDATION_FAIL' }, 3);
    assert.equal(state.phase, 'escalating', 'Should escalate after max retries exhausted');
  });

  it('HINT_SUCCESS after escalation returns to implementing', { timeout: 10_000 }, async (t) => {
    if (g.skip) return t.skip(g.skip);

    const tasks = [makeTask('t1'), makeTask('t2')];
    let state: WorkflowState = {
      ...createInitialState('hint-test'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };

    state = transition(state, { type: 'HINT_SUCCESS' });
    assert.equal(state.phase, 'implementing');
    assert.equal(state.currentTaskIndex, 1);
    assert.equal(state.attempt, 0);
    assert.deepEqual(state.completedTasks, ['t1']);
  });

  it('HINT_FAIL then FULL_SUCCESS completes the task as escalated', { timeout: 10_000 }, async (t) => {
    if (g.skip) return t.skip(g.skip);

    const tasks = [makeTask('t1'), makeTask('t2')];
    let state: WorkflowState = {
      ...createInitialState('full-escalation-test'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };

    state = transition(state, { type: 'HINT_FAIL' });
    assert.equal(state.phase, 'escalating');

    state = transition(state, { type: 'FULL_SUCCESS' });
    assert.equal(state.phase, 'implementing');
    assert.equal(state.currentTaskIndex, 1);
    assert.equal(state.attempt, 0);
    assert.deepEqual(state.escalatedTasks, ['t1']);
    assert.deepEqual(state.completedTasks, []);
  });
});
