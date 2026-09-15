import { describe, it, expect } from 'vitest';
import {
  buildProgressLines,
  deriveBuildProgress,
  UI_IDLE_WARN_MS,
  type DeriveBuildProgressInput,
} from './build-progress.js';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type { OperationsState } from '../../../stores/workflow/operations/state.js';
import type { TasksState, WorkflowTask } from '../../../stores/workflow/tasks.js';
import type { TokensState } from '../../../stores/workflow/tokens.js';

const NOW = 1_000_000;

function tasksState(tasks: WorkflowTask[], overrides: Partial<TasksState> = {}): TasksState {
  return {
    currentTask: 1,
    currentAttempt: 1,
    totalTasks: tasks.length,
    taskCompletionTimes: [],
    taskMap: new Map(tasks.map((task) => [task.id, task])),
    tasks,
    ...overrides,
  };
}

function lifecycleState(overrides: { lastRunnerEventTs?: number | null } = {}): LifecycleState {
  const state: LifecycleState = {
    phase: 'implementing',
    status: 'running',
    interruptParked: false,
    cancelled: false,
    queueDepth: 0,
    phaseFirstSeenTs: {},
    stall: null,
    lastRunnerEventTs: NOW,
    attemptStartedTs: NOW,
    startedAt: NOW,
    endedAt: null,
    durationMs: null,
    reason: null,
  };
  return { ...state, ...overrides };
}

function operationsState(overrides: Partial<OperationsState> = {}): OperationsState {
  return { active: null, last: null, byCallId: new Map(), validationStage: null, ...overrides };
}

function tokensState(): TokensState {
  return {
    localCount: 0,
    escalatedCount: 0,
    tokenUsage: null,
    perPhase: {},
    perTask: {},
    completedTaskCount: 0,
    pricingContext: null,
  };
}

function input(overrides: Partial<DeriveBuildProgressInput> = {}): DeriveBuildProgressInput {
  return {
    tasks: tasksState([
      { id: 'T001', title: 'One', status: 'done' },
      { id: 'T002', title: 'Two', status: 'in_progress' },
    ]),
    tokens: tokensState(),
    lifecycle: lifecycleState(),
    operations: operationsState(),
    config: createDefaultConfig(),
    now: NOW,
    ...overrides,
  };
}

describe('deriveBuildProgress', () => {
  it('60 s silence line names the tool instead of a freshness age', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ lastRunnerEventTs: NOW - UI_IDLE_WARN_MS }),
        now: NOW,
      }),
    );

    expect(progress.freshness).toBe('No update from the worker for 60s');
  });

  it('reports freshness while the seat is still speaking', () => {
    const progress = deriveBuildProgress(
      input({ lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 5_000 }) }),
    );

    expect(progress.freshness).toBe('last event 5s ago');
  });

  it('ETA unavailable: no brief finished yet', () => {
    const progress = deriveBuildProgress(input());

    expect(progress.eta).toEqual({ kind: 'unavailable', reason: 'no brief finished yet' });
  });

  it('attempt 2 of 3 with maxRetries 2', () => {
    const config = createDefaultConfig();
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState([{ id: 'T001', title: 'One', status: 'in_progress' }], {
          currentAttempt: 2,
        }),
        config: { ...config, workflow: { ...config.workflow, maxRetries: 2 } },
      }),
    );

    expect(progress.attempt).toEqual({ current: 2, max: 3 });
    expect(buildProgressLines(progress, 120)[0]).toContain('attempt 2 of 3');
  });

  it('states the estimate in minutes and says so when it is under one', () => {
    const twoBriefsLeft = tasksState(
      [
        { id: 'T001', title: 'One', status: 'done' },
        { id: 'T002', title: 'Two', status: 'in_progress' },
        { id: 'T003', title: 'Three', status: 'pending' },
      ],
      { taskCompletionTimes: [180_000] },
    );
    const slow = deriveBuildProgress(input({ tasks: twoBriefsLeft }));
    expect(buildProgressLines(slow, 120)[0]).toContain('ETA ~6m');

    const quick = deriveBuildProgress(
      input({
        tasks: tasksState(
          [
            { id: 'T001', title: 'One', status: 'done' },
            { id: 'T002', title: 'Two', status: 'in_progress' },
          ],
          { taskCompletionTimes: [2_000] },
        ),
      }),
    );
    expect(buildProgressLines(quick, 120)[0]).toContain('ETA under a minute');
  });

  it('names the running gate command instead of the seat', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          validationStage: { stage: 'test', command: 'npm test', stageStartedTs: NOW - 90_000 },
        }),
        lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 30_000 }),
      }),
    );

    expect(progress.activity).toContain('npm test');
    expect(progress.activity).toContain('running 1m 30s');
    expect(progress.activity).toContain('no output for 30s');
  });
});

describe('buildProgressLines', () => {
  it('2 lines at 120 columns', () => {
    expect(buildProgressLines(deriveBuildProgress(input()), 120)).toHaveLength(2);
  });

  it('4 lines at 80 columns', () => {
    expect(buildProgressLines(deriveBuildProgress(input()), 80)).toHaveLength(4);
  });

  it('5 lines at 60 columns', () => {
    expect(buildProgressLines(deriveBuildProgress(input()), 60)).toHaveLength(5);
  });

  it('counts escalated and failed briefs apart from the ones that passed', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState([
          { id: 'T001', title: 'One', status: 'done' },
          { id: 'T002', title: 'Two', status: 'escalated' },
          { id: 'T003', title: 'Three', status: 'failed' },
        ]),
      }),
    );

    expect(buildProgressLines(progress, 120)[0]).toContain('1/3 briefs passed');
    expect(buildProgressLines(progress, 120)[0]).toContain('1 escalated');
    expect(buildProgressLines(progress, 120)[0]).toContain('1 failed');
  });
});
