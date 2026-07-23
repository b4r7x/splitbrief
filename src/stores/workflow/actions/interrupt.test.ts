import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent } from './event.js';
import { markCancellationRequested, markInterruptRequested } from './interrupt.js';
import { markInterruptResumed } from './resume.js';
import { resetWorkflow } from './reset.js';
import { eventsStore, MAX_EVENTS } from '../events.js';
import { lifecycleStore } from '../lifecycle.js';
import { taskId } from '../../../core/schemas/task.js';
import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeRetry } from '#testing/helpers/events/task.js';

describe('markCancellationRequested', () => {
  beforeEach(() => resetWorkflow());

  it('sets local cancelled state without appending a fake workflow_cancelled event', () => {
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    markCancellationRequested({ ts: 2_000 });
    expect(lifecycleStore.get().cancelled).toBe(true);
    const events = eventsStore.get().events;
    expect(events).toHaveLength(1);
    const status = events.find((e) => e.type === 'planner_status');
    expect(status && 'status' in status ? status.status : undefined).toBe('running');
  });

  it('is a no-op on double cancel', () => {
    markCancellationRequested();
    const after1 = eventsStore.get().events.length;
    markCancellationRequested();
    expect(eventsStore.get().events.length).toBe(after1);
  });

  it('returns true on first call and false on subsequent calls', () => {
    expect(markCancellationRequested()).toBe(true);
    expect(markCancellationRequested()).toBe(false);
  });

  it('accepts the canonical workflow_cancelled event through the bounded event stream', () => {
    for (let i = 0; i < MAX_EVENTS; i += 1) {
      addEvent(makeRetry({ taskId: taskId(`T${String((i % 999) + 1).padStart(3, '0')}`) }));
    }

    markCancellationRequested();
    addEvent({ type: 'workflow_cancelled', ts: Date.now(), phase: 'implementing' });

    const events = eventsStore.get().events;
    expect(events).toHaveLength(MAX_EVENTS);
    expect((events[0] as { taskId: string }).taskId).toBe('T002');
    expect(events[events.length - 1]?.type).toBe('workflow_cancelled');
  });
});

describe('markInterruptRequested / markInterruptResumed', () => {
  beforeEach(() => resetWorkflow());

  it('markInterruptRequested flips a running lifecycle to interrupted and returns true', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });

    expect(markInterruptRequested()).toBe(true);

    expect(lifecycleStore.get()).toMatchObject({
      status: 'interrupted',
      phase: 'implementing',
      cancelled: false,
    });
  });

  it('markInterruptRequested returns false when no workflow is running', () => {
    expect(markInterruptRequested()).toBe(false);
    expect(lifecycleStore.get().status).toBe('idle');

    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    markInterruptRequested();
    expect(markInterruptRequested()).toBe(false);
    expect(lifecycleStore.get().status).toBe('interrupted');

    resetWorkflow();
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'researching', feature: 'test' });
    addEvent({ type: 'workflow_complete', ts: 2_000, phase: 'complete' });
    expect(markInterruptRequested()).toBe(false);
    expect(lifecycleStore.get().status).toBe('complete');
  });

  it('markInterruptResumed restores running', () => {
    addEvent({ type: 'workflow_started', ts: 1_000, phase: 'implementing', feature: 'test' });
    markInterruptRequested();
    expect(lifecycleStore.get().status).toBe('interrupted');

    markInterruptResumed();

    expect(lifecycleStore.get()).toMatchObject({
      status: 'running',
      phase: 'implementing',
      startedAt: 1_000,
    });
  });
});
