import { describe, expect, it } from 'vitest';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH, RunnerCallContextSchema } from './schema.js';
import { projectRunnerCallEvents } from './event-projection.js';
import { createRunnerAttemptCallbackBuffer } from './callback-buffer.js';
import type { RunnerCallContext, RunnerCallEvent } from './types.js';

const runnerContext: RunnerCallContext = {
  callId: 'call-1',
  role: 'planner',
  backendKind: 'cli',
};

function callStarted(ts: number): RunnerCallEvent {
  return {
    type: 'call_started',
    ts,
    ...runnerContext,
  };
}

function textDelta(ts: number): RunnerCallEvent {
  return {
    type: 'call_text_delta',
    ts,
    ...runnerContext,
    channel: 'assistant',
    text: 'x',
  };
}

function callCompleted(ts: number): RunnerCallEvent {
  return {
    type: 'call_completed',
    ts,
    ...runnerContext,
    status: 'completed',
    error: null,
    startedAt: 1,
    endedAt: ts,
    durationMs: ts - 1,
    partial: false,
    usage: null,
    nativeSessionId: null,
  };
}

function callStalled(ts: number): RunnerCallEvent {
  return {
    type: 'call_stalled',
    ts,
    ...runnerContext,
    silentMs: 60_000,
  };
}

function callStallCleared(ts: number): RunnerCallEvent {
  return {
    type: 'call_stall_cleared',
    ts,
    ...runnerContext,
  };
}

describe('createRunnerAttemptCallbackBuffer', () => {
  it('preserves full call attribution in overflow warning and activity events', () => {
    const context = RunnerCallContextSchema.parse({
      ...runnerContext,
      attemptId: 'attempt-1',
      attempt: 1,
      runnerName: 'claude-code',
      model: 'sonnet',
      axes: ['high'],
      transport: { kind: 'stdout-final' },
      sessionScope: { kind: 'workflow', workflowSessionId: 'session-1' },
      taskId: 'T001',
      usageBoundary: 'aggregate',
      invocationIdentity: {
        version: 1,
        capturedAt: 1,
        runner: { kind: 'cli', id: 'claude-code' },
        billing: { posture: 'unknown', basis: 'unknown' },
      },
    });
    const events: RunnerCallEvent[] = [];
    const buffer = createRunnerAttemptCallbackBuffer({
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });
    buffer.callbacks.onCallEvent?.({ type: 'call_started', ts: 1, ...context });
    buffer.callbacks.onOutput('x'.repeat(4 * 1024 * 1024));
    buffer.flush();
    const warning = events.find((event) => event.type === 'call_warning');
    expect(warning).toMatchObject(context);
    if (warning === undefined) throw new Error('Expected overflow warning');
    const projected = projectRunnerCallEvents(warning, {
      rootDir: '/project',
      phase: 'implementing',
      sequence: 1,
    });
    expect(projected.map((event) => event.type)).toEqual([
      'runner_call_warning',
      'runner_call_activity',
    ]);
    for (const event of projected) expect(event).toMatchObject(context);
  });
  it('emits one bounded overflow warning and preserves terminal call events', () => {
    const output: string[] = [];
    const events: RunnerCallEvent[] = [];
    const buffer = createRunnerAttemptCallbackBuffer({
      onOutput: (text) => output.push(text),
      onCallEvent: (event) => events.push(event),
    });

    buffer.callbacks.onCallEvent?.(callStarted(1));
    for (let i = 0; i < 12_298; i += 1) {
      buffer.callbacks.onCallEvent?.(textDelta(i + 2));
    }
    buffer.callbacks.onOutput('dropped after overflow');
    buffer.callbacks.onCallEvent?.(callCompleted(20_000));

    buffer.flush();

    const warnings = events.filter((event) => event.type === 'call_warning');
    expect(warnings).toHaveLength(1);
    const warning = warnings[0];
    if (warning?.type !== 'call_warning') throw new Error('expected call_warning event');
    expect(warning.warning).toMatchObject({
      code: 'callback_buffer_overflow',
      severity: 'warning',
      source: 'system',
      surface: 'activity',
      message: 'Only the first 12288 live updates or 3 MB of this call are shown.',
    });
    expect(warning.warning.message.length).toBeLessThanOrEqual(RUNNER_CALL_MESSAGE_MAX_LENGTH);
    expect(events.at(-1)).toMatchObject({ type: 'call_completed', status: 'completed' });
    expect(output).toEqual([]);
  });

  it('runs callbacks immediately after flush', () => {
    const output: string[] = [];
    const buffer = createRunnerAttemptCallbackBuffer({
      onOutput: (text) => output.push(text),
    });

    buffer.callbacks.onOutput('before flush');
    buffer.flush();
    buffer.callbacks.onOutput('after flush');

    expect(output).toEqual(['before flush', 'after flush']);
  });

  it('call_stalled and call_stall_cleared are delivered before flush', () => {
    const events: RunnerCallEvent[] = [];
    const buffer = createRunnerAttemptCallbackBuffer({
      onOutput: () => {},
      onCallEvent: (event) => events.push(event),
    });

    buffer.callbacks.onCallEvent?.(textDelta(1));
    buffer.callbacks.onCallEvent?.(callStalled(2));
    buffer.callbacks.onCallEvent?.(callStallCleared(3));

    expect(events).toEqual([callStalled(2), callStallCleared(3)]);

    buffer.flush();

    expect(events).toEqual([callStalled(2), callStallCleared(3), textDelta(1)]);
  });
});
