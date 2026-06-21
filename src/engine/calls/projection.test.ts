import { describe, expect, it } from 'vitest';
import { EngineEventSchema } from '../events/schema.js';
import { projectRunnerCallEvent, projectRunnerCallEvents } from './event-projection.js';
import { applyInvokeResultProjection, toInvokeResult } from './projection.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import { runnerCallEventToSessionLogEntry } from './session-log.js';
import type { RunnerCallEvent, RunnerCallResult } from './types.js';
import { normalizeRunnerCallWarning } from './warnings.js';

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

  it('applies legacy postprocess output without dropping collected call values', () => {
    const projected = applyInvokeResultProjection(
      {
        ...result,
        toolUses: [
          {
            id: 'tool-1',
            name: 'Read',
            input: { file_path: 'src/app.ts' },
            output: null,
          },
        ],
      },
      {
        text: 'planned',
        usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 3 },
        sessionId: 'native-1',
      },
    );

    expect(projected).toMatchObject({
      text: 'planned',
      usage: { inputTokens: 7, outputTokens: 8, cacheReadTokens: 3 },
      nativeSessionId: 'native-1',
      toolUses: [{ id: 'tool-1', name: 'Read' }],
    });
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

  it('preserves text delta channels when projecting runner call events', () => {
    const event: RunnerCallEvent = {
      type: 'call_text_delta',
      ts: 11,
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      channel: 'assistant',
      text: 'assistant answer',
    };

    expect(projectRunnerCallEvent(event, { phase: 'planning', sequence: 4 })).toEqual({
      type: 'runner_call_text_delta',
      ts: 11,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 4,
      channel: 'assistant',
      text: 'assistant answer',
    });
  });

  it('projects tool-use delta and done events with lifecycle stage', () => {
    expect(
      projectRunnerCallEvent(
        {
          type: 'call_tool_use_delta',
          ts: 12,
          callId: 'call-1',
          role: 'planner',
          backendKind: 'cli',
          channel: 'tool',
          toolUseId: null,
          name: 'Bash',
          inputDelta: '{"command":"npm',
        },
        { phase: 'planning', sequence: 5 },
      ),
    ).toEqual({
      type: 'runner_call_tool_use',
      ts: 12,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 5,
      stage: 'delta',
      toolUseId: null,
      name: 'Bash',
      inputDelta: '{"command":"npm',
    });

    expect(
      projectRunnerCallEvent(
        {
          type: 'call_tool_use_done',
          ts: 13,
          callId: 'call-1',
          role: 'planner',
          backendKind: 'cli',
          channel: 'tool',
          toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
        },
        { phase: 'planning', sequence: 6 },
      ),
    ).toEqual({
      type: 'runner_call_tool_use',
      ts: 13,
      phase: 'planning',
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      sequence: 6,
      stage: 'done',
      toolUse: { id: 'tool-1', name: 'Bash', input: { command: 'npm test' } },
    });
  });

  it('adds safe activity projections next to raw runner call payload events', () => {
    const projected = projectRunnerCallEvents(
      {
        type: 'call_tool_use_done',
        ts: 13,
        callId: 'call-1',
        role: 'planner',
        backendKind: 'cli',
        channel: 'tool',
        toolUse: {
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'echo sk-abcdefghijklmnopqrst' },
        },
      },
      { phase: 'planning', sequence: 6 },
    );

    expect(projected).toEqual([
      expect.objectContaining({
        type: 'runner_call_tool_use',
        sequence: 6,
        toolUse: expect.objectContaining({
          input: { command: 'echo sk-abcdefghijklmnopqrst' },
        }),
      }),
      expect.objectContaining({
        type: 'runner_call_activity',
        sequence: 6,
        activityId: 'call-1:tool:tool-1',
        stage: 'completed',
        kind: 'command',
        label: 'running echo sk-***REDACTED***',
        redacted: true,
      }),
    ]);
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

  it('adds terminal activity projections for completed calls', () => {
    const projected = projectRunnerCallEvents(
      {
        type: 'call_completed',
        ts: 20,
        callId: 'call-1',
        role: 'implementer',
        backendKind: 'cli',
        status: 'completed',
        error: null,
        startedAt: 10,
        endedAt: 20,
        durationMs: 10,
        partial: false,
        usage: null,
        nativeSessionId: null,
      },
      { phase: 'implementing', sequence: 7 },
    );

    expect(projected).toEqual([
      expect.objectContaining({ type: 'runner_call_completed', sequence: 7 }),
      expect.objectContaining({
        type: 'runner_call_activity',
        activityId: 'call-1:terminal',
        stage: 'completed',
        kind: 'text',
        label: 'completed implementer',
        rawAvailable: false,
        expandId: 'call-1:terminal',
      }),
    ]);
  });

  it('keeps stderr deltas out of primary warning projection by default', () => {
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

    expect(projected).toBeNull();
    expect(
      projectRunnerCallEvents(
        {
          type: 'call_stderr_delta',
          ts: 10,
          callId: 'call-1',
          role: 'planner',
          backendKind: 'api',
          channel: 'stderr',
          text: 'benign progress',
        },
        { phase: 'planning', sequence: 5 },
      ),
    ).toEqual([]);
  });

  it('projects explicit runner call warnings with severity and fingerprint', () => {
    const projected = projectRunnerCallEvent(
      {
        type: 'call_warning',
        ts: 10,
        callId: 'call-1',
        role: 'planner',
        backendKind: 'api',
        warning: normalizeRunnerCallWarning({
          code: 'provider_retry',
          severity: 'warning',
          source: 'provider',
          message: 'retrying request at 2026-06-21T10:00:00.000Z after 23ms',
        }),
      },
      { phase: 'planning', sequence: 5 },
    );

    expect(EngineEventSchema.safeParse(projected).success).toBe(true);
    expect(projected).toMatchObject({
      type: 'runner_call_warning',
      warning: {
        code: 'provider_retry',
        severity: 'warning',
        source: 'provider',
        surface: 'activity',
        message: 'retrying request at 2026-06-21T10:00:00.000Z after 23ms',
        fingerprint: expect.stringMatching(/^rw:/),
      },
    });
  });

  it('bounds projected runner call error messages to the engine event schema limit', () => {
    const projected = projectRunnerCallEvent(
      {
        type: 'call_error',
        ts: 10,
        callId: 'call-1',
        role: 'planner',
        backendKind: 'api',
        status: 'failed',
        error: { code: 'failed', message: 'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH + 100) },
        startedAt: 1,
        endedAt: 10,
        durationMs: 9,
        partial: true,
        usage: null,
        nativeSessionId: null,
      },
      { phase: 'planning', sequence: 5 },
    );

    expect(EngineEventSchema.safeParse(projected).success).toBe(true);
    expect(projected).toMatchObject({
      type: 'runner_call_error',
      error: {
        code: 'failed',
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
        channel: 'assistant',
        text: 'hello',
      },
    });
  });
});
