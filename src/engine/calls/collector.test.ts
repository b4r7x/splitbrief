import { describe, expect, it } from 'vitest';
import { collectRunnerCallResult } from './collector.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import { RUNNER_CALL_OUTPUT_MAX_BYTES, RUNNER_CALL_WARNING_MAX_ITEMS } from './output-limit.js';
import type { RunnerCallEvent, RunnerCallWarningInput } from './types.js';
import { normalizeRunnerCallWarning } from './warnings.js';

const base = {
  ts: 1,
  callId: 'call-1',
  role: 'planner',
  backendKind: 'cli',
} as const;

const completedTerminal = {
  startedAt: 1,
  endedAt: 20,
  durationMs: 19,
  partial: false,
  error: null,
  usage: null,
  nativeSessionId: 'native-1',
} as const;

const timeoutTerminal = {
  startedAt: 1,
  endedAt: 15,
  durationMs: 14,
  partial: true,
  usage: null,
  nativeSessionId: null,
} as const;

function runnerWarning(input: RunnerCallWarningInput) {
  return normalizeRunnerCallWarning(input);
}

describe('collectRunnerCallResult', () => {
  it('collects text, usage, session, tools, artifacts, warnings, and terminal success', () => {
    const events: RunnerCallEvent[] = [
      { type: 'call_started', ...base },
      { type: 'call_text_delta', ...base, channel: 'assistant', text: 'hello ' },
      { type: 'call_text_delta', ...base, channel: 'assistant', text: 'world' },
      {
        type: 'call_usage',
        ...base,
        semantics: 'delta',
        usage: { inputTokens: 5, outputTokens: 2 },
      },
      {
        type: 'call_usage',
        ...base,
        semantics: 'final',
        usage: { inputTokens: 8, outputTokens: 3 },
      },
      { type: 'call_session_id', ...base, nativeSessionId: 'native-1' },
      {
        type: 'call_tool_use_done',
        ...base,
        channel: 'tool',
        toolUse: { id: 'tool-1', name: 'read_file', input: { path: 'a.ts' } },
      },
      {
        type: 'call_artifact',
        ...base,
        artifact: {
          id: 'artifact-1',
          source: 'file',
          name: 'plan.md',
          path: 'plan.md',
          mimeType: 'text/markdown',
          text: null,
        },
      },
      {
        type: 'call_warning',
        ...base,
        warning: runnerWarning({ code: 'slow', message: 'slow stream' }),
      },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ];

    expect(collectRunnerCallResult(events)).toEqual({
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      status: 'completed',
      startedAt: 1,
      endedAt: 20,
      durationMs: 19,
      text: 'hello world',
      usage: { inputTokens: 8, outputTokens: 3 },
      nativeSessionId: 'native-1',
      toolUses: [{ id: 'tool-1', name: 'read_file', input: { path: 'a.ts' } }],
      artifacts: [
        {
          id: 'artifact-1',
          source: 'file',
          name: 'plan.md',
          path: 'plan.md',
          mimeType: 'text/markdown',
          text: null,
        },
      ],
      warnings: [
        expect.objectContaining({
          code: 'slow',
          severity: 'warning',
          source: 'provider',
          surface: 'activity',
          message: 'slow stream',
          fingerprint: expect.stringMatching(/^rw:/),
        }),
      ],
      error: null,
      partial: false,
    });
  });

  it('preserves partial output and failure status for terminal errors', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      { type: 'call_text_delta', ...base, channel: 'assistant', text: 'partial' },
      {
        type: 'call_error',
        ...base,
        status: 'timeout',
        error: { code: 'timeout', message: 'runner timed out' },
        ...timeoutTerminal,
      },
    ]);

    expect(result).toMatchObject({
      status: 'timeout',
      startedAt: 1,
      endedAt: 15,
      durationMs: 14,
      text: 'partial',
      partial: true,
      error: { code: 'timeout', message: 'runner timed out' },
    });
  });

  it('marks streams without terminal events as incomplete', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      { type: 'call_text_delta', ...base, channel: 'assistant', text: 'partial' },
    ]);

    expect(result).toMatchObject({
      status: 'incomplete',
      startedAt: 1,
      text: 'partial',
      partial: true,
      error: { code: 'missing_terminal_event' },
    });
    expect(result.endedAt).toBeGreaterThanOrEqual(result.startedAt);
    expect(result.durationMs).toBe(result.endedAt - result.startedAt);
  });

  it('keeps system progress out of aggregate result text', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      { type: 'call_text_delta', ...base, channel: 'system', text: 'running checks' },
      { type: 'call_text_delta', ...base, channel: 'stdout', text: 'raw runner answer' },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ]);

    expect(result.text).toBe('raw runner answer');
  });

  it('replaces draft text when a final result text event arrives', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      { type: 'call_text_delta', ...base, channel: 'assistant', text: 'draft text' },
      {
        type: 'call_text_delta',
        ...base,
        channel: 'result',
        text: 'final text',
        semantics: 'final',
      },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ]);

    expect(result.text).toBe('final text');
  });

  it('replaces a full-size draft with final result text', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      {
        type: 'call_text_delta',
        ...base,
        channel: 'assistant',
        text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES),
      },
      {
        type: 'call_text_delta',
        ...base,
        channel: 'result',
        text: 'final ok',
        semantics: 'final',
      },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ]);

    expect(result.status).toBe('completed');
    expect(result.text).toBe('final ok');
    expect(result.error).toBeNull();
  });

  it('treats missing text semantics as delta for backward compatibility', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      { type: 'call_text_delta', ...base, channel: 'assistant', text: 'one ' },
      { type: 'call_text_delta', ...base, channel: 'assistant', text: 'two' },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ]);

    expect(result.text).toBe('one two');
  });

  it('marks direct oversized result text as truncated', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      {
        type: 'call_text_delta',
        ...base,
        channel: 'assistant',
        text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10),
      },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ]);

    expect(result).toMatchObject({
      status: 'truncated',
      partial: true,
      error: { code: 'runner_call_text_limit' },
      warnings: [expect.objectContaining({ code: 'runner_call_text_limit' })],
    });
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      RUNNER_CALL_OUTPUT_MAX_BYTES,
    );
  });

  it('keeps stderr diagnostics out of result warnings by default', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      {
        type: 'call_stderr_delta',
        ...base,
        channel: 'stderr',
        text: 'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH + 100),
      },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ]);

    expect(result.warnings).toEqual([]);
  });

  it('surfaces bounded stderr on failure', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      {
        type: 'call_stderr_delta',
        ...base,
        channel: 'stderr',
        text: 'background progress',
      },
      {
        type: 'call_error',
        ...base,
        status: 'failed',
        error: { code: 'failed', message: 'runner failed' },
        startedAt: 1,
        endedAt: 10,
        durationMs: 9,
        partial: true,
        usage: null,
        nativeSessionId: null,
      },
    ]);

    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'stderr_on_failure',
        source: 'stderr',
        surface: 'status',
        channel: 'stderr',
        message: expect.stringContaining('background progress'),
      }),
    );
  });

  it('redacts direct unknown-upstream previews before result warnings', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      {
        type: 'call_unknown_upstream',
        ...base,
        rawPreview: 'token sk-abcdefghijklmnopqrstuvwxyz',
        backendMetadata: {
          backendKind: 'cli',
          source: 'jsonl',
          parser: 'jsonl',
          channel: 'stdout',
          upstreamType: 'mystery',
        },
      },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ]);

    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: 'unknown_upstream',
        source: 'jsonl',
        parser: 'jsonl',
        upstreamType: 'mystery',
        channel: 'stdout',
        message: expect.stringContaining('sk-***REDACTED***'),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('bounds explicit warnings to the schema message limit', () => {
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      {
        type: 'call_warning',
        ...base,
        warning: runnerWarning({
          code: 'provider_warning',
          message: 'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH + 100),
        }),
      },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ]);

    expect(result.warnings[0]).toMatchObject({
      code: 'provider_warning',
      message: `${'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH - 3)}...`,
    });
  });

  it('redacts direct warning messages before returning result warnings', () => {
    const secret = 'fakesecret1234567890';
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      {
        type: 'call_warning',
        ...base,
        warning: {
          code: 'provider_warning',
          severity: 'warning',
          source: 'provider',
          surface: 'activity',
          message: `Authorization: Bearer ${secret}`,
          fingerprint: 'rw:test',
        },
      },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
    ]);

    expect(result.warnings[0]?.message).toContain('Authorization: Bearer ***REDACTED***');
    expect(JSON.stringify(result.warnings)).not.toContain(secret);
  });

  it('caps warnings emitted for events after a terminal event', () => {
    const postTerminalEvents: RunnerCallEvent[] = Array.from({ length: 5000 }, (_, index) => ({
      type: 'call_text_delta',
      ...base,
      ts: 30 + index,
      channel: 'assistant',
      text: 'late text',
    }));
    const result = collectRunnerCallResult([
      { type: 'call_started', ...base },
      {
        type: 'call_completed',
        ...base,
        status: 'completed',
        ...completedTerminal,
      },
      ...postTerminalEvents,
    ]);

    expect(
      result.warnings.filter((warning) => warning.code === 'event_after_terminal'),
    ).toHaveLength(RUNNER_CALL_WARNING_MAX_ITEMS);
    expect(
      result.warnings.filter((warning) => warning.code === 'runner_call_warning_count_limit'),
    ).toHaveLength(1);
    expect(result.warnings).toHaveLength(RUNNER_CALL_WARNING_MAX_ITEMS + 1);
  });

  it('rejects mixed call events', () => {
    expect(() =>
      collectRunnerCallResult([
        { type: 'call_started', ...base },
        { type: 'call_started', ...base, callId: 'call-2' },
      ]),
    ).toThrow(/another call/);
  });
});
