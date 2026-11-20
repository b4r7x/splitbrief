import { describe, it, expect } from 'vitest';
import { deriveBuildProgress, UI_IDLE_WARN_MS, type DeriveBuildProgressInput } from './derive.js';
import { buildProgressRows } from './rows.js';
import { passedCountSpans } from './counts.js';
import { getChromeContentWidth, buildProgressRowCount } from '../../layout/chrome-rows.js';
import { EMPTY_RUN_VIEW, type RunView } from '../../../../core/run-view/reduce.js';
import type { Phase } from '../../../../core/schemas/enums.js';
import { lifecycleStore } from '../../../../stores/workflow/lifecycle/state.js';
import type { LifecycleState } from '../../../../stores/workflow/lifecycle/types.js';
import { runViewStore } from '../../../../stores/workflow/run-view.js';
import type {
  OperationsState,
  RunningOperation,
  TerminalOperation,
} from '../../../../stores/workflow/operations/state.js';
import {
  EMPTY_BRIEFS,
  type RunBriefs,
  type WorkflowTask,
} from '../../../../core/run-view/briefs.js';
import { addEvent } from '../../../../stores/workflow/actions/event.js';
import { resetWorkflow } from '../../../../stores/workflow/actions/reset.js';
import { makeRetry, makeTaskComplete, makeTaskStart } from '#testing/helpers/events/task.js';
import { taskId } from '../../../../core/schemas/task.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { operationsStore } from '../../../../stores/workflow/operations/state.js';

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
  expect(progress.activity).toBe('Review · OpenAI Codex CLI · auto · reviewing changes');
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
    addEvent({ type: 'review_step', ts: NOW - 1_000, phase, step: 'verdict' });
    const progressNow = () =>
      deriveBuildProgress(
        input({
          lifecycle: lifecycleStore.get(),
          runView: runViewStore.get(),
          operations: operationsStore.get(),
        }),
      );
    const reviewer = 'Review · OpenAI Codex CLI · GPT-5 · high';
    expect(progressNow().activity).toBe(`${reviewer} · reviewing changes`);
    expect(progressNow().freshness).toBe('last event 1s ago');
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

it('names the plan render in Review and uses its clock for freshness', () => {
  const progress = deriveBuildProgress(
    input({
      runView: phaseView('final-review'),
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

function tasksState(tasks: WorkflowTask[], overrides: Partial<RunBriefs> = {}): RunBriefs {
  return {
    ...EMPTY_BRIEFS,
    currentTask: 1,
    totalTasks: tasks.length,
    taskMap: new Map(tasks.map((task) => [task.id, task])),
    tasks,
    ...overrides,
  };
}

function lifecycleState(
  overrides: { lastRunnerEventTs?: number | null; stall?: LifecycleState['stall'] } = {},
): LifecycleState {
  const state: LifecycleState = {
    status: 'running',
    interruptParked: false,
    cancelled: false,
    queueDepth: 0,
    queuedMessageIds: new Set(),
    steerableCall: null,
    stall: null,
    retry: null,
    lastRunnerEventTs: NOW,
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

function phaseView(phase: Phase): RunView {
  return { ...EMPTY_RUN_VIEW, phase };
}

// `tasks` stands apart from the run view it seeds, so a test that swaps the view keeps the default briefs.
function input({
  tasks = tasksState([
    { id: 'T001', title: 'One', status: 'done' },
    { id: 'T002', title: 'Two', status: 'in_progress' },
  ]),
  runView = phaseView('implementing'),
  ...overrides
}: Partial<DeriveBuildProgressInput> & { tasks?: RunBriefs } = {}): DeriveBuildProgressInput {
  return {
    lifecycle: lifecycleState(),
    operations: operationsState(),
    now: NOW,
    ...overrides,
    runView: { ...runView, briefs: tasks },
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

    it('names an open command by its description, as its row does', () => {
      const described = {
        activityId: 'call-1:tool:shell-1',
        kind: 'command',
        label: 'tool Shell',
        target: 'grep -c action src && git diff --name-only',
        description: 'Find where Claude tool events are parsed',
        since: NOW - 342_000,
      } as const;
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({ runnerName: 'opencode', openTools: [described] }),
          }),
          lifecycle: silent,
        }),
      );

      expect(progress.freshness).toBe(
        'No output for 5:42 · running Find where Claude tool events are parsed',
      );
    });

    it('names an open subagent by the Agent word, not the Plan word', () => {
      const explore = {
        activityId: 'call-1:task:explore-1',
        kind: 'task',
        label: 'task Explore',
        target: 'Explore',
        since: NOW - 342_000,
      } as const;
      const progress = deriveBuildProgress(
        input({
          operations: operationsState({
            active: runningOperation({ runnerName: 'opencode', openTools: [explore] }),
          }),
          lifecycle: silent,
        }),
      );

      expect(progress.freshness).toBe('No output for 5:42 · agent Explore');
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
          runView: runViewStore.get(),
        }),
      );
      expect(stalled.freshness).toBe('No output for 5:10 · tools report when done');

      addEvent({ type: 'runner_call_stall_cleared', ts: NOW - 1_000, ...call, sequence: 2 });
      const cleared = deriveBuildProgress(
        input({
          operations: operationsState({ active: runningOperation({ runnerName: 'opencode' }) }),
          lifecycle: lifecycleStore.get(),
          runView: runViewStore.get(),
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

  it('states no attempt while the first one runs', () => {
    const progress = deriveBuildProgress(input());

    for (const width of [getChromeContentWidth(120), 80, 60]) {
      expect(
        buildProgressRows(progress, width)
          .map((row) => row.text)
          .join('\n'),
      ).not.toContain('attempt');
    }
  });

  it('states no attempt on the counts line while a split brief, a retry or a consult runs', () => {
    resetWorkflow();
    addEvent({
      type: 'tasks_planned',
      ts: NOW,
      phase: 'implementing',
      total: 5,
      tasks: [
        { id: taskId('T001'), title: 'One', index: 0, file: 'src/one.ts', action: 'modify' },
        { id: taskId('T002'), title: 'Two', index: 1, file: 'src/two.ts', action: 'modify' },
        { id: taskId('T003'), title: 'Three', index: 2, file: 'src/three.ts', action: 'modify' },
        { id: taskId('T004'), title: 'Four', index: 3, file: 'src/four.ts', action: 'modify' },
        { id: taskId('T005'), title: 'Five', index: 4, file: 'src/five.ts', action: 'modify' },
      ],
    });
    addEvent(makeTaskComplete({ taskId: taskId('T001'), title: 'One' }));
    addEvent(
      makeTaskStart({
        taskId: taskId('T004'),
        title: 'Four',
        index: 3,
        total: 5,
        lineageAttempt: 2,
      }),
    );

    const expectBriefCounts = () => {
      for (const width of [getChromeContentWidth(120), 80, 60]) {
        const rows = buildProgressRows(
          deriveBuildProgress(input({ tasks: runViewStore.get().briefs })),
          width,
        );
        expect(rows[0]?.text).toBe('1/5 briefs passed');
      }
    };
    expectBriefCounts();

    addEvent(makeRetry({ taskId: taskId('T004'), attempt: 1, lineageAttempt: 3 }));
    expectBriefCounts();

    addEvent({
      type: 'implementer_generate_running',
      ts: NOW,
      phase: 'implementing',
      taskId: taskId('T004'),
      lineageAttempt: 4,
    });
    expectBriefCounts();
    resetWorkflow();
  });

  it('quotes no estimate of the time left at any width', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState([
          { id: 'T001', title: 'One', status: 'done' },
          { id: 'T002', title: 'Two', status: 'done' },
          { id: 'T003', title: 'Three', status: 'in_progress' },
        ]),
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

  it('ends the counts line with the base re-run that runs beside the build, on its own clock', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState([{ id: 'T001', title: 'One', status: 'in_progress' }]),
        operations: operationsState({
          active: runningOperation(),
          suiteStage: {
            id: 'K1',
            command: 'npm run lint',
            moment: 'plan',
            stageStartedTs: NOW - 3_000,
          },
          baseStage: {
            id: 'V1',
            command: 'npm test',
            moment: 'base',
            stageStartedTs: NOW - 42_000,
          },
        }),
      }),
    );

    for (const width of [getChromeContentWidth(120), 80, 60]) {
      const rows = buildProgressRows(progress, width);
      expect(rows[0]?.text.endsWith('Base re-run V1 0:42')).toBe(true);
      expect(rows[0]?.spans).toContainEqual({ text: 'Base re-run V1', tone: 'text' });
      expect(
        rows
          .slice(1)
          .map((row) => row.text)
          .join(' '),
      ).toContain('Plan check K1');
    }
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
          runView: phaseView('escalating'),
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
    expect(deriveBuildProgress(input({ runView: phaseView('validating-task') })).activity).toBe(
      'Between calls',
    );
    expect(deriveBuildProgress(input({ runView: phaseView('escalating') })).activity).toBe(
      'Waiting for the consult answer',
    );
    expect(deriveBuildProgress(input({ runView: phaseView('final-review') })).activity).toBe(
      'Review · reviewing changes',
    );
  });

  it('says reviewing changes and shows no "no update yet" in final review between calls', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ lastRunnerEventTs: null }),
        runView: phaseView('final-review'),
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

  it('names the recheck of the merged result, not a review, while a REVIEW None run checks it', () => {
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleState({ lastRunnerEventTs: null }),
        runView: { ...phaseView('final-review'), reviewNone: true },
        operations: operationsState({ active: null }),
      }),
    );
    expect(progress.activity).toBe('Checking the merged result');
    expect(progress.activityIdentity).toBeNull();
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
        runView: phaseView('final-review'),
        operations: operationsState({
          active: {
            ...unnamed,
            role: 'review',
            phase: 'final-review',
          },
        }),
      }),
    );
    expect(reviewProg.activity).toBe('Review · reviewing changes');
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
        runView: phaseView('final-review'),
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
        lifecycle: lifecycleState({ lastRunnerEventTs: NOW - 847_000 }),
        runView: phaseView('final-review'),
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
        runView: phaseView('implementing'),
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
      input({
        lifecycle: lifecycleStore.get(),
        runView: runViewStore.get(),
        operations: operationsStore.get(),
      }),
    );
    resetWorkflow();

    expect(progress.activity).toBe('T001 check K2 · node --test test/sleep.test.mjs');
    expect(progress.freshness).toBe('running 0:11');
  });

  it('names the base command a brief check waits on, on the base clock, with no base tail on the counts line', () => {
    const command = 'npm test -- src/parser.test.ts';
    resetWorkflow();
    addEvent({
      type: 'full_suite',
      ts: NOW - 40_000,
      phase: 'implementing',
      status: 'running',
      id: 'V2',
      command,
      moment: 'base',
    });
    addEvent({
      type: 'task_validating',
      ts: NOW - 11_000,
      phase: 'validating-task',
      taskId: taskId('T001'),
      check: { id: 'K2', command },
    });
    addEvent({
      type: 'full_suite',
      ts: NOW - 5_000,
      phase: 'validating-task',
      status: 'running',
      id: 'K2',
      command,
      moment: 'plan',
      waitsOnBase: true,
    });
    const progress = deriveBuildProgress(
      input({
        lifecycle: lifecycleStore.get(),
        runView: runViewStore.get(),
        operations: operationsStore.get(),
      }),
    );
    resetWorkflow();

    expect(progress.activity).toBe(`Base re-run V2 · ${command}`);
    expect(progress.freshness).toBe('running 0:40');
    expect(progress.base).toBeNull();
  });

  // Render of workflow-review-base-rerun at 60 columns: `… legacy.test.ts · running…` lost its clock.
  it('cuts a long command, never the clock that follows it, where they share a row', () => {
    const command = `npm test -- ${[
      'legacy',
      'modern',
      'format',
      'parse',
      'render',
      'store',
      'theme',
    ]
      .map((name) => `src/${name}/${name}.test.ts`)
      .join(' ')}`;
    // The reviewer check V2 waits on the same command at the run base.
    const progress = deriveBuildProgress(
      input({
        runView: phaseView('final-review'),
        operations: operationsState({
          suiteStage: {
            id: 'V2',
            command,
            moment: 'pre-review',
            waitsOnBase: true,
            stageStartedTs: NOW - 5_000,
          },
          baseStage: { id: 'V2', command, moment: 'base', stageStartedTs: NOW - 40_000 },
        }),
      }),
    );
    expect(progress.base).toBeNull();

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

  // A gate command longer than the build: the reviewer check of its id runs in the workspace while
  // the base run goes on, and the byline read `Review · Base re-run V1 · npm test` with the base clock.
  it('leads with a reviewer check that runs beside the base run of its id, and keeps the base clock on the counts line', () => {
    const progress = deriveBuildProgress(
      input({
        runView: phaseView('final-review'),
        operations: operationsState({
          suiteStage: {
            id: 'V1',
            command: 'npm test',
            moment: 'pre-review',
            stageStartedTs: NOW - 5_000,
          },
          baseStage: {
            id: 'V1',
            command: 'npm test',
            moment: 'base',
            stageStartedTs: NOW - 40_000,
          },
        }),
      }),
    );

    expect(progress.activity).toBe('Review · Reviewer check V1 · npm test');
    expect(progress.freshness).toBe('running 0:05');
    expect(progress.base?.map((span) => span.text).join('')).toBe('Base re-run V1 0:40');
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
    ['final-review', { id: 'V6', moment: 'verify', command: 'npm test' }, 'Verify V6'],
  ] as const)('keeps the %s running lead neutral and metadata dim for %s', (phase, suite, lead) => {
    const progress = deriveBuildProgress(
      input({
        runView: phaseView(phase),
        operations: operationsState({ suiteStage: { ...suite, stageStartedTs: NOW - 42_000 } }),
      }),
    );
    for (const width of [160, 80, 60]) {
      const spans = buildProgressRows(progress, width).flatMap((row) => row.spans);
      expect(spans).toContainEqual({ text: lead, tone: 'text' });
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

  it('carries count states and separators as separate tones', () => {
    const progress = deriveBuildProgress(
      input({
        tasks: tasksState([
          { id: 'T001', title: 'One', status: 'done' },
          { id: 'T002', title: 'Two', status: 'escalated' },
          { id: 'T003', title: 'Three', status: 'failed' },
        ]),
      }),
    );
    expect(buildProgressRows(progress, 160)[0]?.spans).toEqual([
      { text: '1/3 briefs passed', tone: 'textDim' },
      { text: ' · 1 ', tone: 'textDim' },
      { text: 'escalated', tone: 'warning' },
      { text: ' · 1 ', tone: 'textDim' },
      { text: 'failed', tone: 'error' },
    ]);
  });

  it.each([
    ['implementer', 'implementer', undefined],
    ['planner', 'planner', 'PLAN'],
    ['escalation', 'planner', 'PLAN'],
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
        runView: phaseView('final-review'),
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
      { text: 'reviewing changes', tone: 'textDim' },
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
      labelSpans: [{ text: 'Plan check C1', tone: 'text' }],
    },
    {
      suite: { id: 'B1', moment: 'base', command: 'npm test' },
      labelSpans: [{ text: 'Base re-run B1', tone: 'text' }],
    },
    {
      suite: { id: 'F1', moment: 'brief', command: 'npm test' },
      labelSpans: [{ text: 'Fix check F1', tone: 'text' }],
    },
    {
      suite: { moment: 'pre-review', command: 'npm test' },
      labelSpans: [{ text: 'Pre-review suite', tone: 'textDim' }],
    },
  ] as const)('colors seat words in the running $suite.moment check', ({ suite, labelSpans }) => {
    const progress = deriveBuildProgress(
      input({
        runView: phaseView('final-review'),
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
        runView: phaseView('final-review'),
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
      { text: 'Render workflow-x', tone: 'text' },
      { text: ' · ', tone: 'textDim' },
      { text: 'running', tone: 'accent' },
      { text: ' 0:12', tone: 'textDim' },
    ]);
  });

  it('keeps Reviewer and its separator tones when the check command is cut', () => {
    const progress = deriveBuildProgress(
      input({
        runView: phaseView('final-review'),
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

  it('3 lines at 80 and at 60 columns', () => {
    for (const width of [80, 60]) {
      const rows = buildProgressRows(deriveBuildProgress(input()), width);
      expect(rows).toHaveLength(3);
      expect(rows[0]?.text).toBe('1/2 briefs passed');
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
      tasks: tasksState([
        { id: 'T001', title: 'One', status: 'done' },
        { id: 'T002', title: 'Two', status: 'done' },
      ]),
      runView: phaseView('final-review'),
      operations: operationsState({
        active: runningOperation({ role: 'review', phase: 'final-review', runnerName: 'codex' }),
        last: completedOperation({ runnerName: 'opencode' }),
      }),
    });
  }

  it('names the review seat as the sidebar spells it: tool, model and axis words', () => {
    const progress = deriveBuildProgress(
      input({
        runView: phaseView('final-review'),
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

    expect(progress.activity).toBe('Review · OpenAI Codex CLI · GPT-5 · high · reviewing changes');
  });

  it('states no attempt', () => {
    const progress = deriveBuildProgress(review());
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
});
