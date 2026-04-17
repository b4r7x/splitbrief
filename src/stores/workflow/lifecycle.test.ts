import { describe, it, expect, beforeEach } from 'vitest';
import { lifecycleStore } from './lifecycle.js';
import { addEvent, resetWorkflow } from './actions.js';
import {
  makePlannerStatus,
} from '#testing/helpers/events.js';

describe('lifecycleStore — phase transitions', () => {
  beforeEach(() => resetWorkflow());

  it('updates phase when planner-status event received', () => {
    addEvent(makePlannerStatus({ phase: 'specifying' }));
    expect(lifecycleStore.get().phase).toBe('specifying');
  });
});

describe('lifecycleStore — queueDepth', () => {
  beforeEach(() => resetWorkflow());

  it('increments queueDepth on message-queued event', () => {
    addEvent({ type: 'message-queued', ts: Date.now(), id: 'm1', phase: 'researching' });
    addEvent({ type: 'message-queued', ts: Date.now(), id: 'm2', phase: 'researching' });
    expect(lifecycleStore.get().queueDepth).toBe(2);
  });

  it('resets queueDepth to 0 on queue-drained', () => {
    addEvent({ type: 'message-queued', ts: Date.now(), id: 'm1', phase: 'researching' });
    addEvent({ type: 'message-queued', ts: Date.now(), id: 'm2', phase: 'researching' });
    addEvent({ type: 'queue-drained', ts: Date.now(), count: 2 });
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });

  it('decrements queueDepth on queue-cleared by count (clamped at 0)', () => {
    addEvent({ type: 'message-queued', ts: Date.now(), id: 'm1', phase: 'researching' });
    addEvent({ type: 'message-queued', ts: Date.now(), id: 'm2', phase: 'researching' });
    addEvent({ type: 'queue-cleared', ts: Date.now(), count: 1 });
    expect(lifecycleStore.get().queueDepth).toBe(1);
    addEvent({ type: 'queue-cleared', ts: Date.now(), count: 5 });
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });
});
