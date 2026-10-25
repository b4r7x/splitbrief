import { describe, it, expect } from 'vitest';
import {
  buildProgressRows,
  deriveBuildProgress,
  UI_IDLE_WARN_MS,
  passedCountSpans,
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
import { operationsStore } from '../../../stores/workflow/operations/state.js';
import {
  makeRunnerCallStarted,
  makeRunnerCallCompleted,
} from '#testing/helpers/events/runner-call.js';

const NOW = 1_000_000;

it.each([
  ['shell', 'Custom Shell'],
  ['agent', 'Agent'],
] as const)('names a recorded %s build seat in the configured seat words', (backendKind, label) => {
  const progress = deriveBuildProgress(
    input({
      operations: operationsState({
        active: runningOperation({ backendKind, runnerName: backendKind, model: 'gpt-5' }),
      }),
    }),
  );
  expect(progress.activity).toBe(`${label} · GPT-5 · working`);
});

it('names a scheduled review during the build exactly as the final review', () => {
  const progress = deriveBuildProgress(
    input({
      operations: operationsState({
        active: runningOperation({ role: 'review' }),
      }),
    }),
  );
  expect(progress.activity).toBe('Review · OpenAI Codex CLI · auto');
});

it.each([
  ['task', 'implementing'],
  ['final', 'final-review'],
] as const)(
  'keeps the %s review fallback identity between calls and during reviewer checks',
  (scope, phase) => {
    resetWorkflow();
    addEvent({ type: 'workflow_started', ts: NOW - 2_000, phase, feature: 'test' });
    addEvent({
      type: 'review_started',
      ts: NOW - 1_000,
      phase,
      scope,
      ...(scope === 'task' && { afterTaskId: 'T001' }),
      tool: 'codex',
      model: 'gpt-5',
      axes: ['high'],
    });
    addEvent({ type: 'review_step', ts: NOW - 1_000, phase, step: 'choosing-checks' });
    const progressNow = () =>
      deriveBuildProgress(
        input({ lifecycle: lifecycleStore.get(), operations: operationsStore.get() }),
      );
    const reviewer = 'Review · OpenAI Codex CLI · GPT-5 · high';
    expect(progressNow().activity).toBe(`${reviewer} · choosing checks`);
    expect(progressNow().freshness).toBe('last event 1s ago');
    addEvent(
      makeRunnerCallStarted({
        ts: NOW - 900,
        phase,
        role: 'review',
        callId: 'review-plan',
        runnerName: 'codex',
        model: 'gpt-5',
        axes: ['high'],
      }),
    );
    expect(progressNow().activity).toBe(`${reviewer} · choosing checks`);
    addEvent(
      makeRunnerCallCompleted({
        ts: NOW - 800,
        phase,
        role: 'review',
        callId: 'review-plan',
        startedAt: NOW - 900,
        endedAt: NOW - 800,
        durationMs: 100,
      }),
    );
    expect(progressNow().activity).toBe(`${reviewer} · choosing checks`);
    addEvent({
      type: 'review_checks',
      ts: NOW - 750,
      phase,
      scope,
      status: 'planned',
      commands: [],
      declined: [],
      reason: 'No checks needed.',
    });
    addEvent({
      type: 'full_suite',
      ts: NOW - 700,
      phase,
      id: 'V1',
      moment: 'pre-review',
      command: 'npm test',
      status: 'running',
    });
    expect(progressNow().activity).toBe('Review · Reviewer check V1 · npm test');
    expect(progressNow().activityIdentity).toBeNull();
    expect(progressNow().freshness).toBe('running 0:00');
    addEvent({
      type: 'full_suite',
      ts: NOW - 600,
      phase,
      id: 'V1',
      moment: 'pre-review',
      command: 'npm test',
      status: 'done',
      passed: true,
    });
    expect(progressNow().activity).toBe(`${reviewer} · reviewing changes`);
    addEvent({
      type: 'review_completed',
      ts: NOW - 500,
      phase,
      scope,
      tool: 'codex',
      verdict: 'pass',
      duration: 500,
    });
    expect(progressNow().activity).toBe(
      scope === 'task' ? 'Between calls' : 'Review · reviewing changes',
    );
    expect(progressNow().freshness).toBe('last event 0s ago');
    resetWorkflow();
  },
);

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
    expect(progress.activity).toBe(
      'REVIEW · OpenAI Codex CLI · auto · answering the consult on T013',
    );
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
    queuedMessageIds: new Set(),
    steerableCall: null,
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

    expect(progress.activity).toBe('OpenAI Codex CLI · auto · working');
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
      expect(
        buildProgressRows(progress, width)
          .map((row) => row.text)
          .join('\n'),
      ).not.toContain('attempt');
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
      expect(
        buildProgressRows(progress, width)
          .map((row) => row.text)
          .join('\n'),
      ).not.toContain('ETA');
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
    expect(buildProgressRows(progress, getChromeContentWidth(120))[0]?.text).toContain(
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
    expect(buildProgressRows(resumed, getChromeContentWidth(120))[0]?.text).toContain(
      'attempt 6 of 12',
    );

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
    expect(buildProgressRows(consulted, getChromeContentWidth(120))[0]?.text).toContain(
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

    expect(progress.activity).toBe('OpenAI Codex CLI · auto · working');
  });

  it('names the build seat as the sidebar spells it: tool, model and axis words', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({
            runnerName: 'codex',
            model: 'gpt-5',
            axes: ['high'],
            taskId: taskId('T001'),
          }),
        }),
      }),
    );

    expect(progress.activity).toBe('OpenAI Codex CLI · GPT-5 · high · working on T001');
  });

  it('sheds whole identity segments, never the work, where the activity row is narrow', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({
            runnerName: 'codex',
            model: 'gpt-5',
            axes: ['high'],
            taskId: taskId('T001'),
          }),
        }),
      }),
    );

    expect(buildProgressRows(progress, 45)[1]?.text).toBe(
      'OpenAI Codex CLI · GPT-5 · working on T001',
    );
    expect(buildProgressRows(progress, 40)[1]?.text).toBe('OpenAI Codex CLI · working on T001');
  });

  it('keeps the consult seat, work and freshness when a two-row identity sheds segments', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({
            role: 'planner',
            backendKind: 'api',
            runnerName: 'custom',
            model: 'long-model-name-'.repeat(10),
            axes: ['high'],
            taskId: 'T013',
          }),
        }),
        lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 5_000 }),
      }),
    );
    const row = buildProgressRows(progress, getChromeContentWidth(120))[1]?.text ?? '';
    expect(row).toBe('PLAN · custom · answering the consult on T013 · last event 5s ago');
    expect(progress.activity).toContain(' · high · answering the consult on T013');
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
      expect(progress.activity).toBe(`Google Antigravity CLI · auto · ${words}`);
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
      expect(progress.activity).toBe(
        'PLAN · Claude Code CLI · auto · answering the consult on T003',
      );
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
    expect(progress.activity).toBe(
      'REVIEW · OpenAI Codex CLI · auto · answering the consult on T013',
    );
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

    expect(progress.activity).toBe('PLAN · Claude Code CLI · auto · answering the consult');
    expect(progress.freshness).toBe('No output for 1:00');
  });

  it('names a shell command named claude by the shell kind, not the CLI', () => {
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

    expect(progress.activity).toBe('Custom Shell · auto · working');
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

      expect(progress.activity).toBe(`${runnerName} · auto · working`);
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

    expect(progress.activity).toBe('Ollama · auto · working');
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

    expect(progress.activity).toBe('Claude Code CLI · auto · working');
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
    ).toBe('Review · reviewing changes');
  });

  it('says reviewing changes and shows no "no update yet" in final review between calls', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review', lastRunnerEventTs: null }),
        operations: operationsState({ active: null }),
      }),
    );
    expect(progress.activity).toBe('Review · reviewing changes');
    expect(progress.freshness).toBe('');
    expect(progress.freshness).not.toContain('no update yet');
    for (const width of [getChromeContentWidth(120), 80, 60]) {
      const block = buildProgressRows(progress, width)
        .map((row) => row.text)
        .join('\n');
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

    expect(progress.activity).toBe(`OpenAI Codex CLI · auto · ${role}`);
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

    expect(buildProgressRows(progress, getChromeContentWidth(120))[1]?.text).toBe(
      'npm test · running 1:30',
    );
    expect(progress.silent).toBe(false);
  });

  // In a real run, the pre-review `npm test` ran ten minutes and no surface said which stage
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
      expect(
        buildProgressRows(progress, width)
          .map((row) => row.text)
          .join('\n'),
      ).not.toContain('last event');
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

  // RC6 run C2: while K2 ran the block still read `working on T001` beside an idle BUILD.
  it('names the brief plan check a brief runs from its start event, on its own clock', () => {
    resetWorkflow();
    addEvent({
      type: 'task_validating',
      ts: NOW - 11_000,
      phase: 'validating-task',
      taskId: taskId('T001'),
      check: { id: 'K2', command: 'node --test test/sleep.test.mjs' },
    });
    const progress = deriveBuildProgress(
      input({ lifecycle: lifecycleStore.get(), operations: operationsStore.get() }),
    );
    resetWorkflow();

    expect(progress.activity).toBe('Plan check K2 · node --test test/sleep.test.mjs');
    expect(progress.freshness).toBe('running 0:11');
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
      const line = buildProgressRows(progress, width)[1]?.text ?? '';
      expect(line.endsWith(' · running 0:40')).toBe(true);
      expect(line.startsWith('Review · Base re-run V2 · npm test -- ')).toBe(true);
      expect(line).toContain('…');
      expect(getTerminalCellWidth(line)).toBeLessThanOrEqual(width);
    }
    for (const width of [60, 80]) {
      const rows = buildProgressRows(progress, width);
      expect(rows).toHaveLength(buildProgressRowCount(width));
      expect(rows[2]?.text).toBe('running 0:40');
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

describe('buildProgressRows', () => {
  it('keeps the sidebar passed count in success', () => {
    expect(passedCountSpans('3')).toEqual([
      { text: '3 ', tone: 'textDim' },
      { text: 'passed', tone: 'success' },
    ]);
  });

  it.each([
    [
      'final-review',
      { id: 'R1', moment: 'plan', scenario: 'workflow-x', command: 'npm run tui-shots' },
      'Render workflow-x',
    ],
    ['final-review', { id: 'V1', moment: 'base', command: 'npm test' }, 'Base re-run V1'],
    ['implementing', { id: 'V1', moment: 'brief', command: 'npm test' }, 'Fix check V1'],
  ] as const)('keeps the %s running lead accent and metadata dim for %s', (phase, suite, lead) => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase }),
        operations: operationsState({ suiteStage: { ...suite, stageStartedTs: NOW - 42_000 } }),
      }),
    );
    for (const width of [160, 80, 60]) {
      const spans = buildProgressRows(progress, width).flatMap((row) => row.spans);
      expect(spans).toContainEqual({ text: lead, tone: 'accent' });
      expect(spans).toContainEqual({ text: ' 0:42', tone: 'textDim' });
      if (suite.moment !== 'plan')
        expect(spans).toContainEqual({ text: suite.command, tone: 'textDim' });
      for (const span of spans.filter((part) => part.text === ' · '))
        expect(span.tone).toBe('textDim');
    }
  });

  it.each([160, 80, 60])(
    'keeps the running state accent and its clock dim at %s cells',
    (width) => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            suiteStage: {
              id: 'V1',
              moment: 'pre-review',
              command: 'npm test',
              stageStartedTs: NOW - 12_000,
            },
          }),
        }),
      );
      const spans = buildProgressRows(progress, width).flatMap((row) => row.spans);
      expect(spans).toContainEqual({ text: 'running', tone: 'accent' });
      expect(spans).toContainEqual({ text: ' 0:12', tone: 'textDim' });
    },
  );

  it('carries count states, separators and attempts as separate tones', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState(
          [
            { id: 'T001', title: 'One', status: 'done' },
            { id: 'T002', title: 'Two', status: 'escalated' },
            { id: 'T003', title: 'Three', status: 'failed' },
          ],
          { currentAttempt: 2 },
        ),
      }),
    );
    expect(buildProgressRows(progress, 160)[0]?.spans).toEqual([
      { text: '1/3 briefs passed', tone: 'textDim' },
      { text: ' · 1 ', tone: 'textDim' },
      { text: 'escalated', tone: 'warning' },
      { text: ' · 1 ', tone: 'textDim' },
      { text: 'failed', tone: 'error' },
      { text: ' · ', tone: 'textDim' },
      { text: `attempt 2 of ${BOUNDS.attemptsPerLineage}`, tone: 'textDim' },
    ]);
  });

  it.each([
    ['implementer', 'implementer', undefined],
    ['planner', 'planner', 'PLAN'],
    ['escalation', 'planner', 'PLAN'],
    ['review', 'reviewer', 'REVIEW'],
  ] as const)(
    'carries the %s identity and consult seat tone through fitting',
    (role, tone, seat) => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({
              role,
              taskId: 'T013',
              model: 'gpt-5',
              axes: ['high'],
            }),
          }),
          lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 16_000 }),
        }),
      );
      const identity = 'OpenAI Codex CLI · GPT-5 · high';
      for (const width of [160, 80, 45, 12, 1, 0]) {
        const rows = buildProgressRows(progress, width);
        const spans = rows[1]?.spans ?? [];
        expect(spans.some((span) => span.tone === tone && span.text.startsWith('O'))).toBe(
          width >= 45,
        );
        if (width === 160 && seat !== undefined) expect(spans).toContainEqual({ text: seat, tone });
        if (width === 160) expect(spans).toContainEqual({ text: identity, tone });
        for (const row of rows) expect(row.spans.map((span) => span.text).join('')).toBe(row.text);
        for (const span of spans.filter(
          (span) => span.text.includes('consult') || span.text.includes('working'),
        )) {
          expect(span.tone).toBe('textDim');
        }
      }
    },
  );

  it('keeps the seat tone when a wide-character identity is cut within its leading word', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({ runnerName: '界界界界', backendKind: 'api' }),
        }),
      }),
    );
    const row = buildProgressRows(progress, 14)[1];
    expect(row?.text).toBe('界… · working');
    expect(row?.spans).toEqual([
      { text: '界…', tone: 'implementer' },
      { text: ' · ', tone: 'textDim' },
      { text: 'working', tone: 'textDim' },
    ]);
  });

  it('colors a final review identity and its lead as the reviewer seat', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review' }),
        operations: operationsState({
          active: runningOperation({ role: 'review', phase: 'final-review' }),
        }),
      }),
    );
    expect(buildProgressRows(progress, 160)[1]?.spans).toEqual([
      { text: 'Review', tone: 'reviewer' },
      { text: ' · ', tone: 'textDim' },
      { text: 'OpenAI Codex CLI · auto', tone: 'reviewer' },
      { text: ' · ', tone: 'textDim' },
      { text: 'last event 0s ago', tone: 'textDim' },
    ]);
  });

  it.each([
    {
      suite: { id: 'V1', moment: 'pre-review', command: 'npm test' },
      labelSpans: [
        { text: 'Reviewer', tone: 'reviewer' },
        { text: ' check V1', tone: 'textDim' },
      ],
    },
    {
      suite: { id: 'C1', moment: 'plan', command: 'npm test' },
      labelSpans: [
        { text: 'Plan', tone: 'planner' },
        { text: ' check C1', tone: 'textDim' },
      ],
    },
    {
      suite: { id: 'B1', moment: 'base', command: 'npm test' },
      labelSpans: [{ text: 'Base re-run B1', tone: 'accent' }],
    },
    {
      suite: { id: 'F1', moment: 'brief', command: 'npm test' },
      labelSpans: [{ text: 'Fix check F1', tone: 'accent' }],
    },
    {
      suite: { moment: 'pre-review', command: 'npm test' },
      labelSpans: [{ text: 'Pre-review suite', tone: 'textDim' }],
    },
  ] as const)('colors seat words in the running $suite.moment check', ({ suite, labelSpans }) => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review' }),
        operations: operationsState({ suiteStage: { ...suite, stageStartedTs: NOW - 12_000 } }),
      }),
    );
    const spans = buildProgressRows(progress, 160)[1]?.spans ?? [];
    expect(spans).toEqual([
      { text: 'Review', tone: 'reviewer' },
      { text: ' · ', tone: 'textDim' },
      ...labelSpans,
      { text: ' · ', tone: 'textDim' },
      { text: 'npm test', tone: 'textDim' },
      { text: ' · ', tone: 'textDim' },
      { text: 'running', tone: 'accent' },
      { text: ' 0:12', tone: 'textDim' },
    ]);
  });

  it('colors the Review seat and running render lead without a command', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review' }),
        operations: operationsState({
          suiteStage: {
            id: 'R1',
            moment: 'plan',
            command: 'npm test',
            scenario: 'workflow-x',
            stageStartedTs: NOW - 12_000,
          },
        }),
      }),
    );
    expect(buildProgressRows(progress, 160)[1]?.spans).toEqual([
      { text: 'Review', tone: 'reviewer' },
      { text: ' · ', tone: 'textDim' },
      { text: 'Render workflow-x', tone: 'accent' },
      { text: ' · ', tone: 'textDim' },
      { text: 'running', tone: 'accent' },
      { text: ' 0:12', tone: 'textDim' },
    ]);
  });

  it('keeps Reviewer and its separator tones when the check command is cut', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review' }),
        operations: operationsState({
          suiteStage: {
            id: 'V1',
            moment: 'pre-review',
            command: `npm test -- ${'long-command-argument '.repeat(12)}`,
            stageStartedTs: NOW - 12_000,
          },
        }),
      }),
    );
    for (const width of [80, 120, 160]) {
      const row = buildProgressRows(progress, width)[1];
      expect(row?.spans).toContainEqual({ text: 'Reviewer', tone: 'reviewer' });
      expect(row?.spans).toContainEqual({ text: ' · ', tone: 'textDim' });
      expect(row?.text).toContain('…');
      expect(row?.spans.map((span) => span.text).join('')).toBe(row?.text);
    }
  });

  it('carries silence as warning at every width while ordinary freshness stays dim', () => {
    const base = input({
      operations: operationsState({ active: runningOperation() }),
      lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 16_000 }),
    });
    const normal = deriveBuildProgress(base);
    const silent = deriveBuildProgress({
      ...base,
      lifecycle: lifecycleState({
        stall: { since: NOW - 12_000, silentMs: 300_000, runnerName: 'codex' },
      }),
    });
    for (const width of [160, 80, 60]) {
      expect(buildProgressRows(normal, width).flatMap((row) => row.spans)).toContainEqual({
        text: 'last event 16s ago',
        tone: 'textDim',
      });
      expect(buildProgressRows(silent, width).flatMap((row) => row.spans)).toContainEqual({
        text: 'No output for 5:12',
        tone: 'warning',
      });
    }
  });

  it('keeps row keys stable when the recorded identity and terminal width change', () => {
    for (const runnerName of ['codex', 'opencode']) {
      const progress = deriveBuildProgress(
        input({ operations: operationsState({ active: runningOperation({ runnerName }) }) }),
      );
      for (const width of [getChromeContentWidth(120), 80, 60]) {
        expect(buildProgressRows(progress, width).map((row) => row.key)).toEqual(
          buildProgressRowCount(width) === 2
            ? ['counts', 'activity']
            : ['counts', 'activity', 'freshness'],
        );
      }
    }
  });

  it.each<{ operation: Partial<RunningOperation>; identity: string }>([
    { operation: {}, identity: 'OpenAI Codex CLI · auto' },
    { operation: { model: 'gpt-5', axes: ['high'] }, identity: 'OpenAI Codex CLI · GPT-5 · high' },
  ])(
    'cuts a silence that names a long tool from its end, keeping the seat and the clock ($identity)',
    ({ operation, identity }) => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({
              ...operation,
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

      const [, row] = buildProgressRows(progress, 120);
      expect(
        row?.text.startsWith(`${identity} · working · No output for 5:10 · running npm test`),
      ).toBe(true);
      expect(row?.text.endsWith('…')).toBe(true);
      expect(getTerminalCellWidth(row?.text ?? '')).toBeLessThanOrEqual(120);
    },
  );

  it.each([
    { role: 'implementer', prefix: '', doing: 'working on T013' },
    { role: 'planner', prefix: 'PLAN · ', doing: 'answering the consult on T013' },
    { role: 'review', prefix: 'REVIEW · ', doing: 'answering the consult on T013' },
  ] as const)(
    'keeps the $role seat, work and silence clock after shedding a long model',
    ({ role, prefix, doing }) => {
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({
              role,
              taskId: 'T013',
              model: 'long-model-name-'.repeat(10),
              axes: ['high'],
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

      for (const cols of [120, 80, 60]) {
        const width = getChromeContentWidth(cols);
        const rows = buildProgressRows(progress, width);
        const activity = `${prefix}OpenAI Codex CLI · ${doing}`;
        if (cols === 120) {
          expect(rows[1]?.text).toBe(`${activity} · No output for 5:10`);
        } else {
          expect(rows[1]?.text).toBe(activity);
          expect(rows[2]?.text.startsWith('No output for 5:10 · running npm test')).toBe(true);
          expect(rows[2]?.text.endsWith('…')).toBe(true);
        }
        for (const row of rows) expect(getTerminalCellWidth(row.text)).toBeLessThanOrEqual(width);
      }
    },
  );

  it('drops a silence description when only its clock fits after the full identity', () => {
    const progress = deriveBuildProgress(
      input({
        operations: operationsState({
          active: runningOperation({ model: 'long-model-name-'.repeat(4), axes: ['high'] }),
        }),
        lifecycle: lifecycleState({
          stall: { since: NOW - 10_000, silentMs: 300_000, runnerName: 'codex' },
        }),
      }),
    );
    const width = getTerminalCellWidth(`${progress.activity} · No output for 5:10`);
    for (const extra of [0, 1, 2, 3]) {
      const row = buildProgressRows(
        { ...progress, freshness: `${progress.freshness} · running npm test` },
        width + extra,
      )[1];
      expect(row?.text).toBe(`${progress.activity} · No output for 5:10`);
    }
  });

  it('2 lines at 120 columns', () => {
    expect(
      buildProgressRows(deriveBuildProgress(input()), getChromeContentWidth(120)),
    ).toHaveLength(2);
  });

  it('3 lines at 80 and at 60 columns, with or without an attempt to state', () => {
    const retry = input({
      tasks: tasksState([{ id: 'T001', title: 'One', status: 'in_progress' }], {
        currentAttempt: 2,
      }),
    });
    for (const width of [80, 60]) {
      expect(buildProgressRows(deriveBuildProgress(input()), width)).toHaveLength(3);
      expect(buildProgressRows(deriveBuildProgress(retry), width)).toHaveLength(3);
      expect(buildProgressRows(deriveBuildProgress(retry), width)[0]?.text).toBe(
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
      const block = buildProgressRows(progress, width)
        .map((row) => row.text)
        .join('\n');
      expect(block).toContain('OpenAI Codex CLI · auto · working');
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

    expect(buildProgressRows(progress, getChromeContentWidth(120))[0]?.text).toContain(
      '1/3 briefs passed',
    );
    expect(buildProgressRows(progress, getChromeContentWidth(120))[0]?.text).toContain(
      '1 escalated',
    );
    expect(buildProgressRows(progress, getChromeContentWidth(120))[0]?.text).toContain('1 failed');
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

  it('names the review seat as the sidebar spells it: tool, model and axis words', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ phase: 'final-review' }),
        operations: operationsState({
          active: runningOperation({
            role: 'review',
            phase: 'final-review',
            runnerName: 'codex',
            model: 'gpt-5',
            axes: ['high'],
          }),
        }),
      }),
    );

    expect(progress.activity).toBe('Review · OpenAI Codex CLI · GPT-5 · high');
  });

  it('states no attempt', () => {
    const progress = deriveBuildProgress(review());
    expect(progress.attempt).toBeNull();
    for (const width of [getChromeContentWidth(120), 80, 60]) {
      const block = buildProgressRows(progress, width)
        .map((row) => row.text)
        .join('\n');
      expect(block).toContain('2/2 briefs passed');
      expect(block).not.toContain('attempt');
    }
  });

  it('paints exactly the rows the chrome budgets for it', () => {
    const progress = deriveBuildProgress(review());
    for (const width of [getChromeContentWidth(120), 80, 60]) {
      expect(buildProgressRows(progress, width)).toHaveLength(buildProgressRowCount(width));
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
      expect(buildProgressRows(progress, width)).toHaveLength(buildProgressRowCount(width));
    }
    expect(progress.attempt).not.toBeNull();
  });
});
