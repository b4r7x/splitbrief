import { describe, it, expect, beforeEach } from 'vitest';
import { lifecycleStore } from './state.js';
import { updateStall } from './phase.js';
import { runViewStore } from '../run-view.js';
import { addEvent } from '../actions/event.js';
import { markWorkflowPaused } from '../actions/pause.js';
import { resetWorkflow } from '../actions/reset.js';
import { hydrateFromState } from '../actions/hydrate.js';
import { loadEvents } from '../actions/load.js';
import { makePlannerStatus, makePlannerText } from '#testing/helpers/events/planner.js';
import {
  makeRunnerCallActivity,
  makeRunnerCallCompleted,
  makeRunnerCallError,
  makeRunnerCallHeartbeat,
  makeRunnerCallStalled,
  makeRunnerCallStallCleared,
  makeRunnerCallStarted,
} from '#testing/helpers/events/runner-call.js';
import {
  makeRetry,
  makeTaskComplete,
  makeTaskSkipped,
  makeTaskStart,
} from '#testing/helpers/events/task.js';
import { taskId } from '../../../core/schemas/task.js';
import { makeTask } from '#testing/helpers/factories/task.js';
import { makeWorkflowState } from '#testing/helpers/factories/workflow-state.js';

describe('runner call stall', () => {
  beforeEach(() => resetWorkflow());

  it('runner_call_stalled sets stall and runner_call_stall_cleared clears it', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    const running = lifecycleStore.get();

    const stalled = updateStall(running, makeRunnerCallStalled());
    expect(stalled.stall).toEqual({
      since: 2_000,
      silentMs: 60_000,
      runnerName: null,
      backendKind: 'cli',
    });

    const cleared = updateStall(stalled, makeRunnerCallStallCleared());
    expect(cleared.stall).toBeNull();
  });

  it('carries the silent runner so the byline can name why the output stopped', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    const stalled = updateStall(
      lifecycleStore.get(),
      makeRunnerCallStalled({ runnerName: 'opencode' }),
    );

    expect(stalled.stall?.runnerName).toBe('opencode');
  });

  it('carries the backend kind so an API call is not read as the CLI of the same name', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    const stalled = updateStall(
      lifecycleStore.get(),
      makeRunnerCallStalled({ runnerName: 'opencode', backendKind: 'api' }),
    );

    expect(stalled.stall).toMatchObject({ runnerName: 'opencode', backendKind: 'api' });
  });

  it('call activity, completion, error, planner text, and phase changes clear stall', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    const running = lifecycleStore.get();
    const stalled = updateStall(running, makeRunnerCallStalled());
    expect(stalled.stall).not.toBeNull();

    expect(updateStall(stalled, makeRunnerCallActivity()).stall).toBeNull();
    expect(updateStall(stalled, makeRunnerCallCompleted()).stall).toBeNull();
    expect(updateStall(stalled, makeRunnerCallError()).stall).toBeNull();
    expect(updateStall(stalled, makePlannerText({ text: 'thinking' })).stall).toBeNull();

    // Phase changes clear stall through updatePhase (applyPhaseChange), which
    // runs before updateStall in the addEvent reducer chain.
    addEvent(makeRunnerCallStalled());
    expect(lifecycleStore.get().stall).not.toBeNull();
    addEvent(makePlannerStatus({ phase: 'validating-task' }));
    expect(lifecycleStore.get().stall).toBeNull();
  });

  it('counts a heartbeat as a sign of life and a status change as none', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent(makeRunnerCallStarted({ ts: 2_000 }));
    addEvent(makeRunnerCallHeartbeat({ ts: 50_000 }));
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(50_000);

    addEvent(makePlannerStatus({ phase: 'implementing', status: 'running', ts: 90_000 }));
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(50_000);
  });

  it('uses review start and completion for freshness without changing planner or run clocks', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'review_started',
      ts: 2_000,
      phase: 'implementing',
      scope: 'task',
      tool: 'codex',
    });
    expect(lifecycleStore.get()).toMatchObject({
      status: 'running',
      lastRunnerEventTs: 2_000,
      plannerCall: null,
      plannerCallStartedTs: null,
      startedAt: 1_000,
      endedAt: null,
      durationMs: null,
    });
    addEvent({
      type: 'review_completed',
      ts: 3_000,
      phase: 'implementing',
      scope: 'task',
      tool: 'codex',
      verdict: 'pass',
      duration: 1_000,
    });
    expect(lifecycleStore.get()).toMatchObject({
      status: 'running',
      lastRunnerEventTs: 3_000,
      startedAt: 1_000,
      endedAt: null,
      durationMs: null,
    });
  });

  it('tracks the last runner event for the build-progress block', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent(
      makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 2, ts: 2_000 }),
    );
    expect(lifecycleStore.get().lastRunnerEventTs).toBeNull();

    addEvent(makePlannerText({ text: 'thinking', ts: 3_000 }));
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(3_000);

    addEvent(makeRetry({ taskId: taskId('T001'), attempt: 1, ts: 4_000 }));
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(3_000);
  });

  it('updates lastRunnerEventTs on check, suite, validate, and review_checks events', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    expect(lifecycleStore.get().lastRunnerEventTs).toBeNull();

    addEvent({
      type: 'full_suite',
      ts: 2_000,
      phase: 'final-review',
      status: 'running',
      command: 'npm test',
      moment: 'pre-review',
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(2_000);

    addEvent({
      type: 'checks_run',
      ts: 3_000,
      phase: 'implementing',
      taskId: taskId('T001'),
      results: [],
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(3_000);

    addEvent({
      type: 'validate',
      ts: 4_000,
      phase: 'implementing',
      taskId: taskId('T001'),
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(4_000);

    addEvent({
      type: 'review_checks',
      ts: 5_000,
      phase: 'final-review',
      status: 'none',
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(5_000);

    addEvent({
      type: 'full_suite',
      ts: 6_000,
      phase: 'final-review',
      status: 'done',
      command: 'npm test',
      moment: 'base',
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(6_000);

    addEvent({
      type: 'full_suite',
      ts: 7_000,
      phase: 'implementing',
      status: 'running',
      command: 'npm test',
      moment: 'brief',
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(7_000);
  });

  it('moves lastRunnerEventTs from null for each check and suite event type', () => {
    resetWorkflow();
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'full_suite',
      ts: 2_000,
      phase: 'final-review',
      status: 'running',
      command: 'npm test',
      moment: 'pre-review',
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(2_000);

    resetWorkflow();
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'checks_run',
      ts: 3_000,
      phase: 'implementing',
      taskId: taskId('T001'),
      results: [],
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(3_000);

    resetWorkflow();
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'validate',
      ts: 4_000,
      phase: 'implementing',
      taskId: taskId('T001'),
      status: 'done',
      passed: true,
      stages: { typecheck: true, lint: true, test: true },
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(4_000);

    resetWorkflow();
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'review_checks',
      ts: 5_000,
      phase: 'final-review',
      status: 'none',
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(5_000);
  });
});

describe('seat retry', () => {
  beforeEach(() => resetWorkflow());

  it('holds the retry after seat_retry', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    expect(lifecycleStore.get().retry).toBeNull();

    addEvent({
      type: 'seat_retry',
      ts: 2_000,
      phase: 'implementing',
      seat: 'build',
      attempt: 1,
      delayMs: 1_000,
    });

    expect(lifecycleStore.get().retry).toEqual({ attempt: 1, delayMs: 1_000 });
  });

  it('clears the retry when the next call starts', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'seat_retry',
      ts: 2_000,
      phase: 'implementing',
      seat: 'build',
      attempt: 1,
      delayMs: 1_000,
    });

    addEvent(makeRunnerCallStarted({ ts: 3_000 }));

    expect(runViewStore.get().phase).toBe('implementing');
    expect(lifecycleStore.get().retry).toBeNull();
  });

  it('clears the retry on a phase change', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'seat_retry',
      ts: 2_000,
      phase: 'implementing',
      seat: 'build',
      attempt: 2,
      delayMs: 4_000,
    });

    addEvent(makePlannerStatus({ phase: 'validating-task', ts: 3_000 }));

    expect(runViewStore.get().phase).toBe('validating-task');
    expect(lifecycleStore.get().retry).toBeNull();
  });

  it('clears the retry when the run is interrupted', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'seat_retry',
      ts: 2_000,
      phase: 'implementing',
      seat: 'build',
      attempt: 1,
      delayMs: 1_000,
    });

    addEvent({ type: 'turn_interrupted', ts: 3_000, phase: 'implementing', source: 'user' });

    expect(lifecycleStore.get()).toMatchObject({ status: 'interrupted', retry: null });
  });

  it('clears the retry when the run is paused', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'seat_retry',
      ts: 2_000,
      phase: 'implementing',
      seat: 'build',
      attempt: 1,
      delayMs: 1_000,
    });

    markWorkflowPaused();

    expect(lifecycleStore.get()).toMatchObject({ status: 'paused', retry: null });
  });

  it('clears the retry when the run completes', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'seat_retry',
      ts: 2_000,
      phase: 'implementing',
      seat: 'build',
      attempt: 1,
      delayMs: 1_000,
    });

    addEvent({ type: 'workflow_complete', ts: 3_000, phase: 'complete' });

    expect(lifecycleStore.get()).toMatchObject({ status: 'complete', retry: null });
  });

  it('clears the retry when the run is cancelled', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'seat_retry',
      ts: 2_000,
      phase: 'implementing',
      seat: 'build',
      attempt: 1,
      delayMs: 1_000,
    });

    addEvent({
      type: 'workflow_cancelled',
      ts: 3_000,
      phase: 'implementing',
      reason: 'user_cancelled',
    });

    expect(lifecycleStore.get()).toMatchObject({ status: 'cancelled', retry: null });
  });

  it('clears the retry on reset', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'seat_retry',
      ts: 2_000,
      phase: 'implementing',
      seat: 'build',
      attempt: 1,
      delayMs: 1_000,
    });
    expect(lifecycleStore.get().retry).not.toBeNull();

    resetWorkflow();

    expect(lifecycleStore.get().retry).toBeNull();
  });

  it('clears the retry when the saved state is laid over the log', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({
      type: 'seat_retry',
      ts: 2_000,
      phase: 'implementing',
      seat: 'build',
      attempt: 1,
      delayMs: 1_000,
    });

    hydrateFromState(makeWorkflowState({ phase: 'implementing' }), false);

    expect(lifecycleStore.get()).toMatchObject({ status: 'paused', restored: true, retry: null });
  });
});

describe('brief clock', () => {
  beforeEach(() => resetWorkflow());

  it('starts a fresh clock when another brief starts', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent(
      makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 2, ts: 2_000 }),
    );
    addEvent(
      makeTaskStart({ taskId: taskId('T002'), title: 'Two', index: 1, total: 2, ts: 5_000 }),
    );

    expect(lifecycleStore.get().briefClock).toEqual({
      taskId: 'T002',
      workedMs: 0,
      stretch: { start: 5_000, latest: 5_000 },
      cut: false,
    });
  });

  it('keeps the accumulated time when the same brief starts again', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent(
      makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 1, ts: 2_000 }),
    );
    addEvent(makeRetry({ taskId: taskId('T001'), attempt: 1, ts: 4_000 }));
    addEvent(
      makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 1, ts: 6_000 }),
    );

    expect(lifecycleStore.get().briefClock).toEqual({
      taskId: 'T001',
      workedMs: 2_000,
      stretch: { start: 6_000, latest: 6_000 },
      cut: false,
    });
  });

  it('clears the clock when a new run starts', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent(
      makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 1, ts: 2_000 }),
    );
    addEvent({ type: 'workflow_started', ts: 5_000, phase: 'implementing', feature: 'again' });

    expect(lifecycleStore.get().briefClock).toBeNull();
  });

  it.each(['task_completed', 'task_skipped', 'task_full_fail'] as const)(
    'clears the clock when %s ends the brief',
    (type) => {
      addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
      addEvent(
        makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 1, ts: 2_000 }),
      );
      addEvent(
        type === 'task_completed'
          ? makeTaskComplete({ ts: 3_000 })
          : type === 'task_skipped'
            ? makeTaskSkipped({ ts: 3_000 })
            : {
                type: 'task_full_fail',
                ts: 3_000,
                phase: 'implementing',
                taskId: taskId('T001'),
              },
      );

      expect(lifecycleStore.get().briefClock).toBeNull();
    },
  );

  it('leaves the clock alone for the replay markers', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent(
      makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 1, ts: 2_000 }),
    );
    const clock = lifecycleStore.get().briefClock;

    addEvent({ type: 'replay_started', ts: 350_000, phase: 'implementing', totalEvents: 3 });
    addEvent({
      type: 'replay_complete',
      ts: 352_000,
      phase: 'implementing',
      totalEvents: 3,
      durationMs: 2_000,
    });

    expect(lifecycleStore.get().briefClock).toBe(clock);
  });

  it('rebuilds the brief clock from a replayed log', () => {
    loadEvents([
      { type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' },
      makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 2, ts: 2_000 }),
      makeTaskComplete({ ts: 5_000 }),
      makeTaskStart({ taskId: taskId('T002'), title: 'Two', index: 1, total: 2, ts: 6_000 }),
    ]);

    expect(lifecycleStore.get().briefClock).toEqual({
      taskId: 'T002',
      workedMs: 0,
      stretch: { start: 6_000, latest: 6_000 },
      cut: false,
    });
  });

  it('keeps the brief clock across a workflow_resumed and a state hydrate', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent(
      makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 1, ts: 2_000 }),
    );
    addEvent(makePlannerText({ text: 'working', ts: 3_000 }));
    addEvent({
      type: 'turn_interrupted',
      ts: 4_000,
      phase: 'implementing',
      source: 'user',
      at: 'mid-step',
      step: { kind: 'brief', taskId: taskId('T001'), attempt: 0 },
    });

    expect(lifecycleStore.get().briefClock).toEqual({
      taskId: 'T001',
      workedMs: 2_000,
      stretch: null,
      cut: true,
    });

    addEvent({ type: 'workflow_resumed', ts: 9_000, phase: 'implementing' });

    expect(lifecycleStore.get().briefClock).toEqual({
      taskId: 'T001',
      workedMs: 2_000,
      stretch: null,
      cut: false,
    });

    hydrateFromState(
      makeWorkflowState({ phase: 'implementing', tasks: [makeTask({ id: 'T001' })] }),
      false,
    );

    expect(lifecycleStore.get().briefClock).toEqual({
      taskId: 'T001',
      workedMs: 2_000,
      stretch: null,
      cut: false,
    });
  });
});
