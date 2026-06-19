import { describe, expect, it } from 'vitest';
import { EngineEventSchema } from '../events/schema.js';
import { projectRunnerCallEvent } from './event-projection.js';
import { toInvokeResult, toRunnerCallResult } from './projection.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import { runnerCallEventToSessionLogEntry } from './session-log.js';
import type { RunnerCallEvent, RunnerCallResult } from './types.js';

const result: RunnerCallResult = {
  callId: 'call-1',
  role: 'implementer',
  backendKind: 'shell',
  status: 'completed',
  startedAt: 1,
  endedAt: 9,
  durationMs: 8,
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
    expect(() =>
      toInvokeResult({
        ...result,
        status: 'timeout',
        error: { code: 'timeout', message: 'runner timed out' },
        partial: true,
      }),
    ).toThrow(/Cannot project timeout/);
  });

  it('normalizes legacy InvokeResult values to completed call results', () => {
    const projected = toRunnerCallResult(
      { callId: 'planner-1', role: 'planner', backendKind: 'api' },
      {
        text: 'planned',
        usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 3 },
        sessionId: 'native-1',
      },
    );
    expect(projected).toEqual({
      callId: 'planner-1',
      role: 'planner',
      backendKind: 'api',
      status: 'completed',
      startedAt: expect.any(Number),
      endedAt: expect.any(Number),
      durationMs: 0,
      text: 'planned',
      usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 3 },
      nativeSessionId: 'native-1',
      toolUses: [],
      artifacts: [],
      warnings: [],
      error: null,
      partial: false,
    });
    expect(projected.startedAt).toBe(projected.endedAt);
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

  it('projects terminal events with frozen timing and metadata', () => {
    const event: RunnerCallEvent = {
      type: 'call_completed',
      ts: 20,
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      runnerName: 'openrouter',
      model: 'gpt-5',
      attempt: 1,
      status: 'completed',
      error: null,
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      partial: false,
      usage: { inputTokens: 5, outputTokens: 6 },
      nativeSessionId: null,
    };

    expect(projectRunnerCallEvent(event, { phase: 'planning', sequence: 4 })).toEqual({
      type: 'runner_call_completed',
      ts: 20,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'api',
      runnerName: 'openrouter',
      model: 'gpt-5',
      attempt: 1,
      sequence: 4,
      status: 'completed',
      error: null,
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      partial: false,
      usage: { inputTokens: 5, outputTokens: 6 },
      nativeSessionId: null,
    });
  });

  it('bounds projected stderr warnings to the engine event schema limit', () => {
    const projected = projectRunnerCallEvent(
      {
        type: 'call_stderr_delta',
        ts: 10,
        callId: 'call-1',
        role: 'planner',
        backendKind: 'api',
        channel: 'stderr',
        text: 'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH + 100),
      },
      { phase: 'planning', sequence: 5 },
    );

    expect(EngineEventSchema.safeParse(projected).success).toBe(true);
    expect(projected).toMatchObject({
      type: 'runner_call_warning',
      warning: {
        code: 'stderr',
        message: `${'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH - 3)}...`,
      },
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
