import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent, markCancelled, resetWorkflow, getSections } from './actions.js';
import { eventsStore, MAX_EVENTS } from './events.js';
import { tasksStore } from './tasks.js';
import { tokensStore } from './tokens.js';
import { lifecycleStore } from './lifecycle.js';
import { abortStore } from './abort.js';
import { taskId } from '../../core/schemas/task.js';
import {
  makePlannerStatus,
  makeRetry,
  makeTaskStart,
  makeTaskComplete,
  makeCostUpdate,
} from '#testing/helpers/events.js';
import { makeTask } from '#testing/helpers/factories/task.js';

describe('addEvent — cross-bucket isolation', () => {
  beforeEach(() => resetWorkflow());

  it('preserves unrelated sub-store fields on generic events', () => {
    lifecycleStore.__testReset({ phase: 'implementing' });
    tokensStore.__testReset({ localCount: 3, escalatedCount: 1 });
    addEvent(makeRetry());
    expect(lifecycleStore.get().phase).toBe('implementing');
    expect(tokensStore.get().localCount).toBe(3);
    expect(tokensStore.get().escalatedCount).toBe(1);
  });
});

describe('markCancelled', () => {
  beforeEach(() => resetWorkflow());

  it('sets cancelled and appends workflow_cancelled event', () => {
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    markCancelled();
    expect(lifecycleStore.get().cancelled).toBe(true);
    const events = eventsStore.get().events;
    expect(events[events.length - 1]?.type).toBe('workflow_cancelled');
  });

  it('replaces running planner_status with done', () => {
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    markCancelled();
    const events = eventsStore.get().events;
    const status = events.find(e => e.type === 'planner_status');
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

  it('appends cancellation through the bounded event stream', () => {
    for (let i = 0; i < MAX_EVENTS; i += 1) {
      addEvent(makeRetry({ taskId: taskId(`T${i}`) }));
    }

    markCancelled();

    const events = eventsStore.get().events;
    expect(events).toHaveLength(MAX_EVENTS);
    expect((events[0] as { taskId: string }).taskId).toBe('T1');
    expect(events[events.length - 1]?.type).toBe('workflow_cancelled');
  });
});

describe('addEvent — cancelled gate', () => {
  beforeEach(() => resetWorkflow());

  it('drops error events after cancel', () => {
    markCancelled();
    addEvent({ type: 'error', ts: Date.now(), phase: 'implementing', message: 'noise' });
    expect(eventsStore.get().events.filter(e => e.type === 'error')).toHaveLength(0);
  });

  it('drops planner_status events after cancel', () => {
    markCancelled();
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    expect(eventsStore.get().events.filter(e => e.type === 'planner_status')).toHaveLength(0);
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

  it('clears abort pending state before resetting sub-stores', () => {
    // Seed the abort store into a pending state, then verify resetWorkflow clears it
    // — this is the observable contract the dispatcher must preserve.
    abortStore.markPending();
    expect(abortStore.get().pending).toBe(true);
    resetWorkflow();
    expect(abortStore.get().pending).toBe(false);
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

  it('restores observable workflow state from a persisted resume snapshot', () => {
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
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
      awaitingContinue: false,
      messageQueue: [
        {
          id: 'q1',
          text: 'queued',
          queuedAt: new Date().toISOString(),
          phase: 'implementing',
          deliveredViaNative: false,
        },
      ],
    });
    expect(lifecycleStore.get().phase).toBe('implementing');
    expect(lifecycleStore.get().queueDepth).toBe(1);
    expect(tasksStore.get().currentTask).toBe(3);
    expect(tasksStore.get().totalTasks).toBe(3);
    expect(tasksStore.get().tasks.map(task => [task.id, task.status])).toEqual([
      ['T1', 'done'],
      ['T2', 'done'],
      ['T3', 'pending'],
    ]);
    expect(tasksStore.get().taskMap.get('T2')?.status).toBe('done');
    expect(tokensStore.get().tokenUsage).toEqual({
      plannerInput: 0,
      plannerOutput: 0,
      implementerInput: 0,
      implementerOutput: 0,
      escalationInput: 0,
      escalationOutput: 0,
    });
    expect(tokensStore.get().localCount).toBe(2);
    expect(tokensStore.get().escalatedCount).toBe(0);
    expect(tokensStore.get().completedTaskCount).toBe(2);
    expect(tokensStore.get().pricingContext).toEqual({
      plannerTool: 'anthropic',
      plannerModel: 'claude-sonnet-4-6',
      implementerTool: 'deepseek',
      implementerModel: 'deepseek-chat',
    });
  });

  it('uses resumed token usage as the baseline for the next cumulative cost update', () => {
    resetWorkflow({
      stateVersion: 1,
      phase: 'planning',
      feature: 'f',
      currentTaskIndex: 0,
      attempt: 0,
      tasks: [makeTask({ id: 'T1', status: 'pending' })],
      plannerSessionId: null,
      startedAt: new Date().toISOString(),
      tokenUsage: { plannerInput: 100, plannerOutput: 50, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 },
      awaitingContinue: false,
      messageQueue: [],
    });

    addEvent(makeCostUpdate({
      phase: 'planning',
      tokenUsage: { plannerInput: 150, plannerOutput: 75, implementerInput: 0, implementerOutput: 0, escalationInput: 0, escalationOutput: 0 },
    }));

    expect(tokensStore.get().perPhase['planning']).toMatchObject({
      inputTokens: 50,
      outputTokens: 25,
    });
  });
});

describe('getSections', () => {
  beforeEach(() => resetWorkflow());

  it('reflects the current event stream', () => {
    addEvent(makeRetry());
    expect(getSections()).toHaveLength(1);
  });

  it('clears derived sections after workflow reset', () => {
    addEvent(makeRetry());
    expect(getSections()).toHaveLength(1);
    resetWorkflow();
    expect(getSections()).toEqual([]);
  });
});
