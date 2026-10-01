import { describe, it, expect } from 'vitest';
import {
  buildProgressLines,
  buildProgressRowCount,
  deriveBuildProgress,
  UI_IDLE_WARN_MS,
  type DeriveBuildProgressInput,
} from './build-progress.js';
import { createDefaultConfig } from '../../../core/config/load/defaults.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type {
  OperationsState,
  RunningOperation,
  TerminalOperation,
} from '../../../stores/workflow/operations/state.js';
import type { TasksState, WorkflowTask } from '../../../stores/workflow/tasks.js';

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

function lifecycleState(
  overrides: {
    lastRunnerEventTs?: number | null;
    stall?: LifecycleState['stall'];
    phase?: 'implementing' | 'final-review';
  } = {},
): LifecycleState {
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

function runningOperation(overrides: Partial<RunningOperation> = {}): RunningOperation {
  return {
    callId: 'call-1',
    role: 'implementer',
    phase: 'implementing',
    label: 'implementer',
    runnerName: 'codex',
    startedAt: NOW,
    status: 'running',
    endedAt: null,
    durationMs: null,
    partial: false,
    reason: null,
    usage: null,
    warnings: [],
    ...overrides,
  };
}

function completedOperation(overrides: Partial<TerminalOperation> = {}): TerminalOperation {
  return {
    ...runningOperation(),
    status: 'completed',
    endedAt: NOW - 1_000,
    durationMs: 30_000,
    partial: false,
    ...overrides,
  };
}

function input(overrides: Partial<DeriveBuildProgressInput> = {}): DeriveBuildProgressInput {
  return {
    tasks: tasksState([
      { id: 'T001', title: 'One', status: 'done' },
      { id: 'T002', title: 'Two', status: 'in_progress' },
    ]),
    lifecycle: lifecycleState(),
    operations: operationsState(),
    config: createDefaultConfig(),
    now: NOW,
    ...overrides,
  };
}

describe('deriveBuildProgress', () => {
  it('states the watchdog silence span without naming the tool a second time', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({ active: runningOperation() }),
        lifecycle: lifecycleState({
          lastRunnerEventTs: NOW - UI_IDLE_WARN_MS,
          stall: { since: NOW, silentMs: UI_IDLE_WARN_MS, runnerName: 'codex' },
        }),
        now: NOW,
      }),
    );

    expect(progress.activity).toBe('OpenAI Codex CLI · implementing');
    expect(progress.freshness).toBe('No update for 1m 0s');
    expect(progress.silent).toBe(true);
  });

  it('reads the silence from the stall, not a heartbeat that only says the process is alive', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({ active: runningOperation() }),
        // A usage event refreshed the heartbeat two seconds ago while the watchdog's silence stands.
        lifecycle: lifecycleState({
          lastRunnerEventTs: NOW - 2_000,
          stall: { since: NOW - 10_000, silentMs: 300_000, runnerName: 'codex' },
        }),
        now: NOW,
      }),
    );

    expect(progress.freshness).toBe('No update for 5m 10s');
    expect(progress.silent).toBe(true);
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

  it('names the seat and what it is doing, and no usage beside them', () => {
    const progress = deriveBuildProgress(
      input({ operations: operationsState({ active: runningOperation() }) }),
    );

    expect(progress.activity).toBe('OpenAI Codex CLI · implementing');
  });

  it('names the tool by its display name, whichever name its runner gave the call', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({ role: 'escalation', runnerName: 'claude' }),
        }),
        lifecycle: lifecycleState({
          stall: { since: NOW, silentMs: UI_IDLE_WARN_MS, runnerName: 'claude' },
        }),
      }),
    );

    expect(progress.activity).toBe('Claude Code CLI · implementing');
    expect(progress.freshness).toBe('No update for 1m 0s');
  });

  it('shows a shell command named claude literally, as the shell, not the CLI', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({ backendKind: 'shell', runnerName: 'claude' }),
        }),
        lifecycle: lifecycleState({
          stall: { since: NOW, silentMs: UI_IDLE_WARN_MS, runnerName: 'claude' },
        }),
      }),
    );

    expect(progress.activity).toBe('claude · implementing');
    expect(progress.freshness).toBe('No update for 1m 0s');
  });

  it('shows a custom API name literally even when it matches a CLI name', () => {
    for (const runnerName of ['claude-code', 'opencode']) {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({ backendKind: 'api', runnerName }),
          }),
        }),
      );

      expect(progress.activity).toBe(`${runnerName} · implementing`);
    }
  });

  it('keeps a catalogued API provider under its display name', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({ backendKind: 'api', runnerName: 'ollama' }),
        }),
        lifecycle: lifecycleState({
          stall: { since: NOW, silentMs: UI_IDLE_WARN_MS, runnerName: 'ollama' },
        }),
      }),
    );

    expect(progress.activity).toBe('Ollama · implementing');
    expect(progress.freshness).toBe('No update for 1m 0s');
  });

  it('keeps the Claude Code CLI display for a cli call named by its command', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({ backendKind: 'cli', runnerName: 'claude' }),
        }),
      }),
    );

    expect(progress.activity).toBe('Claude Code CLI · implementing');
  });

  it('keeps the estimate when an escalation and the brief ran on the same tool', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState(
          [
            { id: 'T001', title: 'One', status: 'done' },
            { id: 'T002', title: 'Two', status: 'in_progress' },
          ],
          { taskCompletionTimes: [120_000] },
        ),
        operations: operationsState({
          active: runningOperation({ runnerName: 'claude-code' }),
          last: completedOperation({ role: 'escalation', runnerName: 'claude' }),
        }),
      }),
    );

    expect(progress.eta).toEqual({ kind: 'estimate', remainingMs: 120_000 });
  });

  it('retires the estimate when the brief moved to another tool', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState(
          [
            { id: 'T001', title: 'One', status: 'done' },
            { id: 'T002', title: 'Two', status: 'in_progress' },
          ],
          { taskCompletionTimes: [120_000] },
        ),
        operations: operationsState({
          active: runningOperation({ runnerName: 'codex' }),
          last: completedOperation({ runnerName: 'claude-code' }),
        }),
      }),
    );

    expect(progress.eta).toEqual({ kind: 'unavailable', reason: 'worker changed' });
  });

  it('retires a CLI estimate when a shell call only shares its command name', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState(
          [
            { id: 'T001', title: 'One', status: 'done' },
            { id: 'T002', title: 'Two', status: 'in_progress' },
          ],
          { taskCompletionTimes: [120_000] },
        ),
        operations: operationsState({
          active: runningOperation({ backendKind: 'shell', runnerName: 'claude' }),
          last: completedOperation({ backendKind: 'cli', runnerName: 'claude-code' }),
        }),
      }),
    );

    expect(progress.eta).toEqual({ kind: 'unavailable', reason: 'worker changed' });
  });

  it('retires a CLI estimate when an API worker only shares its name', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState(
          [
            { id: 'T001', title: 'One', status: 'done' },
            { id: 'T002', title: 'Two', status: 'in_progress' },
          ],
          { taskCompletionTimes: [120_000] },
        ),
        operations: operationsState({
          active: runningOperation({ backendKind: 'api', runnerName: 'claude-code' }),
          last: completedOperation({ backendKind: 'cli', runnerName: 'claude-code' }),
        }),
      }),
    );

    expect(progress.eta).toEqual({ kind: 'unavailable', reason: 'worker changed' });
  });

  it('keeps the estimate across cli calls named by the command and by the id', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState(
          [
            { id: 'T001', title: 'One', status: 'done' },
            { id: 'T002', title: 'Two', status: 'in_progress' },
          ],
          { taskCompletionTimes: [120_000] },
        ),
        operations: operationsState({
          active: runningOperation({ backendKind: 'cli', runnerName: 'claude' }),
          last: completedOperation({ backendKind: 'cli', runnerName: 'claude-code' }),
        }),
      }),
    );

    expect(progress.eta).toEqual({ kind: 'estimate', remainingMs: 120_000 });
  });

  it('keeps the old alias identity when a call carries no backend kind', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState(
          [
            { id: 'T001', title: 'One', status: 'done' },
            { id: 'T002', title: 'Two', status: 'in_progress' },
          ],
          { taskCompletionTimes: [120_000] },
        ),
        operations: operationsState({
          active: runningOperation({ runnerName: 'claude' }),
          last: completedOperation({ runnerName: 'claude-code' }),
        }),
      }),
    );

    expect(progress.eta).toEqual({ kind: 'estimate', remainingMs: 120_000 });
  });

  it('names the phase alone between calls', () => {
    expect(deriveBuildProgress(input()).activity).toBe('implementing');
  });

  it('names the side call the phase cannot tell, and still no usage', () => {
    const progress = deriveBuildProgress(
      input({ operations: operationsState({ active: runningOperation({ role: 'summary' }) }) }),
    );

    expect(progress.activity).toBe('OpenAI Codex CLI · summary');
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
  });

  // No seat is on a call while a gate command runs, so a long command is no one's silence: its row
  // says how long it has run, and freshness how long ago a seat last spoke, once.
  it('keeps a long gate command out of the silence warning', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          validationStage: { stage: 'test', command: 'npm test', stageStartedTs: NOW - 90_000 },
        }),
        lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 90_000 }),
      }),
    );

    expect(buildProgressLines(progress, 120)[1]).toBe(
      'npm test · running 1m 30s · last event 1m 30s ago',
    );
    expect(progress.silent).toBe(false);
  });

  it('spells a long silence the way every other elapsed span in the block reads', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({ active: runningOperation() }),
        lifecycle: lifecycleState({
          stall: {
            since: NOW - 10_000,
            silentMs: 302_000,
            runnerName: 'codex',
          },
        }),
      }),
    );

    expect(progress.freshness).toBe('No update for 5m 12s');
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

  it('keeps the phase and both clocks at every width, and names a token count at none', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({ active: runningOperation() }),
        lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 5_000 }),
      }),
    );

    for (const width of [120, 80, 60]) {
      const block = buildProgressLines(progress, width).join('\n');
      expect(block).toContain('OpenAI Codex CLI · implementing');
      expect(block).toContain('last event 5s ago');
      expect(block).toContain('1/2 briefs passed');
      expect(block).toContain('attempt 1 of');
      expect(block).not.toMatch(/token/i);
      expect(block).not.toMatch(/\d+k\b/);
    }
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

describe('the build block during the final review', () => {
  // The review seat runs no brief: it has no attempt to count and no briefs left to estimate.
  function review(): DeriveBuildProgressInput {
    return input({
      tasks: tasksState(
        [
          { id: 'T001', title: 'One', status: 'done' },
          { id: 'T002', title: 'Two', status: 'done' },
        ],
        { currentAttempt: 1, taskCompletionTimes: [60_000, 60_000] },
      ),
      lifecycle: lifecycleState({ phase: 'final-review' }),
      operations: operationsState({
        active: runningOperation({ role: 'review', phase: 'final-review', runnerName: 'codex' }),
        last: completedOperation({ runnerName: 'opencode' }),
      }),
    });
  }

  it('states no attempt and no estimate', () => {
    const progress = deriveBuildProgress(review());
    expect(progress.attempt).toBeNull();
    expect(progress.eta).toBeNull();
    for (const width of [120, 80, 60]) {
      const block = buildProgressLines(progress, width).join('\n');
      expect(block).toContain('2/2 briefs passed');
      expect(block).not.toContain('attempt');
      expect(block).not.toContain('ETA');
    }
  });

  it('paints exactly the rows the chrome budgets for it', () => {
    const progress = deriveBuildProgress(review());
    for (const width of [120, 80, 60]) {
      expect(buildProgressLines(progress, width)).toHaveLength(
        buildProgressRowCount(width, 'final-review'),
      );
    }
  });

  it('keeps the attempt and the estimate while a brief builds', () => {
    const progress = deriveBuildProgress(input());
    for (const width of [120, 80, 60]) {
      expect(buildProgressLines(progress, width)).toHaveLength(
        buildProgressRowCount(width, 'implementing'),
      );
    }
    expect(progress.attempt).not.toBeNull();
    expect(progress.eta).not.toBeNull();
  });
});
