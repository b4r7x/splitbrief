import { describe, it, expect } from 'vitest';
import { createInitialState, transition } from './state.js';
import type { WorkflowState } from './types.js';
import { makeTask as makeTaskBase } from '#testing/helpers/fixtures.js';

function makeTask(id: string) {
  return makeTaskBase({ id, title: `Task ${id}`, file: `src/${id}.ts`, description: `Description for ${id}` });
}

describe('createInitialState', () => {
  it('returns idle phase with feature set and empty arrays', () => {
    const state = createInitialState('feature');
    expect(state.phase).toBe('idle');
    expect(state.feature).toBe('feature');
    expect(state.tasks).toEqual([]);
    expect(state.completedTasks).toEqual([]);
    expect(state.escalatedTasks).toEqual([]);
    expect(state.skippedTasks).toEqual([]);
    expect(state.failedTasks).toEqual([]);
    expect(state.currentTaskIndex).toBe(0);
    expect(state.attempt).toBe(0);
    expect(state.tokenUsage.plannerInput).toBe(0);
    expect(state.tokenUsage.plannerOutput).toBe(0);
    expect(state.tokenUsage.implementerInput).toBe(0);
    expect(state.tokenUsage.implementerOutput).toBe(0);
    expect(state.tokenUsage.escalationInput).toBe(0);
    expect(state.tokenUsage.escalationOutput).toBe(0);
  });
});

describe('transition', () => {
  it('START -> researching', () => {
    const state = createInitialState('feat');
    const next = transition(state, { type: 'START', feature: 'feat' });
    expect(next.phase).toBe('researching');
  });

  it('RESEARCH_DONE -> specifying', () => {
    const state = { ...createInitialState('feat'), phase: 'researching' as const };
    const next = transition(state, { type: 'RESEARCH_DONE' });
    expect(next.phase).toBe('specifying');
  });

  it('SPEC_DONE -> reviewing-spec', () => {
    const state = { ...createInitialState('feat'), phase: 'specifying' as const };
    const next = transition(state, { type: 'SPEC_DONE' });
    expect(next.phase).toBe('reviewing-spec');
  });

  it('APPROVE_SPEC -> planning', () => {
    const state = { ...createInitialState('feat'), phase: 'reviewing-spec' as const };
    const next = transition(state, { type: 'APPROVE_SPEC' });
    expect(next.phase).toBe('planning');
  });

  it('REJECT_SPEC -> idle', () => {
    const state = { ...createInitialState('feat'), phase: 'reviewing-spec' as const };
    const next = transition(state, { type: 'REJECT_SPEC' });
    expect(next.phase).toBe('idle');
  });

  it('PLAN_DONE -> reviewing-plan with tasks set', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];
    const state = { ...createInitialState('feat'), phase: 'planning' as const };
    const next = transition(state, { type: 'PLAN_DONE', tasks });
    expect(next.phase).toBe('reviewing-plan');
    expect(next.tasks).toEqual(tasks);
  });

  it('APPROVE_PLAN -> implementing with currentTaskIndex=0', () => {
    const state = { ...createInitialState('feat'), phase: 'reviewing-plan' as const };
    const next = transition(state, { type: 'APPROVE_PLAN' });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(0);
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
    expect(next.phase).toBe('validating-task');
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
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.completedTasks).toEqual(['t1']);
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
    expect(next.phase).toBe('implementing');
    expect(next.attempt).toBe(2);
  });

  it('ESCALATE -> escalating', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    const next = transition(state, { type: 'ESCALATE' });
    expect(next.phase).toBe('escalating');
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
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.completedTasks).toEqual(['t1']);
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
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.failedTasks).toEqual(['t1']);
  });

  it('ALL_DONE -> final-review', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    const next = transition(state, { type: 'ALL_DONE' });
    expect(next.phase).toBe('final-review');
  });

  it('REVIEW_DONE -> complete', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'final-review',
    };
    const next = transition(state, { type: 'REVIEW_DONE' });
    expect(next.phase).toBe('complete');
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
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual(tasks);
    expect(next.completedTasks).toEqual(['t0']);
    expect(next.feature).toBe('feat');
  });

  it('REJECT_PLAN -> idle', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-plan',
    };
    const next = transition(state, { type: 'REJECT_PLAN' });
    expect(next.phase).toBe('idle');
  });

  it('HINT_FAIL -> stays in escalating', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
    };
    const next = transition(state, { type: 'HINT_FAIL' });
    expect(next.phase).toBe('escalating');
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
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.escalatedTasks).toEqual(['t1']);
    expect(next.attempt).toBe(0);
  });

  it('SET_SESSION_ID updates sessionId', () => {
    const state = createInitialState('feat');
    const next = transition(state, { type: 'SET_SESSION_ID', sessionId: 'abc-123' });
    expect(next.sessionId).toBe('abc-123');
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
    expect(next.phase).toBe('implementing');
    expect(next.attempt).toBe(0);
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
    expect(next.phase).toBe('implementing');
    expect(next.attempt).toBe(0);
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
    expect(next.phase).toBe('implementing');
    expect(next.attempt).toBe(5);
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
    expect(next.phase).toBe('escalating');
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
    expect(next.phase).toBe('escalating');
  });

  it('full workflow: START through REVIEW_DONE', () => {
    const tasks = [makeTask('t1'), makeTask('t2')];

    let s = createInitialState('full-flow');
    expect(s.phase).toBe('idle');

    s = transition(s, { type: 'START', feature: 'full-flow' });
    expect(s.phase).toBe('researching');

    s = transition(s, { type: 'RESEARCH_DONE' });
    expect(s.phase).toBe('specifying');

    s = transition(s, { type: 'SPEC_DONE' });
    expect(s.phase).toBe('reviewing-spec');

    s = transition(s, { type: 'APPROVE_SPEC' });
    expect(s.phase).toBe('planning');

    s = transition(s, { type: 'PLAN_DONE', tasks });
    expect(s.phase).toBe('reviewing-plan');
    expect(s.tasks).toEqual(tasks);

    s = transition(s, { type: 'APPROVE_PLAN' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(0);

    // Task 1: send and pass
    s = transition(s, { type: 'TASK_SENT' });
    expect(s.phase).toBe('validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(1);
    expect(s.completedTasks).toEqual(['t1']);

    // Task 2: send and pass
    s = transition(s, { type: 'TASK_SENT' });
    expect(s.phase).toBe('validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(2);
    expect(s.completedTasks).toEqual(['t1', 't2']);

    s = transition(s, { type: 'ALL_DONE' });
    expect(s.phase).toBe('final-review');

    s = transition(s, { type: 'REVIEW_DONE' });
    expect(s.phase).toBe('complete');

    // Verify final state
    expect(s.feature).toBe('full-flow');
    expect(s.completedTasks).toEqual(['t1', 't2']);
    expect(s.failedTasks).toEqual([]);
    expect(s.escalatedTasks).toEqual([]);
    expect(s.skippedTasks).toEqual([]);
    expect(s.currentTaskIndex).toBe(2);
  });
});
