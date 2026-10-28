import { describe, it, expect } from 'vitest';
import {
  buildProgressRows,
  deriveBuildProgress,
  type DeriveBuildProgressInput,
} from './build-progress.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { seatWaitSentence } from '../../../core/sessions/seat-wait-line.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type { OperationsState } from '../../../stores/workflow/operations/state.js';
import type { TasksState, WorkflowTask } from '../../../stores/workflow/tasks.js';

const NOW = 1_000_000;

function tasksState(
  tasks: WorkflowTask[] = [
    { id: 'T001', title: 'One', status: 'done' },
    { id: 'T002', title: 'Two', status: 'in_progress' },
  ],
  overrides: Partial<TasksState> = {},
): TasksState {
  return {
    tasks,
    totalTasks: tasks.length,
    currentTask: tasks.length,
    currentAttempt: 1,
    taskMap: new Map(tasks.map((task) => [task.id, task])),
    ...overrides,
  };
}

function lifecycleState(
  overrides: {
    phase?: LifecycleState['phase'];
    seatWait?: LifecycleState['seatWait'];
    lastRunnerEventTs?: number | null;
  } = {},
): LifecycleState {
  return {
    phase: overrides.phase ?? 'implementing',
    status: 'running',
    interruptParked: false,
    cancelled: false,
    queueDepth: 0,
    queuedMessageIds: new Set(),
    steerableCall: null,
    phaseFirstSeenTs: {},
    stall: null,
    seatWait: overrides.seatWait ?? null,
    lastRunnerEventTs: overrides.lastRunnerEventTs ?? null,
    attemptStartedTs: null,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    reason: null,
  };
}

function operationsState(overrides: Partial<OperationsState> = {}): OperationsState {
  return { active: null, last: null, byCallId: new Map(), validationStage: null, ...overrides };
}

function testInput(overrides: Partial<DeriveBuildProgressInput> = {}): DeriveBuildProgressInput {
  return {
    tasks: tasksState(),
    lifecycle: lifecycleState(),
    operations: operationsState(),
    now: NOW,
    ...overrides,
  };
}

describe('seat wait in the build block', () => {
  it('shows the wait sentence on every block row during implementing with seatWait set', () => {
    const resetAt = new Date(NOW + 10 * 60 * 1000).toISOString();
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({
          phase: 'implementing',
          seatWait: { tool: 'codex', resetAt },
          lastRunnerEventTs: null,
        }),
        operations: operationsState({ active: null }),
        now: NOW,
      }),
    );
    const expectedSentence = seatWaitSentence('codex', resetAt, NOW)!;
    expect(buildProgressRows(progress, getChromeContentWidth(120))[1]?.text).toBe(expectedSentence);
    // Below 120 columns the block keeps three rows, so the reset takes the third.
    expect(
      buildProgressRows(progress, getChromeContentWidth(80))
        .slice(1)
        .map((row) => row.text),
    ).toEqual(expectedSentence.split(' · '));

    for (const width of [getChromeContentWidth(120), getChromeContentWidth(80), 60]) {
      const text = buildProgressRows(progress, width)
        .map((row) => row.text)
        .join('\n');
      expect(text).not.toContain('Between calls');
      expect(text).not.toContain('no update yet');
    }
  });

  it('shows the wait sentence on every block row during final-review with seatWait set', () => {
    const resetAt = new Date(NOW + 10 * 60 * 1000).toISOString();
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({
          phase: 'final-review',
          seatWait: { tool: 'codex', resetAt },
          lastRunnerEventTs: null,
        }),
        operations: operationsState({ active: null }),
        now: NOW,
      }),
    );
    const expectedSentence = seatWaitSentence('codex', resetAt, NOW)!;
    expect(buildProgressRows(progress, getChromeContentWidth(120))[1]?.text).toBe(expectedSentence);
    // Below 120 columns the block keeps three rows, so the reset takes the third.
    expect(
      buildProgressRows(progress, getChromeContentWidth(80))
        .slice(1)
        .map((row) => row.text),
    ).toEqual(expectedSentence.split(' · '));

    for (const width of [getChromeContentWidth(120), getChromeContentWidth(80), 60]) {
      const text = buildProgressRows(progress, width)
        .map((row) => row.text)
        .join('\n');
      expect(text).not.toContain('Between calls');
      expect(text).not.toContain('no update yet');
    }
  });

  it('returns Between calls when seatWait is null on implementing', () => {
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({
          phase: 'implementing',
          seatWait: null,
          lastRunnerEventTs: null,
        }),
        operations: operationsState({ active: null }),
        now: NOW,
      }),
    );
    expect(progress.activity).toBe('Between calls');
    expect(progress.freshness).toBe('no update yet');

    const text = buildProgressRows(progress, getChromeContentWidth(80))
      .map((row) => row.text)
      .join('\n');
    expect(text).toContain('Between calls');
    expect(text).toContain('no update yet');
  });

  it('shows Between calls when the wait deadline has passed', () => {
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({
          phase: 'implementing',
          seatWait: { tool: 'codex', resetAt: new Date(NOW - 60 * 1000).toISOString() },
          lastRunnerEventTs: null,
        }),
        operations: operationsState({ active: null }),
        now: NOW,
      }),
    );
    expect(progress.activity).toBe('Between calls');
    expect(progress.freshness).toBe('no update yet');
  });

  it('falls back when seatWait resetAt is invalid and produces null sentence', () => {
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({
          phase: 'implementing',
          seatWait: { tool: 'codex', resetAt: 'invalid' },
          lastRunnerEventTs: null,
        }),
        operations: operationsState({ active: null }),
        now: NOW,
      }),
    );
    expect(progress.activity).toBe('Between calls');
    expect(progress.freshness).toBe('no update yet');
  });
});
