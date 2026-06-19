import { describe, expect, it } from 'vitest';
import { collectRunnerCallResult } from './collector.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import type { RunnerCallEvent } from './types.js';

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
      { type: 'call_warning', ...base, warning: { code: 'slow', message: 'slow stream' } },
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
      warnings: [{ code: 'slow', message: 'slow stream' }],
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

  it('bounds stderr warnings to the schema message limit', () => {
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

    expect(result.warnings[0]).toEqual({
      code: 'stderr',
      message: `${'x'.repeat(RUNNER_CALL_MESSAGE_MAX_LENGTH - 3)}...`,
    });
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
