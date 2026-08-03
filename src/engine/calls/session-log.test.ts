import { describe, expect, it } from 'vitest';
import { runnerCallEventToSessionLogEntry } from './session-log.js';
import type { RunnerCallEvent } from './types.js';

describe('runnerCallEventToSessionLogEntry', () => {
  it('stores projected call events as ordinary event records', () => {
    const event: RunnerCallEvent = {
      type: 'call_text_delta',
      ts: Date.UTC(2026, 0, 1),
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      channel: 'assistant',
      text: 'hello',
    };

    expect(runnerCallEventToSessionLogEntry(event, { phase: 'planning', sequence: 1 })).toEqual({
      kind: 'event',
      ts: '2026-01-01T00:00:00.000Z',
      type: 'runner_call_text_delta',
      phase: 'planning',
      data: {
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        sequence: 1,
        channel: 'assistant',
        text: 'hello',
        semantics: 'delta',
      },
    });
  });

  it('stores pre-redacted custom runner output without its original child bytes', () => {
    const childOutputCanary = 'custom-public-child-output-48152';
    const entry = runnerCallEventToSessionLogEntry(
      {
        type: 'call_text_delta',
        ts: Date.UTC(2026, 0, 1),
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        channel: 'assistant',
        text: 'helper output: ***REDACTED***',
      },
      { phase: 'planning', sequence: 1 },
    );

    expect(entry).toMatchObject({
      type: 'runner_call_text_delta',
      data: { text: 'helper output: ***REDACTED***' },
    });
    expect(JSON.stringify(entry)).not.toContain(childOutputCanary);
  });
});
