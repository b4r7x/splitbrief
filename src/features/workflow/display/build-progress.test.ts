import { describe, it, expect } from 'vitest';
import {
  buildProgressLines,
  deriveBuildProgress,
  UI_IDLE_WARN_MS,
  type DeriveBuildProgressInput,
} from './build-progress.js';
import { getChromeContentWidth, buildProgressRowCount } from '../layout/chrome-rows.js';
import { BOUNDS } from '../../../core/pipeline-spec/bounds.js';
import { lifecycleStore, type LifecycleState } from '../../../stores/workflow/lifecycle.js';
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
import { getTerminalCellWidth } from '../../../utils/display-text.js';

const NOW = 1_000_000;

it('names a scheduled review during the build as reviewing', () => {
  const progress = deriveBuildProgress(
    input({
      operations: operationsState({
        active: runningOperation({ role: 'review' }),
      }),
    }),
  );
  expect(progress.activity).toBe('OpenAI Codex CLI · reviewing');
});

it.each(['implementing', 'validating-task'] as const)(
  'names the review seat on a fix-task consult that runs while %s',
  (phase) => {
    // A blocked report and a stale refresh consult the reviewer before the ladder escalates.
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase }),
        operations: operationsState({
          active: runningOperation({ role: 'review', phase, taskId: taskId('T013') }),
        }),
      }),
    );
    expect(progress.activity).toBe('REVIEW · OpenAI Codex CLI · answering the consult on T013');
  },
);

it('names the plan render in Review and uses its clock for freshness', () => {
  const progress = deriveBuildProgress(
    input({
      lifecycle: lifecycleState({ phase: 'final-review' }),
      operations: operationsState({
        suiteStage: {
          id: 'R1',
          moment: 'plan',
          scenario: 'workflow-x',
          command: 'npm run tui-shots -- --scenario workflow-x --output /tmp/render',
          stageStartedTs: NOW - 12_000,
        },
      }),
    }),
  );
  expect(progress.activity).toBe('Review · Render workflow-x');
  expect(progress.freshness).toBe('running 0:12');
});

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
    phase?: Extract<LifecycleState, { status: 'running' }>['phase'];
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

    expect(progress.activity).toBe('OpenAI Codex CLI · working');
    expect(progress.freshness).toBe('No output for 1:00');
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

    expect(progress.freshness).toBe('No output for 5:10');
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

    it('names the tool the stream opened after the silence clock', () => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({ runnerName: 'opencode', openTools: [vitest] }),
          }),
          lifecycle: silent,
        }),
      );

      expect(progress.freshness).toBe('No output for 5:42 · running npx vitest run src/features');
      expect(progress.silent).toBe(true);
    });

    it('gives the hint when a quiet stream reports tools only once they end', () => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({ runnerName: 'opencode', openTools: [] }),
          }),
          lifecycle: silent,
        }),
      );

      expect(progress.freshness).toBe('No output for 5:42 · tools report when done');
      expect(progress.silent).toBe(true);
    });

    it('states the bare silence for a stream that reports its tools as they start', () => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({ active: runningOperation({ runnerName: 'codex' }) }),
          lifecycle: lifecycleState({
            stall: { since: NOW - 282_000, silentMs: 60_000, runnerName: 'codex' },
          }),
        }),
      );

      expect(progress.freshness).toBe('No output for 5:42');
      expect(progress.silent).toBe(true);
    });

    it('runs the clock on past an hour and states no stop time', () => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({ active: runningOperation({ runnerName: 'codex' }) }),
          lifecycle: lifecycleState({
            stall: { since: NOW - 4_440_000, silentMs: 60_000, runnerName: 'codex' },
          }),
        }),
      );

      expect(progress.freshness).toBe('No output for 1:15:00');
      expect(progress.freshness).not.toMatch(/ends|until|left|hang|stuck|of \d/i);
    });

    it('clears the warning once the seat speaks again', () => {
      resetWorkflow();
      const call = {
        phase: 'implementing',
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        runnerName: 'opencode',
      } as const;
      addEvent({
        type: 'workflow_started',
        ts: NOW - 400_000,
        phase: 'implementing',
        feature: 'f',
      });
      addEvent({
        type: 'runner_call_stalled',
        ts: NOW - 10_000,
        ...call,
        sequence: 1,
        silentMs: 300_000,
      });
      const stalled = deriveBuildProgress(
        input({
          operations: operationsState({ active: runningOperation({ runnerName: 'opencode' }) }),
          lifecycle: lifecycleStore.get(),
        }),
      );
      expect(stalled.freshness).toBe('No output for 5:10 · tools report when done');

      addEvent({ type: 'runner_call_stall_cleared', ts: NOW - 1_000, ...call, sequence: 2 });
      const cleared = deriveBuildProgress(
        input({
          operations: operationsState({ active: runningOperation({ runnerName: 'opencode' }) }),
          lifecycle: lifecycleStore.get(),
        }),
      );
      expect(cleared.silent).toBe(false);
      expect(cleared.freshness).not.toContain('No output');
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
    for (const width of [getChromeContentWidth(120), 80, 60]) {
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
    for (const width of [getChromeContentWidth(120), 80, 60]) {
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
    expect(buildProgressLines(progress, getChromeContentWidth(120))[0]).toContain(
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
    expect(buildProgressLines(resumed, getChromeContentWidth(120))[0]).toContain('attempt 6 of 12');

    addEvent(
      makeRetry({ taskId: taskId('T001'), attempt: 1, lineageAttempt: 7, attemptAllowance: 12 }),
    );
    const retried = deriveBuildProgress(input({ tasks: tasksStore.get() }));
    expect(retried.attempt).toEqual({ current: 7, max: 12 });
    addEvent({
      type: 'implementer_generate_running',
      ts: NOW,
      phase: 'implementing',
      taskId: taskId('T001'),
      lineageAttempt: 8,
      attemptAllowance: 12,
    });
    const consulted = deriveBuildProgress(input({ tasks: tasksStore.get() }));
    expect(consulted.attempt).toEqual({ current: 8, max: 12 });
    expect(buildProgressLines(consulted, getChromeContentWidth(120))[0]).toContain(
      'attempt 8 of 12',
    );
    addEvent({
      type: 'implementer_generate_running',
      ts: NOW + 1,
      phase: 'implementing',
      taskId: taskId('T001'),
    });
    expect(tasksStore.get()).toMatchObject({ currentAttempt: 8, attemptAllowance: 12 });
    resetWorkflow();
  });

  it('names the seat and what it is doing, and no usage beside them', () => {
    const progress = deriveBuildProgress(
      input({ operations: operationsState({ active: runningOperation() }) }),
    );

    expect(progress.activity).toBe('OpenAI Codex CLI · working');
  });

  it('names the brief from the call, and uses working when the call has no brief', () => {
    for (const [task, words] of [
      [taskId('T003'), 'working on T003'],
      [undefined, 'working'],
    ] as const) {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({
              runnerName: 'antigravity',
              ...(task === undefined ? {} : { taskId: task }),
            }),
          }),
        }),
      );
      expect(progress.activity).toBe(`Google Antigravity CLI · ${words}`);
    }
  });

  it('names a planner consult and its brief during the build', () => {
    for (const role of ['planner', 'escalation'] as const) {
      const progress = deriveBuildProgress(
        input({
          lifecycle: lifecycleState({ phase: 'escalating' }),
          operations: operationsState({
            active: runningOperation({ role, taskId: 'T003', runnerName: 'claude' }),
          }),
        }),
      );
      expect(progress.activity).toBe('PLAN · Claude Code CLI · answering the consult on T003');
    }
  });

  it('names the review seat when it answers the consult on a fix task', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'escalating' }),
        operations: operationsState({
          active: runningOperation({ role: 'review', taskId: 'T013', runnerName: 'codex' }),
        }),
      }),
    );
    expect(progress.activity).toBe('REVIEW · OpenAI Codex CLI · answering the consult on T013');
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

    expect(progress.activity).toBe('PLAN · Claude Code CLI · answering the consult');
    expect(progress.freshness).toBe('No output for 1:00');
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

    expect(progress.activity).toBe('claude · working');
    expect(progress.freshness).toBe('No output for 1:00');
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

      expect(progress.activity).toBe(`${runnerName} · working`);
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

    expect(progress.activity).toBe('Ollama · working');
    expect(progress.freshness).toBe('No output for 1:00');
  });

  it('keeps the Claude Code CLI display for a cli call named by its command', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({ backendKind: 'cli', runnerName: 'claude' }),
        }),
      }),
    );

    expect(progress.activity).toBe('Claude Code CLI · working');
  });

  it('names the build state between calls', () => {
    expect(deriveBuildProgress(input()).activity).toBe('Between calls');
    expect(
      deriveBuildProgress(input({ lifecycle: lifecycleState({ phase: 'validating-task' }) }))
        .activity,
    ).toBe('Between calls');
    expect(
      deriveBuildProgress(input({ lifecycle: lifecycleState({ phase: 'escalating' }) })).activity,
    ).toBe('Waiting for the consult answer');
    expect(
      deriveBuildProgress(input({ lifecycle: lifecycleState({ phase: 'final-review' }) })).activity,
    ).toBe('Review · waiting for the verdict');
  });

  it('says waiting for the verdict and shows no "no update yet" in final review between calls', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review', lastRunnerEventTs: null }),
        operations: operationsState({ active: null }),
      }),
    );
    expect(progress.activity).toBe('Review · waiting for the verdict');
    expect(progress.freshness).toBe('');
    expect(progress.freshness).not.toContain('no update yet');
    for (const width of [getChromeContentWidth(120), 80, 60]) {
      const block = buildProgressLines(progress, width).join('\n');
      expect(block).not.toContain('no update yet');
      expect(block).not.toContain('final-review');
    }
  });

  it('shows the work when an operation has no runnerName', () => {
    const unnamed = runningOperation();
    delete unnamed.runnerName;
    const buildProg = deriveBuildProgress(
      input({
        operations: operationsState({
          active: unnamed,
        }),
      }),
    );
    expect(buildProg.activity).toBe('working');
    expect(buildProg.activity).not.toContain('final-review');

    const reviewProg = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review' }),
        operations: operationsState({
          active: {
            ...unnamed,
            role: 'review',
            phase: 'final-review',
          },
        }),
      }),
    );
    expect(reviewProg.activity).toBe('Review · reviewing');
    expect(reviewProg.activity).not.toContain('final-review');
  });

  it.each(['summary', 'compaction'] as const)('names the %s side call without usage', (role) => {
    const progress = deriveBuildProgress(
      input({ operations: operationsState({ active: runningOperation({ role }) }) }),
    );

    expect(progress.activity).toBe(`OpenAI Codex CLI · ${role}`);
  });

  it.each([
    ['summary', 'Summary'],
    ['compaction', 'Compaction'],
  ] as const)('names %s during Review without a reviewer seat', (role, label) => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review' }),
        operations: operationsState({
          active: runningOperation({ role, phase: 'final-review', runnerName: 'codex' }),
        }),
      }),
    );
    expect(progress.activity).toBe(`Review · ${label}`);
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

    expect(progress.activity).toBe('npm test');
    expect(progress.freshness).toBe('running 1:30');
  });

  // No seat is on a call while a gate command runs, so a long command is no one's silence: its own
  // clock is the block's proof of life, said once.
  it('keeps a long gate command out of the silence warning', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          validationStage: { stage: 'test', command: 'npm test', stageStartedTs: NOW - 90_000 },
        }),
        lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 90_000 }),
      }),
    );

    expect(buildProgressLines(progress, getChromeContentWidth(120))[1]).toBe(
      'npm test · running 1:30',
    );
    expect(progress.silent).toBe(false);
  });

  // S8 run 18:06–18:58: the pre-review `npm test` ran ten minutes and no surface said which stage
  // it was or how long it had run.
  it('names the full-suite stage, its command and how long it has run, not the seat', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          suiteStage: {
            stage: 'test',
            command: 'npm test',
            moment: 'pre-review',
            stageStartedTs: NOW - 602_000,
          },
        }),
      }),
    );

    expect(progress.activity).toBe('Pre-review suite · npm test');
    expect(progress.freshness).toBe('running 10:02');
  });

  // The byline leads with the same check clock (`formatElapsedClock`); past an hour both read
  // `1:00:02`, never one clock in the block and another in the byline.
  it('counts a check past an hour in the clock the byline reads', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          suiteStage: {
            id: 'V1',
            command: 'npm test',
            moment: 'pre-review',
            stageStartedTs: NOW - 3_602_000,
          },
        }),
      }),
    );

    expect(progress.freshness).toBe('running 1:00:02');
  });

  // Render of workflow-review-check-running: `last event 14m 7s ago` sat under `running 10:02`,
  // the age of the last seat word beside a command that had spoken for ten minutes.
  it('lets the running check clock stand as freshness, never the age of the last seat word', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review', lastRunnerEventTs: NOW - 847_000 }),
        operations: operationsState({
          suiteStage: {
            id: 'V2',
            command: 'npm test',
            moment: 'pre-review',
            stageStartedTs: NOW - 602_000,
          },
        }),
      }),
    );

    expect(progress.activity).toBe('Review · Reviewer check V2 · npm test');
    expect(progress.freshness).toBe('running 10:02');
    expect(progress.silent).toBe(false);
    for (const width of [160, getChromeContentWidth(120), 80, 60]) {
      expect(buildProgressLines(progress, width).join('\n')).not.toContain('last event');
    }
  });

  // Q2 review B2: while a fix brief re-ran V1 the block named no command.
  it('names the fix check a brief runs again and its own clock', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'implementing' }),
        operations: operationsState({
          suiteStage: {
            id: 'V1',
            command: 'npm test',
            moment: 'brief',
            stageStartedTs: NOW - 42_000,
          },
        }),
      }),
    );

    expect(progress.activity).toBe('Fix check V1 · npm test');
    expect(progress.freshness).toBe('running 0:42');
  });

  // Render of workflow-review-base-rerun at 60 columns: `… legacy.test.ts · running…` lost its clock.
  it('cuts a long command, never the clock that follows it, where they share a row', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review' }),
        operations: operationsState({
          suiteStage: {
            id: 'V2',
            command: `npm test -- ${[
              'legacy',
              'modern',
              'format',
              'parse',
              'render',
              'store',
              'theme',
            ]
              .map((name) => `src/${name}/${name}.test.ts`)
              .join(' ')}`,
            moment: 'base',
            stageStartedTs: NOW - 40_000,
          },
        }),
      }),
    );

    for (const width of [getChromeContentWidth(120), 140]) {
      const line = buildProgressLines(progress, width)[1] ?? '';
      expect(line.endsWith(' · running 0:40')).toBe(true);
      expect(line.startsWith('Review · Base re-run V2 · npm test -- ')).toBe(true);
      expect(line).toContain('…');
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(width);
    }
    for (const width of [60, 80]) {
      const lines = buildProgressLines(progress, width);
      expect(lines).toHaveLength(buildProgressRowCount(width));
      expect(lines[2]).toBe('running 0:40');
    }
  });

  it('spells a long silence as a clock', () => {
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

    expect(progress.freshness).toBe('No output for 5:12');
  });
});

describe('buildProgressRowCount', () => {
  it('2 rows at 120 terminal columns and wider, 3 below', () => {
    expect(buildProgressRowCount(getChromeContentWidth(120))).toBe(2);
    expect(buildProgressRowCount(getChromeContentWidth(121))).toBe(2);
    expect(buildProgressRowCount(getChromeContentWidth(119))).toBe(3);
  });
});

describe('buildProgressLines', () => {
  it('cuts a silence that names a long tool from its end, keeping the seat and the clock', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({
            openTools: [
              {
                activityId: 'call-1:tool:bash-1',
                kind: 'command',
                label: 'bash',
                target: `npm test -- ${'src/features/workflow/'.repeat(8)}`,
                since: NOW - 400_000,
              },
            ],
          }),
        }),
        lifecycle: lifecycleState({
          stall: { since: NOW - 10_000, silentMs: 300_000, runnerName: 'codex' },
        }),
      }),
    );

    const [, row] = buildProgressLines(progress, 120);
    expect(
      row?.startsWith('OpenAI Codex CLI · working · No output for 5:10 · running npm test'),
    ).toBe(true);
    expect(getTerminalCellWidth(row ?? '')).toBeLessThanOrEqual(120);
  });

  it('2 lines at 120 columns', () => {
    expect(
      buildProgressLines(deriveBuildProgress(input()), getChromeContentWidth(120)),
    ).toHaveLength(2);
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

    for (const width of [getChromeContentWidth(120), 80, 60]) {
      const block = buildProgressLines(progress, width).join('\n');
      expect(block).toContain('OpenAI Codex CLI · working');
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

    expect(buildProgressLines(progress, getChromeContentWidth(120))[0]).toContain(
      '1/3 briefs passed',
    );
    expect(buildProgressLines(progress, getChromeContentWidth(120))[0]).toContain('1 escalated');
    expect(buildProgressLines(progress, getChromeContentWidth(120))[0]).toContain('1 failed');
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
    for (const width of [getChromeContentWidth(120), 80, 60]) {
      const block = buildProgressLines(progress, width).join('\n');
      expect(block).toContain('2/2 briefs passed');
      expect(block).not.toContain('attempt');
    }
  });

  it('paints exactly the rows the chrome budgets for it', () => {
    const progress = deriveBuildProgress(review());
    for (const width of [getChromeContentWidth(120), 80, 60]) {
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
    for (const width of [getChromeContentWidth(120), 80, 60]) {
      expect(buildProgressLines(progress, width)).toHaveLength(buildProgressRowCount(width));
    }
    expect(progress.attempt).not.toBeNull();
  });
});
