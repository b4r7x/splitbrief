import { describe, expect, it } from 'vitest';
import { taskId } from '../../core/schemas/task.js';
import { EngineEventSchema } from '../events/schema.js';
import type { EngineEvent, EngineEventOf } from '../events/types.js';
import { interruptedCallEvents } from './interrupted.js';

const T002 = taskId('T002');

function call(callId: string, role: 'implementer' | 'review' = 'implementer') {
  return {
    callId,
    role,
    backendKind: 'cli',
    runnerName: 'agy',
    model: 'gemini-3.8-flash-high',
    ...(role === 'implementer' && { taskId: T002 }),
  } as const;
}

function started(callId: string, ts: number, role?: 'implementer' | 'review'): EngineEvent {
  return {
    type: 'runner_call_started',
    ts,
    phase: role === 'review' ? 'final-review' : 'implementing',
    ...call(callId, role),
    sequence: ts,
  };
}

function activity(callId: string, ts: number): EngineEvent {
  return {
    type: 'runner_call_activity',
    ts,
    phase: 'implementing',
    ...call(callId),
    sequence: ts,
    activityId: `${callId}:tool:${ts}`,
    stage: 'completed',
    kind: 'edit',
    label: 'Edit',
    target: 'src/strings.js',
    redacted: false,
  };
}

function completed(callId: string, ts: number): EngineEvent {
  return {
    type: 'runner_call_completed',
    ts,
    phase: 'implementing',
    ...call(callId),
    sequence: ts,
    status: 'completed',
    error: null,
    partial: false,
    startedAt: 0,
    endedAt: ts,
    durationMs: ts,
    usage: null,
    nativeSessionId: null,
  };
}

const resumed: EngineEvent = { type: 'workflow_resumed', ts: 500, phase: 'implementing' };

describe('interruptedCallEvents', () => {
  it('closes the call a process left open as interrupted, dated at its last report', () => {
    const events = [
      { type: 'workflow_started', ts: 0, phase: 'planning', feature: 'f' } as const,
      started('implementer-1', 10),
      completed('implementer-1', 20),
      started('implementer-2', 30),
      activity('implementer-2', 45),
    ];

    const closed = interruptedCallEvents(events, '/repo');

    expect(closed.map((event) => event.type)).toEqual([
      'runner_call_error',
      'runner_call_activity',
    ]);
    const error = closed[0] as EngineEventOf<'runner_call_error'>;
    expect(error).toMatchObject({
      ts: 45,
      callId: 'implementer-2',
      role: 'implementer',
      taskId: T002,
      status: 'aborted',
      error: { code: 'runner_interrupted', message: 'SPLITBRIEF exited' },
      startedAt: 30,
      endedAt: 45,
      durationMs: 15,
      usage: null,
    });
    expect(closed[1]).toMatchObject({
      ts: 45,
      activityId: 'implementer-2:terminal',
      kind: 'error',
      stage: 'aborted',
    });
    for (const event of closed) expect(EngineEventSchema.safeParse(event).success).toBe(true);
  });

  it('builds the same events from the same log, so a reader and the resume agree', () => {
    const events = [started('review-1', 10, 'review'), activity('review-1', 12)];
    expect(interruptedCallEvents(events, '/repo')).toEqual(interruptedCallEvents(events, '/repo'));
  });

  it('leaves a log whose calls all ended, or whose cut is already recorded, with nothing to close', () => {
    const ended = [started('implementer-1', 10), completed('implementer-1', 20)];
    expect(interruptedCallEvents(ended, '/repo')).toEqual([]);

    const recorded = [started('implementer-2', 30), activity('implementer-2', 45)];
    const once = [...recorded, ...interruptedCallEvents(recorded, '/repo')];
    expect(interruptedCallEvents(once, '/repo')).toEqual([]);
  });

  it('reads only the calls of the last process, since call ids restart with each one', () => {
    const events = [started('implementer-1', 10), resumed, started('implementer-1', 600)];

    const closed = interruptedCallEvents(events, '/repo');

    expect(closed).toHaveLength(2);
    expect(closed[0]).toMatchObject({ callId: 'implementer-1', startedAt: 600 });
  });
});
