import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent } from './event.js';
import { markCancellationRequested } from './interrupt.js';
import { resetWorkflow } from './reset.js';
import { eventsStore } from '../events.js';
import { tasksStore } from '../tasks.js';
import { tokensStore } from '../tokens.js';
import { lifecycleStore } from '../lifecycle.js';
import { operationsStore } from '../operations/state.js';
import { loadEvents } from './load.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeRetry, makeTaskStart, makeTaskComplete } from '#testing/helpers/events/task.js';

describe('addEvent — cross-bucket isolation', () => {
  beforeEach(() => resetWorkflow());

  it('preserves unrelated sub-store fields on generic events', () => {
    lifecycleStore.__testReset({ phase: 'implementing' });
    tokensStore.__testReset({ completedTaskCount: 4 });
    addEvent(makeRetry());
    expect(lifecycleStore.get().phase).toBe('implementing');
    expect(tokensStore.get().completedTaskCount).toBe(4);
  });
});

describe('addEvent — runner call stall', () => {
  beforeEach(() => resetWorkflow());

  it('applies runner_call_stalled and runner_call_stall_cleared to the lifecycle stall field', () => {
    lifecycleStore.__testReset({ phase: 'implementing' });

    addEvent({
      type: 'runner_call_stalled',
      ts: 2_000,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 1,
      silentMs: 60_000,
    });
    expect(lifecycleStore.get().stall).toEqual({
      since: 2_000,
      silentMs: 60_000,
      runnerName: null,
      backendKind: 'cli',
    });

    addEvent({
      type: 'runner_call_stall_cleared',
      ts: 2_500,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
    });
    expect(lifecycleStore.get().stall).toBeNull();
  });
});

describe('addEvent — cancelled gate', () => {
  beforeEach(() => resetWorkflow());

  it('drops error events after cancel', () => {
    markCancellationRequested();
    addEvent({ type: 'error', ts: Date.now(), phase: 'implementing', message: 'noise' });
    expect(eventsStore.get().events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('drops late runner activity after cancel so interrupted rows do not reappear', () => {
    markCancellationRequested();
    addEvent({
      type: 'runner_call_activity',
      ts: Date.now(),
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      runnerName: 'codex',
      sequence: 1,
      activityId: 'call-1:terminal',
      stage: 'aborted',
      kind: 'error',
      label: 'aborted runner_interrupted',
      redacted: false,
    });

    expect(eventsStore.get().events.filter((e) => e.type === 'runner_call_activity')).toEqual([]);
  });

  it('drops planner_status events after cancel', () => {
    markCancellationRequested();
    addEvent(makePlannerStatus({ phase: 'researching', status: 'running' }));
    expect(eventsStore.get().events.filter((e) => e.type === 'planner_status')).toHaveLength(0);
  });

  it('applies a stopped review_completed after workflow_cancelled exactly as replay does', () => {
    const events: EngineEvent[] = [
      { type: 'workflow_started', ts: 500, phase: 'implementing', feature: 'test' },
      {
        type: 'review_started',
        ts: 1_000,
        phase: 'implementing',
        scope: 'task',
        afterTaskId: 'T001',
        tool: 'codex',
        model: 'gpt-5',
      },
      { type: 'workflow_cancelled', ts: 1_200, phase: 'implementing', reason: 'user_cancelled' },
      {
        type: 'review_completed',
        ts: 1_300,
        phase: 'implementing',
        scope: 'task',
        afterTaskId: 'T001',
        tool: 'codex',
        model: 'gpt-5',
        verdict: 'stopped',
        duration: 300,
      },
    ];
    for (const event of events) addEvent(event);
    expect(eventsStore.get().events.at(-1)).toEqual(events.at(-1));
    expect(lifecycleStore.get()).toMatchObject({
      status: 'cancelled',
      endedAt: 1_200,
      durationMs: 700,
    });
    const live = {
      events: eventsStore.get(),
      lifecycle: lifecycleStore.get(),
      operations: operationsStore.get(),
    };
    loadEvents(events);
    expect({
      events: eventsStore.get(),
      lifecycle: lifecycleStore.get(),
      operations: operationsStore.get(),
    }).toEqual(live);
  });

  it('does not mutate tasks store after cancel', () => {
    markCancellationRequested();
    addEvent(makeTaskStart({ index: 0, total: 1 }));
    expect(tasksStore.get().currentTask).toBe(0);
    expect(tasksStore.get().totalTasks).toBe(0);
  });

  it('does not mutate tokens store after cancel', () => {
    markCancellationRequested();
    addEvent(makeTaskComplete({ method: 'local' }));
    expect(tokensStore.get().completedTaskCount).toBe(0);
  });
});
