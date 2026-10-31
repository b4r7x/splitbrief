import { describe, expect, it } from 'vitest';
import { makeRecoveryIssue } from '#testing/helpers/factories/recovery.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';
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
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'final-review' }))).toEqual({
      ...LOGGED,
      phase: 'final-review',
    });
  });

  it('reads a closed run as complete when its log stopped before the end', () => {
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'complete' })).phase).toBe('complete');
  });

  it('keeps the view when the log and the state agree', () => {
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'implementing' }))).toEqual(LOGGED);
  });

  it('takes the saved halt and the step it resumes at over a log that never prompted it', () => {
    const issue = makeRecoveryIssue();
    const state = makeWorkflowState({
      phase: 'implementing',
      tasks: [makeTask({ id: 'T002' })],
      attempt: 1,
      pendingRecovery: issue,
    });
    expect(settleRunView(LOGGED, state).halt).toEqual({
      issue,
      at: { kind: 'brief', taskId: 'T002', attempt: 1 },
    });
  });

  it('clears a logged halt the saved state no longer holds', () => {
    const halted: RunView = {
      ...LOGGED,
      halt: { issue: makeRecoveryIssue(), at: { kind: 'review', cycle: 0 } },
    };
    expect(settleRunView(halted, makeWorkflowState({ phase: 'implementing' })).halt).toBeNull();
  });

  it('lays the saved brief list over the logged one and keeps the logged attempt and checks', () => {
    const logged: RunView = {
      ...LOGGED,
      briefs: {
        ...EMPTY_BRIEFS,
        tasks: [{ id: 'T001', title: 'Logged', status: 'in_progress', route: { runner: 'codex' } }],
        currentAttempt: 2,
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
    expect(settled.briefs).toMatchObject({
      currentTask: 2,
      totalTasks: 2,
      currentAttempt: 2,
      completedTasks: 1,
    });
    expect(settled.briefs.checks).toBe(logged.briefs.checks);
  });

  it('reads no brief position from a state with no briefs', () => {
    expect(settleRunView(LOGGED, makeWorkflowState({ phase: 'planning' })).briefs).toMatchObject({
      tasks: [],
      currentTask: 0,
      totalTasks: 0,
    });
  });
});
