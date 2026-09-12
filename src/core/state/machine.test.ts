import { describe, it, expect } from 'vitest';
import { createInitialState, transition } from './machine.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
  getSkippedTaskIds,
} from './selectors.js';
import type { QueuedMessage, WorkflowState } from '../schemas/workflow.js';
import { taskId } from '../schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';

function makeQueuedMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: 'msg-test',
    text: 'queued message',
    queuedAt: '2026-01-01T00:00:00.000Z',
    phase: 'researching',
    deliveredViaNative: false,
    nativeDeliveryState: 'pending',
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
  it.each([
    ['idle', 'VALIDATION_PASS'],
    ['implementing', 'VALIDATION_FAIL'],
    ['implementing', 'ESCALATE'],
  ] as const)('rejects %s -> %s outside its phase', (phase, type) => {
    const state: WorkflowState = { ...createInitialState('feat'), phase };

    expect(() => transition(state, { type })).toThrow(`Cannot apply ${type}`);
  });

  it.each(['START_QUICK', 'START_INSTANT'] as const)(
    'does not expose the legacy %s path into implementation',
    (type) => {
      const state = createInitialState('feat');
      const action = { type, tasks: [makeTask({ id: 'T001' })] };

      expect(() => transition(state, action as never)).toThrow(
        `Cannot apply ${type} while workflow is in idle.`,
      );
    },
  );

  it('REJECT_SPEC -> idle', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-spec',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, { type: 'REJECT_SPEC' });
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it.each([
    [1, undefined, 'implementing', 2],
    [3, undefined, 'escalating', 3],
    [4, 5, 'implementing', 5],
    [5, 5, 'escalating', 5],
  ] as const)(
    'VALIDATION_FAIL at attempt %i of max %s -> %s',
    (attempt, maxRetries, phase, nextAttempt) => {
      const state: WorkflowState = {
        ...createInitialState('feat'),
        phase: 'validating-task',
        tasks: [makeTask({ id: 'T001' })],
        currentTaskIndex: 0,
        attempt,
      };

      const next = transition(state, { type: 'VALIDATION_FAIL' }, { maxRetries });

      expect(next.phase).toBe(phase);
      expect(next.attempt).toBe(nextAttempt);
    },
  );

  it('ESCALATE -> escalating', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
    };
    const next = transition(state, { type: 'ESCALATE' });
    expect(next.phase).toBe('escalating');
  });

  it('HINT_SUCCESS -> implementing with index advanced', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
    };
    const next = transition(state, { type: 'HINT_SUCCESS' });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.attempt).toBe(0);
    expect(getCompletedTaskIds(next)).toEqual([]);
    expect(getEscalatedTaskIds(next)).toEqual(['T001']);
  });

  it('HINT_SUCCESS is accepted from implementing for escalated retry completions', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'HINT_SUCCESS' });

    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(getCompletedTaskIds(next)).toEqual([]);
    expect(getEscalatedTaskIds(next)).toEqual(['T001']);
  });

  it('CANCEL -> idle with tasks cleared and counters reset', () => {
    const tasks = [makeTask({ id: 'T000', status: 'done' }), makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, { type: 'CANCEL' });
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
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

  it('CLEAR_QUEUE removes only messages still pending delivery', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      messageQueue: [
        makeQueuedMessage({ id: 'msg-pending' }),
        makeQueuedMessage({ id: 'msg-injecting', nativeDeliveryState: 'injecting' }),
        makeQueuedMessage({ id: 'msg-native', deliveredViaNative: true }),
        makeQueuedMessage({
          id: 'msg-drained',
          drainedAt: '2026-01-01T00:00:01.000Z',
        }),
      ],
    };

    const next = transition(state, { type: 'CLEAR_QUEUE' });

    expect(next.messageQueue.map((message) => message.id)).toEqual(['msg-native', 'msg-drained']);
  });

  it('REJECT_PLAN -> idle', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-plan',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, { type: 'REJECT_PLAN' });
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
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
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
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
    expect(getEscalatedTaskIds(next)).toEqual(['T001']);
    expect(next.attempt).toBe(0);
  });

  it('SET_PLANNER_SESSION_ID overwrites existing plannerSessionId', () => {
    let state = createInitialState('feat');
    state = transition(state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'first' });
    state = transition(state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'second' });
    expect(state.plannerSessionId).toBe('second');
  });

  it('a re-entered task at attempt 2 of maxRetries 3 escalates after one local VALIDATION_FAIL', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const resumed: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
      attempt: 2,
    };
    const started = transition(resumed, { type: 'START_TASK', taskId: tasks[0]!.id });
    expect(started.attempt).toBe(2);
    expect(started.tasks[0]?.status).toBe('in_progress');

    const sent = transition(started, { type: 'TASK_SENT' });
    const failed = transition(sent, { type: 'VALIDATION_FAIL' });
    expect(failed.phase).toBe('implementing');
    expect(failed.attempt).toBe(3);

    const sentAgain = transition(failed, { type: 'TASK_SENT' });
    const exhausted = transition(sentAgain, { type: 'VALIDATION_FAIL' });
    expect(exhausted.phase).toBe('escalating');
  });

  it('CLEAR_TASK_CODE removes stale currentCode from the selected task only', () => {
    const tasks = [
      makeTask({ id: 'T001', currentCode: 'stale code' }),
      makeTask({ id: 'T002', currentCode: 'keep code' }),
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

  it('full workflow: START through REVIEW_DONE', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];

    let s = createInitialState('full-flow');
    expect(s.phase).toBe('idle');

    s = transition(s, { type: 'START' });
    expect(s.phase).toBe('researching');

    s = transition(s, { type: 'RESEARCH_DONE' });
    expect(s.phase).toBe('specifying');

    s = transition(s, { type: 'SPEC_DONE' });
    expect(s.phase).toBe('reviewing-spec');

    s = transition(s, { type: 'APPROVE_SPEC' });
    expect(s.phase).toBe('planning');

    s = transition(s, { type: 'BRIEF_ADMISSION_OPENED' });
    expect(s.phase).toBe('reviewing-briefs');

    s = { ...s, tasks };
    s = transition(s, { type: 'BEGIN_IMPLEMENTATION' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(0);

    s = transition(s, { type: 'TASK_SENT' });
    expect(s.phase).toBe('validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(1);
    expect(getCompletedTaskIds(s)).toEqual(['T001']);

    s = transition(s, { type: 'TASK_SENT' });
    expect(s.phase).toBe('validating-task');
    s = transition(s, { type: 'VALIDATION_PASS' });
    expect(s.phase).toBe('implementing');
    expect(s.currentTaskIndex).toBe(2);
    expect(getCompletedTaskIds(s)).toEqual(['T001', 'T002']);

    s = transition(s, { type: 'ALL_DONE' });
    expect(s.phase).toBe('final-review');

    s = transition(s, { type: 'REVIEW_DONE' });
    expect(s.phase).toBe('complete');

    expect(s.feature).toBe('full-flow');
    expect(getCompletedTaskIds(s)).toEqual(['T001', 'T002']);
    expect(getFailedTaskIds(s)).toEqual([]);
    expect(getEscalatedTaskIds(s)).toEqual([]);
    expect(getSkippedTaskIds(s)).toEqual([]);
    expect(s.currentTaskIndex).toBe(2);
  });

  it.each([
    ['REWIND_TO_SPEC', 'specifying'],
    ['REWIND_TO_PLAN', 'planning'],
  ] as const)('%s -> %s with tasks cleared and counters reset', (type, phase) => {
    const tasks = [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
      awaitingContinue: true,
      plannerSessionId: 'old-session',
      discoveredValidation: { testCommand: 'npm test' },
    };
    const next = transition(state, { type });
    expect(next.phase).toBe(phase);
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
    expect(next.awaitingContinue).toBe(false);
    expect(next.plannerSessionId).toBeUndefined();
    expect(next.discoveredValidation).toBeUndefined();
  });

  it('RESET_TASK -> implementing with task set to pending and index rewound', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003' }),
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
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'RESET_TASK', taskId: taskId('T999') });
    expect(next).toBe(state);
  });

  it.each([
    ['REWIND_TO_SPEC', 'specifying', 'spec', 'use refresh tokens'],
    ['REWIND_TO_PLAN', 'planning', 'plan', 'add caching layer'],
  ] as const)('%s with comment sets rewindPending', (type, phase, target, comment) => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type, comment });
    expect(next.phase).toBe(phase);
    expect(next.rewindPending).toEqual({ target, comment });
  });

  it('REWIND_TO_SPEC without comment sets rewindPending with no comment field', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type: 'REWIND_TO_SPEC' });
    expect(next.phase).toBe('specifying');
    expect(next.rewindPending).toEqual({ target: 'spec' });
    expect(next.rewindPending?.comment).toBeUndefined();
  });

  it('RESET_TASK does NOT set rewindPending', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
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
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'constitution-check',
      awaitingContinue: true,
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, {
      type: 'CONSTITUTION_CHECK_FAIL',
    });
    expect(next.phase).toBe('idle');
    expect(next.awaitingContinue).toBe(false);
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it('ANALYZE_START -> analyzing', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const next = transition(state, { type: 'ANALYZE_START' });
    expect(next.phase).toBe('analyzing');
  });

  it('does not leave analyzing through a legacy implementation transition', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'analyzing' };
    expect(() => transition(state, { type: 'ANALYZE_DONE' } as never)).toThrow(
      'Cannot apply ANALYZE_DONE while workflow is in analyzing.',
    );
  });

  it('PLAN_DONE straight from researching enters reviewing-plan', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'researching' };
    const next = transition(state, { type: 'PLAN_DONE', tasks });
    expect(next.phase).toBe('reviewing-plan');
    expect(next.tasks).toEqual(tasks);
  });

  it('PLAN_DONE from analyzing returns to reviewing-plan', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'analyzing' };
    const next = transition(state, { type: 'PLAN_DONE', tasks });
    expect(next.phase).toBe('reviewing-plan');
    expect(next.tasks).toEqual(tasks);
  });

  it('RESEARCH_DONE from specifying stays in specifying', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'specifying' };
    const next = transition(state, { type: 'RESEARCH_DONE' });
    expect(next.phase).toBe('specifying');
  });

  it('PLAN_DONE from specifying enters reviewing-plan', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'specifying' };
    const next = transition(state, { type: 'PLAN_DONE', tasks });
    expect(next.phase).toBe('reviewing-plan');
    expect(next.tasks).toEqual(tasks);
  });

  it('BEGIN_IMPLEMENTATION enters implementing without a permit', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      tasks,
      currentTaskIndex: 3,
      attempt: 2,
    };
    const next = transition(state, { type: 'BEGIN_IMPLEMENTATION' });
    expect(next.phase).toBe('implementing');
    expect(next.tasks).toEqual(tasks);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
  });

  it('REJECT_BRIEFS resets to idle', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-briefs',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, { type: 'REJECT_BRIEFS' });
    expect(next.phase).toBe('idle');
    expect(next.tasks).toEqual([]);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.attempt).toBe(0);
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
    });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery?.status).toBe('applying');
    expect(next.pendingRecovery?.selectedAction).toBe('route-bigger-worker');
  });

  it('MARK_RECOVERY_APPLYING replaces a stale paused action for replay', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue({
        status: 'paused',
        selectedAction: 'pause-run',
      }),
    };

    const next = transition(state, {
      type: 'MARK_RECOVERY_APPLYING',
      action: 'retry-same-worker',
    });

    expect(next.pendingRecovery?.status).toBe('applying');
    expect(next.pendingRecovery?.selectedAction).toBe('retry-same-worker');
  });

  it('RESOLVE_PENDING_RECOVERY clears pending recovery after a selected action succeeds', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue({
        status: 'applying',
        selectedAction: 'retry-same-worker',
      }),
    };

    const next = transition(state, {
      type: 'RESOLVE_PENDING_RECOVERY',
    });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery).toBeUndefined();
  });

  it('TASK_SENT strips currentCode from the sent task', () => {
    const tasks = [makeTask({ id: 'T001', currentCode: 'const x = 1;' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'TASK_SENT' });
    expect(next.phase).toBe('validating-task');
    expect(next.tasks[0]?.currentCode).toBeUndefined();
  });

  it('VALIDATION_PASS strips currentCode from the completed task', () => {
    const tasks = [makeTask({ id: 'T001', currentCode: 'const x = 1;' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'VALIDATION_PASS' });
    expect(next.tasks[0]?.currentCode).toBeUndefined();
    expect(next.tasks[0]?.status).toBe('done');
  });

  it('SKIP_TASK -> implementing with attempt reset and index advanced', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
      attempt: 2,
    };
    const next = transition(state, { type: 'SKIP_TASK', taskId: tasks[0]!.id });
    expect(next.phase).toBe('implementing');
    expect(next.currentTaskIndex).toBe(1);
    expect(next.attempt).toBe(0);
    expect(getSkippedTaskIds(next)).toEqual(['T001']);
  });

  it('FULL_SUCCESS strips currentCode from the escalated task', () => {
    const tasks = [
      makeTask({ id: 'T001', currentCode: 'source code here' }),
      makeTask({ id: 'T002' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks,
      currentTaskIndex: 0,
    };
    const next = transition(state, { type: 'FULL_SUCCESS' });
    expect(next.tasks[0]?.currentCode).toBeUndefined();
    expect(next.tasks[0]?.status).toBe('escalated');
  });
});
