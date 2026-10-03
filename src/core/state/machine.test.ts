import { describe, it, expect } from 'vitest';
import { createInitialState, transition } from './machine.js';
import type { StateAction } from './types.js';
import {
  getCompletedTaskIds,
  getEscalatedTaskIds,
  getFailedTaskIds,
  getSkippedTaskIds,
} from './selectors.js';
import {
  WorkflowStateSchema,
  type LineageRecord,
  type QueuedMessage,
  type WorkflowState,
} from '../schemas/workflow.js';
import { taskId, type Task } from '../schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { DEFAULT_LOCAL_RETRIES } from '../pipeline-spec/retries.js';

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
  it.each(['quick', 'standard', 'speckit'] as const)(
    'START enters the one planning session for %s',
    (mode) => {
      const state: WorkflowState = { ...createInitialState('feat'), mode };
      expect(transition(state, { type: 'START' }).phase).toBe('planning');
    },
  );

  it.each(['planning', 'reviewing-plan'] as const)(
    'PLAN_COMPILED keeps the plan and its tasks in %s',
    (phase) => {
      const tasks = [makeTask({ id: 'T001' })];
      const plan = {
        summary: 'One task.',
        decisions: [],
        criteria: [{ id: 'C1', text: 'Works.', checkIds: ['K1'] }],
        checks: [{ id: 'K1', kind: 'cmd' as const, value: 'npm test', required: true }],
        validation: null,
      };
      const state: WorkflowState = { ...createInitialState('feat'), phase };
      const next = transition(state, { type: 'PLAN_COMPILED', plan, tasks });
      expect(next.phase).toBe(phase);
      expect(next.plan).toEqual(plan);
      expect(next.tasks).toEqual(tasks);
    },
  );

  it.each([
    'reviewing-spec',
    'clarifying',
    'constitution-check',
    'analyzing',
    'reviewing-briefs',
  ] as const)('BEGIN_PLANNING moves an old run parked in %s into the planning session', (phase) => {
    const state: WorkflowState = { ...createInitialState('feat'), phase };
    expect(transition(state, { type: 'BEGIN_PLANNING' }).phase).toBe('planning');
  });

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

  it.each(['REJECT_SPEC', 'REJECT_PLAN', 'REJECT_BRIEFS', 'CONSTITUTION_CHECK_FAIL'] as const)(
    'no longer accepts %s from any phase',
    (type) => {
      const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-spec' };

      expect(() => transition(state, { type } as never)).toThrow(`Cannot apply ${type}`);
    },
  );

  it('CLOSE_RUN records the close and leaves the phase and tasks alone', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'reviewing-spec',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(
      state,
      { type: 'CLOSE_RUN' },
      { now: new Date('2026-05-01T10:00:00Z') },
    );
    expect(next.closed).toEqual({ at: '2026-05-01T10:00:00.000Z', as: 'ended' });
    expect(next.phase).toBe('reviewing-spec');
    expect(next.tasks).toEqual(tasks);
    expect(next.currentTaskIndex).toBe(1);
    expect(next.attempt).toBe(2);
  });

  it.each(['complete', 'ended'] as const)('CLOSE_RUN preserves the first %s closure', (as) => {
    const initial = { ...createInitialState('feat'), phase: 'final-review' as const };
    const closed = transition(
      initial,
      as === 'complete' ? { type: 'REVIEW_DONE', reviewStatus: 'passed' } : { type: 'CLOSE_RUN' },
      { now: new Date('2026-05-01T10:00:00Z') },
    );
    expect(transition(closed, { type: 'CLOSE_RUN', at: '2026-05-02T10:00:00.000Z' })).toBe(closed);
  });

  it('CLOSE_RUN takes the timestamp the caller gives it', () => {
    const state = createInitialState('feat');
    const next = transition(state, { type: 'CLOSE_RUN', at: '2026-01-02T03:04:05.000Z' });
    expect(next.closed?.at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('CLOSE_RUN clears the parked step and the pending recovery', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      pendingRecovery: makeRecoveryIssue(),
      interruptedStep: {
        step: { kind: 'planner', call: 'spec' },
        source: 'user',
        at: '2026-04-01T00:00:00.000Z',
      },
    };
    const next = transition(state, { type: 'CLOSE_RUN' });
    expect(next.pendingRecovery).toBeUndefined();
    expect(next.interruptedStep).toBeUndefined();
  });

  it('a closed run refuses every transition but CLOSE_RUN', () => {
    const closed: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      closed: { at: '2026-05-01T10:00:00.000Z', as: 'ended' },
    };

    expect(() => transition(closed, { type: 'ALL_DONE' })).toThrow(
      'Cannot apply ALL_DONE: this run is closed.',
    );
    expect(() => transition(closed, { type: 'RESUME_STEP' })).toThrow(
      'Cannot apply RESUME_STEP: this run is closed.',
    );
    expect(transition(closed, { type: 'CLOSE_RUN' }).closed?.as).toBe('ended');
  });

  it.each([
    [0, 'implementing', 1],
    [1, 'escalating', 1],
    [2, 'escalating', 2],
  ] as const)(
    'VALIDATION_FAIL at attempt %i -> %s at attempt %i under DEFAULT_LOCAL_RETRIES',
    (attempt, phase, nextAttempt) => {
      const state: WorkflowState = {
        ...createInitialState('feat'),
        phase: 'validating-task',
        tasks: [makeTask({ id: 'T001' })],
        currentTaskIndex: 0,
        attempt,
      };

      const next = transition(state, { type: 'VALIDATION_FAIL' });

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

  it.each(['HINT_SUCCESS', 'HINT_FAIL', 'FULL_SUCCESS'] as const)(
    'no longer accepts the retired %s hint action from any phase',
    (type) => {
      const state: WorkflowState = { ...createInitialState('feat'), phase: 'escalating' };

      expect(() => transition(state, { type } as never)).toThrow(`Cannot apply ${type}`);
    },
  );

  it('CLOSE_RUN keeps the tasks and the feature it closed over', () => {
    const tasks = [makeTask({ id: 'T000', status: 'done' }), makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 1,
      attempt: 2,
    };
    const next = transition(state, { type: 'CLOSE_RUN' });
    expect(next.phase).toBe('implementing');
    expect(next.tasks).toEqual(tasks);
    expect(next.currentTaskIndex).toBe(1);
    expect(next.feature).toBe('feat');
  });

  it('INTERRUPT_STEP records the step it cut and parks the run', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
    };
    const next = transition(
      state,
      {
        type: 'INTERRUPT_STEP',
        step: { kind: 'brief', taskId: taskId('T001'), attempt: 2 },
        source: 'user',
        cut: 'mid-step',
      },
      { now: new Date('2026-05-01T10:00:00Z') },
    );
    expect(next.interruptedStep).toEqual({
      step: { kind: 'brief', taskId: 'T001', attempt: 2 },
      source: 'user',
      cut: 'mid-step',
      at: '2026-05-01T10:00:00.000Z',
    });
    expect(next.awaitingContinue).toBe(true);
    expect(next.phase).toBe('implementing');
  });

  it('INTERRUPT_STEP keeps a captured partial when the caller names one', () => {
    const next = transition(createInitialState('feat'), {
      type: 'INTERRUPT_STEP',
      step: { kind: 'planner', call: 'research' },
      source: 'watchdog',
      cut: 'mid-step',
      partialRef: { kind: 'session-log', index: 7 },
    });
    expect(next.interruptedStep?.partialRef).toEqual({ kind: 'session-log', index: 7 });
    expect(next.interruptedStep?.source).toBe('watchdog');
  });

  it('INTERRUPT_STEP records a pause between briefs as a boundary cut', () => {
    const next = transition(
      { ...createInitialState('feat'), phase: 'implementing' },
      {
        type: 'INTERRUPT_STEP',
        step: { kind: 'brief', taskId: taskId('T002'), attempt: 0 },
        source: 'user',
        cut: 'boundary',
      },
    );
    expect(next.interruptedStep?.cut).toBe('boundary');
    expect(next.awaitingContinue).toBe(true);
  });

  it('RESUME_STEP clears the parked step', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      awaitingContinue: true,
      interruptedStep: {
        step: { kind: 'review', cycle: 1 },
        source: 'user',
        at: '2026-04-01T00:00:00.000Z',
      },
    };
    const next = transition(state, { type: 'RESUME_STEP' });
    expect(next.interruptedStep).toBeUndefined();
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

  it('DRAIN_QUEUE with ids acknowledges only the listed messages still pending delivery', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      messageQueue: [
        makeQueuedMessage({ id: 'msg-a' }),
        makeQueuedMessage({ id: 'msg-b' }),
        makeQueuedMessage({ id: 'msg-injecting', nativeDeliveryState: 'injecting' }),
      ],
    };

    const next = transition(state, { type: 'DRAIN_QUEUE', ids: ['msg-a', 'msg-injecting'] });

    expect(
      next.messageQueue.map((message) => [message.id, message.drainedAt !== undefined]),
    ).toEqual([
      ['msg-a', true],
      ['msg-b', false],
      ['msg-injecting', false],
    ]);
  });

  it('DRAIN_QUEUE without ids acknowledges every message still pending delivery', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      messageQueue: [
        makeQueuedMessage({ id: 'msg-a' }),
        makeQueuedMessage({ id: 'msg-b' }),
        makeQueuedMessage({ id: 'msg-injecting', nativeDeliveryState: 'injecting' }),
      ],
    };

    const next = transition(state, { type: 'DRAIN_QUEUE' });

    expect(
      next.messageQueue.map((message) => [message.id, message.drainedAt !== undefined]),
    ).toEqual([
      ['msg-a', true],
      ['msg-b', true],
      ['msg-injecting', false],
    ]);
  });

  it('SET_PLANNER_SESSION_ID overwrites existing plannerSessionId', () => {
    let state = createInitialState('feat');
    state = transition(state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'first' });
    state = transition(state, { type: 'SET_PLANNER_SESSION_ID', sessionId: 'second' });
    expect(state.plannerSessionId).toBe('second');
  });

  it('a re-entered task at the local retry limit escalates on its next VALIDATION_FAIL', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const resumed: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
      attempt: DEFAULT_LOCAL_RETRIES,
    };
    const started = transition(resumed, { type: 'START_TASK', taskId: tasks[0]!.id });
    expect(started.attempt).toBe(DEFAULT_LOCAL_RETRIES);
    expect(started.tasks[0]?.status).toBe('in_progress');

    const sent = transition(started, { type: 'TASK_SENT' });
    const exhausted = transition(sent, { type: 'VALIDATION_FAIL' });
    expect(exhausted.phase).toBe('escalating');
    expect(exhausted.attempt).toBe(DEFAULT_LOCAL_RETRIES);
  });

  it('UPDATE_TASK_CODE without code removes stale currentCode from the selected task only', () => {
    const tasks = [
      makeTask({ id: 'T001', currentCode: 'stale code' }),
      makeTask({ id: 'T002', currentCode: 'keep code' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
    };

    const next = transition(state, {
      type: 'UPDATE_TASK_CODE',
      taskId: tasks[0]!.id,
      action: 'modify',
    });

    expect(next.tasks[0]?.currentCode).toBeUndefined();
    expect(next.tasks[1]?.currentCode).toBe('keep code');
  });

  it('full workflow: START through REVIEW_DONE', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];

    let s = createInitialState('full-flow');
    expect(s.phase).toBe('idle');

    s = transition(s, { type: 'START' });
    expect(s.phase).toBe('planning');

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

    s = transition(s, { type: 'REVIEW_DONE', reviewStatus: 'passed' });
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

  it('no longer accepts WIDEN_TASK_SCOPE from any phase', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks: [makeTask({ id: 'T001', file: 'src/a.ts' })],
    };

    expect(() =>
      transition(state, {
        type: 'WIDEN_TASK_SCOPE',
        taskId: taskId('T001'),
        paths: ['src/consumer.ts'],
        reason: 'consumer of the export',
      } as never),
    ).toThrow('Cannot apply WIDEN_TASK_SCOPE');
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

  it('CORRECT_PLAN keeps the card correction as the pending rewind until a plan compiles', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-plan' };
    const corrected = transition(state, { type: 'CORRECT_PLAN', comment: 'Greet in Polish' });
    expect(corrected.rewindPending).toEqual({ target: 'plan', comment: 'Greet in Polish' });
    expect(corrected.phase).toBe('reviewing-plan');
    const planning = transition(corrected, { type: 'BEGIN_PLANNING' });
    const compiled = transition(planning, {
      type: 'PLAN_COMPILED',
      plan: { summary: 's', decisions: [], criteria: [], checks: [], validation: null },
      tasks: [],
    });
    expect(compiled.rewindPending).toBeUndefined();
  });

  it('SPEC_CLARIFY_START -> clarifying', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-spec' };
    const next = transition(state, { type: 'SPEC_CLARIFY_START' });
    expect(next.phase).toBe('clarifying');
  });

  it.each(['idle', 'researching', 'specifying'] as const)(
    'BEGIN_PLANNING enters planning from %s',
    (phase) => {
      const state: WorkflowState = { ...createInitialState('feat'), phase };
      expect(transition(state, { type: 'BEGIN_PLANNING' }).phase).toBe('planning');
    },
  );

  // A plan gate answered with a revision invalidates the briefs, so the step loop has to re-enter
  // planning to compile them again from the plan the operator just changed.
  it('BEGIN_PLANNING re-enters planning from a parked plan gate', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-plan' };
    expect(transition(state, { type: 'BEGIN_PLANNING' }).phase).toBe('planning');
  });

  it('SPEC_CLARIFY_START enters clarifying from specifying', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'specifying' };
    expect(transition(state, { type: 'SPEC_CLARIFY_START' }).phase).toBe('clarifying');
  });

  it('SPEC_DONE opens the spec gate from constitution-check', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'constitution-check' };
    expect(transition(state, { type: 'SPEC_DONE' }).phase).toBe('reviewing-spec');
  });

  it('ANALYZE_START enters analyzing from planning', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'planning' };
    expect(transition(state, { type: 'ANALYZE_START' }).phase).toBe('analyzing');
  });

  it('PLAN_DONE settles an approved spec gate whose plan is unchanged', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-spec' };
    const next = transition(state, { type: 'PLAN_DONE', tasks });
    expect(next.phase).toBe('reviewing-plan');
    expect(next.tasks).toEqual(tasks);
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

  it.each(['planning', 'reviewing-plan', 'analyzing'] as const)(
    'BRIEFS_COMPILED from %s keeps the briefs in planning, for a run with no plan gate',
    (phase) => {
      const tasks = [makeTask({ id: 'T001' })];
      const state: WorkflowState = { ...createInitialState('feat'), phase };
      const next = transition(state, { type: 'BRIEFS_COMPILED', tasks });
      expect(next.phase).toBe('planning');
      expect(next.tasks).toEqual(tasks);
      expect(transition(next, { type: 'BRIEF_ADMISSION_OPENED' }).phase).toBe('reviewing-briefs');
    },
  );

  it.each(['planning', 'reviewing-plan', 'reviewing-briefs'] as const)(
    'BEGIN_IMPLEMENTATION enters implementing from %s',
    (phase) => {
      const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
      const state: WorkflowState = {
        ...createInitialState('feat'),
        phase,
        tasks,
        currentTaskIndex: 3,
        attempt: 2,
      };
      const next = transition(state, { type: 'BEGIN_IMPLEMENTATION' });
      expect(next.phase).toBe('implementing');
      expect(next.tasks).toEqual(tasks);
      expect(next.currentTaskIndex).toBe(0);
      expect(next.attempt).toBe(0);
    },
  );

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

  it('UPDATE_TASK_CODE replaces the anchor, sibling and context code together', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
    };

    const updated = transition(state, {
      type: 'UPDATE_TASK_CODE',
      taskId: tasks[0]!.id,
      action: 'modify',
      code: 'anchor code',
      codeByFile: { 'src/a.ts': 'anchor code', 'src/b.ts': 'sibling code' },
    });
    expect(updated.tasks[0]?.currentCode).toBe('anchor code');
    expect(updated.tasks[0]?.currentCodeByFile).toEqual({
      'src/a.ts': 'anchor code',
      'src/b.ts': 'sibling code',
    });

    const created = transition(updated, {
      type: 'UPDATE_TASK_CODE',
      taskId: tasks[0]!.id,
      action: 'create',
      codeByFile: { 'src/b.ts': 'sibling code' },
      contextCodeByFile: { 'src/types.ts': 'context code' },
    });
    expect(created.tasks[0]?.currentCode).toBeUndefined();
    expect(created.tasks[0]?.currentCodeByFile).toEqual({ 'src/b.ts': 'sibling code' });
    expect(created.tasks[0]?.contextCodeByFile).toEqual({ 'src/types.ts': 'context code' });

    expect(created.tasks[0]?.action).toBe('create');

    const cleared = transition(created, {
      type: 'UPDATE_TASK_CODE',
      taskId: tasks[0]!.id,
      action: 'create',
    });
    expect(cleared.tasks[0]?.currentCodeByFile).toBeUndefined();
    expect(cleared.tasks[0]?.contextCodeByFile).toBeUndefined();
  });

  it('REVIEW_DONE records reviewStatus', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'final-review' };

    expect(transition(state, { type: 'REVIEW_DONE', reviewStatus: 'passed' }).reviewStatus).toBe(
      'passed',
    );
    expect(transition(state, { type: 'REVIEW_DONE', reviewStatus: 'failed' }).reviewStatus).toBe(
      'failed',
    );
  });

  it('REVIEW_FIX_START resets the named tasks to pending and returns to implementing', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003', status: 'done' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'final-review',
      tasks,
      currentTaskIndex: 3,
      attempt: 2,
    };

    const next = transition(state, {
      type: 'REVIEW_FIX_START',
      cycle: 1,
      fixes: { T002: ['missing null guard'], T003: ['unhandled error'] },
    });

    expect(next.phase).toBe('implementing');
    expect(next.tasks.map((t) => t.status)).toEqual(['done', 'pending', 'pending']);
    expect(next.currentTaskIndex).toBe(1);
    expect(next.attempt).toBe(0);
    expect(next.reviewFixes).toEqual({
      cycle: 1,
      findings: { T002: ['missing null guard'], T003: ['unhandled error'] },
    });
  });

  it('REVIEW_FIX_START reopens a failed review and clears its verdict, never a passed one', () => {
    const complete: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'complete',
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      currentTaskIndex: 1,
      completedAt: '2026-09-24T00:00:00.000Z',
      reviewFixes: { cycle: 2, findings: {} },
    };
    const fix: StateAction = { type: 'REVIEW_FIX_START', cycle: 3, fixes: { T001: ['rethrow'] } };

    const reopened = transition({ ...complete, reviewStatus: 'failed' }, fix);

    expect(reopened.phase).toBe('implementing');
    expect(reopened.tasks[0]?.status).toBe('pending');
    expect(reopened.reviewStatus).toBeUndefined();
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.reviewFixes).toEqual({ cycle: 3, findings: { T001: ['rethrow'] } });
    expect(() => transition({ ...complete, reviewStatus: 'passed' }, fix)).toThrow();
  });

  it('passing or skipping a reopened brief moves the index past briefs that already passed', () => {
    const reopened: WorkflowState = transition(
      {
        ...createInitialState('feat'),
        phase: 'final-review',
        tasks: ['T001', 'T002', 'T003', 'T004'].map((id) => makeTask({ id, status: 'done' })),
        currentTaskIndex: 4,
      },
      { type: 'REVIEW_FIX_START', cycle: 1, fixes: { T001: ['a'], T004: ['b'] } },
    );
    const started = transition(reopened, { type: 'START_TASK', taskId: taskId('T001') });
    const sent = transition(started, { type: 'TASK_SENT' });

    expect(transition(sent, { type: 'VALIDATION_PASS' }).currentTaskIndex).toBe(3);
    expect(
      transition(started, { type: 'SKIP_TASK', taskId: taskId('T001') }).currentTaskIndex,
    ).toBe(3);
    expect(
      transition(
        { ...reopened, currentTaskIndex: 1 },
        { type: 'START_TASK', taskId: taskId('T004') },
      ).currentTaskIndex,
    ).toBe(3);
  });

  it('VALIDATION_PASS drops the completed task from reviewFixes findings', () => {
    const tasks = [makeTask({ id: 'T001' }), makeTask({ id: 'T002' })];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks,
      currentTaskIndex: 0,
      reviewFixes: { cycle: 1, findings: { T001: ['fix me'], T002: ['fix me too'] } },
    };

    const next = transition(state, { type: 'VALIDATION_PASS' });

    expect(next.reviewFixes?.findings).toEqual({ T002: ['fix me too'] });
  });
});

describe('consult and split state operations', () => {
  function implementationState(
    tasks: Task[],
    overrides: Partial<WorkflowState> = {},
  ): WorkflowState {
    return { ...createInitialState('feat'), phase: 'implementing', tasks, ...overrides };
  }

  function lineage(overrides: Partial<LineageRecord> = {}): LineageRecord {
    return {
      consults: 0,
      attempts: 0,
      consultAllowance: 2,
      attemptAllowance: 8,
      staleConsultedRevision: {},
      consultRecords: [],
      replacedParents: [],
      notes: [],
      ...overrides,
    };
  }

  it('REPLACE_TASK keeps the id, criteria and position and records the new revision', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'failed', criteria: ['C1'], revision: 2 }),
      makeTask({ id: 'T003' }),
    ];
    const state = implementationState(tasks, { currentTaskIndex: 2, attempt: 3 });
    const replacement = makeTask({
      id: 'T099',
      title: 'Rewritten brief',
      criteria: ['C9'],
      files: ['src/rewritten.ts'],
      inputHashes: { 'src/rewritten.ts': 'hash' },
    });

    const next = transition(state, {
      type: 'REPLACE_TASK',
      taskId: taskId('T002'),
      task: replacement,
    });

    const rewritten = next.tasks[1];
    expect(rewritten?.id).toBe('T002');
    expect(rewritten?.criteria).toEqual(['C1']);
    expect(rewritten?.title).toBe('Rewritten brief');
    expect(rewritten?.status).toBe('pending');
    expect(rewritten?.revision).toBe(3);
    expect(rewritten?.inputHashes).toEqual({ 'src/rewritten.ts': 'hash' });
    expect(next.currentTaskIndex).toBe(2);
    expect(next.attempt).toBe(0);
    expect(next.tasks[0]).toBe(tasks[0]);
    expect(next.tasks[2]).toBe(tasks[2]);
  });

  it('INSERT_TASKS replaces the parent with its subtasks and re-points pending dependents', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'failed' }),
      makeTask({ id: 'T003', dependsOn: ['T002'] }),
      makeTask({ id: 'T004', status: 'done', dependsOn: ['T002'] }),
    ];
    const state = implementationState(tasks, { currentTaskIndex: 1 });
    const children = [
      makeTask({ id: 'T011', file: 'src/split-a.ts' }),
      makeTask({ id: 'T012', file: 'src/split-b.ts', dependsOn: ['T011'] }),
    ];

    const next = transition(state, {
      type: 'INSERT_TASKS',
      parentId: taskId('T002'),
      tasks: children,
    });

    expect(next.tasks.map((task) => task.id)).toEqual(['T001', 'T011', 'T012', 'T003', 'T004']);
    expect(next.tasks.find((task) => task.id === 'T011')?.parentId).toBe('T002');
    expect(next.tasks.find((task) => task.id === 'T012')?.parentId).toBe('T002');
    expect(next.tasks.find((task) => task.id === 'T012')?.dependsOn).toEqual(['T011']);
    expect(next.tasks.find((task) => task.id === 'T003')?.dependsOn).toEqual(['T011', 'T012']);
    expect(next.tasks.find((task) => task.id === 'T004')?.dependsOn).toEqual(['T002']);
    expect(next.currentTaskIndex).toBe(1);
  });

  it('keeps lineage counters across a split and a JSON round trip through the state schema', () => {
    const state = implementationState([makeTask({ id: 'T001', status: 'failed' })], {
      currentTaskIndex: 0,
      lineages: {
        T001: lineage({
          consults: 2,
          attempts: 5,
          consultAllowance: 3,
          attemptAllowance: 12,
          staleConsultedRevision: { T001: 2 },
          notes: ['granted by the user'],
        }),
      },
    });

    const split = transition(state, {
      type: 'INSERT_TASKS',
      parentId: taskId('T001'),
      tasks: [makeTask({ id: 'T011' }), makeTask({ id: 'T012' })],
    });

    expect(split.lineages?.T001).toMatchObject({
      consults: 2,
      attempts: 5,
      consultAllowance: 3,
      attemptAllowance: 12,
      staleConsultedRevision: { T001: 2 },
      notes: ['granted by the user'],
    });
    expect(split.lineages?.T001?.replacedParents.map((task) => task.id)).toEqual(['T001']);

    const roundTripped = WorkflowStateSchema.parse(JSON.parse(JSON.stringify(split)));
    expect(roundTripped.lineages?.T001).toEqual(split.lineages?.T001);
  });

  it('RESET_TASK leaves the lineage counters alone', () => {
    const state = implementationState([makeTask({ id: 'T002', status: 'failed' })], {
      currentTaskIndex: 0,
      lineages: { T002: lineage({ consults: 2, attempts: 5 }) },
    });

    const next = transition(state, { type: 'RESET_TASK', taskId: taskId('T002') });

    expect(next.tasks[0]?.status).toBe('pending');
    expect(next.lineages?.T002?.consults).toBe(2);
    expect(next.lineages?.T002?.attempts).toBe(5);
  });

  it('GRANT_ALLOWANCE raises the lineage allowance and records the note', () => {
    const state = implementationState([makeTask({ id: 'T002' })], {
      lineages: { T002: lineage({ consults: 1, attempts: 2 }) },
    });

    const next = transition(state, {
      type: 'GRANT_ALLOWANCE',
      target: 'lineage',
      taskId: taskId('T002'),
      note: 'The user granted one more consult.',
    });

    expect(next.lineages?.T002).toMatchObject({
      consultAllowance: 3,
      attemptAllowance: 12,
      notes: ['The user granted one more consult.'],
    });
  });

  it('GRANT_ALLOWANCE for the planner adds calls and records the note on the lineage', () => {
    const state = implementationState([makeTask({ id: 'T002' })], {
      plannerCalls: { used: 3, allowance: 10 },
    });

    const next = transition(state, {
      type: 'GRANT_ALLOWANCE',
      target: 'planner',
      taskId: taskId('T002'),
      note: 'five more planner calls',
    });

    expect(next.plannerCalls).toEqual({ used: 3, allowance: 15 });
    expect(next.lineages?.T002?.notes).toEqual(['five more planner calls']);
  });

  it('RECORD_CONSULT appends the answer, counts the consult, and remembers a stale revision', () => {
    const state = implementationState([makeTask({ id: 'T002' })]);

    const next = transition(
      state,
      {
        type: 'RECORD_CONSULT',
        taskId: taskId('T002'),
        revision: 2,
        reason: 'stale',
        answer: {
          answer: {
            action: 'guidance',
            diagnosis: 'The captured code is from an older revision.',
            instructions: 'Re-read the file.',
            context: null,
          },
        },
      },
      { now: new Date('2026-05-01T10:00:00Z') },
    );

    expect(next.lineages?.T002).toMatchObject({
      consults: 1,
      staleConsultedRevision: { T002: 2 },
    });
    expect(next.lineages?.T002?.consultRecords[0]).toEqual({
      reason: 'stale',
      action: 'guidance',
      diagnosis: 'The captured code is from an older revision.',
      at: '2026-05-01T10:00:00.000Z',
      taskId: 'T002',
      revision: 2,
      answer: {
        answer: {
          action: 'guidance',
          diagnosis: 'The captured code is from an older revision.',
          instructions: 'Re-read the file.',
          context: null,
        },
      },
    });
  });

  it('COUNT_ATTEMPT and COUNT_PLANNER_CALL raise the lineage counters', () => {
    let state = implementationState([makeTask({ id: 'T002' })], {
      plannerCalls: { used: 0, allowance: 10 },
    });

    state = transition(state, { type: 'COUNT_ATTEMPT', taskId: taskId('T002') });
    state = transition(state, { type: 'COUNT_ATTEMPT', taskId: taskId('T002') });
    state = transition(state, { type: 'COUNT_PLANNER_CALL' });

    expect(state.lineages?.T002?.attempts).toBe(2);
    expect(state.plannerCalls).toEqual({ used: 1, allowance: 10 });
  });

  it('SET_TASK_INPUT_HASHES and RECORD_CHECK_RESULTS update the task', () => {
    const state = implementationState([makeTask({ id: 'T002' })]);

    const hashed = transition(state, {
      type: 'SET_TASK_INPUT_HASHES',
      taskId: taskId('T002'),
      inputHashes: { 'src/a.ts': 'sha' },
    });
    expect(hashed.tasks[0]?.inputHashes).toEqual({ 'src/a.ts': 'sha' });

    const recorded = transition(hashed, {
      type: 'RECORD_CHECK_RESULTS',
      taskId: taskId('T002'),
      results: [
        { id: 'K1', passed: true },
        { id: 'K2', passed: false },
      ],
    });
    expect(recorded.tasks[0]?.checkResults).toEqual([
      { id: 'K1', passed: true },
      { id: 'K2', passed: false },
    ]);

    const rerun = transition(recorded, {
      type: 'RECORD_CHECK_RESULTS',
      taskId: taskId('T002'),
      results: [{ id: 'K2', passed: true }],
    });
    expect(rerun.tasks[0]?.checkResults).toEqual([
      { id: 'K1', passed: true },
      { id: 'K2', passed: true },
    ]);
  });

  it('SET_SEAT_WAIT parks the seat and CLEAR_SEAT_WAIT releases it', () => {
    const state = implementationState([makeTask({ id: 'T002' })]);

    const waiting = transition(state, {
      type: 'SET_SEAT_WAIT',
      seat: 'plan',
      resetAt: '2026-05-01T10:00:00.000Z',
    });
    expect(waiting.seatWait).toEqual({ seat: 'plan', resetAt: '2026-05-01T10:00:00.000Z' });

    expect(transition(waiting, { type: 'CLEAR_SEAT_WAIT' }).seatWait).toBeUndefined();
  });
});
