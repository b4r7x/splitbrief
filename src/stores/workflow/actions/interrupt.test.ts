import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent } from './event.js';
import { markCancellationRequested } from './interrupt.js';
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

  it('leaves lifecycle state untouched on double cancel', () => {
    markCancellationRequested();
    const before = lifecycleStore.get();
    markCancellationRequested();
    expect(lifecycleStore.get()).toBe(before);
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
