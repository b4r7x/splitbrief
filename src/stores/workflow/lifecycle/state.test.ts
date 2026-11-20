import { describe, it, expect, beforeEach } from 'vitest';
import { lifecycleStore } from './state.js';
import { runViewStore } from '../run-view.js';
import { addEvent } from '../actions/event.js';
import { resetWorkflow } from '../actions/reset.js';
import { hydrateFromState } from '../actions/hydrate.js';
import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import { taskId } from '../../../core/schemas/task.js';

describe('lifecycleStore', () => {
  beforeEach(() => resetWorkflow());

  it('updates phase from non-planner_status phase-bearing events', () => {
    addEvent({ type: 'workflow_started', ts: Date.now(), phase: 'researching', feature: 'test' });
    expect(runViewStore.get().phase).toBe('researching');
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
    expect(runViewStore.get().phase).toBe('implementing');
  });

  it('updates phase and tracks queueDepth through enqueue/drain/clear', () => {
    addEvent(makePlannerStatus({ phase: 'specifying' }));
    expect(runViewStore.get().phase).toBe('specifying');

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

    expect(runViewStore.get().phaseFirstSeen).toEqual({
      researching: 1_000,
      specifying: 2_000,
    });
  });

  it('keeps map reference stable when phase already seen', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    const seeded = runViewStore.get().phaseFirstSeen;

    addEvent(makePlannerStatus({ phase: 'specifying', ts: 2_000 }));
    const afterNewPhase = runViewStore.get().phaseFirstSeen;
    expect(afterNewPhase).not.toBe(seeded);

    addEvent(makePlannerStatus({ phase: 'researching', ts: 3_000 }));
    expect(runViewStore.get().phaseFirstSeen).toBe(afterNewPhase);

    addEvent({
      type: 'message_queued',
      ts: 3_500,
      id: 'm1',
      phase: 'researching',
      preview: 'queued',
    });
    expect(lifecycleStore.get().queueDepth).toBe(1);
    expect(runViewStore.get().phaseFirstSeen).toBe(afterNewPhase);
  });

  it('reseeds phaseFirstSeen on workflow_started', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    addEvent(makePlannerStatus({ phase: 'specifying', ts: 2_000 }));

    addEvent({ type: 'workflow_started', ts: 5_000, phase: 'researching', feature: 'again' });

    expect(runViewStore.get().phaseFirstSeen).toEqual({ researching: 5_000 });
  });

  it('records phaseFirstSeen for the resumed phase on workflow_resumed', () => {
    resetWorkflow();
    hydrateFromState(
      {
        stateVersion: 1,
        phase: 'specifying',
        feature: 'f',
        currentTaskIndex: 0,
        attempt: 0,
        tasks: [],
        startedAt: new Date().toISOString(),

        awaitingContinue: false,
        messageQueue: [],
      },
      false,
    );
    expect(runViewStore.get().phaseFirstSeen).toEqual({});

    addEvent({ type: 'workflow_resumed', ts: 9_000, phase: 'specifying' });

    expect(runViewStore.get().phaseFirstSeen).toEqual({ specifying: 9_000 });
  });

  // A run that passed its review resumes into Apply in `complete`: it runs, and it stays past review.
  it('keeps complete on a run that resumes into its Apply step', () => {
    addEvent({ type: 'workflow_complete', ts: 1_000, phase: 'complete', review: 'passed' });

    addEvent({ type: 'workflow_resumed', ts: 2_000, phase: 'complete', inProcess: true });

    expect(lifecycleStore.get().status).toBe('running');
    expect(runViewStore.get().phase).toBe('complete');
  });

  it('carries phaseFirstSeen into terminal states', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    addEvent({ type: 'workflow_complete', ts: 2_000, phase: 'complete' });

    expect(lifecycleStore.get().status).toBe('complete');
    expect(runViewStore.get().phaseFirstSeen).toEqual({
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
