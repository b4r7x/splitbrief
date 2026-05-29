import { beforeEach, describe, expect, it } from 'vitest';
import { createTuiSink } from './tui-sink.js';
import { createEventBus } from '../../engine/events/bus.js';
import { eventsStore } from '../../stores/workflow/events.js';
import { tasksStore } from '../../stores/workflow/tasks.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { resetWorkflow, markCancelled } from '../../stores/workflow/actions.js';
import { makePlannerText, makeTaskStart, makeWorkflowCancelled } from '#testing/helpers/events.js';

describe('tuiSink', () => {
  beforeEach(() => resetWorkflow());

  it('forwards events published on the bus into the workflow events store', () => {
    const bus = createEventBus();
    bus.subscribe(createTuiSink());

    const event = makePlannerText({ text: 'hi' });
    bus.publish(event);

    const events = eventsStore.get().events;
    expect(events.at(-1)).toEqual(event);
  });

  it('updates the tasks sub-store when a task_started event is published', () => {
    const bus = createEventBus();
    bus.subscribe(createTuiSink());

    bus.publish(makeTaskStart({ index: 2, total: 5 }));

    expect(tasksStore.get().currentTask).toBe(3);
    expect(tasksStore.get().totalTasks).toBe(5);
  });

  it('reflects workflow_cancelled on the lifecycle store', () => {
    const bus = createEventBus();
    bus.subscribe(createTuiSink());

    bus.publish(makeWorkflowCancelled());

    const last = eventsStore.get().events.at(-1);
    expect(last?.type).toBe('workflow_cancelled');
  });

  it('respects the store cancel gate — no events recorded after markCancelled', () => {
    const bus = createEventBus();
    bus.subscribe(createTuiSink());

    markCancelled();
    const beforeLen = eventsStore.get().events.length;

    bus.publish(makePlannerText({ text: 'post-cancel' }));

    expect(eventsStore.get().events.length).toBe(beforeLen);
    expect(lifecycleStore.get().cancelled).toBe(true);
  });

  it('unsubscribing stops delivery to the store', () => {
    const bus = createEventBus();
    const unsubscribe = bus.subscribe(createTuiSink());

    bus.publish(makePlannerText({ text: 'first' }));
    const afterFirst = eventsStore.get().events.length;

    unsubscribe();
    bus.publish(makePlannerText({ text: 'second' }));

    expect(eventsStore.get().events.length).toBe(afterFirst);
  });
});
