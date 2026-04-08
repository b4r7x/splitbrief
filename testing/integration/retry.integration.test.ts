import { describe, it, expect, beforeAll } from 'vitest';
import { guardIntegration, type TestGuard } from './guard.js';
import { createInitialState, transition } from '../../src/core/state/machine.js';
import type { WorkflowState } from '../../src/types.js';
import { makeTask } from '../helpers/fixtures.js';

let g: TestGuard;

beforeAll(async () => {
  g = await guardIntegration();
});

describe('Retry flow integration', () => {
  it('exhausting retries transitions to escalating', { timeout: 10_000 }, async (t) => {
    if (g.skip) { t.skip(); return; }

    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
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
      expect(state.phase).toBe('validating-task');
      state = transition(state, { type: 'VALIDATION_FAIL' }, 3);
      expect(state.phase).toBe('implementing');
      expect(state.attempt).toBe(i + 1);
    }

    // 4th attempt: attempt=3 >= maxRetries=3, should escalate
    state = transition(state, { type: 'TASK_SENT' });
    expect(state.phase).toBe('validating-task');
    state = transition(state, { type: 'VALIDATION_FAIL' }, 3);
    expect(state.phase).toBe('escalating');
  });

  it('HINT_SUCCESS after escalation returns to implementing', { timeout: 10_000 }, async (t) => {
    if (g.skip) { t.skip(); return; }

    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
    let state: WorkflowState = {
      ...createInitialState('hint-test'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };

    state = transition(state, { type: 'HINT_SUCCESS' });
    expect(state.phase).toBe('implementing');
    expect(state.currentTaskIndex).toBe(1);
    expect(state.attempt).toBe(0);
    expect(state.completedTasks).toEqual(['t1']);
  });

  it('HINT_FAIL then FULL_SUCCESS completes the task as escalated', { timeout: 10_000 }, async (t) => {
    if (g.skip) { t.skip(); return; }

    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
    let state: WorkflowState = {
      ...createInitialState('full-escalation-test'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };

    state = transition(state, { type: 'HINT_FAIL' });
    expect(state.phase).toBe('escalating');

    state = transition(state, { type: 'FULL_SUCCESS' });
    expect(state.phase).toBe('implementing');
    expect(state.currentTaskIndex).toBe(1);
    expect(state.attempt).toBe(0);
    expect(state.escalatedTasks).toEqual(['t1']);
    expect(state.completedTasks).toEqual([]);
  });
});
