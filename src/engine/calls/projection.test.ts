import { describe, expect, it } from 'vitest';
import { projectRunnerCallEvent } from './event-projection.js';
import { toInvokeResult, toRunnerCallResult } from './projection.js';
import { runnerCallEventToSessionLogEntry } from './session-log.js';
import type { RunnerCallEvent, RunnerCallResult } from './types.js';

const result: RunnerCallResult = {
  callId: 'call-1',
  role: 'implementer',
  backendKind: 'shell',
  status: 'completed',
  text: 'done',
  usage: { inputTokens: 1, outputTokens: 2 },
  nativeSessionId: null,
  toolUses: [],
  artifacts: [],
  warnings: [],
  error: null,
  partial: false,
};

describe('toInvokeResult', () => {
  it('projects completed call results to legacy InvokeResult', () => {
    expect(toInvokeResult(result)).toEqual({
      text: 'done',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('rejects non-completed call results', () => {
    expect(() => toInvokeResult({ ...result, status: 'timeout', partial: true })).toThrow(
      /Cannot project timeout/,
    );
  });

  it('normalizes legacy InvokeResult values to completed call results', () => {
    expect(
      toRunnerCallResult(
        { callId: 'planner-1', role: 'planner', backendKind: 'api' },
        {
          text: 'planned',
          usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 3 },
          sessionId: 'native-1',
        },
      ),
    ).toEqual({
      callId: 'planner-1',
      role: 'planner',
      backendKind: 'api',
      status: 'completed',
      text: 'planned',
      usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 3 },
      nativeSessionId: 'native-1',
      toolUses: [],
      artifacts: [],
      warnings: [],
      error: null,
      partial: false,
    });
  });

  it('passes through typed runner call results', () => {
    expect(
      toRunnerCallResult({ callId: 'ignored', role: 'planner', backendKind: 'api' }, result),
    ).toBe(result);
  });
});

describe('projectRunnerCallEvent', () => {
  it('projects call events to strict engine event variants', () => {
    const event: RunnerCallEvent = {
      type: 'call_usage',
      ts: 10,
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      usage: { inputTokens: 5, outputTokens: 6 },
      semantics: 'delta',
    };

    expect(projectRunnerCallEvent(event, { phase: 'planning', sequence: 3 })).toEqual({
      type: 'runner_call_usage',
      ts: 10,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      sequence: 3,
      usage: { inputTokens: 5, outputTokens: 6 },
      semantics: 'delta',
    });
  });
});

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
        text: 'hello',
      },
    });
  });
});
