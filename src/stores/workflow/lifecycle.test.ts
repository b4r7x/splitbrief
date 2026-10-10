import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearLifecycleInterrupted,
  lifecycleStore,
  markLifecycleInterrupted,
  markLifecyclePaused,
  markLifecycleWaitEnded,
  markLifecycleWaitStarted,
  runElapsedMs,
  updateStall,
} from './lifecycle.js';
import { addEvent } from './actions/event.js';
import { markWorkflowPaused } from './actions/pause.js';
import { markWorkflowResumed } from './actions/resume.js';
import { markWaitEnded, markWaitStarted } from './actions/wait.js';
import { resetWorkflow } from './actions/reset.js';
import { hydrateFromState } from './actions/hydrate.js';
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
import { makeRetry, makeTaskStart } from '#testing/helpers/events/task.js';
import { taskId } from '../../core/schemas/task.js';
import { makeUsage } from '#testing/helpers/factories/summary.js';

describe('lifecycleStore', () => {
  beforeEach(() => resetWorkflow());

  it('updates phase from non-planner_status phase-bearing events', () => {
    addEvent({ type: 'workflow_started', ts: Date.now(), phase: 'researching', feature: 'test' });
    expect(lifecycleStore.get().phase).toBe('researching');
    addEvent({
      type: 'task_started',
      ts: Date.now(),
      phase: 'implementing',
      taskId: taskId('T001'),
      title: 'Task',
      index: 0,
      total: 1,
      file: 'a.ts',
      action: 'create',
    });
    expect(lifecycleStore.get().phase).toBe('implementing');
  });

  it('updates phase and tracks queueDepth through enqueue/drain/clear', () => {
    addEvent(makePlannerStatus({ phase: 'specifying' }));
    expect(lifecycleStore.get().phase).toBe('specifying');

    addEvent({
      type: 'message_queued',
      ts: Date.now(),
      id: 'm1',
      phase: 'researching',
      preview: 'first',
    });
    addEvent({
      type: 'message_queued',
      ts: Date.now(),
      id: 'm2',
      phase: 'researching',
      preview: 'second',
    });
    expect(lifecycleStore.get().queueDepth).toBe(2);

    addEvent({ type: 'queue_drained', ts: Date.now(), count: 2, phase: 'researching' });
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });

  it('decrements queueDepth on native injection', () => {
    addEvent({
      type: 'message_queued',
      ts: Date.now(),
      id: 'm1',
      phase: 'researching',
      preview: 'inject me',
    });

    addEvent({
      type: 'message_injected_native',
      ts: Date.now(),
      id: 'm1',
      phase: 'researching',
      preview: 'inject me',
    });

    expect(lifecycleStore.get().queueDepth).toBe(0);
  });

  it('uses drained ids to decrement queueDepth', () => {
    addEvent({
      type: 'message_queued',
      ts: Date.now(),
      id: 'm1',
      phase: 'researching',
      preview: 'first',
    });
    addEvent({
      type: 'message_queued',
      ts: Date.now(),
      id: 'm2',
      phase: 'researching',
      preview: 'second',
    });

    addEvent({
      type: 'queue_drained',
      ts: Date.now(),
      count: 1,
      ids: ['m1'],
      phase: 'researching',
    });

    expect(lifecycleStore.get().queueDepth).toBe(1);
  });

  it('decrements queueDepth on queue_cleared by count (clamped at 0)', () => {
    addEvent({
      type: 'message_queued',
      ts: Date.now(),
      id: 'm1',
      phase: 'researching',
      preview: 'first',
    });
    addEvent({
      type: 'message_queued',
      ts: Date.now(),
      id: 'm2',
      phase: 'researching',
      preview: 'second',
    });
    addEvent({ type: 'queue_cleared', ts: Date.now(), count: 1, phase: 'researching' });
    expect(lifecycleStore.get().queueDepth).toBe(1);
    addEvent({ type: 'queue_cleared', ts: Date.now(), count: 5, phase: 'researching' });
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });

  it('records terminal cancellation timing from workflow_cancelled', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    addEvent({
      type: 'workflow_cancelled',
      ts: 1_400,
      phase: 'researching',
      reason: 'user_cancelled',
    });

    expect(lifecycleStore.get()).toMatchObject({
      cancelled: true,
      status: 'cancelled',
      endedAt: 1_400,
      durationMs: 400,
      reason: 'user_cancelled',
    });
  });

  it('records first-seen timestamp per phase', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    addEvent(makePlannerStatus({ phase: 'specifying', ts: 2_000 }));
    addEvent(makePlannerStatus({ phase: 'researching', ts: 3_000 }));

    expect(lifecycleStore.get().phaseFirstSeenTs).toEqual({
      researching: 1_000,
      specifying: 2_000,
    });
  });

  it('keeps map reference stable when phase already seen', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    const seeded = lifecycleStore.get().phaseFirstSeenTs;

    addEvent(makePlannerStatus({ phase: 'specifying', ts: 2_000 }));
    const afterNewPhase = lifecycleStore.get().phaseFirstSeenTs;
    expect(afterNewPhase).not.toBe(seeded);

    addEvent(makePlannerStatus({ phase: 'researching', ts: 3_000 }));
    expect(lifecycleStore.get().phaseFirstSeenTs).toBe(afterNewPhase);

    addEvent({
      type: 'message_queued',
      ts: 3_500,
      id: 'm1',
      phase: 'researching',
      preview: 'queued',
    });
    expect(lifecycleStore.get().queueDepth).toBe(1);
    expect(lifecycleStore.get().phaseFirstSeenTs).toBe(afterNewPhase);
  });

  it('reseeds phaseFirstSeenTs on workflow_started', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    addEvent(makePlannerStatus({ phase: 'specifying', ts: 2_000 }));

    addEvent({ type: 'workflow_started', ts: 5_000, phase: 'researching', feature: 'again' });

    expect(lifecycleStore.get().phaseFirstSeenTs).toEqual({ researching: 5_000 });
  });

  it('records phaseFirstSeenTs for the resumed phase on workflow_resumed', () => {
    resetWorkflow();
    hydrateFromState({
      stateVersion: 1,
      phase: 'specifying',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      startedAt: new Date().toISOString(),
      tokenUsage: makeUsage(),
      awaitingContinue: false,
      messageQueue: [],
    });
    expect(lifecycleStore.get().phaseFirstSeenTs).toEqual({});

    addEvent({ type: 'workflow_resumed', ts: 9_000, phase: 'specifying' });

    expect(lifecycleStore.get().phaseFirstSeenTs).toEqual({ specifying: 9_000 });
  });

  it('carries phaseFirstSeenTs into terminal states', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    addEvent({ type: 'workflow_complete', ts: 2_000, phase: 'complete' });

    expect(lifecycleStore.get().status).toBe('complete');
    expect(lifecycleStore.get().phaseFirstSeenTs).toEqual({
      researching: 1_000,
      complete: 2_000,
    });
  });

  it('records the planner call a running status names and drops it when the call is over', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    expect(lifecycleStore.get().plannerCall).toBeNull();

    addEvent(makePlannerStatus({ phase: 'planning', ts: 2_000, call: 'plan' }));
    expect(lifecycleStore.get().plannerCall).toBe('plan');

    addEvent(makePlannerStatus({ phase: 'planning', ts: 3_000, call: 'tasks' }));
    expect(lifecycleStore.get().plannerCall).toBe('tasks');

    addEvent(makePlannerStatus({ phase: 'reviewing-plan', ts: 4_000 }));
    expect(lifecycleStore.get().plannerCall).toBeNull();

    addEvent(makePlannerStatus({ phase: 'planning', ts: 5_000, call: 'tasks' }));
    addEvent(makePlannerStatus({ phase: 'planning', ts: 6_000, status: 'done', call: 'tasks' }));
    expect(lifecycleStore.get().plannerCall).toBeNull();
  });

  it('forgets the planner call when a run starts over', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'planning', feature: 'test' });
    addEvent(makePlannerStatus({ phase: 'planning', ts: 2_000, call: 'tasks' }));

    addEvent({ type: 'workflow_started', ts: 5_000, phase: 'researching', feature: 'again' });

    expect(lifecycleStore.get().plannerCall).toBeNull();
  });
});

describe('waiting on the user', () => {
  beforeEach(() => resetWorkflow());

  it('books each wait against the phase it happened in and adds waits up', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    const running = lifecycleStore.get();

    const waiting = markLifecycleWaitStarted(running, 2_000);
    expect(waiting.waitingSince).toBe(2_000);
    expect(markLifecycleWaitStarted(waiting, 2_500)).toBe(waiting);

    const answered = markLifecycleWaitEnded(waiting, 5_000);
    expect(answered).toMatchObject({ waitingSince: null, waitedMs: { researching: 3_000 } });
    expect(markLifecycleWaitEnded(answered, 6_000)).toBe(answered);

    const again = markLifecycleWaitEnded(markLifecycleWaitStarted(answered, 7_000), 8_000);
    expect(again.waitedMs).toEqual({ researching: 4_000 });
  });

  it('keeps waits by phase, so a later phase of the same stage still carries them', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    markWaitStarted(2_000);
    markWaitEnded(3_000);
    addEvent(makePlannerStatus({ phase: 'specifying', ts: 4_000 }));
    markWaitStarted(5_000);
    markWaitEnded(5_500);

    expect(lifecycleStore.get().waitedMs).toEqual({ researching: 1_000, specifying: 500 });
  });

  it('only a running lifecycle waits, and a new run starts with no wait', () => {
    const idle = lifecycleStore.get();
    expect(markLifecycleWaitStarted(idle, 2_000)).toBe(idle);

    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    const paused = markLifecyclePaused(lifecycleStore.get(), 1_500);
    expect(markLifecycleWaitStarted(paused, 2_000)).toBe(paused);

    markWaitStarted(2_000);
    markWaitEnded(3_000);
    addEvent({ type: 'workflow_started', ts: 5_000, phase: 'researching', feature: 'again' });
    expect(lifecycleStore.get()).toMatchObject({ waitingSince: null, waitedMs: {} });
  });
});

describe('interrupted lifecycle', () => {
  beforeEach(() => resetWorkflow());

  it('markLifecycleInterrupted moves running to interrupted', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    const running = lifecycleStore.get();

    const interrupted = markLifecycleInterrupted(running);

    expect(interrupted).toMatchObject({
      status: 'interrupted',
      phase: 'implementing',
      cancelled: false,
      startedAt: 1_000,
      endedAt: null,
      durationMs: null,
    });
    expect(markLifecycleInterrupted(interrupted)).toBe(interrupted);
  });

  it('markLifecycleInterrupted is a no-op on idle, complete, and cancelled', () => {
    const idle = lifecycleStore.get();
    expect(markLifecycleInterrupted(idle)).toBe(idle);

    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    addEvent({ type: 'workflow_complete', ts: 2_000, phase: 'complete' });
    const complete = lifecycleStore.get();
    expect(markLifecycleInterrupted(complete)).toBe(complete);

    lifecycleStore.__testReset({ status: 'cancelled', phase: 'implementing' });
    const cancelled = lifecycleStore.get();
    expect(markLifecycleInterrupted(cancelled)).toBe(cancelled);
  });

  it('phase events do not resurrect running from interrupted', () => {
    lifecycleStore.__testReset({ status: 'interrupted', phase: 'implementing', startedAt: 1_000 });

    addEvent(makePlannerStatus({ phase: 'validating-task', ts: 2_000 }));
    expect(lifecycleStore.get().status).toBe('interrupted');
    expect(lifecycleStore.get().phase).toBe('validating-task');

    addEvent(makeTaskStart({ phase: 'escalating', ts: 3_000 }));
    expect(lifecycleStore.get().status).toBe('interrupted');
    expect(lifecycleStore.get().phase).toBe('escalating');
  });

  it('workflow_cancelled and workflow_complete win over interrupted', () => {
    lifecycleStore.__testReset({ status: 'interrupted', phase: 'implementing', startedAt: 1_000 });
    addEvent({ type: 'workflow_complete', ts: 2_000, phase: 'complete' });
    expect(lifecycleStore.get()).toMatchObject({ status: 'complete', endedAt: 2_000 });

    lifecycleStore.__testReset({ status: 'interrupted', phase: 'implementing', startedAt: 1_000 });
    addEvent({
      type: 'workflow_cancelled',
      ts: 3_000,
      phase: 'implementing',
      reason: 'user_cancelled',
    });
    expect(lifecycleStore.get()).toMatchObject({
      status: 'cancelled',
      cancelled: true,
      endedAt: 3_000,
      reason: 'user_cancelled',
    });
  });

  it('turn_interrupted marks a running lifecycle interrupted and parked for attach clients', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });

    addEvent({ type: 'turn_interrupted', ts: 2_000, phase: 'implementing', source: 'user' });

    expect(lifecycleStore.get()).toMatchObject({ status: 'interrupted', interruptParked: true });
    // Terminal states are not resurrected by a straggler turn_interrupted.
    addEvent({ type: 'workflow_complete', ts: 3_000, phase: 'complete' });
    addEvent({ type: 'turn_interrupted', ts: 4_000, phase: 'implementing', source: 'user' });
    expect(lifecycleStore.get().status).toBe('complete');
  });

  it('a new runner call clears an event-set interrupt', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent({ type: 'turn_interrupted', ts: 2_000, phase: 'implementing', source: 'user' });
    expect(lifecycleStore.get()).toMatchObject({ status: 'interrupted', interruptParked: true });

    addEvent(makeRunnerCallStarted({ ts: 3_000 }));

    expect(lifecycleStore.get().status).toBe('running');
    expect(lifecycleStore.get().interruptParked).toBe(false);
    expect(lifecycleStore.get().phase).toBe('implementing');
  });

  it('a new runner call clears a park', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    markWorkflowPaused();
    expect(lifecycleStore.get().status).toBe('paused');

    addEvent(makeRunnerCallStarted({ ts: 3_000 }));

    expect(lifecycleStore.get()).toMatchObject({ status: 'running', phase: 'implementing' });
  });

  it('clearLifecycleInterrupted returns interrupted to running', () => {
    lifecycleStore.__testReset({ status: 'interrupted', phase: 'implementing', startedAt: 1_000 });
    const interrupted = lifecycleStore.get();
    expect(interrupted.status).toBe('interrupted');

    const resumed = clearLifecycleInterrupted(interrupted);

    expect(resumed).toMatchObject({
      status: 'running',
      phase: 'implementing',
      cancelled: false,
      startedAt: 1_000,
      endedAt: null,
    });
    expect(clearLifecycleInterrupted(resumed)).toBe(resumed);
  });
});

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

    // Phase changes clear stall through updatePhase (applyRunningPhase), which
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
      phase: 'implementing',
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
      phase: 'implementing',
      lastRunnerEventTs: 3_000,
      startedAt: 1_000,
      endedAt: null,
      durationMs: null,
    });
    expect(runElapsedMs(lifecycleStore.get(), 4_000)).toBe(3_000);
  });

  it('tracks the last runner event and the attempt start for the build-progress block', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    addEvent(
      makeTaskStart({ taskId: taskId('T001'), title: 'One', index: 0, total: 2, ts: 2_000 }),
    );
    expect(lifecycleStore.get().attemptStartedTs).toBe(2_000);

    addEvent(makePlannerText({ text: 'thinking', ts: 3_000 }));
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(3_000);

    addEvent(makeRetry({ taskId: taskId('T001'), attempt: 1, ts: 4_000 }));
    expect(lifecycleStore.get().attemptStartedTs).toBe(4_000);
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
      scope: 'final',
      status: 'planned',
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
      scope: 'final',
      status: 'planned',
    });
    expect(lifecycleStore.get().lastRunnerEventTs).toBe(5_000);
  });
});

describe('the run clock', () => {
  beforeEach(() => resetWorkflow());

  const MIN = 60_000;
  const HOUR = 60 * MIN;

  function atRestState(): Parameters<typeof hydrateFromState>[0] {
    return {
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      startedAt: new Date(0).toISOString(),
      tokenUsage: makeUsage(),
      awaitingContinue: false,
      messageQueue: [],
    };
  }

  // Ten minutes of work, a stop, a night at rest, five minutes more: the run ran fifteen minutes.
  it('leaves a night the run sat stopped out of its run time', () => {
    addEvent({ type: 'workflow_started', ts: 0, phase: 'implementing', feature: 'f' });
    addEvent({ type: 'workflow_cancelled', ts: 10 * MIN, phase: 'implementing' });
    hydrateFromState(atRestState(), { endedAt: 10 * MIN });
    expect(runElapsedMs(lifecycleStore.get(), 10 * HOUR)).toBe(10 * MIN);

    addEvent({ type: 'workflow_resumed', ts: 10 * HOUR, phase: 'implementing' });
    expect(runElapsedMs(lifecycleStore.get(), 10 * HOUR + 5 * MIN)).toBe(15 * MIN);

    addEvent({ type: 'workflow_complete', ts: 10 * HOUR + 5 * MIN, phase: 'complete' });
    expect(lifecycleStore.get().durationMs).toBe(15 * MIN);
  });

  it('keeps a paused fixture at the run time it names, whatever the clock reads', () => {
    lifecycleStore.__testReset({
      status: 'paused',
      phase: 'implementing',
      startedAt: 0,
      durationMs: 10 * MIN,
    });

    expect(lifecycleStore.get()).toMatchObject({ status: 'paused', durationMs: 10 * MIN });
  });

  it('leaves a live park out of the run time', () => {
    addEvent({ type: 'workflow_started', ts: 0, phase: 'implementing', feature: 'f' });
    markWorkflowPaused(10 * MIN);
    expect(runElapsedMs(lifecycleStore.get(), 10 * HOUR)).toBe(10 * MIN);

    markWorkflowResumed(10 * HOUR);
    expect(runElapsedMs(lifecycleStore.get(), 10 * HOUR + 5 * MIN)).toBe(15 * MIN);
  });

  it('reads a log that ended mid-run back at the run time it had reached', () => {
    addEvent({ type: 'workflow_started', ts: 0, phase: 'implementing', feature: 'f' });
    addEvent({ type: 'workflow_cancelled', ts: 10 * MIN, phase: 'implementing' });
    hydrateFromState(atRestState(), { endedAt: 10 * MIN });
    addEvent({ type: 'workflow_resumed', ts: 10 * HOUR, phase: 'implementing' });
    hydrateFromState(atRestState(), { endedAt: 10 * HOUR + 5 * MIN });

    expect(lifecycleStore.get().durationMs).toBe(15 * MIN);
  });
});
