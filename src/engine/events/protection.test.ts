import { describe, expect, it } from 'vitest';
import { protectEngineEventForConsumer, TRANSCRIPT_OMITTED_MESSAGE } from './protection.js';
import type { EngineEvent } from './types.js';

describe('protectEngineEventForConsumer', () => {
  it('drops transcript-only runner payload events when transcript persistence is disabled', () => {
    const event: EngineEvent = {
      type: 'runner_call_text_delta',
      ts: 10,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 1,
      text: 'secret transcript',
    };

    expect(
      protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: false }),
    ).toBeNull();
  });

  it('preserves runner terminal metadata while omitting error message content', () => {
    const event: EngineEvent = {
      type: 'runner_call_error',
      ts: 20,
      phase: 'implementing',
      callId: 'call-1',
      role: 'implementer',
      backendKind: 'cli',
      sequence: 2,
      status: 'failed',
      error: { code: 'failed', message: 'failed with sk-abcdefghijklmnopqrst' },
      partial: true,
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      usage: { inputTokens: 1, outputTokens: 2 },
      nativeSessionId: 'native-1',
    };

    expect(
      protectEngineEventForConsumer(event, { context: 'ipc', persistTranscript: false }),
    ).toMatchObject({
      type: 'runner_call_error',
      status: 'failed',
      partial: true,
      durationMs: 10,
      usage: { inputTokens: 1, outputTokens: 2 },
      nativeSessionId: 'native-1',
      error: { code: 'failed', message: TRANSCRIPT_OMITTED_MESSAGE },
    });
  });

  it('redacts secrets and strips terminal controls from persisted events', () => {
    const event: EngineEvent = {
      type: 'warning',
      ts: 30,
      phase: 'planning',
      message: 'token sk-abcdefghijklmnopqrst \u001b]0;owned\u0007done',
    };

    expect(
      protectEngineEventForConsumer(event, { context: 'session-log', persistTranscript: true }),
    ).toEqual({
      type: 'warning',
      ts: 30,
      phase: 'planning',
      message: 'token sk-***REDACTED*** done',
    });
  });
});
