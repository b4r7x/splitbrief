import { describe, expect, it } from 'vitest';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import { createRunnerAttemptCallbackBuffer } from './callback-buffer.js';
import { RUNNER_CALL_OUTPUT_MAX_EVENTS } from './output-limit.js';
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
  it('emits one bounded overflow warning and preserves terminal call events', () => {
    const output: string[] = [];
    const events: RunnerCallEvent[] = [];
    const buffer = createRunnerAttemptCallbackBuffer({
      onOutput: (text) => output.push(text),
      onCallEvent: (event) => events.push(event),
    });

    buffer.callbacks.onCallEvent?.(callStarted(1));
    for (let i = 0; i < RUNNER_CALL_OUTPUT_MAX_EVENTS * 3 + 10; i += 1) {
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
      message: expect.stringContaining('Runner callback buffer exceeded'),
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
