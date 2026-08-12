import { describe, it, expect, beforeEach } from 'vitest';
import { addEvent } from './event.js';
import { markCancellationRequested } from './interrupt.js';
import { resetWorkflow } from './reset.js';
import { eventsStore } from '../events.js';
import { tasksStore } from '../tasks.js';
import { tokensStore } from '../tokens.js';
import { lifecycleStore } from '../lifecycle.js';
import { makePlannerStatus } from '#testing/helpers/events/planner.js';
import { makeRetry, makeTaskStart, makeTaskComplete } from '#testing/helpers/events/task.js';

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

  it('does not mutate tasks store after cancel', () => {
    markCancellationRequested();
    addEvent(makeTaskStart({ index: 0, total: 1 }));
    expect(tasksStore.get().currentTask).toBe(0);
    expect(tasksStore.get().totalTasks).toBe(0);
  });

  it('does not mutate tokens store after cancel', () => {
    markCancellationRequested();
    addEvent(makeTaskComplete({ method: 'local' }));
    expect(tokensStore.get().localCount).toBe(0);
  });
});
