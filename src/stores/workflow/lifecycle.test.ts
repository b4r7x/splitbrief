import { describe, it, expect, beforeEach } from 'vitest';
import { lifecycleStore } from './lifecycle.js';
import { addEvent, resetWorkflow } from './actions.js';
import { makePlannerStatus } from '#testing/helpers/events.js';
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
