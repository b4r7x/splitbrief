import { describe, it, expect } from 'vitest';
import {
  buildProgressLines,
  buildProgressRowCount,
  deriveBuildProgress,
  UI_IDLE_WARN_MS,
  type DeriveBuildProgressInput,
} from './build-progress.js';
import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type {
  OperationsState,
  RunningOperation,
  TerminalOperation,
} from '../../../stores/workflow/operations/state.js';
import { tasksStore, type TasksState, type WorkflowTask } from '../../../stores/workflow/tasks.js';
import { addEvent } from '../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../stores/workflow/actions/reset.js';
import { makeRetry, makeTaskStart } from '#testing/helpers/events/task.js';
import { taskId } from '../../../core/schemas/task.js';

const NOW = 1_000_000;

function tasksState(tasks: WorkflowTask[], overrides: Partial<TasksState> = {}): TasksState {
  return {
    currentTask: 1,
    currentAttempt: 1,
    attemptAllowance: BOUNDS.attemptsPerLineage,
    totalTasks: tasks.length,
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

  describe('a tool that runs through the silence', () => {
    const silent = lifecycleState({
      lastRunnerEventTs: NOW - 342_000,
      stall: { since: NOW - 282_000, silentMs: 60_000, runnerName: 'opencode' },
    });

    const vitest = {
      activityId: 'call-1:tool:bash-1',
      kind: 'command',
      label: 'bash',
      target: 'npx vitest run src/features',
      since: NOW - 342_000,
    } as const;

    it('names the tool the stream opened and how long it has run', () => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({ runnerName: 'opencode', openTools: [vitest] }),
          }),
          lifecycle: silent,
        }),
      );

      expect(progress.freshness).toBe('running npx vitest run src/features · 5m 42s');
      expect(progress.silent).toBe(false);
    });

    it('says a tool is running when a quiet stream reports tools only once they end', () => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({ runnerName: 'opencode', openTools: [] }),
          }),
          lifecycle: silent,
        }),
      );

      expect(progress.freshness).toBe('a tool is running · 5m 42s');
    });

    it('keeps the silence warning for a stream that reports its tools as they start', () => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({ active: runningOperation({ runnerName: 'codex' }) }),
          lifecycle: silent,
        }),
      );

      expect(progress.freshness).toBe('No update for 5m 42s');
      expect(progress.silent).toBe(true);
    });
  });

  it('reports freshness while the seat is still speaking', () => {
    const progress = deriveBuildProgress(
      input({ lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 5_000 }) }),
    );

    expect(progress.freshness).toBe('last event 5s ago');
  });

  // A brief's first attempt is the normal case: the bound only matters once a retry has spent one.
  it('states no attempt while the first one runs', () => {
    const progress = deriveBuildProgress(input());

    expect(progress.attempt).toBeNull();
    for (const width of [120, 80, 60]) {
      expect(buildProgressLines(progress, width).join('\n')).not.toContain('attempt');
    }
  });

  it('quotes no estimate of the time left at any width', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState(
          [
            { id: 'T001', title: 'One', status: 'done' },
            { id: 'T002', title: 'Two', status: 'done' },
            { id: 'T003', title: 'Three', status: 'in_progress' },
          ],
          { currentAttempt: 3 },
        ),
      }),
    );

    expect(progress).not.toHaveProperty('eta');
    for (const width of [120, 80, 60]) {
      expect(buildProgressLines(progress, width).join('\n')).not.toContain('ETA');
    }
  });

  it('states the attempt against the lineage attempt allowance', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState([{ id: 'T001', title: 'One', status: 'in_progress' }], {
          currentAttempt: 2,
        }),
      }),
    );

    expect(progress.attempt).toEqual({ current: 2, max: BOUNDS.attemptsPerLineage });
    expect(buildProgressLines(progress, 120)[0]).toContain(
      `attempt 2 of ${BOUNDS.attemptsPerLineage}`,
    );
  });

  // A brief resumed after Continue granted more attempts is on its lineage's sixth attempt of
  // twelve, not on a fresh first one: the block states the count the engine recorded.
  it('states the lineage attempt and allowance the task events carry, after a grant', () => {
    resetWorkflow();
    addEvent(makeTaskStart({ taskId: taskId('T001'), lineageAttempt: 6, attemptAllowance: 12 }));

    const resumed = deriveBuildProgress(input({ tasks: tasksStore.get() }));
    expect(resumed.attempt).toEqual({ current: 6, max: 12 });
    expect(buildProgressLines(resumed, 120)[0]).toContain('attempt 6 of 12');

    addEvent(
      makeRetry({ taskId: taskId('T001'), attempt: 1, lineageAttempt: 7, attemptAllowance: 12 }),
    );
    const retried = deriveBuildProgress(input({ tasks: tasksStore.get() }));
    expect(retried.attempt).toEqual({ current: 7, max: 12 });
    resetWorkflow();
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

  it('3 lines at 80 and at 60 columns, with or without an attempt to state', () => {
    const retry = input({
      tasks: tasksState([{ id: 'T001', title: 'One', status: 'in_progress' }], {
        currentAttempt: 2,
      }),
    });
    for (const width of [80, 60]) {
      expect(buildProgressLines(deriveBuildProgress(input()), width)).toHaveLength(3);
      expect(buildProgressLines(deriveBuildProgress(retry), width)).toHaveLength(3);
      expect(buildProgressLines(deriveBuildProgress(retry), width)[0]).toBe(
        `0/1 briefs passed · attempt 2 of ${BOUNDS.attemptsPerLineage}`,
      );
    }
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
        { currentAttempt: 1 },
      ),
      lifecycle: lifecycleState({ phase: 'final-review' }),
      operations: operationsState({
        active: runningOperation({ role: 'review', phase: 'final-review', runnerName: 'codex' }),
        last: completedOperation({ runnerName: 'opencode' }),
      }),
    });
  }

  it('states no attempt', () => {
    const progress = deriveBuildProgress(review());
    expect(progress.attempt).toBeNull();
    for (const width of [120, 80, 60]) {
      const block = buildProgressLines(progress, width).join('\n');
      expect(block).toContain('2/2 briefs passed');
      expect(block).not.toContain('attempt');
    }
  });

  it('paints exactly the rows the chrome budgets for it', () => {
    const progress = deriveBuildProgress(review());
    for (const width of [120, 80, 60]) {
      expect(buildProgressLines(progress, width)).toHaveLength(buildProgressRowCount(width));
    }
  });

  it('paints the budgeted rows while a retry builds', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState([{ id: 'T001', title: 'One', status: 'in_progress' }], {
          currentAttempt: 2,
        }),
      }),
    );
    for (const width of [120, 80, 60]) {
      expect(buildProgressLines(progress, width)).toHaveLength(buildProgressRowCount(width));
    }
    expect(progress.attempt).not.toBeNull();
  });
});
