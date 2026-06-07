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

    addEvent({ type: 'message_queued', ts: Date.now(), id: 'm1', phase: 'researching' });
    addEvent({ type: 'message_queued', ts: Date.now(), id: 'm2', phase: 'researching' });
    expect(lifecycleStore.get().queueDepth).toBe(2);

    addEvent({ type: 'queue_drained', ts: Date.now(), count: 2, phase: 'researching' });
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });

  it('decrements queueDepth on queue_cleared by count (clamped at 0)', () => {
    addEvent({ type: 'message_queued', ts: Date.now(), id: 'm1', phase: 'researching' });
    addEvent({ type: 'message_queued', ts: Date.now(), id: 'm2', phase: 'researching' });
    addEvent({ type: 'queue_cleared', ts: Date.now(), count: 1, phase: 'researching' });
    expect(lifecycleStore.get().queueDepth).toBe(1);
    addEvent({ type: 'queue_cleared', ts: Date.now(), count: 5, phase: 'researching' });
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });
});
