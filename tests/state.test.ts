import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, transition } from '../src/state.js';
import type { WorkflowState } from '../src/types.js';
import { makeTask as makeTaskBase } from './helpers/fixtures.js';

function makeTask(id: string) {
  return makeTaskBase({ id, title: `Task ${id}`, file: `src/${id}.ts`, description: `Description for ${id}` });
}

describe('createInitialState', () => {
  it('returns idle phase with feature set and empty arrays', () => {
    const state = createInitialState('feature');
    assert.equal(state.phase, 'idle');
    assert.equal(state.feature, 'feature');
    assert.deepEqual(state.tasks, []);
    assert.deepEqual(state.completedTasks, []);
    assert.deepEqual(state.escalatedTasks, []);
    assert.deepEqual(state.skippedTasks, []);
    assert.deepEqual(state.failedTasks, []);
    assert.equal(state.currentTaskIndex, 0);
    assert.equal(state.attempt, 0);
    assert.equal(state.tokenUsage.plannerInput, 0);
    assert.equal(state.tokenUsage.plannerOutput, 0);
    assert.equal(state.tokenUsage.implementerInput, 0);
    assert.equal(state.tokenUsage.implementerOutput, 0);
    assert.equal(state.tokenUsage.escalationInput, 0);
    assert.equal(state.tokenUsage.escalationOutput, 0);
  });
});

describe('transition', () => {
  it('START -> researching', () => {
    const state = createInitialState('feat');
    const next = transition(state, { type: 'START', feature: 'feat' });
    assert.equal(next.phase, 'researching');
  });

  it('RESEARCH_DONE -> specifying', () => {
    const state = { ...createInitialState('feat'), phase: 'researching' as const };
    const next = transition(state, { type: 'RESEARCH_DONE' });
    assert.equal(next.phase, 'specifying');
  });

  it('SPEC_DONE -> reviewing-spec', () => {
    const state = { ...createInitialState('feat'), phase: 'specifying' as const };
    const next = transition(state, { type: 'SPEC_DONE' });
    assert.equal(next.phase, 'reviewing-spec');
  });

  it('APPROVE_SPEC -> planning', () => {
    const state = { ...createInitialState('feat'), phase: 'reviewing-spec' as const };
    const next = transition(state, { type: 'APPROVE_SPEC' });
    assert.equal(next.phase, 'planning');
  });

  it('REJECT_SPEC -> idle', () => {
    const state = { ...createInitialState('feat'), phase: 'reviewing-spec' as const };
    const next = transition(state, { type: 'REJECT_SPEC' });
    assert.equal(next.phase, 'idle');
  });

  it('PLAN_DONE -> reviewing-plan with tasks set', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];
    const state = { ...createInitialState('feat'), phase: 'planning' as const };
    const next = transition(state, { type: 'PLAN_DONE', tasks });
    assert.equal(next.phase, 'reviewing-plan');
    assert.deepEqual(next.tasks, tasks);
  });

  it('APPROVE_PLAN -> implementing with currentTaskIndex=0', () => {
    const state = { ...createInitialState('feat'), phase: 'reviewing-plan' as const };
    const next = transition(state, { type: 'APPROVE_PLAN' });
    assert.equal(next.phase, 'implementing');
    assert.equal(next.currentTaskIndex, 0);
  });

  it('TASK_SENT -> validating-task', () => {
    const tasks = [makeTask('t1')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'TASK_SENT' });
    assert.equal(next.phase, 'validating-task');
  });

  it('VALIDATION_PASS -> implementing with index advanced and task in completedTasks', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'VALIDATION_PASS' });
    assert.equal(next.phase, 'implementing');
    assert.equal(next.currentTaskIndex, 1);
    assert.deepEqual(next.completedTasks, ['t1']);
  });

  it('VALIDATION_FAIL with attempt < 3 -> implementing with attempt incremented', () => {
    const tasks = [makeTask('t1')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
      attempt: 1,
    };
    const next = transition(state, { type: 'VALIDATION_FAIL' });
    assert.equal(next.phase, 'implementing');
    assert.equal(next.attempt, 2);
  });

  it('ESCALATE -> escalating', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    const next = transition(state, { type: 'ESCALATE' });
    assert.equal(next.phase, 'escalating');
  });

  it('HINT_SUCCESS -> implementing with index advanced', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'HINT_SUCCESS' });
    assert.equal(next.phase, 'implementing');
    assert.equal(next.currentTaskIndex, 1);
    assert.deepEqual(next.completedTasks, ['t1']);
  });

  it('FULL_FAIL -> implementing with task in failedTasks', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'FULL_FAIL' });
    assert.equal(next.phase, 'implementing');
    assert.equal(next.currentTaskIndex, 1);
    assert.deepEqual(next.failedTasks, ['t1']);
  });

  it('ALL_DONE -> final-review', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    const next = transition(state, { type: 'ALL_DONE' });
    assert.equal(next.phase, 'final-review');
  });

  it('REVIEW_DONE -> complete', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'final-review',
    };
    const next = transition(state, { type: 'REVIEW_DONE' });
    assert.equal(next.phase, 'complete');
  });

  it('CANCEL -> idle with state preserved', () => {
    const tasks = [makeTask('t1')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
      completedTasks: ['t0'],
    };
    const next = transition(state, { type: 'CANCEL' });
    assert.equal(next.phase, 'idle');
    assert.deepEqual(next.tasks, tasks);
    assert.deepEqual(next.completedTasks, ['t0']);
    assert.equal(next.feature, 'feat');
  });

  it('REJECT_PLAN -> idle', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-plan',
    };
    const next = transition(state, { type: 'REJECT_PLAN' });
    assert.equal(next.phase, 'idle');
  });

  it('HINT_FAIL -> stays in escalating', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
    };
    const next = transition(state, { type: 'HINT_FAIL' });
    assert.equal(next.phase, 'escalating');
  });

  it('FULL_SUCCESS -> implementing with index advanced, task in escalatedTasks, attempt reset', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };
    const next = transition(state, { type: 'FULL_SUCCESS' });
    assert.equal(next.phase, 'implementing');
    assert.equal(next.currentTaskIndex, 1);
    assert.deepEqual(next.escalatedTasks, ['t1']);
    assert.equal(next.attempt, 0);
  });

  it('SET_SESSION_ID updates sessionId', () => {
    const state = createInitialState('feat');
    const next = transition(state, { type: 'SET_SESSION_ID', sessionId: 'abc-123' });
    assert.equal(next.sessionId, 'abc-123');
  });

  it('HINT_SUCCESS resets attempt to 0', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };
    const next = transition(state, { type: 'HINT_SUCCESS' });
    assert.equal(next.phase, 'implementing');
    assert.equal(next.attempt, 0);
  });

  it('FULL_FAIL resets attempt to 0', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };
    const next = transition(state, { type: 'FULL_FAIL' });
    assert.equal(next.phase, 'implementing');
    assert.equal(next.attempt, 0);
  });

  it('configurable maxRetries: attempt < custom max stays in implementing', () => {
    const tasks = [makeTask('t1')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
      attempt: 4,
    };
    const next = transition(state, { type: 'VALIDATION_FAIL' }, 5);
    assert.equal(next.phase, 'implementing');
    assert.equal(next.attempt, 5);
  });

  it('configurable maxRetries: attempt >= custom max transitions to escalating', () => {
    const tasks = [makeTask('t1')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
      attempt: 5,
    };
    const next = transition(state, { type: 'VALIDATION_FAIL' }, 5);
    assert.equal(next.phase, 'escalating');
  });

  it('VALIDATION_FAIL at default max transitions to escalating', () => {
    const tasks = [makeTask('t1')];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };
    const next = transition(state, { type: 'VALIDATION_FAIL' });
    assert.equal(next.phase, 'escalating');
  });

  it('full workflow: START through REVIEW_DONE', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];

    let s = createInitialState('full-flow');
    assert.equal(s.phase, 'idle');

    s = transition(s, { type: 'START', feature: 'full-flow' });
    assert.equal(s.phase, 'researching');

    s = transition(s, { type: 'RESEARCH_DONE' });
    assert.equal(s.phase, 'specifying');

    s = transition(s, { type: 'SPEC_DONE' });
    assert.equal(s.phase, 'reviewing-spec');

    s = transition(s, { type: 'APPROVE_SPEC' });
    assert.equal(s.phase, 'planning');

    s = transition(s, { type: 'PLAN_DONE', tasks });
    assert.equal(s.phase, 'reviewing-plan');
    assert.deepEqual(s.tasks, tasks);

    s = transition(s, { type: 'APPROVE_PLAN' });
    assert.equal(s.phase, 'implementing');
    assert.equal(s.currentTaskIndex, 0);

    // Task 1: send and pass
    s = transition(s, { type: 'TASK_SENT' });
    assert.equal(s.phase, 'validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    assert.equal(s.phase, 'implementing');
    assert.equal(s.currentTaskIndex, 1);
    assert.deepEqual(s.completedTasks, ['t1']);

    // Task 2: send and pass
    s = transition(s, { type: 'TASK_SENT' });
    assert.equal(s.phase, 'validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    assert.equal(s.phase, 'implementing');
    assert.equal(s.currentTaskIndex, 2);
    assert.deepEqual(s.completedTasks, ['t1', 't2']);

    s = transition(s, { type: 'ALL_DONE' });
    assert.equal(s.phase, 'final-review');

    s = transition(s, { type: 'REVIEW_DONE' });
    assert.equal(s.phase, 'complete');

    // Verify final state
    assert.equal(s.feature, 'full-flow');
    assert.deepEqual(s.completedTasks, ['t1', 't2']);
    assert.deepEqual(s.failedTasks, []);
    assert.deepEqual(s.escalatedTasks, []);
    assert.deepEqual(s.skippedTasks, []);
    assert.equal(s.currentTaskIndex, 2);
  });
});
