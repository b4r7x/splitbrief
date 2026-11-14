import { describe, it, expect, beforeEach } from 'vitest';
import { lifecycleStore } from './state.js';
import {
  clearLifecycleInterrupted,
  markLifecycleInterrupted,
  markLifecyclePaused,
  markLifecycleWaitEnded,
  markLifecycleWaitStarted,
} from './marks.js';
import { runViewStore } from '../run-view.js';
import { addEvent } from '../actions/event.js';
import { markWorkflowPaused } from '../actions/pause.js';
import { markWaitEnded, markWaitStarted } from '../actions/wait.js';
import { resetWorkflow } from '../actions/reset.js';
import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeRunnerCallStarted } from '#testing/helpers/events/runner-call.js';
import { makeTaskStart } from '#testing/helpers/events/task.js';
import { taskId } from '../../../core/schemas/task.js';

describe('waiting on the user', () => {
  beforeEach(() => resetWorkflow());

  it('books each wait against the phase it happened in and adds waits up', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    const running = lifecycleStore.get();

    const waiting = markLifecycleWaitStarted(running, 2_000);
    expect(waiting.waitingSince).toBe(2_000);
    expect(markLifecycleWaitStarted(waiting, 2_500)).toBe(waiting);

    const answered = markLifecycleWaitEnded(waiting, 5_000, 'researching');
    expect(answered).toMatchObject({ waitingSince: null, waitedMs: { researching: 3_000 } });
    expect(markLifecycleWaitEnded(answered, 6_000, 'researching')).toBe(answered);

    const again = markLifecycleWaitEnded(
      markLifecycleWaitStarted(answered, 7_000),
      8_000,
      'researching',
    );
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

    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'cancelled' });
    const cancelled = lifecycleStore.get();
    expect(markLifecycleInterrupted(cancelled)).toBe(cancelled);
  });

  it('reads the validating phase as soon as a brief enters its checks', () => {
    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'running', startedAt: 1_000 });

    addEvent({
      type: 'task_validating',
      ts: 2_000,
      phase: 'validating-task',
      taskId: taskId('T001'),
    });

    expect(lifecycleStore.get().status).toBe('running');
    expect(runViewStore.get().phase).toBe('validating-task');
    expect(runViewStore.get().phaseFirstSeen['validating-task']).toBe(2_000);
  });

  it('phase events do not resurrect running from interrupted', () => {
    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'interrupted', startedAt: 1_000 });

    addEvent(makePlannerStatus({ phase: 'validating-task', ts: 2_000 }));
    expect(lifecycleStore.get().status).toBe('interrupted');
    expect(runViewStore.get().phase).toBe('validating-task');

    addEvent(makeTaskStart({ phase: 'escalating', ts: 3_000 }));
    expect(lifecycleStore.get().status).toBe('interrupted');
    expect(runViewStore.get().phase).toBe('escalating');
  });

  it('workflow_cancelled and workflow_complete win over interrupted', () => {
    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'interrupted', startedAt: 1_000 });
    addEvent({ type: 'workflow_complete', ts: 2_000, phase: 'complete' });
    expect(lifecycleStore.get()).toMatchObject({ status: 'complete', endedAt: 2_000 });

    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'interrupted', startedAt: 1_000 });
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
    expect(runViewStore.get().phase).toBe('implementing');
  });

  it('a new runner call clears a park', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    markWorkflowPaused();
    expect(lifecycleStore.get().status).toBe('paused');

    addEvent(makeRunnerCallStarted({ ts: 3_000 }));

    expect(lifecycleStore.get().status).toBe('running');
    expect(runViewStore.get().phase).toBe('implementing');
  });

  it('clearLifecycleInterrupted returns interrupted to running', () => {
    runViewStore.__testReset({ phase: 'implementing' });
    lifecycleStore.__testReset({ status: 'interrupted', startedAt: 1_000 });
    const interrupted = lifecycleStore.get();
    expect(interrupted.status).toBe('interrupted');

    const resumed = clearLifecycleInterrupted(interrupted);

    expect(resumed).toMatchObject({
      status: 'running',
      cancelled: false,
      startedAt: 1_000,
      endedAt: null,
    });
    expect(clearLifecycleInterrupted(resumed)).toBe(resumed);
  });
});
