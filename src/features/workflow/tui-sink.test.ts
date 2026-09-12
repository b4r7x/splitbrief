import { beforeEach, describe, expect, it } from 'vitest';
import { addTuiEvent } from './tui-sink.js';
import { createEventBus } from '../../engine/events/bus.js';
import type { EngineEventOf } from '../../engine/events/types.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { resetWorkflow } from '../../stores/workflow/actions/reset.js';
import { markCancellationRequested } from '../../stores/workflow/actions/interrupt.js';
import { makePlannerText } from '#testing/helpers/events/planner.js';
import { makeTaskStart } from '#testing/helpers/events/task.js';
import type { EngineEvent } from '../../engine/events/types.js';

describe('tuiSink', () => {
  beforeEach(() => resetWorkflow());

  it('accumulates multiple engine error events in the events store in order via the bus and TUI sink', () => {
    const bus = createEventBus();
    bus.subscribe(addTuiEvent);

    bus.publish(makeErrorEvent({ message: 'first error', ts: 1 }));
    bus.publish(makeErrorEvent({ message: 'second error', ts: 2 }));
    bus.publish(makeErrorEvent({ message: 'third error', ts: 3 }));

    const errors = eventsStore
      .get()
      .events.filter(
        (event): event is Extract<EngineEvent, { type: 'error' }> => event.type === 'error',
      );
    expect(errors).toHaveLength(3);
    expect(errors[0]?.message).toBe('first error');
    expect(errors[1]?.message).toBe('second error');
    expect(errors[2]?.message).toBe('third error');
  });

  it('updates the tasks sub-store when a task_started event is published', () => {
    const bus = createEventBus();
    bus.subscribe(addTuiEvent);

    bus.publish(makeTaskStart({ index: 2, total: 5 }));

    expect(tasksStore.get().currentTask).toBe(3);
    expect(tasksStore.get().totalTasks).toBe(5);
  });

  it('respects the store cancel gate after local cancellation intent', () => {
    const bus = createEventBus();
    bus.subscribe(addTuiEvent);

    markCancellationRequested();
    const beforeLen = eventsStore.get().events.length;

    bus.publish(makePlannerText({ text: 'post-cancel' }));

    expect(eventsStore.get().events.length).toBe(beforeLen);
    expect(lifecycleStore.get().cancelled).toBe(true);
  });
});

function makeErrorEvent(overrides?: Partial<EngineEventOf<'error'>>): EngineEventOf<'error'> {
  return {
    type: 'error',
    ts: Date.now(),
    phase: 'implementing',
    message: 'Something went wrong',
    ...overrides,
  };
}
