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
});
