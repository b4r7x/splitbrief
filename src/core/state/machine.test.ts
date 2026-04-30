import { describe, it, expect } from 'vitest';
import { createInitialState, transition, transitionError } from './machine.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
  getSkippedTaskIds,
} from './selectors.js';
import type { WorkflowState } from '../schemas/workflow.js';
import type { RecoveryIssue } from '../schemas/recovery.js';
import { taskId } from '../schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';

function makeRecoveryIssue(overrides: Partial<RecoveryIssue> = {}): RecoveryIssue {
  return {
    id: 'rec_2026_04_28_001',
    reason: 'validation-failed',
    phase: 'validating-task',
    status: 'awaiting-user',
    taskId: taskId('T001'),
    taskTitle: 'Fix login validation',
    files: ['src/auth/session.ts'],
    affectedTaskIds: [taskId('T001')],
    message: 'T001 validation failed after 3 attempts',
    details: ['npm test failed in src/auth/session.test.ts'],
    attempts: 3,
    maxAttempts: 3,
    selectedImplementerProfile: 'local-qwen',
    availableActions: [
      'retry-same-worker',
      'route-bigger-worker',
      'planner-split-rebase',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ],
    recommendedAction: 'retry-same-worker',
    createdAt: '2026-04-28T12:00:00.000Z',
    ...overrides,
  };
}

describe('createInitialState', () => {
  it('returns idle phase with feature set and empty tasks', () => {
    const state = createInitialState('feature');
    expect(state.phase).toBe('idle');
    expect(state.feature).toBe('feature');
    expect(state.tasks).toEqual([]);
  });
});

describe('transition', () => {
  it('throws when an action is not valid for the current phase', () => {
    const state = createInitialState('feat');

    expect(() => transition(state, { type: 'VALIDATION_PASS' })).toThrow('Cannot apply VALIDATION_PASS');
  });

  it('does not allow plan approval to bypass brief review actions', () => {
    const tasks = [makeTask({ id: 't1' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-briefs', tasks };

    try {
      transition(state, { type: 'APPROVE_PLAN' });
      throw new Error('expected transition to throw');
    } catch (err) {
      expect(transitionError.isInvalidActionForPhase(err)).toBe(true);
    }
  });

  it('START -> researching', () => {
    const state = createInitialState('feat');
    const next = transition(state, { type: 'START', feature: 'feat' });
    expect(next.phase).toBe('researching');
  });

  it('START_QUICK -> implementing with tasks set', () => {
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
    const state = createInitialState('feat');
    const next = transition(state, { type: 'START_QUICK', tasks });
    expect(next.phase).toBe('implementing');
    expect(next.tasks).toEqual(tasks);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it('REJECT_SPEC -> idle', () => {
    const state = { ...createInitialState('feat'), phase: 'reviewing-spec' as const };
    const next = transition(state, { type: 'REJECT_SPEC' });
    expect(next.phase).toBe('idle');
  });

  it('VALIDATION_FAIL with attempt < 3 -> implementing with attempt incremented', () => {
    const tasks = [makeTask({ id: 't1' })];
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
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'HINT_SUCCESS' });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(getCompletedTaskIds(next)).toEqual(['t1']);
  });

  it('FULL_FAIL -> implementing with task in failedTasks', () => {
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'FULL_FAIL' });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(getFailedTaskIds(next)).toEqual(['t1']);
  });

  it('CANCEL -> idle with state preserved', () => {
    const tasks = [makeTask({ id: 't0', status: 'done' }), makeTask({ id: 't1' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
    };
    const next = transition(state, { type: 'CANCEL' });
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual(tasks);
    expect(getCompletedTaskIds(next)).toEqual(['t0']);
    expect(next.feature).toBe('feat');
  });

  it('CANCEL clears awaitingContinue', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      awaitingContinue: true,
    };
    const next = transition(state, { type: 'CANCEL' });
    expect(next.awaitingContinue).toBe(false);
  });

  it('ABORT_TURN sets awaitingContinue to true', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    const next = transition(state, { type: 'ABORT_TURN' });
    expect(next.awaitingContinue).toBe(true);
    expect(next.phase).toBe('implementing');
  });

  it('CONTINUE_TURN clears awaitingContinue', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      awaitingContinue: true,
    };
    const next = transition(state, { type: 'CONTINUE_TURN' });
    expect(next.awaitingContinue).toBe(false);
    expect(next.phase).toBe('implementing');
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
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
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
    expect(getEscalatedTaskIds(next)).toEqual(['t1']);
    expect(next.attempt).toBe(0);
  });

  it('SET_PLANNER_SESSION_ID updates plannerSessionId', () => {
    const state = createInitialState('feat');
    const next = transition(state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'abc-123' });
    expect(next.plannerSessionId).toBe('abc-123');
  });

  it('plannerSessionId defaults to null in initial state', () => {
    const state = createInitialState('feat');
    expect(state.plannerSessionId).toBeNull();
  });

  it('SET_PLANNER_SESSION_ID overwrites existing plannerSessionId', () => {
    let state = createInitialState('feat');
    state = transition(state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'first' });
    state = transition(state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'second' });
    expect(state.plannerSessionId).toBe('second');
  });

  it('START_TASK resets attempt to 0 (resume retry-budget fix)', () => {
    const tasks = [makeTask({ id: 't1' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
      attempt: 2,
    };
    const next = transition(state, { type: 'START_TASK', taskId: tasks[0]!.id });
    expect(next.attempt).toBe(0);
    expect(next.tasks[0]?.status).toBe('in_progress');
  });

  it('CLEAR_TASK_CODE removes stale currentCode from the selected task only', () => {
    const tasks = [
      makeTask({ id: 't1', currentCode: 'stale code' }),
      makeTask({ id: 't2', currentCode: 'keep code' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
    };

    const next = transition(state, { type: 'CLEAR_TASK_CODE', taskId: tasks[0]!.id });

    expect(next.tasks[0]?.currentCode).toBeUndefined();
    expect(next.tasks[1]?.currentCode).toBe('keep code');
  });

  it('HINT_SUCCESS resets attempt to 0', () => {
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
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
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
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
    const tasks = [makeTask({ id: 't1' })];
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
    const tasks = [makeTask({ id: 't1' })];
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
    const tasks = [makeTask({ id: 't1' })];
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
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];

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

    s = transition(s, { type: 'TASK_SENT' });
    expect(s.phase).toBe('validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(1);
    expect(getCompletedTaskIds(s)).toEqual(['t1']);

    s = transition(s, { type: 'TASK_SENT' });
    expect(s.phase).toBe('validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(2);
    expect(getCompletedTaskIds(s)).toEqual(['t1', 't2']);

    s = transition(s, { type: 'ALL_DONE' });
    expect(s.phase).toBe('final-review');

    s = transition(s, { type: 'REVIEW_DONE' });
    expect(s.phase).toBe('complete');

    expect(s.feature).toBe('full-flow');
    expect(getCompletedTaskIds(s)).toEqual(['t1', 't2']);
    expect(getFailedTaskIds(s)).toEqual([]);
    expect(getEscalatedTaskIds(s)).toEqual([]);
    expect(getSkippedTaskIds(s)).toEqual([]);
    expect(s.currentTaskIndex).toBe(2);
  });

  it('REWIND_TO_SPEC -> specifying with tasks cleared and counters reset', () => {
    const tasks = [makeTask({ id: 't1', status: 'done' }), makeTask({ id: 't2' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
      awaitingContinue: true,
    };
    const next = transition(state, { type: 'REWIND_TO_SPEC' });
    expect(next.phase).toBe('specifying');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
    expect(next.awaitingContinue).toBe(false);
  });

  it('REWIND_TO_PLAN -> planning with tasks cleared and counters reset', () => {
    const tasks = [makeTask({ id: 't1', status: 'done' }), makeTask({ id: 't2' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
      awaitingContinue: true,
    };
    const next = transition(state, { type: 'REWIND_TO_PLAN' });
    expect(next.phase).toBe('planning');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
    expect(next.awaitingContinue).toBe(false);
  });

  it('RESET_TASK -> implementing with task set to pending and index rewound', () => {
    const tasks = [
      makeTask({ id: 't1', status: 'done' }),
      makeTask({ id: 't2', status: 'done' }),
      makeTask({ id: 't3' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 2,
      attempt: 1,
    };
    const next = transition(state, { type: 'RESET_TASK', taskId: tasks[1]!.id });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.attempt).toBe(0);
    expect(next.tasks[1]?.status).toBe('pending');
    expect(next.tasks[0]?.status).toBe('done');
  });

  it('RESET_TASK with unknown taskId returns state unchanged', () => {
    const tasks = [makeTask({ id: 't1' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'RESET_TASK', taskId: taskId('nonexistent') });
    expect(next).toBe(state);
  });

  it('REWIND_TO_SPEC with comment sets rewindPending', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type: 'REWIND_TO_SPEC', comment: 'use refresh tokens' });
    expect(next.phase).toBe('specifying');
    expect(next.rewindPending).toEqual({ target: 'spec', comment: 'use refresh tokens' });
  });

  it('REWIND_TO_SPEC without comment sets rewindPending with no comment field', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type: 'REWIND_TO_SPEC' });
    expect(next.phase).toBe('specifying');
    expect(next.rewindPending).toEqual({ target: 'spec' });
    expect(next.rewindPending?.comment).toBeUndefined();
  });

  it('REWIND_TO_PLAN with comment sets rewindPending', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type: 'REWIND_TO_PLAN', comment: 'add caching layer' });
    expect(next.phase).toBe('planning');
    expect(next.rewindPending).toEqual({ target: 'plan', comment: 'add caching layer' });
  });

  it('RESET_TASK does NOT set rewindPending', () => {
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
    };
    const next = transition(state, { type: 'RESET_TASK', taskId: tasks[0]!.id });
    expect(next.rewindPending).toBeUndefined();
  });

  it('CLEAR_REWIND_PENDING clears the field', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'specifying',
      rewindPending: { target: 'spec', comment: 'foo' },
    };
    const next = transition(state, { type: 'CLEAR_REWIND_PENDING' });
    expect(next.rewindPending).toBeUndefined();
    expect(next.phase).toBe('specifying');
  });

  it('SPEC_CLARIFY_START -> clarifying', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-spec' };
    const next = transition(state, { type: 'SPEC_CLARIFY_START' });
    expect(next.phase).toBe('clarifying');
  });

  it('SPEC_CLARIFY_DONE -> constitution-check', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'clarifying' };
    const next = transition(state, { type: 'SPEC_CLARIFY_DONE' });
    expect(next.phase).toBe('constitution-check');
  });

  it('CONSTITUTION_CHECK_PASS -> planning', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'constitution-check' };
    const next = transition(state, { type: 'CONSTITUTION_CHECK_PASS' });
    expect(next.phase).toBe('planning');
  });

  it('CONSTITUTION_CHECK_FAIL -> idle and clears awaitingContinue', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'constitution-check',
      awaitingContinue: true,
    };
    const next = transition(state, { type: 'CONSTITUTION_CHECK_FAIL', reason: 'violates principle X' });
    expect(next.phase).toBe('idle');
    expect(next.awaitingContinue).toBe(false);
  });

  it('ANALYZE_START -> analyzing', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type: 'ANALYZE_START' });
    expect(next.phase).toBe('analyzing');
  });

  it('ANALYZE_DONE -> implementing', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'analyzing' };
    const next = transition(state, { type: 'ANALYZE_DONE' });
    expect(next.phase).toBe('implementing');
  });

  it('BRIEFS_READY -> reviewing-briefs with tasks set', () => {
    const tasks = [makeTask({ id: 't1' }), makeTask({ id: 't2' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-plan', currentTaskIndex: 3, attempt: 2 };
    const next = transition(state, { type: 'BRIEFS_READY', tasks });
    expect(next.phase).toBe('reviewing-briefs');
    expect(next.tasks).toEqual(tasks);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it('APPROVE_BRIEFS -> implementing with index and attempt reset', () => {
    const tasks = [makeTask({ id: 't1' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-briefs', tasks };
    const next = transition(state, { type: 'APPROVE_BRIEFS' });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it('REJECT_BRIEFS -> idle', () => {
    const tasks = [makeTask({ id: 't1' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-briefs', tasks };
    const next = transition(state, { type: 'REJECT_BRIEFS' });
    expect(next.phase).toBe('idle');
  });

  it('BRIEFS_READY can be called from implementing phase', () => {
    const tasks = [makeTask({ id: 't1' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type: 'BRIEFS_READY', tasks });
    expect(next.phase).toBe('reviewing-briefs');
  });

  it('SET_PENDING_RECOVERY stores recovery overlay without changing phase', () => {
    const issue = makeRecoveryIssue();
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'validating-task' };

    const next = transition(state, { type: 'SET_PENDING_RECOVERY', issue });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery).toEqual(issue);
  });

  it('PAUSE_PENDING_RECOVERY marks pending recovery as paused', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue(),
    };

    const next = transition(state, { type: 'PAUSE_PENDING_RECOVERY' });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery?.status).toBe('paused');
  });

  it('MARK_RECOVERY_APPLYING records selected action while keeping recovery pending', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue(),
    };

    const next = transition(state, {
      type: 'MARK_RECOVERY_APPLYING',
      action: 'route-bigger-worker',
      selectedAt: '2026-04-28T12:05:00.000Z',
    });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery?.status).toBe('applying');
    expect(next.pendingRecovery?.selectedAction).toBe('route-bigger-worker');
    expect(next.pendingRecovery?.selectedAt).toBe('2026-04-28T12:05:00.000Z');
  });

  it('CLEAR_PENDING_RECOVERY removes pending recovery without changing phase', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue({ status: 'paused' }),
    };

    const next = transition(state, { type: 'CLEAR_PENDING_RECOVERY' });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery).toBeUndefined();
  });

  it('RESOLVE_PENDING_RECOVERY clears pending recovery after a selected action succeeds', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue({ status: 'applying', selectedAction: 'retry-same-worker' }),
    };

    const next = transition(state, { type: 'RESOLVE_PENDING_RECOVERY', action: 'retry-same-worker' });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery).toBeUndefined();
  });
});
