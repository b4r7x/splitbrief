import { describe, it, expect } from 'vitest';
import {
  buildProgressRows,
  deriveBuildProgress,
  type DeriveBuildProgressInput,
} from './build-progress.js';
import { getChromeContentWidth } from '../layout/chrome-rows.js';
import { seatWaitSentence } from '../../../core/sessions/seat-wait-line.js';
import { EMPTY_RUN_VIEW, type RunView } from '../../../core/run-view/reduce.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';
import type { OperationsState } from '../../../stores/workflow/operations/state.js';
import { EMPTY_BRIEFS, type RunBriefs } from '../../../core/run-view/briefs.js';

const NOW = 1_000_000;

const BRIEFS: RunBriefs = {
  ...EMPTY_BRIEFS,
  tasks: [
    { id: 'T001', title: 'One', status: 'done' },
    { id: 'T002', title: 'Two', status: 'in_progress' },
  ],
  totalTasks: 2,
  currentTask: 2,
};

function lifecycleState(overrides: { lastRunnerEventTs?: number | null } = {}): LifecycleState {
  return {
    status: 'running',
    interruptParked: false,
    cancelled: false,
    queueDepth: 0,
    queuedMessageIds: new Set(),
    steerableCall: null,
    stall: null,
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

function waitView(resetAt: string, live = true, phase: Phase = 'implementing'): RunView {
  return {
    phase,
    phaseFirstSeen: {},
    seatWait: { tool: 'codex', wait: { seat: 'build', resetAt }, live },
    briefs: BRIEFS,
  };
}

function testInput(overrides: Partial<DeriveBuildProgressInput> = {}): DeriveBuildProgressInput {
  return {
    lifecycle: lifecycleState(),
    operations: operationsState(),
    runView: { ...EMPTY_RUN_VIEW, phase: 'implementing', briefs: BRIEFS },
    now: NOW,
    ...overrides,
  };
}

describe('seat wait in the build block', () => {
  it('shows the wait sentence on every block row during implementing with a seat waiting', () => {
    const resetAt = new Date(NOW + 10 * 60 * 1000).toISOString();
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({ lastRunnerEventTs: null }),
        runView: waitView(resetAt),
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

  it('shows the wait sentence on every block row during final-review with a seat waiting', () => {
    const resetAt = new Date(NOW + 10 * 60 * 1000).toISOString();
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({ lastRunnerEventTs: null }),
        runView: waitView(resetAt, true, 'final-review'),
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

  it('returns Between calls when no seat waits on implementing', () => {
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({ lastRunnerEventTs: null }),
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
        lifecycle: lifecycleState({ lastRunnerEventTs: null }),
        runView: waitView(new Date(NOW - 60 * 1000).toISOString()),
        operations: operationsState({ active: null }),
        now: NOW,
      }),
    );
    expect(progress.activity).toBe('Between calls');
    expect(progress.freshness).toBe('no update yet');
  });

  it('falls back when the reset of the wait is invalid and produces null sentence', () => {
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({ lastRunnerEventTs: null }),
        runView: waitView('invalid'),
        operations: operationsState({ active: null }),
        now: NOW,
      }),
    );
    expect(progress.activity).toBe('Between calls');
    expect(progress.freshness).toBe('no update yet');
  });

  it('shows Between calls when a stop kept the wait and no process waits on it', () => {
    const progress = deriveBuildProgress(
      testInput({
        lifecycle: lifecycleState({ lastRunnerEventTs: null }),
        runView: waitView(new Date(NOW + 10 * 60 * 1000).toISOString(), false),
        operations: operationsState({ active: null }),
        now: NOW,
      }),
    );
    expect(progress.activity).toBe('Between calls');
    expect(progress.freshness).toBe('no update yet');
  });
});
