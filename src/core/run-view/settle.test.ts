import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
import type { ClarificationQuestion } from '../schemas/question.js';
import { taskId } from '../schemas/task.js';
import { EMPTY_BRIEFS } from './briefs.js';
import { EMPTY_RUN_VIEW, type RunView } from './reduce.js';
import { settleRunView } from './settle.js';

const LOGGED: RunView = {
  ...EMPTY_RUN_VIEW,
  phase: 'implementing',
  phaseFirstSeen: { planning: 1_000, implementing: 2_000 },
};

describe('settleRunView', () => {
  it('takes the saved phase over a log one step behind and keeps the logged times', () => {
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'final-review' }), false)).toEqual({
      ...LOGGED,
      phase: 'final-review',
    });
  });

  it.each([
    ['a seat after a None pass', true, false],
    ['None after a seat pass', false, true],
  ])('names the REVIEW of the next pass, %s, over the logged one', (_, logged, next) => {
    const view: RunView = { ...LOGGED, phase: 'final-review', reviewNone: logged };
    expect(settleRunView(view, makeWorkflowState({ phase: 'final-review' }), next).reviewNone).toBe(
      next,
    );
  });

  it.each([
    ['worktree', true, { kind: 'apply' }],
    ['staged-copy', true, { kind: 'apply' }],
    ['checkout', true, { kind: 'review', cycle: 0 }],
    ['worktree', false, { kind: 'review', cycle: 0 }],
  ] as const)('reads the step after the last brief on a %s, REVIEW None %s', (kind, none, step) => {
    const state = makeWorkflowState({
      phase: 'final-review',
      workspace: { kind, path: '/tmp/run', base: { snapshotId: 'base', head: null } },
    });
    expect(settleRunView(LOGGED, state, none).afterLastBrief).toEqual(step);
  });

  it('reads a closed run as complete when its log stopped before the end', () => {
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'complete' }), false).phase).toBe(
      'complete',
    );
  });

  it('keeps the view when the log and the state agree', () => {
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'implementing' }), false)).toEqual(
      LOGGED,
    );
  });

  it('takes the saved halt and the step it resumes at over a log that never prompted it', () => {
    const issue = makeRecoveryIssue();
    const state = makeWorkflowState({
      phase: 'implementing',
      tasks: [makeTask({ id: 'T002' })],
      attempt: 1,
      pendingRecovery: issue,
    });
    expect(settleRunView(LOGGED, state, false).halt).toEqual({
      issue,
      at: { kind: 'brief', taskId: 'T002', attempt: 1 },
    });
  });

  it('clears a logged halt the saved state no longer holds', () => {
    const halted: RunView = {
      ...LOGGED,
      halt: { issue: makeRecoveryIssue(), at: { kind: 'review', cycle: 0 } },
    };
    expect(
      settleRunView(halted, makeWorkflowState({ phase: 'implementing' }), false).halt,
    ).toBeNull();
  });

  it('lays the saved brief list over the logged one and keeps the logged checks', () => {
    const logged: RunView = {
      ...LOGGED,
      briefs: {
        ...EMPTY_BRIEFS,
        tasks: [{ id: 'T001', title: 'Logged', status: 'in_progress', route: { runner: 'codex' } }],
        checks: new Map([['T001', [{ id: 'C1', status: 'pass' }]]]),
        completedTasks: 1,
      },
    };
    const settled = settleRunView(
      logged,
      makeWorkflowState({
        phase: 'implementing',
        currentTaskIndex: 1,
        tasks: [
          makeTask({ id: 'T001', title: 'Saved', status: 'done' }),
          makeTask({ id: 'T002', suggestedFiles: ['src/b.ts'], action: 'modify' }),
        ],
      }),
      false,
    );
    expect(settled.briefs.tasks).toEqual([
      { id: 'T001', title: 'Saved', status: 'done', file: 'src/hello.ts', action: 'create' },
      {
        id: 'T002',
        title: 'Create hello module',
        status: 'pending',
        file: 'src/b.ts',
        action: 'modify',
      },
    ]);
    expect(settled.briefs.taskMap.get('T002')).toBe(settled.briefs.tasks[1]);
    expect(settled.briefs).toMatchObject({ currentTask: 2, totalTasks: 2, completedTasks: 1 });
    expect(settled.briefs.checks).toBe(logged.briefs.checks);
  });

  it('reads no brief position from a state with no briefs', () => {
    expect(
      settleRunView(LOGGED, makeWorkflowState({ phase: 'planning' }), false).briefs,
    ).toMatchObject({
      tasks: [],
      currentTask: 0,
      totalTasks: 0,
    });
  });
});

describe('settleRunView ask and stop', () => {
  const round: ClarificationQuestion[] = [{ id: 'module', type: 'input', text: 'Which module?' }];
  const conversation = {
    call: 'plan' as const,
    text: 'Before the plan',
    answers: [],
    questions: round,
  };

  it('takes the round the saved state waits on, and none once it is answered', () => {
    const waiting = makeWorkflowState({
      phase: 'planning',
      pendingPlannerConversation: { ...conversation, answered: false },
    });
    expect(settleRunView(LOGGED, waiting, false).questions).toEqual(round);
    const answered = makeWorkflowState({
      phase: 'planning',
      pendingPlannerConversation: { ...conversation, answered: true },
    });
    expect(settleRunView(LOGGED, answered, false).questions).toBeNull();
  });

  it('reopens the card of a typed plan the state is parked at', () => {
    const plan = {
      summary: 'One task.',
      decisions: [],
      criteria: [{ id: 'C1', text: 'Works.', checkIds: ['K1'] }],
      checks: [],
      validation: null,
    };
    expect(
      settleRunView(LOGGED, makeWorkflowState({ phase: 'reviewing-plan', plan }), false).planCard,
    ).toBe(true);
    expect(
      settleRunView(LOGGED, makeWorkflowState({ phase: 'reviewing-spec' }), false).planCard,
    ).toBe(false);
  });

  it('takes the files the saved stop kept and the error the saved failure names', () => {
    const settled = settleRunView(
      LOGGED,
      makeWorkflowState({
        phase: 'implementing',
        interruptedStep: {
          step: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
          source: 'user',
          cut: 'mid-step',
          kept: ['src/a.ts'],
          at: '2026-09-01T00:00:00.000Z',
        },
        lastFailure: {
          step: { kind: 'planner', call: 'plan' },
          message: 'Disk full',
          at: '2026-09-01T00:00:00.000Z',
        },
      }),
      false,
    );
    expect(settled).toMatchObject({ stopKept: ['src/a.ts'], failure: 'Disk full' });
  });
});
