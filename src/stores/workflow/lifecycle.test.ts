import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearLifecycleInterrupted,
  lifecycleStore,
  markLifecycleInterrupted,
  updateStall,
} from './lifecycle.js';
import { addEvent } from './actions/event.js';
import { markInterruptParked, markInterruptRequested } from './actions/interrupt.js';
import { markInterruptResumed } from './actions/resume.js';
import { resetWorkflow } from './actions/reset.js';
import { makePlannerStatus, makePlannerText } from '#testing/helpers/events/planner.js';
import {
  makeRunnerCallActivity,
  makeRunnerCallCompleted,
  makeRunnerCallError,
  makeRunnerCallStalled,
  makeRunnerCallStallCleared,
  makeRunnerCallStarted,
} from '#testing/helpers/events/runner-call.js';
import { makeTaskStart } from '#testing/helpers/events/task.js';
import { taskId } from '../../core/schemas/task.js';

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
    resetWorkflow({
      stateVersion: 1,
      phase: 'specifying',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [],
      startedAt: new Date().toISOString(),
      tokenUsage: {
        plannerInput: 0,
        plannerOutput: 0,
        implementerInput: 0,
        implementerOutput: 0,
        escalationInput: 0,
        escalationOutput: 0,
      },
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

  it('turn_interrupted parks a host interrupt already requested via Esc-Esc', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    markInterruptRequested();
    expect(lifecycleStore.get()).toMatchObject({ status: 'interrupted', interruptParked: false });

    addEvent({ type: 'turn_interrupted', ts: 2_000, phase: 'implementing', source: 'user' });

    expect(lifecycleStore.get()).toMatchObject({ status: 'interrupted', interruptParked: true });
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

  it('tracks the continuation-prompt park across interrupt, park, and resume', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    markInterruptParked();
    expect(lifecycleStore.get().interruptParked).toBe(false);

    markInterruptRequested();
    expect(lifecycleStore.get()).toMatchObject({ status: 'interrupted', interruptParked: false });

    markInterruptParked();
    expect(lifecycleStore.get()).toMatchObject({ status: 'interrupted', interruptParked: true });

    markInterruptResumed();
    expect(lifecycleStore.get()).toMatchObject({ status: 'running', interruptParked: false });
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
    expect(stalled.stall).toEqual({ since: 2_000, silentMs: 60_000, runnerName: null });

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
});
