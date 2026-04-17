import { describe, it, expect, beforeEach, vi } from 'vitest';
import { addEvent, markCancelled, resetWorkflow, getSections } from './actions.js';
import { eventsStore } from './events.js';
import { tasksStore } from './tasks.js';
import { tokensStore } from './tokens.js';
import { lifecycleStore } from './lifecycle.js';
import { abortStore } from './abort.js';
import {
  makePlannerStatus,
  makeRetry,
  makeTaskStart,
  makeTaskComplete,
} from '#testing/helpers/events.js';
import { makeTask } from '#testing/helpers/fixtures.js';

describe('addEvent — cross-bucket isolation', () => {
  beforeEach(() => resetWorkflow());

  it('preserves unrelated sub-store fields on generic events', () => {
    lifecycleStore.set(s => ({ ...s, phase: 'implementing' }));
    tokensStore.set(s => ({ ...s, localCount: 3, escalatedCount: 1 }));
    addEvent(makeRetry());
    expect(lifecycleStore.get().phase).toBe('implementing');
    expect(tokensStore.get().localCount).toBe(3);
    expect(tokensStore.get().escalatedCount).toBe(1);
  });
});

describe('markCancelled', () => {
  beforeEach(() => resetWorkflow());

  it('sets cancelled and appends workflow-cancelled event', () => {
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    markCancelled();
    expect(lifecycleStore.get().cancelled).toBe(true);
    const events = eventsStore.get().events;
    expect(events[events.length - 1]?.type).toBe('workflow-cancelled');
  });

  it('replaces running planner-status with done', () => {
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    markCancelled();
    const events = eventsStore.get().events;
    const status = events.find(e => e.type === 'planner-status');
    expect(status && 'status' in status ? status.status : undefined).toBe('done');
  });

  it('is a no-op on double cancel', () => {
    markCancelled();
    const after1 = eventsStore.get().events.length;
    markCancelled();
    expect(eventsStore.get().events.length).toBe(after1);
  });

  it('returns true on first call and false on subsequent calls', () => {
    expect(markCancelled()).toBe(true);
    expect(markCancelled()).toBe(false);
  });
});

describe('addEvent — cancelled gate', () => {
  beforeEach(() => resetWorkflow());

  it('drops error events after cancel', () => {
    markCancelled();
    addEvent({ type: 'error', ts: Date.now(), message: 'noise' });
    expect(eventsStore.get().events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('drops planner-status events after cancel', () => {
    markCancelled();
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    expect(eventsStore.get().events.filter(e => e.type === 'planner-status')).toHaveLength(0);
  });

  it('does not mutate tasks store after cancel', () => {
    markCancelled();
    addEvent(makeTaskStart({ index: 0, total: 1 }));
    expect(tasksStore.get().currentTask).toBe(0);
    expect(tasksStore.get().totalTasks).toBe(0);
  });

  it('does not mutate tokens store after cancel', () => {
    markCancelled();
    addEvent(makeTaskComplete({ method: 'local' }));
    expect(tokensStore.get().localCount).toBe(0);
  });
});

describe('resetWorkflow', () => {
  beforeEach(() => resetWorkflow());

  it('calls abortStore.clear before resetting sub-stores', () => {
    const clearSpy = vi.spyOn(abortStore, 'clear');
    resetWorkflow();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('resets all four sub-stores to initial state', () => {
    addEvent(makeTaskStart({ index: 1, total: 3 }));
    addEvent(makePlannerStatus({ phase: 'implementing', status: 'running' }));
    addEvent(makeTaskComplete({ method: 'local' }));

    resetWorkflow();

    expect(eventsStore.get().events).toEqual([]);
    expect(tasksStore.get().currentTask).toBe(0);
    expect(tasksStore.get().totalTasks).toBe(0);
    expect(tokensStore.get().localCount).toBe(0);
    expect(lifecycleStore.get().phase).toBe('idle');
    expect(lifecycleStore.get().cancelled).toBe(false);
    expect(lifecycleStore.get().queueDepth).toBe(0);
  });

  it('applies resume state to lifecycle and tasks', () => {
    resetWorkflow({
      stateVersion: 1,
      phase: 'implementing',
      feature: 'f',
      currentTaskIndex: 2,
      attempt: 0,
      tasks: [
        makeTask({ id: 'T1', status: 'done' }),
        makeTask({ id: 'T2', status: 'done' }),
        makeTask({ id: 'T3', status: 'pending' }),
      ],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: { plannerInput: 0, plannerOutput: 0, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 },
      awaitingContinue: false,
      messageQueue: [],
    });
    expect(lifecycleStore.get().phase).toBe('implementing');
    expect(tasksStore.get().currentTask).toBe(2);
    expect(tasksStore.get().totalTasks).toBe(3);
  });
});

describe('getSections memoization', () => {
  beforeEach(() => resetWorkflow());

  it('returns the same section array when events reference unchanged', () => {
    addEvent(makeRetry());
    const first = getSections();
    const second = getSections();
    expect(second).toBe(first);
  });

  it('invalidates cached sections when new events arrive', () => {
    addEvent(makeRetry());
    const first = getSections();
    addEvent(makeRetry());
    const second = getSections();
    expect(second).not.toBe(first);
  });
});
