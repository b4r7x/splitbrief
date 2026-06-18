import { describe, expect, it } from 'vitest';
import { collectRunnerCallResult } from './collector.js';
import type { RunnerCallEvent } from './types.js';

const base = {
  ts: 1,
  callId: 'call-1',
  role: 'planner',
  backendKind: 'cli',
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
        usage: null,
        nativeSessionId: 'native-1',
      },
    ];

    expect(collectRunnerCallResult(events)).toEqual({
      callId: 'call-1',
      role: 'planner',
      backendKind: 'cli',
      status: 'completed',
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
      },
    ]);

    expect(result).toMatchObject({
      status: 'timeout',
      text: 'partial',
      partial: true,
      error: { code: 'timeout', message: 'runner timed out' },
    });
  });

  it('marks streams without terminal events as incomplete', () => {
    expect(
      collectRunnerCallResult([
        { type: 'call_started', ...base },
        { type: 'call_text_delta', ...base, channel: 'assistant', text: 'partial' },
      ]),
    ).toMatchObject({
      status: 'incomplete',
      text: 'partial',
      partial: true,
      error: { code: 'missing_terminal_event' },
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
