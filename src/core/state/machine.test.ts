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
  fixCyclesOf,
  type ChangedFilesSnapshot,
  type LineageRecord,
  type QueuedMessage,
  type WorkflowState,
} from '../schemas/workflow.js';
import { taskId, type Task } from '../schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeTaskSpec } from '#testing/helpers/factories/plan.js';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { DEFAULT_LOCAL_RETRIES } from '../pipeline-spec/retries.js';
import { BOUNDS } from '../pipeline-spec/bounds.js';
import { deriveRunStatus } from '../sessions/run-status.js';
import { reviewsAgain } from '../review/verdict.js';
import { plainUserMessage } from '../types/user-input.js';

function makeQueuedMessage(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: 'msg-test',
    ...plainUserMessage('queued message'),
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
  it.each(['implementing', 'escalating', 'planning', 'final-review'] as const)(
    'refuses RESUME_TASK outside validation in %s',
    (phase) => {
      const state: WorkflowState = { ...createInitialState('feat'), phase };

      expect(() => transition(state, { type: 'RESUME_TASK' })).toThrow(
        `Cannot apply RESUME_TASK while workflow is in ${phase}.`,
      );
    },
  );

  it.each(['implementing', 'validating-task', 'escalating'] as const)(
    'preserves the task phase across a consult question in %s',
    (phase) => {
      const state = { ...createInitialState('feat'), phase, tasks: [makeTask()] };
      const conversation = {
        call: 'plan' as const,
        text: 'Which approach?',
        questions: [],
        answers: [{ reply: 'Which approach?', answer: 'Keep it' }],
        answered: true,
      };
      const asked = transition(state, { type: 'SET_PLANNER_CONVERSATION', conversation });
      expect(asked.phase).toBe(phase);
      const cleared = transition(asked, { type: 'CLEAR_PLANNER_CONVERSATION' });
      expect(cleared.phase).toBe(phase);
      expect(cleared.pendingPlannerConversation).toBeUndefined();
      expect(cleared.userAnswers).toEqual(conversation.answers);
    },
  );

  it('keeps fix identity and verbatim findings through a rewrite and split', () => {
    const fix = {
      cycle: 1,
      findings: [{ id: 'F1', text: 'VERBATIM defect', acceptance: 'keep the error' }],
    };
    const task = makeTask({ id: 'T001', fix });
    const state = { ...createInitialState('feat'), phase: 'implementing' as const, tasks: [task] };
    const rewritten = transition(state, {
      type: 'REPLACE_TASK',
      taskId: task.id,
      task: makeTask({ id: 'T001', description: 'New approach' }),
    });
    expect(rewritten.tasks[0]?.fix).toEqual(fix);
    expect(rewritten.tasks[0]?.description).toContain('VERBATIM defect');
    const split = transition(rewritten, {
      type: 'INSERT_TASKS',
      parentId: task.id,
      tasks: [makeTask({ id: 'T002' }), makeTask({ id: 'T003' })],
    });
    for (const child of split.tasks) {
      expect(child.fix).toEqual(fix);
      expect(child.description).toContain('VERBATIM defect');
      expect(child.description).toContain('Acceptance: keep the error');
    }
  });
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

  it('CLOSE_RUN records the run.patch the close saved the changes in', () => {
    const next = transition(
      createInitialState('feat'),
      { type: 'CLOSE_RUN', as: 'discarded', patch: '.splitbrief/sessions/s1/run.patch' },
      { now: new Date('2026-05-01T10:00:00Z') },
    );
    expect(next.closed).toEqual({
      at: '2026-05-01T10:00:00.000Z',
      as: 'discarded',
      patch: '.splitbrief/sessions/s1/run.patch',
    });
  });

  it('APPLY_UNDONE records the undo on an applied run once and keeps it closed', () => {
    const applied: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'complete',
      applied: { at: '2026-05-01T10:00:00.000Z', backupId: 'b1', files: ['src/a.ts'] },
      closed: { at: '2026-05-01T10:00:00.000Z', as: 'applied' },
    };

    const undone = transition(
      applied,
      { type: 'APPLY_UNDONE', conflicts: ['src/b.ts'] },
      { now: new Date('2026-05-02T10:00:00Z') },
    );

    expect(undone.applied?.undone).toEqual({
      at: '2026-05-02T10:00:00.000Z',
      conflicts: ['src/b.ts'],
    });
    expect(undone.closed).toEqual(applied.closed);
    expect(() => transition(undone, { type: 'APPLY_UNDONE', conflicts: [] })).toThrow(
      'Cannot apply APPLY_UNDONE',
    );
    const ended: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'complete',
      closed: { at: '2026-05-01T10:00:00.000Z', as: 'ended' },
    };
    expect(() => transition(ended, { type: 'APPLY_UNDONE', conflicts: [] })).toThrow(
      'Cannot apply APPLY_UNDONE',
    );
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

  it('INTERRUPT_STEP records the files a cut brief kept, and nothing when it kept none', () => {
    const step = { kind: 'brief', taskId: taskId('T001'), attempt: 0 } as const;
    const base: WorkflowState = { ...createInitialState('feat'), phase: 'implementing' };
    const kept = transition(base, {
      type: 'INTERRUPT_STEP',
      step,
      source: 'user',
      cut: 'mid-step',
      kept: ['src/a.ts', 'src/b.ts'],
    });
    expect(kept.interruptedStep?.kept).toEqual(['src/a.ts', 'src/b.ts']);

    const none = transition(base, {
      type: 'INTERRUPT_STEP',
      step,
      source: 'user',
      cut: 'mid-step',
      kept: [],
    });
    expect(none.interruptedStep).not.toHaveProperty('kept');
  });

  it('RECORD_REJECT drops the files a reject put back from the stop, and the list when none stay', () => {
    const step = { kind: 'brief', taskId: taskId('T002'), attempt: 0 } as const;
    const stopped = transition(
      { ...createInitialState('feat'), phase: 'implementing' },
      { type: 'INTERRUPT_STEP', step, source: 'user', cut: 'mid-step', kept: ['a.ts', 'b.ts'] },
    );

    const partly = transition(stopped, {
      type: 'RECORD_REJECT',
      removed: ['a.ts', 'c.ts'],
      booked: [],
    });
    expect(partly.interruptedStep).toMatchObject({ step, cut: 'mid-step', kept: ['b.ts'] });
    expect(partly.awaitingContinue).toBe(true);

    const all = transition(partly, { type: 'RECORD_REJECT', removed: ['b.ts'], booked: [] });
    expect(all.interruptedStep).toMatchObject({ step, cut: 'mid-step' });
    expect(all.interruptedStep).not.toHaveProperty('kept');
    expect(deriveRunStatus({ state: all, liveness: 'not-alive' })).toMatchObject({
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'mid-step' } },
    });
    expect(deriveRunStatus({ state: all, liveness: 'not-alive' })).not.toHaveProperty(
      'stop.on.kept',
    );

    const unstopped = createInitialState('feat');
    expect(transition(unstopped, { type: 'RECORD_REJECT', removed: ['a.ts'], booked: [] })).toBe(
      unstopped,
    );
  });

  it('RECORD_REJECT reopens each passed brief whose files a reject put back, and the run waits before the first', () => {
    const step = { kind: 'brief', taskId: taskId('T003'), attempt: 1 } as const;
    const dispatched = [taskId('T002'), taskId('T003')].reduce<WorkflowState>(
      (state, id) => transition(state, { type: 'RECORD_DISPATCH', taskId: id }),
      {
        ...createInitialState('feat'),
        phase: 'implementing',
        tasks: [
          makeTask({ id: 'T001', status: 'done' }),
          makeTask({ id: 'T002', status: 'escalated' }),
          makeTask({ id: 'T003', status: 'in_progress' }),
        ],
        currentTaskIndex: 2,
        attempt: 1,
      },
    );
    const stopped = transition(dispatched, {
      type: 'INTERRUPT_STEP',
      step,
      source: 'user',
      cut: 'mid-step',
      kept: ['c.ts'],
    });

    const next = transition(stopped, {
      type: 'RECORD_REJECT',
      removed: ['b.ts', 'c.ts'],
      booked: [taskId('T002'), taskId('T003')],
    });

    expect(next.tasks.map((task) => [task.id, task.status])).toEqual([
      ['T001', 'done'],
      ['T002', 'pending'],
      ['T003', 'in_progress'],
    ]);
    expect(next).toMatchObject({ phase: 'implementing', currentTaskIndex: 1, attempt: 0 });
    expect(next.lineages?.T002?.dispatchedRevision).toEqual({});
    expect(next.lineages?.T003?.dispatchedRevision).toEqual({ T003: 1 });
    expect(next.interruptedStep).toEqual({
      step: { kind: 'brief', taskId: 'T002', attempt: 0 },
      source: 'user',
      cut: 'boundary',
      at: stopped.interruptedStep?.at,
    });
    expect(deriveRunStatus({ state: next, liveness: 'not-alive' })).toMatchObject({
      stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
      resumeAt: { kind: 'brief', taskId: 'T002', attempt: 0 },
    });
  });

  it.each([
    {
      halt: 'a halted brief',
      phase: 'escalating',
      currentTaskIndex: 1,
      issue: makeRecoveryIssue({ taskId: taskId('T002'), affectedTaskIds: [taskId('T002')] }),
    },
    {
      halt: 'a failed final review',
      phase: 'complete',
      currentTaskIndex: 2,
      issue: makeRecoveryIssue({
        reason: 'review-failed',
        phase: 'complete',
        taskId: undefined,
        affectedTaskIds: [],
      }),
    },
  ] as const)(
    'RECORD_REJECT that reopens a brief before $halt clears the halt, and the run waits before the brief',
    ({ phase, currentTaskIndex, issue }) => {
      const halted: WorkflowState = {
        ...createInitialState('feat'),
        phase,
        tasks: [
          makeTask({ id: 'T001', status: 'done' }),
          makeTask({ id: 'T002', status: 'in_progress' }),
        ],
        currentTaskIndex,
        attempt: 3,
        pendingRecovery: issue,
        review: {
          scope: 'final',
          cycle: 0,
          verdict: { tasks: [], criteria: [], findings: [] },
          outcome: 'fail',
          verification: [],
          redInputs: [{ id: 'P1', text: 'Required check K1 did not pass' }],
          at: '2026-10-03T10:00:00.000Z',
        },
        pendingTriage: {
          inputs: [
            {
              id: 'P1',
              kind: 'defect',
              source: 'check',
              text: 'Required check K1 did not pass',
              file: null,
            },
          ],
        },
        pendingScheduledReview: { afterTaskId: taskId('T001') },
      };

      const next = transition(halted, {
        type: 'RECORD_REJECT',
        removed: ['a.ts'],
        booked: [taskId('T001')],
      });

      expect(next.pendingRecovery).toBeUndefined();
      expect(next.pendingTriage).toBeUndefined();
      expect(next.pendingScheduledReview).toBeUndefined();
      expect(reviewsAgain(next, 'final')).toBe(false);
      expect(next).toMatchObject({ phase: 'implementing', currentTaskIndex: 0, attempt: 0 });
      expect(next.interruptedStep).toMatchObject({
        step: { kind: 'brief', taskId: 'T001', attempt: 0 },
        source: 'user',
        cut: 'boundary',
      });
      expect(deriveRunStatus({ state: next, liveness: 'not-alive' })).toMatchObject({
        stop: { kind: 'stopped', on: { kind: 'paused', at: 'boundary' } },
        resumeAt: { kind: 'brief', taskId: 'T001', attempt: 0 },
      });
    },
  );

  it('RECORD_REJECT that reopens no brief before the halt keeps the halt', () => {
    const issue = makeRecoveryIssue({ taskId: taskId('T001'), affectedTaskIds: [taskId('T001')] });
    const halted: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks: [makeTask({ id: 'T001', status: 'in_progress' })],
      pendingRecovery: issue,
    };

    const next = transition(halted, { type: 'RECORD_REJECT', removed: ['a.ts'], booked: [] });

    expect(next.pendingRecovery).toBe(issue);
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

  it('no longer accepts WIDEN_TASK_SCOPE from any phase', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'escalating',
      tasks: [makeTask({ id: 'T001', suggestedFiles: ['src/a.ts'] })],
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

  it.each([
    'RESEARCH_DONE',
    'SPEC_DONE',
    'APPROVE_SPEC',
    'SPEC_CLARIFY_START',
    'SPEC_CLARIFY_DONE',
    'CONSTITUTION_CHECK_PASS',
    'BRIEFS_COMPILED',
    'BRIEF_ADMISSION_OPENED',
    'ANALYZE_START',
    'REWIND_TO_SPEC',
    'REWIND_TO_PLAN',
  ])('refuses the retired chain action %s', (type) => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'planning' };
    expect(() => transition(state, { type } as never)).toThrow(`Cannot apply ${type}`);
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

  it('PLAN_DONE settles an approved spec gate whose plan is unchanged', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'reviewing-spec' };
    const next = transition(state, { type: 'PLAN_DONE', tasks });
    expect(next.phase).toBe('reviewing-plan');
    expect(next.tasks).toEqual(tasks);
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

  it('PLAN_DONE from specifying enters reviewing-plan', () => {
    const tasks = [makeTask({ id: 'T001' })];
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'specifying' };
    const next = transition(state, { type: 'PLAN_DONE', tasks });
    expect(next.phase).toBe('reviewing-plan');
    expect(next.tasks).toEqual(tasks);
  });

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

  it('MARK_RECOVERY_APPLYING records selected action while keeping recovery pending', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      pendingRecovery: makeRecoveryIssue(),
    };

    const next = transition(state, {
      type: 'MARK_RECOVERY_APPLYING',
      action: 'skip-current-task',
    });

    expect(next.phase).toBe('validating-task');
    expect(next.pendingRecovery?.status).toBe('applying');
    expect(next.pendingRecovery?.selectedAction).toBe('skip-current-task');
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

  it('RESTART_ATTEMPT_ON_SEAT clears the halt and keeps the attempt, task and parked step', () => {
    const tasks = [makeTask({ id: 'T001', status: 'in_progress' })];
    const interruptedStep: NonNullable<WorkflowState['interruptedStep']> = {
      step: { kind: 'brief', taskId: taskId('T001'), attempt: 3 },
      source: 'seat',
      cut: 'mid-step',
      at: '2026-04-01T00:00:00.000Z',
    };
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 0,
      attempt: 3,
      pendingRecovery: makeRecoveryIssue({
        status: 'applying',
        selectedAction: 'switch-seat',
        taskId: taskId('T001'),
      }),
      interruptedStep,
      awaitingContinue: true,
    };

    const next = transition(state, { type: 'RESTART_ATTEMPT_ON_SEAT', taskId: taskId('T001') });

    expect(next.pendingRecovery).toBeUndefined();
    expect(next.attempt).toBe(3);
    expect(next.currentTaskIndex).toBe(0);
    expect(next.tasks[0]?.status).toBe('in_progress');
    expect(next.interruptedStep).toEqual(interruptedStep);
    expect(next.awaitingContinue).toBe(true);
  });

  it('pins the brief to the profile a recovery names until the brief settles', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', status: 'in_progress' }), makeTask({ id: 'T002' })],
      currentTaskIndex: 0,
    };
    const pin = { taskId: taskId('T001'), profile: 'small' };

    const moved = transition(state, {
      type: 'RESTART_ATTEMPT_ON_SEAT',
      taskId: taskId('T001'),
      profile: 'small',
    });
    expect(moved.retryProfile).toEqual(pin);
    const reset = transition(moved, { type: 'RESET_TASK', taskId: taskId('T001') });
    expect(reset.retryProfile).toEqual(pin);
    expect(
      transition(state, { type: 'RESET_TASK', taskId: taskId('T001'), profile: 'small' })
        .retryProfile,
    ).toEqual(pin);
    const started = transition(reset, { type: 'START_TASK', taskId: taskId('T001') });
    expect(started.retryProfile).toEqual(pin);
    const passed = transition(transition(started, { type: 'TASK_SENT' }), {
      type: 'VALIDATION_PASS',
    });
    expect(passed.retryProfile).toBe(undefined);
    expect(transition(started, { type: 'SKIP_TASK', taskId: taskId('T001') }).retryProfile).toBe(
      undefined,
    );
    expect(transition(started, { type: 'SKIP_TASK', taskId: taskId('T002') }).retryProfile).toEqual(
      pin,
    );
  });

  it('RESTART_ATTEMPT_ON_SEAT leaves a task it does not know alone', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001' })],
      pendingRecovery: makeRecoveryIssue({ status: 'applying', selectedAction: 'switch-seat' }),
    };
    const unknown = transition(state, {
      type: 'RESTART_ATTEMPT_ON_SEAT',
      taskId: taskId('T999'),
    });

    expect(unknown).toBe(state);
  });

  it('RECORD_SEAT_SWITCH appends one switch record with its timestamp', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001' })],
    };

    const next = transition(
      state,
      {
        type: 'RECORD_SEAT_SWITCH',
        switchId: 'b8b5c54f-97b8-47e0-8d19-30f7e671c972',
        seat: 'build',
        from: 'OpenCode CLI · deepseek/deepseek-flash',
        to: 'OpenCode CLI · opencode-go/deepseek-v4.1-flash',
        fromSeat: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        toSeat: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
        cause: 'runner-usage-limit',
        auto: true,
        configRevision: 'abc123',
      },
      { now: new Date('2026-10-07T10:00:00Z') },
    );

    expect(next.seatSwitches).toEqual([
      {
        switchId: 'b8b5c54f-97b8-47e0-8d19-30f7e671c972',
        seat: 'build',
        from: 'OpenCode CLI · deepseek/deepseek-flash',
        to: 'OpenCode CLI · opencode-go/deepseek-v4.1-flash',
        fromSeat: { tool: 'opencode', model: 'deepseek/deepseek-flash' },
        toSeat: { tool: 'opencode', model: 'opencode-go/deepseek-v4.1-flash' },
        cause: 'runner-usage-limit',
        auto: true,
        configRevision: 'abc123',
        ts: '2026-10-07T10:00:00.000Z',
      },
    ]);
    expect(WorkflowStateSchema.safeParse(next).success).toBe(true);
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

  it('a passed review clears its pending correction inputs', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'final-review',
      pendingTriage: {
        inputs: [{ id: 'U1', kind: 'defect', source: 'user', text: 'Keep the error', file: null }],
      },
    };
    expect(
      transition(state, { type: 'REVIEW_DONE', reviewStatus: 'passed' }).pendingTriage,
    ).toBeUndefined();
    expect(
      transition(state, { type: 'REVIEW_DONE', reviewStatus: 'failed' }).pendingTriage,
    ).toEqual(state.pendingTriage);
  });

  it('passing or skipping a fix brief advances past the briefs that already passed', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [
        ...['T001', 'T002', 'T003'].map((id) => makeTask({ id, status: 'done' })),
        makeTask({ id: 'T004', suggestedFiles: ['src/fix.ts'] }),
      ],
      currentTaskIndex: 3,
    };
    const started = transition(state, { type: 'START_TASK', taskId: taskId('T004') });
    const sent = transition(started, { type: 'TASK_SENT' });

    expect(transition(sent, { type: 'VALIDATION_PASS' }).currentTaskIndex).toBe(4);
    expect(transition(state, { type: 'SKIP_TASK', taskId: taskId('T004') }).currentTaskIndex).toBe(
      4,
    );
  });

  it('passing a brief advances past a brief the user skipped', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      tasks: [
        makeTask({ id: 'T001', status: 'in_progress' }),
        makeTask({ id: 'T002', status: 'skipped' }),
        makeTask({ id: 'T003' }),
      ],
      currentTaskIndex: 0,
    };

    const next = transition(state, { type: 'VALIDATION_PASS' });

    expect(next.currentTaskIndex).toBe(2);
    expect(next.tasks.map((task) => task.status)).toEqual(['done', 'skipped', 'pending']);
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
      attempts: 0,
      dispatchedRevision: {},
      consultRecords: [],
      replacedParents: [],
      notes: [],
      ...overrides,
    };
  }

  it('RESUME_TASK returns to BUILD without changing the brief or spending an attempt', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'validating-task',
      attempt: 1,
      tasks: [makeTask({ status: 'in_progress' })],
      lineages: { T001: lineage({ attempts: 3 }) },
      messageQueue: [makeQueuedMessage({ phase: 'validating-task' })],
    };

    expect(transition(state, { type: 'RESUME_TASK' })).toEqual({
      ...state,
      phase: 'implementing',
    });
  });

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
      suggestedFiles: ['src/rewritten.ts'],
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
      makeTask({ id: 'T011', suggestedFiles: ['src/split-a.ts'] }),
      makeTask({ id: 'T012', suggestedFiles: ['src/split-b.ts'], dependsOn: ['T011'] }),
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
          attempts: 5,
          progress: {
            failure: [{ source: 'check K1', keys: ['src/a.ts: TS2322'] }],
            unmoved: 1,
            answers: 2,
          },
          notes: ['the user continued'],
        }),
      },
    });

    const split = transition(state, {
      type: 'INSERT_TASKS',
      parentId: taskId('T001'),
      tasks: [makeTask({ id: 'T011' }), makeTask({ id: 'T012' })],
    });

    expect(split.lineages?.T001).toMatchObject({
      attempts: 5,
      progress: {
        failure: [{ source: 'check K1', keys: ['src/a.ts: TS2322'] }],
        unmoved: 1,
        answers: 2,
      },
      notes: ['the user continued'],
    });
    expect(split.lineages?.T001?.replacedParents.map((task) => task.id)).toEqual(['T001']);

    const roundTripped = WorkflowStateSchema.parse(JSON.parse(JSON.stringify(split)));
    expect(roundTripped.lineages?.T001).toEqual(split.lineages?.T001);
  });

  it('RESET_TASK leaves the lineage counters alone', () => {
    const state = implementationState([makeTask({ id: 'T002', status: 'failed' })], {
      currentTaskIndex: 0,
      lineages: {
        T002: lineage({
          attempts: 5,
          progress: {
            failure: [{ source: 'check K1', keys: ['src/a.ts: TS2322'] }],
            unmoved: 1,
            answers: 2,
          },
        }),
      },
    });

    const next = transition(state, { type: 'RESET_TASK', taskId: taskId('T002') });

    expect(next.tasks[0]?.status).toBe('pending');
    expect(next.lineages?.T002?.progress).toEqual({
      failure: [{ source: 'check K1', keys: ['src/a.ts: TS2322'] }],
      unmoved: 1,
      answers: 2,
    });
    expect(next.lineages?.T002?.attempts).toBe(5);
  });

  it('RESET_PROGRESS clears the progress, keeps the attempts and records the note', () => {
    const state = implementationState([makeTask({ id: 'T002' })], {
      lineages: {
        T002: lineage({
          attempts: 2,
          progress: {
            failure: [{ source: 'check K1', keys: ['src/a.ts: TS2322'] }],
            unmoved: 1,
            answers: 2,
          },
        }),
      },
    });

    const next = transition(state, {
      type: 'RESET_PROGRESS',
      taskId: taskId('T002'),
      note: 'The user continued the brief.',
      failingOutput: 'FAIL src/a.test.ts',
    });

    expect(next.lineages?.T002).not.toHaveProperty('progress');
    expect(next.lineages?.T002).toMatchObject({
      attempts: 2,
      notes: ['The user continued the brief.'],
      carriedFailure: 'FAIL src/a.test.ts',
    });
  });

  it('RECORD_CONSULT records the answer and the progress and leaves the task alone', () => {
    const task = makeTask({ id: 'T002' });
    const state = implementationState([task]);

    const next = transition(
      state,
      {
        type: 'RECORD_CONSULT',
        taskId: taskId('T002'),
        revision: 2,
        reason: 'failed',
        seat: 'plan',
        progress: {
          failure: [{ source: 'check K1', keys: ['src/a.ts: TS2322'] }],
          unmoved: 1,
          answers: 2,
        },
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

    expect(next.lineages?.T002?.progress).toEqual({
      failure: [{ source: 'check K1', keys: ['src/a.ts: TS2322'] }],
      unmoved: 1,
      answers: 2,
    });
    expect(next.tasks[0]).toBe(task);
    expect(next.lineages?.T002?.consultRecords[0]).toEqual({
      reason: 'failed',
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
      seat: 'plan',
    });
  });

  it('COUNT_ATTEMPT raises the lineage attempt count', () => {
    let state = implementationState([makeTask({ id: 'T002' })]);

    state = transition(state, { type: 'COUNT_ATTEMPT', taskId: taskId('T002') });
    state = transition(state, { type: 'COUNT_ATTEMPT', taskId: taskId('T002') });

    expect(state.lineages?.T002?.attempts).toBe(2);
  });

  it('RECORD_CHECK_RESULTS updates the task', () => {
    const state = implementationState([makeTask({ id: 'T002', revision: 2 })]);

    const recorded = transition(state, {
      type: 'RECORD_CHECK_RESULTS',
      taskId: taskId('T002'),
      results: [
        { id: 'K1', status: 'pass' },
        { id: 'K2', status: 'fail' },
      ],
    });
    expect(recorded.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'fail' },
    ]);

    const rerun = transition(recorded, {
      type: 'RECORD_CHECK_RESULTS',
      taskId: taskId('T002'),
      results: [{ id: 'K2', status: 'pass' }],
    });
    expect(rerun.tasks[0]?.checkResults).toEqual([
      { id: 'K1', status: 'pass' },
      { id: 'K2', status: 'pass' },
    ]);
  });

  it('RECORD_DISPATCH stamps the revision a brief dispatched, and an older lineage reads none', () => {
    const state = implementationState([makeTask({ id: 'T002', revision: 2 })]);

    const dispatched = transition(state, { type: 'RECORD_DISPATCH', taskId: taskId('T002') });
    expect(dispatched.lineages?.T002?.dispatchedRevision).toEqual({ T002: 2 });

    const { dispatchedRevision: _dropped, ...older } = dispatched.lineages?.T002 ?? {};
    const parsed = WorkflowStateSchema.parse({ ...dispatched, lineages: { T002: older } });
    expect(parsed.lineages?.T002?.dispatchedRevision).toEqual({});
  });

  it('COUNT_ATTEMPT records the first line of a failure, bounded, with the attempt and revision', () => {
    let state = implementationState([makeTask({ id: 'T002', revision: 2 })]);

    state = transition(state, {
      type: 'COUNT_ATTEMPT',
      taskId: taskId('T002'),
      failure: '\ncheck K1 did not pass (fail): \n> mocha\nError: Cannot find module',
    });
    state = transition(state, { type: 'COUNT_ATTEMPT', taskId: taskId('T002') });
    state = transition(state, {
      type: 'COUNT_ATTEMPT',
      taskId: taskId('T002'),
      failure: 'y'.repeat(1_000),
    });

    const failures = state.lineages?.T002?.attemptFailures ?? [];
    expect(state.lineages?.T002?.attempts).toBe(3);
    expect(failures).toMatchObject([
      { attempt: 1, taskId: 'T002', revision: 2, line: 'check K1 did not pass (fail):' },
      { attempt: 3, taskId: 'T002', revision: 2 },
    ]);
    expect(failures[1]?.line.length).toBe(BOUNDS.consultAttemptLineChars);
  });

  describe('the task start of a lineage', () => {
    const start: ChangedFilesSnapshot = { head: 'h1', files: [], dirtyFileContents: {} };
    const later: ChangedFilesSnapshot = { head: 'h1', files: ['src/a.ts'], dirtyFileContents: {} };
    const baseline = (activeTaskSnapshot: ChangedFilesSnapshot) => ({
      head: 'h1',
      fingerprints: {},
      activeTaskSnapshot,
    });

    it('RECORD_DISPATCH keeps the first start across a rewrite and a split until the last brief passes', () => {
      let state = implementationState([makeTask({ id: 'T002' }), makeTask({ id: 'T004' })], {
        currentTaskIndex: 0,
        changedFilesBaseline: baseline(start),
      });

      state = transition(state, { type: 'RECORD_DISPATCH', taskId: taskId('T002') });
      expect(state.lineages?.T002?.startSnapshot).toEqual(start);

      state = transition(
        { ...state, changedFilesBaseline: baseline(later) },
        { type: 'REPLACE_TASK', taskId: taskId('T002'), task: makeTask({ id: 'T002' }) },
      );
      state = transition(state, { type: 'RECORD_DISPATCH', taskId: taskId('T002') });
      expect(state.lineages?.T002?.startSnapshot).toEqual(start);

      state = transition(state, {
        type: 'INSERT_TASKS',
        parentId: taskId('T002'),
        tasks: [makeTask({ id: 'T011' }), makeTask({ id: 'T012' })],
      });
      state = transition(state, { type: 'RECORD_DISPATCH', taskId: taskId('T011') });
      state = transition(state, { type: 'VALIDATION_PASS' });
      expect(state.lineages?.T002?.startSnapshot).toEqual(start);

      state = transition(state, { type: 'RECORD_DISPATCH', taskId: taskId('T012') });
      state = transition(state, { type: 'VALIDATION_PASS' });
      expect(state.lineages?.T002).toBeDefined();
      expect(state.lineages?.T002?.startSnapshot).toBeUndefined();
      expect(WorkflowStateSchema.parse(JSON.parse(JSON.stringify(state))).lineages).toEqual(
        state.lineages,
      );
    });

    it('SKIP_TASK drops the start of the lineage it closes', () => {
      let state = implementationState([makeTask({ id: 'T002' })], {
        currentTaskIndex: 0,
        changedFilesBaseline: baseline(start),
      });

      state = transition(state, { type: 'RECORD_DISPATCH', taskId: taskId('T002') });
      expect(state.lineages?.T002?.startSnapshot).toEqual(start);
      state = transition(state, { type: 'SKIP_TASK', taskId: taskId('T002') });

      expect(state.lineages?.T002).toBeDefined();
      expect(state.lineages?.T002?.startSnapshot).toBeUndefined();
    });
  });

  it('SET_PENDING_REVIEW_COMMANDS replaces the list and clears an empty list', () => {
    const state = implementationState([makeTask({ id: 'T002' })]);
    const pending = transition(state, {
      type: 'SET_PENDING_REVIEW_COMMANDS',
      commands: ['npm test', 'npm run typecheck'],
    });
    const replaced = transition(pending, {
      type: 'SET_PENDING_REVIEW_COMMANDS',
      commands: ['npm run typecheck'],
    });
    expect(replaced.pendingReviewCommands).toEqual(['npm run typecheck']);
    expect(
      transition(replaced, { type: 'SET_PENDING_REVIEW_COMMANDS', commands: [] })
        .pendingReviewCommands,
    ).toBeUndefined();
  });

  it('SET_SEAT_WAIT parks the seat and CLEAR_SEAT_WAIT releases it', () => {
    const state = implementationState([makeTask({ id: 'T002' })]);

    const wait = {
      seat: 'plan',
      resetAt: '2026-05-01T10:00:00.000Z',
      tool: 'codex',
      kind: 'cli',
    } as const;
    const waiting = transition(state, { type: 'SET_SEAT_WAIT', wait });
    expect(waiting.seatWait).toEqual(wait);

    expect(transition(waiting, { type: 'CLEAR_SEAT_WAIT' }).seatWait).toBeUndefined();
  });
});

describe('fix cycles, review and triage records', () => {
  function failedReviewState(overrides: Partial<WorkflowState> = {}): WorkflowState {
    return {
      ...createInitialState('feat'),
      phase: 'complete',
      reviewStatus: 'failed',
      completedAt: '2026-10-03T09:00:00.000Z',
      ...overrides,
    };
  }

  it('INSERT_TASKS with a null parent appends the tasks and leaves the run untouched', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'final-review',
      tasks,
      currentTaskIndex: 2,
    };
    const fix = makeTask({ id: 'T003', suggestedFiles: ['src/fix.ts'] });

    const next = transition(state, { type: 'INSERT_TASKS', parentId: null, tasks: [fix] });

    expect(next.tasks.map((task) => task.id)).toEqual(['T001', 'T002', 'T003']);
    expect(next.tasks[0]).toBe(tasks[0]);
    expect(next.tasks[1]).toBe(tasks[1]);
    expect(next.currentTaskIndex).toBe(2);
    expect(next.lineages).toBeUndefined();
  });

  it('START_FIX_CYCLE counts the cycle, reopens no task and takes the first open brief', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002', status: 'done' }),
      makeTask({ id: 'T003' }),
    ];
    const state = failedReviewState({
      tasks,
      currentTaskIndex: 3,
      fixCycles: { used: 1, notes: [] },
      pendingTriage: { inputs: [] },
    });

    const next = transition(state, { type: 'START_FIX_CYCLE' });

    expect(next.phase).toBe('implementing');
    expect(next.fixCycles).toEqual({ used: 2, notes: [], open: { cycle: 2 } });
    expect(next.reviewStatus).toBeUndefined();
    expect(next.completedAt).toBeUndefined();
    expect(next.pendingTriage).toBeUndefined();
    expect(next.currentTaskIndex).toBe(2);
    expect(next.tasks.map((task) => task.status)).toEqual(['done', 'done', 'pending']);
  });

  it('START_FIX_CYCLE counts from the legacy review cycle when fixCycles is absent', () => {
    const state = failedReviewState({ reviewFixes: { cycle: 1, findings: {} } });

    const next = transition(state, { type: 'START_FIX_CYCLE' });

    expect(next.fixCycles).toEqual({ used: 2, notes: [], open: { cycle: 2 } });
  });

  it('START_FIX_CYCLE clears the scheduled review and its triage', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })],
      currentTaskIndex: 1,
      pendingScheduledReview: { afterTaskId: taskId('T001') },
      pendingTriage: { inputs: [], reviewAfterTaskId: taskId('T001') },
    };

    const next = transition(state, { type: 'START_FIX_CYCLE' });

    expect(next.pendingScheduledReview).toBeUndefined();
    expect(next.pendingTriage).toBeUndefined();
  });

  it('START_FIX_CYCLE refuses a completed run whose review passed', () => {
    const state = failedReviewState({ reviewStatus: 'passed' });

    expect(() => transition(state, { type: 'START_FIX_CYCLE' })).toThrow(
      'Cannot apply START_FIX_CYCLE',
    );
  });

  it('REVIEW_DONE records a scheduled failure terminal while implementing', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002' })],
      currentTaskIndex: 1,
    };

    const next = transition(state, { type: 'REVIEW_DONE', reviewStatus: 'failed' });

    expect(next.phase).toBe('complete');
    expect(next.reviewStatus).toBe('failed');
    expect(next.completedAt).toBeDefined();
    expect(next.tasks[1]?.status).toBe('pending');
  });

  it('RECORD_REVIEW stores a scheduled review recorded while implementing', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      currentTaskIndex: 1,
    };
    const review: NonNullable<WorkflowState['review']> = {
      cycle: 0,
      verdict: {
        tasks: [{ id: taskId('T001'), plan: 'met', note: '' }],
        criteria: [{ id: 'C1', status: 'pass', evidence: '' }],
        findings: [],
      },
      outcome: 'pass',
      verification: [],
      at: '2026-10-04T10:00:00.000Z',
    };

    const recorded = transition(state, { type: 'RECORD_REVIEW', review });

    expect(recorded.phase).toBe('implementing');
    expect(recorded.review).toEqual(review);
    expect(WorkflowStateSchema.safeParse(recorded).success).toBe(true);
  });

  it('SAVE_REVIEW_ANSWER keeps the answer until RECORD_REVIEW replaces it', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'final-review',
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      currentTaskIndex: 1,
    };
    const verdict = {
      tasks: [{ id: taskId('T001'), plan: 'met' as const, note: '' }],
      criteria: [{ id: 'C1', status: 'pass' as const, evidence: '' }],
      findings: [],
    };
    const answer: NonNullable<WorkflowState['reviewAnswer']> = {
      scope: 'final',
      cycle: 0,
      answer: { ...verdict, fixTasks: [], rejected: [], verify: [], ask: null },
      preExistingChecks: [],
      discharged: ['npm test'],
      at: '2026-10-04T10:00:00.000Z',
    };

    const saved = transition(state, { type: 'SAVE_REVIEW_ANSWER', answer });
    expect(saved.reviewAnswer).toEqual(answer);
    expect(WorkflowStateSchema.safeParse(saved).success).toBe(true);

    const recorded = transition(saved, {
      type: 'RECORD_REVIEW',
      review: { cycle: 0, verdict, outcome: 'pass', verification: [], at: answer.at },
    });
    expect(recorded.reviewAnswer).toBeUndefined();
    expect(transition(saved, { type: 'DROP_REVIEW_ANSWER' }).reviewAnswer).toBeUndefined();
    const rejected = transition(saved, {
      type: 'RECORD_REJECT',
      removed: ['a.ts'],
      booked: [taskId('T001')],
    });
    expect(rejected).toMatchObject({ phase: 'implementing', currentTaskIndex: 0 });
    expect(rejected.reviewAnswer).toBeUndefined();
  });

  it('RECORD_TRIAGE appends a triage recorded while implementing', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      currentTaskIndex: 1,
    };
    const record: NonNullable<WorkflowState['triage']>[number] = {
      cycle: 1,
      at: '2026-10-04T10:01:00.000Z',
      inputIds: ['F1'],
      result: { fixTasks: [], rejected: [], verify: [], ask: null },
    };

    const next = transition(state, { type: 'RECORD_TRIAGE', record });

    expect(next.phase).toBe('implementing');
    expect(next.triage).toEqual([record]);
  });

  it('QUEUE_TRIAGE parks a planner question asked while implementing', () => {
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks: [makeTask({ id: 'T001', status: 'done' })],
      currentTaskIndex: 1,
    };
    const inputs = [
      {
        id: 'A1',
        kind: 'answer' as const,
        source: 'user' as const,
        text: 'It is intended',
        file: null,
      },
    ];

    const next = transition(state, { type: 'QUEUE_TRIAGE', inputs });

    expect(next.phase).toBe('implementing');
    expect(next.pendingTriage).toEqual({ inputs });
  });

  it('START_FIX_CYCLE counts the cycle and takes the first open brief while implementing', () => {
    const tasks = [
      makeTask({ id: 'T001', status: 'done' }),
      makeTask({ id: 'T002' }),
      makeTask({ id: 'T003' }),
    ];
    const state: WorkflowState = {
      ...createInitialState('feat'),
      phase: 'implementing',
      tasks,
      currentTaskIndex: 2,
      fixCycles: { used: 0, notes: [] },
      pendingTriage: { inputs: [] },
    };

    const next = transition(state, { type: 'START_FIX_CYCLE' });

    expect(next.phase).toBe('implementing');
    expect(next.fixCycles).toEqual({ used: 1, notes: [], open: { cycle: 1 } });
    expect(next.currentTaskIndex).toBe(1);
    expect(next.pendingTriage).toBeUndefined();
    expect(next.tasks.map((task) => task.status)).toEqual(['done', 'pending', 'pending']);
  });

  it('REVIEW_CORRECTION queues the correction and keeps it in the notes at any cycle', () => {
    const state = failedReviewState({
      fixCycles: { used: 1, notes: ['earlier note'] },
    });

    const next = transition(state, {
      type: 'REVIEW_CORRECTION',
      text: 'Use the shared greeting helper',
    });

    expect(next.phase).toBe('final-review');
    expect(next.reviewStatus).toBeUndefined();
    expect(next.completedAt).toBeUndefined();
    expect(next.pendingTriage).toEqual({
      inputs: [
        {
          id: 'U1',
          kind: 'defect',
          source: 'user',
          text: 'Use the shared greeting helper',
          file: null,
        },
      ],
    });
    expect(next.fixCycles).toEqual({
      used: 1,
      notes: ['earlier note', 'Use the shared greeting helper'],
    });
  });

  it('REVIEW_CORRECTION with no text queues no input and adds no note', () => {
    const state = failedReviewState({
      fixCycles: { used: 3, notes: [] },
    });

    const next = transition(state, { type: 'REVIEW_CORRECTION', text: '' });

    expect(next.phase).toBe('final-review');
    expect(next.pendingTriage).toEqual({ inputs: [] });
    expect(next.fixCycles).toEqual({ used: 3, notes: [] });
  });

  it('REVIEW_CORRECTION refuses a completed run whose review passed', () => {
    const state = failedReviewState({ reviewStatus: 'passed' });

    expect(() => transition(state, { type: 'REVIEW_CORRECTION', text: 'x' })).toThrow(
      'Cannot apply REVIEW_CORRECTION',
    );
  });

  it('RECORD_REVIEW stores the review and RECORD_TRIAGE appends to the log', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'final-review' };
    const review: NonNullable<WorkflowState['review']> = {
      cycle: 1,
      verdict: { tasks: [], criteria: [], findings: [] },
      outcome: 'fail',
      verification: [{ id: 'F1', status: 'fail', output: 'check K1 did not pass' }],
      at: '2026-10-03T10:00:00.000Z',
    };
    const record: NonNullable<WorkflowState['triage']>[number] = {
      cycle: 1,
      at: '2026-10-03T10:01:00.000Z',
      inputIds: ['U1'],
      result: { fixTasks: [], rejected: [], verify: [], ask: null },
    };

    const recorded = transition(state, { type: 'RECORD_REVIEW', review });
    expect(recorded.review).toEqual(review);

    const triaged = transition(recorded, { type: 'RECORD_TRIAGE', record });
    const again = transition(triaged, { type: 'RECORD_TRIAGE', record: { ...record, cycle: 2 } });
    expect(again.triage?.map((entry) => entry.cycle)).toEqual([1, 2]);
    expect(WorkflowStateSchema.safeParse(again).success).toBe(true);
  });

  it.each([
    ['the next final review judges a final review cycle', 'final', 'final', undefined, 1],
    ['a task review does not judge a final review cycle', 'final', 'task', 'T002', undefined],
    [
      'the task review after the last inserted fix task judges a task review cycle',
      'task',
      'task',
      'T004',
      1,
    ],
    [
      "a task review after the reviewer's own fix task id does not judge it",
      'task',
      'task',
      'T002',
      undefined,
    ],
    ['a task review of another task does not judge it', 'task', 'task', 'T001', undefined],
    ['the final review does not judge a task review cycle', 'task', 'final', undefined, undefined],
  ] as const)('RECORD_REVIEW: %s', (_name, cycleScope, reviewScope, afterTaskId, judges) => {
    const started = transition(
      {
        ...createInitialState('feat'),
        phase: 'final-review',
        triage: [
          {
            cycle: 1,
            at: '2026-10-03T10:01:00.000Z',
            inputIds: ['F1'],
            result: {
              fixTasks: [{ ...makeTaskSpec({ id: 'T002' }), findingIds: ['F1'] }],
              rejected: [],
              verify: [],
              ask: null,
            },
            blocking: ['finding:F1'],
            scope: cycleScope,
          },
        ],
      },
      { type: 'START_FIX_CYCLE', lastFixTaskId: taskId('T004') },
    );
    expect(started.fixCycles).toEqual({
      used: 1,
      notes: [],
      open: { cycle: 1, lastFixTaskId: 'T004' },
    });

    const recorded = transition(started, {
      type: 'RECORD_REVIEW',
      review: {
        scope: reviewScope,
        ...(afterTaskId !== undefined && { afterTaskId: taskId(afterTaskId) }),
        cycle: 1,
        verdict: { tasks: [], criteria: [], findings: [] },
        outcome: 'pass',
        verification: [],
        at: '2026-10-03T10:02:00.000Z',
      },
    });

    expect(recorded.review?.judges).toBe(judges);
    expect(recorded.fixCycles?.open?.cycle).toBe(judges === undefined ? 1 : undefined);
    expect(WorkflowStateSchema.safeParse(recorded).success).toBe(true);
  });

  it('INSERT_TASKS: a split of the last fix task hands its open fix cycle to the last child', () => {
    const fix = { cycle: 1, findings: [{ id: 'F1', text: 'bug', acceptance: null }] };
    const started = transition(
      {
        ...createInitialState('feat'),
        phase: 'implementing',
        tasks: [makeTask({ id: 'T001', status: 'done' }), makeTask({ id: 'T002', fix })],
        currentTaskIndex: 1,
      },
      { type: 'START_FIX_CYCLE', lastFixTaskId: taskId('T002') },
    );
    const split = transition(started, {
      type: 'INSERT_TASKS',
      parentId: taskId('T002'),
      tasks: [makeTask({ id: 'T003' }), makeTask({ id: 'T004' })],
    });
    expect(split.fixCycles?.open).toEqual({ cycle: 1, lastFixTaskId: 'T004' });

    const other = transition(
      { ...split, tasks: [...split.tasks, makeTask({ id: 'T005' })] },
      { type: 'INSERT_TASKS', parentId: taskId('T005'), tasks: [makeTask({ id: 'T006' })] },
    );
    expect(other.fixCycles?.open).toEqual({ cycle: 1, lastFixTaskId: 'T004' });
  });

  it('QUEUE_TRIAGE parks the inputs on pendingTriage', () => {
    const state: WorkflowState = { ...createInitialState('feat'), phase: 'final-review' };
    const inputs = [
      {
        id: 'I1',
        kind: 'question' as const,
        source: 'apply' as const,
        text: 'The merge kept both greetings',
        file: null,
      },
    ];

    const next = transition(state, { type: 'QUEUE_TRIAGE', inputs });

    expect(next.pendingTriage).toEqual({ inputs });
  });

  it('START_FIX_CYCLE starts at the fix brief, never at a brief the user skipped', () => {
    const state = failedReviewState({
      tasks: [
        makeTask({ id: 'T001', status: 'skipped' }),
        makeTask({ id: 'T002', status: 'done' }),
        makeTask({ id: 'T003' }),
      ],
      currentTaskIndex: 3,
    });

    const next = transition(state, { type: 'START_FIX_CYCLE' });

    expect(next.currentTaskIndex).toBe(2);
    expect(next.tasks.map((task) => task.status)).toEqual(['skipped', 'done', 'pending']);
  });
});

describe('the run workspace and Apply', () => {
  const WORKSPACE: NonNullable<WorkflowState['workspace']> = {
    kind: 'worktree',
    path: '/tmp/project/.splitbrief/worktrees/run',
    base: { snapshotId: 'workspace-base', head: null },
  };
  const NOW = { now: new Date('2026-10-03T10:00:00Z') };
  const ready = (): WorkflowState => ({
    ...createInitialState('feat'),
    phase: 'complete',
    reviewStatus: 'passed',
    workspace: WORKSPACE,
  });

  it('RECORD_WORKSPACE records the workspace in any phase', () => {
    const state = { ...createInitialState('feat'), phase: 'implementing' as const };
    expect(transition(state, { type: 'RECORD_WORKSPACE', workspace: WORKSPACE }).workspace).toEqual(
      WORKSPACE,
    );
  });

  it('ACCEPT_AS_IS records the open findings on a failed review', () => {
    const failed = { ...ready(), reviewStatus: 'failed' as const };
    const next = transition(failed, { type: 'ACCEPT_AS_IS', findings: ['F1', 'F2'] }, NOW);
    expect(next.acceptedAsIs).toEqual({ at: '2026-10-03T10:00:00.000Z', findings: ['F1', 'F2'] });
  });

  it('ACCEPT_AS_IS stores the note apart from the findings', () => {
    const failed = { ...ready(), reviewStatus: 'failed' as const };
    const next = transition(
      failed,
      { type: 'ACCEPT_AS_IS', findings: ['F1'], note: 'Checked by hand.' },
      NOW,
    );
    expect(next.acceptedAsIs).toEqual({
      at: '2026-10-03T10:00:00.000Z',
      findings: ['F1'],
      note: 'Checked by hand.',
    });
  });

  it.each(['passed', 'failed'] as const)(
    'a %s final review replaces a task review skipped as is',
    (reviewStatus) => {
      const implementing = { ...createInitialState('feat'), phase: 'implementing' as const };
      const skipped = transition(implementing, { type: 'ACCEPT_AS_IS', findings: ['F1'] }, NOW);
      const done = transition(transition(skipped, { type: 'ALL_DONE' }), {
        type: 'REVIEW_DONE',
        reviewStatus,
      });
      expect(done.acceptedAsIs).toBeUndefined();
    },
  );

  it('APPLY_REVIEW_START only from ready', () => {
    const merged = [{ path: 'src/a.ts', checkoutHunks: '@@ -1 +1 @@\n-a\n+b\n' }];
    const accepted = transition(
      { ...ready(), reviewFixes: { cycle: 1, findings: {} } },
      { type: 'ACCEPT_AS_IS', findings: ['F1'] },
    );
    const next = transition(accepted, { type: 'APPLY_REVIEW_START', merged });
    expect(next.phase).toBe('final-review');
    expect(next.reviewStatus).toBeUndefined();
    expect(next.applyReview).toEqual({ merged, failures: [] });
    expect(next.acceptedAsIs).toBeUndefined();
    expect(next.fixCycles).toEqual({ used: 2, notes: [] });
    const passed = transition(next, {
      type: 'REVIEW_DONE',
      reviewStatus: 'passed',
      candidate: { 'src/a.ts': 'file:abc' },
    });
    expect(passed.applyReview).toBeUndefined();
    expect(passed.reviewedCandidate).toEqual({ 'src/a.ts': 'file:abc' });

    const failed = { ...ready(), reviewStatus: 'failed' as const };
    expect(() => transition(failed, { type: 'APPLY_REVIEW_START', merged: [] })).toThrow(
      'Cannot apply APPLY_REVIEW_START',
    );
    const noWorkspace = { ...ready(), workspace: undefined };
    expect(() => transition(noWorkspace, { type: 'APPLY_REVIEW_START', merged: [] })).toThrow(
      'Cannot apply APPLY_REVIEW_START',
    );
  });

  it('APPLY_REVIEW_START with a triage queues the inputs and leaves the fix cycle to START_FIX_CYCLE', () => {
    const merged = [{ path: 'a.txt', checkoutHunks: 'checkout diff' }];
    const triage = [
      {
        id: 'A1',
        kind: 'defect' as const,
        source: 'apply' as const,
        text: 'Apply merge conflict in a.txt: resolve the conflict markers',
        file: 'a.txt',
      },
    ];
    const state = transition(
      { ...ready(), reviewFixes: { cycle: 1, findings: {} } },
      { type: 'APPLY_REVIEW_START', merged, triage },
    );

    expect(state.phase).toBe('final-review');
    expect(state.applyReview).toEqual({ merged, failures: [] });
    expect(state.pendingTriage).toEqual({ inputs: triage });
    expect(fixCyclesOf(state).used).toBe(1);
    expect(WorkflowStateSchema.parse(state).pendingTriage?.inputs).toEqual(triage);

    const fixed = transition(state, { type: 'START_FIX_CYCLE' });
    expect(fixed.fixCycles).toEqual({ used: 2, notes: [], open: { cycle: 2 } });
    expect(fixed.pendingTriage).toBeUndefined();
  });

  it('RECORD_APPLY_INTEGRATED replaces the record of a path handed off again', () => {
    const first = transition(ready(), {
      type: 'RECORD_APPLY_INTEGRATED',
      integrated: [
        { path: 'a.txt', checkout: 'file:a', workspace: 'file:ours' },
        { path: 'b.txt', checkout: 'absent', workspace: 'file:b' },
      ],
    });
    const next = transition(first, {
      type: 'RECORD_APPLY_INTEGRATED',
      integrated: [{ path: 'a.txt', checkout: 'file:a2', workspace: null }],
    });

    expect(next.applyIntegrated).toEqual([
      { path: 'b.txt', checkout: 'absent', workspace: 'file:b' },
      { path: 'a.txt', checkout: 'file:a2', workspace: null },
    ]);
  });

  it("BIND_APPLY_INTEGRATED binds open records and ends the ones at the base or on the checkout's side", () => {
    const recorded = transition(ready(), {
      type: 'RECORD_APPLY_INTEGRATED',
      integrated: [
        { path: 'bound.txt', checkout: 'file:c', workspace: 'file:kept' },
        { path: 'run.txt', checkout: 'file:c', workspace: null },
        { path: 'checkout.txt', checkout: 'file:c', workspace: null },
        { path: 'base.txt', checkout: 'file:c', workspace: null },
      ],
    });

    const bound = transition(recorded, {
      type: 'BIND_APPLY_INTEGRATED',
      candidate: { 'bound.txt': 'file:later', 'run.txt': 'file:run', 'checkout.txt': 'file:c' },
    });

    expect(bound.applyIntegrated).toEqual([
      { path: 'bound.txt', checkout: 'file:c', workspace: 'file:kept' },
      { path: 'run.txt', checkout: 'file:c', workspace: 'file:run' },
    ]);
  });

  it('a handed-off file saved without its workspace entry loads as no record', () => {
    const saved = {
      ...ready(),
      applyIntegrated: [
        { path: 'a.txt', checkoutHash: 'hash-a' },
        { path: 'b.txt', checkout: 'file:b' },
        { path: 'c.txt', checkout: 'file:c', workspace: null },
      ],
    };

    expect(WorkflowStateSchema.parse(saved).applyIntegrated).toEqual([
      { path: 'c.txt', checkout: 'file:c', workspace: null },
    ]);
  });

  it('RECORD_APPLY_RECHECK replaces failures and preserves them after a failed review', () => {
    const merged = [{ path: 'src/a.ts', checkoutHunks: 'checkout diff' }];
    const state = transition(ready(), { type: 'APPLY_REVIEW_START', merged });
    const failures = [
      'T001 check C1 did not pass (fail): error',
      'plan check P1 did not pass (fail): error',
    ];
    const recorded = transition(state, { type: 'RECORD_APPLY_RECHECK', failures, notRun: [] });

    expect(recorded.phase).toBe('final-review');
    expect(recorded.applyReview).toEqual({ merged, failures, notRun: [] });
    expect(state.applyReview?.failures).toEqual([]);
    expect(WorkflowStateSchema.parse(recorded).applyReview?.failures).toEqual(failures);

    const failed = transition(recorded, { type: 'REVIEW_DONE', reviewStatus: 'failed' });
    expect(failed.applyReview?.failures).toEqual(failures);
    const accepted = transition(failed, { type: 'ACCEPT_AS_IS', findings: failures }, NOW);
    expect(accepted.acceptedAsIs?.findings).toEqual(failures);
    expect(accepted.applyReview).toBeUndefined();

    const rerun = transition(recorded, { type: 'RECORD_APPLY_RECHECK', failures: [], notRun: [] });
    expect(rerun.applyReview).toEqual({ merged, failures: [], notRun: [] });
  });

  it('RECORD_APPLY_RECHECK refuses a final review without applyReview', () => {
    const state: WorkflowState = { ...ready(), phase: 'final-review' };
    expect(() =>
      transition(state, { type: 'RECORD_APPLY_RECHECK', failures: [], notRun: [] }),
    ).toThrow('Cannot apply RECORD_APPLY_RECHECK while workflow is in final-review.');
  });

  it.each(['implementing', 'complete'] as const)(
    'RECORD_APPLY_RECHECK refuses the %s phase',
    (phase) => {
      const state: WorkflowState = { ...ready(), phase, applyReview: { merged: [], failures: [] } };
      expect(() =>
        transition(state, { type: 'RECORD_APPLY_RECHECK', failures: [], notRun: [] }),
      ).toThrow(`Cannot apply RECORD_APPLY_RECHECK while workflow is in ${phase}.`);
    },
  );

  it('APPLY_START marks the run applying, from ready or from an applying run', () => {
    const applying = transition(ready(), { type: 'APPLY_START', backupId: 'apply-1' }, NOW);
    expect(applying.applying).toEqual({ at: '2026-10-03T10:00:00.000Z', backupId: 'apply-1' });
    const retried = transition(applying, { type: 'APPLY_START', backupId: 'apply-2' }, NOW);
    expect(retried.applying?.backupId).toBe('apply-2');
  });

  it('APPLY_START refuses a run that is not ready', () => {
    const noWorkspace = { ...ready(), workspace: undefined };
    expect(() => transition(noWorkspace, { type: 'APPLY_START', backupId: 'b' })).toThrow(
      'Cannot apply APPLY_START',
    );
  });

  it.each([
    { type: 'APPLY_START', backupId: 'apply-2' },
    { type: 'APPLY_REVIEW_START', merged: [] },
  ] satisfies StateAction[])('$type refuses an applied record without a closure', (action) => {
    const applied = {
      ...ready(),
      applied: { at: NOW.now.toISOString(), backupId: 'apply-1', files: ['src/a.ts'] },
    };
    expect(() => transition(applied, action)).toThrow(`Cannot apply ${action.type}`);
  });

  it('APPLY_DONE records the applied files and closes the run as applied', () => {
    const applying = transition(ready(), { type: 'APPLY_START', backupId: 'apply-1' }, NOW);
    const applied = transition(applying, { type: 'APPLY_DONE', files: ['src/a.ts'] }, NOW);
    expect(applied.applying).toBeUndefined();
    expect(applied.applied).toEqual({
      at: '2026-10-03T10:00:00.000Z',
      backupId: 'apply-1',
      files: ['src/a.ts'],
    });
    expect(applied.closed).toEqual({ at: '2026-10-03T10:00:00.000Z', as: 'applied' });
    expect(() => transition(applied, { type: 'APPLY_START', backupId: 'b' })).toThrow(
      'this run is closed',
    );
  });

  it('APPLY_DONE refuses a run that never started Apply', () => {
    expect(() => transition(ready(), { type: 'APPLY_DONE', files: [] })).toThrow(
      'Cannot apply APPLY_DONE',
    );
  });

  it('APPLY_RESTORED drops the applying record and leaves the run ready to apply', () => {
    const applying = transition(ready(), { type: 'APPLY_START', backupId: 'apply-1' }, NOW);
    const restored = transition(applying, { type: 'APPLY_RESTORED' }, NOW);
    expect(restored.applying).toBeUndefined();
    expect(restored.applied).toBeUndefined();
    expect(restored.closed).toBeUndefined();
    expect(deriveRunStatus({ state: restored, liveness: 'not-alive' }).kind).toBe('ready-to-apply');
  });

  it('APPLY_RESTORED refuses a run that never started Apply', () => {
    expect(() => transition(ready(), { type: 'APPLY_RESTORED' })).toThrow(
      'Cannot apply APPLY_RESTORED',
    );
  });

  it('CLOSE_RUN on a ready run closes as discarded when asked', () => {
    expect(transition(ready(), { type: 'CLOSE_RUN', as: 'discarded' }, NOW).closed).toEqual({
      at: '2026-10-03T10:00:00.000Z',
      as: 'discarded',
    });
    expect(transition(ready(), { type: 'CLOSE_RUN' }).closed?.as).toBe('ended');
  });

  it('the persisted schema accepts the workspace, Apply and override fields', () => {
    const applying = transition(ready(), { type: 'APPLY_START', backupId: 'apply-1' }, NOW);
    const applied = transition(applying, { type: 'APPLY_DONE', files: ['src/a.ts'] }, NOW);
    const accepted = { ...applied, acceptedAsIs: { at: 'x', findings: ['F1'] } };
    expect(WorkflowStateSchema.safeParse(accepted).success).toBe(true);
    expect(WorkflowStateSchema.safeParse(applying).success).toBe(true);
  });
});
