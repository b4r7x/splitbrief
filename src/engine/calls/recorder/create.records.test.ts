import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_STDERR_MAX_BYTES,
  RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES,
} from '../output-limit.js';
import type { RunnerCallContext, RunnerCallEvent } from '../types.js';
import { createRunnerCallRecorder } from './create.js';
import type { RunnerCallRecorder } from './types.js';

const context: RunnerCallContext = {
  callId: 'call-1',
  role: 'planner',
  backendKind: 'api',
  runnerName: 'openai',
  model: 'gpt-5',
};

describe('runner call records', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: 5_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A record keeps the field order a log line has; a random tool use id reads as `<id-N>` in the
  // order it first appears, and a run of one character reads as its length.
  function recordLines(records: readonly unknown[]): string[] {
    const ids = new Map<string, string>();
    return records.map((record) =>
      JSON.stringify(record)
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
          const known = ids.get(id) ?? `<id-${ids.size + 1}>`;
          ids.set(id, known);
          return known;
        })
        .replace(/(.)\1{63,}/g, (run, char: string) => `<${char}*${run.length}>`),
    );
  }

  function recordOf(callContext: RunnerCallContext) {
    return (type: RunnerCallEvent['type'], ts: number, fields: Record<string, unknown> = {}) => ({
      type,
      ts,
      ...callContext,
      ...fields,
    });
  }

  const record = recordOf(context);

  const textLimitNote = {
    code: 'runner_call_text_limit',
    severity: 'debug',
    source: 'system',
    surface: 'debug',
    message: 'The reply was larger than 1 MB and was not kept in full.',
    fingerprint: 'rw:3a7bc85c667a3fa6dfa1342f',
  };
  const textLimitResultNote = {
    code: 'runner_call_text_limit',
    severity: 'debug',
    source: 'system',
    surface: 'debug',
    fingerprint: 'rw:3a7bc85c667a3fa6dfa1342f',
    message: 'The reply was larger than 1 MB and was not kept in full.',
  };

  it('writes each record of a completed call whole and in the order of its steps', () => {
    const credential = 'opaque-record-credential-5b1e';
    const events: RunnerCallEvent[] = [];
    let atTerminal: unknown;
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 10,
      credentialValues: [credential],
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'call_completed') {
          atTerminal = { terminal: recorder.hasTerminal(), status: recorder.snapshot().status };
        }
      },
    });

    recorder.runtimeStatus({ phase: 'waiting-first-response', loadState: 'loaded' });
    recorder.sessionId({ nativeSessionId: 'sid-1', ts: 11 });
    recorder.sessionId({ nativeSessionId: 'sid-1', resolvedModel: 'model-1', ts: 12 });
    recorder.sessionId({ nativeSessionId: 'sid-1', ts: 13 });
    recorder.text({ channel: 'assistant', text: `Reading ${credential}`, ts: 14 });
    recorder.stderr({ text: 'warn: slow disk', ts: 15 });
    recorder.stderr({ text: 'retrying', ts: 16 });
    recorder.toolUseDelta({
      toolUseId: 'tool-1',
      name: 'Read',
      inputDelta: '{"path":',
      stage: 'started',
      ts: 17,
    });
    recorder.toolUseDelta({ toolUseId: null, name: null, inputDelta: '"a.ts"}', ts: 18 });
    recorder.toolUseDone({
      toolUse: { id: null, name: 'Read', input: { path: 'a.ts' }, output: { lines: 3 } },
      ts: 19,
    });
    recorder.toolUseDelta({ toolUseId: null, name: null, inputDelta: '[]', ts: 19 });
    recorder.toolUseDelta({
      toolUseId: null,
      name: 'Write',
      inputDelta: '{}',
      stage: 'started',
      ts: 20,
    });
    recorder.toolUseDelta({ toolUseId: null, name: 'Edit', inputDelta: '{}', ts: 21 });
    recorder.toolUseDone({ toolUse: { id: null, name: 'Edit', input: {} }, ts: 22 });
    recorder.heartbeat({ ts: 23 });
    recorder.heartbeat({ ts: 500 });
    recorder.heartbeat({ ts: 1_023 });
    recorder.stalled({ silentMs: 60_000, ts: 1_100 });
    recorder.stallCleared({ ts: 1_101 });
    recorder.stalled({ silentMs: -1, ts: 1_101 });
    recorder.warning({ warning: { code: 'provider_warning', message: 'slow stream' }, ts: 1_103 });
    recorder.unknownUpstream({
      rawPreview: 'odd frame',
      backendMetadata: { backendKind: 'api', source: 'test', parser: 'jsonl' },
      ts: 1_104,
    });

    recorder.text({ channel: 'result', text: 'Done.', semantics: 'final', ts: 1_106 });
    const result = recorder.finishCompleted({ endedAt: 1_200, structured: { verdict: 'pass' } });

    const invalidStall =
      'Invalid runner call event: silentMs: Too small: expected number to be >=0 {"type":"call_stalled","ts":1101,"callId":"call-1","role":"planner","backendKind":"api","runnerName":"openai","model":"gpt-5","silentMs":-1}';
    expect(recordLines([...events, result])).toEqual(
      recordLines([
        record('call_started', 10),
        record('call_runtime_status', 5_000, {
          runtimeStatus: { phase: 'waiting-first-response', loadState: 'loaded' },
        }),
        record('call_session_id', 11, { nativeSessionId: 'sid-1' }),
        record('call_session_id', 12, { nativeSessionId: 'sid-1', resolvedModel: 'model-1' }),
        record('call_text_delta', 14, { channel: 'assistant', text: 'Reading ***REDACTED***' }),
        record('call_warning', 5_000, {
          warning: {
            code: 'stderr_diagnostic',
            severity: 'warning',
            source: 'stderr',
            surface: 'status',
            channel: 'stderr',
            message: 'warn: slow disk',
            fingerprint: 'rw:3de9b0395280bbe5087976c9',
          },
        }),
        record('call_stderr_delta', 15, { channel: 'stderr', text: 'warn: slow disk' }),
        record('call_stderr_delta', 16, { channel: 'stderr', text: 'retrying' }),
        record('call_tool_use_delta', 17, {
          channel: 'tool',
          toolUseId: 'tool-1',
          name: 'Read',
          inputDelta: '{"path":',
        }),
        record('call_tool_use_delta', 18, {
          channel: 'tool',
          toolUseId: 'tool-1',
          name: 'Read',
          inputDelta: '"a.ts"}',
        }),
        record('call_tool_use_done', 19, {
          channel: 'tool',
          toolUse: { id: 'tool-1', name: 'Read', input: { path: 'a.ts' }, output: { lines: 3 } },
        }),
        record('call_tool_use_delta', 19, {
          channel: 'tool',
          toolUseId: '<id-1>',
          name: null,
          inputDelta: '[]',
        }),
        record('call_tool_use_delta', 20, {
          channel: 'tool',
          toolUseId: '<id-2>',
          name: 'Write',
          inputDelta: '{}',
        }),
        record('call_tool_use_delta', 21, {
          channel: 'tool',
          toolUseId: '<id-3>',
          name: 'Edit',
          inputDelta: '{}',
        }),
        record('call_tool_use_done', 22, {
          channel: 'tool',
          toolUse: { id: '<id-3>', name: 'Edit', input: {} },
        }),
        record('call_heartbeat', 23),
        record('call_heartbeat', 1_023),
        record('call_stalled', 1_100, { silentMs: 60_000 }),
        record('call_stall_cleared', 1_101),
        record('call_unknown_upstream', 1_101, {
          rawPreview: invalidStall,
          backendMetadata: { backendKind: 'api', source: 'recorder', upstreamType: 'call_stalled' },
        }),
        record('call_warning', 1_103, {
          warning: {
            code: 'provider_warning',
            severity: 'warning',
            source: 'provider',
            surface: 'activity',
            fingerprint: 'rw:31ed519a820b71b59c33b799',
            message: 'slow stream',
          },
        }),
        record('call_unknown_upstream', 1_104, {
          rawPreview: 'odd frame',
          backendMetadata: { backendKind: 'api', source: 'test', parser: 'jsonl' },
        }),
        record('call_text_delta', 1_106, { channel: 'result', text: 'Done.', semantics: 'final' }),
        record('call_completed', 1_200, {
          status: 'completed',
          error: null,
          partial: false,
          startedAt: 10,
          endedAt: 1_200,
          durationMs: 1_190,

          nativeSessionId: 'sid-1',
          structured: { verdict: 'pass' },
        }),
        {
          ...context,
          status: 'completed',
          startedAt: 10,
          endedAt: 1_200,
          durationMs: 1_190,
          text: 'Done.',

          nativeSessionId: 'sid-1',
          toolUses: [
            { id: 'tool-1', name: 'Read', input: { path: 'a.ts' }, output: { lines: 3 } },
            { id: '<id-3>', name: 'Edit', input: {} },
          ],
          warnings: [
            {
              code: 'stderr_diagnostic',
              severity: 'warning',
              source: 'stderr',
              surface: 'status',
              channel: 'stderr',
              fingerprint: 'rw:3de9b0395280bbe5087976c9',
              message: 'warn: slow disk',
            },
            {
              code: 'unknown_upstream',
              severity: 'warning',
              source: 'recorder',
              surface: 'debug',
              upstreamType: 'call_stalled',
              fingerprint: 'rw:9dafa9e3928e5e6e414b779c',
              message: invalidStall,
            },
            {
              code: 'provider_warning',
              severity: 'warning',
              source: 'provider',
              surface: 'activity',
              fingerprint: 'rw:31ed519a820b71b59c33b799',
              message: 'slow stream',
            },
            {
              code: 'unknown_upstream',
              severity: 'warning',
              source: 'test',
              surface: 'debug',
              parser: 'jsonl',
              fingerprint: 'rw:e904c77ee7d401870d21ab00',
              message: 'odd frame',
            },
          ],
          error: null,
          partial: false,
          structured: { verdict: 'pass' },
        },
      ]),
    );
    expect(atTerminal).toEqual({ terminal: true, status: 'completed' });
  });

  it('writes the cut text note, then the stderr note, then the error of a failed call', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    recorder.text({
      channel: 'assistant',
      text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10),
      ts: 2,
    });
    recorder.text({ channel: 'assistant', text: 'tail', ts: 2 });
    recorder.stderr({ text: 'disk full', ts: 3 });
    const result = recorder.finishFailed({
      status: 'failed',
      error: {
        code: 'provider-error',
        message: 'exit 1\nat line 2',
        status: 500,
        providerType: 'server_error',
      },
      endedAt: 9,
    });

    const error = {
      code: 'provider-error',
      message: 'exit 1\nat line 2',
      status: 500,
      providerType: 'server_error',
    };
    expect(recordLines([...events, result])).toEqual(
      recordLines([
        record('call_started', 1),
        record('call_text_delta', 2, {
          channel: 'assistant',
          text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES),
        }),
        record('call_stderr_delta', 3, { channel: 'stderr', text: 'disk full' }),
        record('call_warning', 5_000, { warning: textLimitNote }),
        record('call_warning', 5_000, {
          warning: {
            code: 'stderr_on_failure',
            severity: 'warning',
            source: 'stderr',
            surface: 'status',
            channel: 'stderr',
            message: 'disk full ',
            fingerprint: 'rw:6ab87e158e72b012c46b64b3',
          },
        }),
        record('call_error', 9, {
          status: 'failed',
          error,
          partial: true,
          rawTail: 'exit 1',
          startedAt: 1,
          endedAt: 9,
          durationMs: 8,

          nativeSessionId: null,
        }),
        {
          ...context,
          status: 'failed',
          startedAt: 1,
          endedAt: 9,
          durationMs: 8,
          text: `${'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10)}tail`,

          nativeSessionId: null,
          toolUses: [],
          warnings: [
            textLimitResultNote,
            {
              code: 'stderr_on_failure',
              severity: 'warning',
              source: 'stderr',
              surface: 'status',
              channel: 'stderr',
              fingerprint: 'rw:6ab87e158e72b012c46b64b3',
              message: 'disk full ',
            },
          ],
          error,
          partial: true,
        },
      ]),
    );
  });

  it('stops a call after the tool use past its stop, with no cut text note and no stderr note that a stderr warning gave', () => {
    const events: RunnerCallEvent[] = [];
    const atLimit: string[][] = [];
    const implementerContext: RunnerCallContext = { ...context, role: 'implementer' };
    const implementerRecord = recordOf(implementerContext);
    const recorder = createRunnerCallRecorder({
      context: implementerContext,
      startedAt: 1,
      stopAfterToolUses: 1,
      onEvent: (event) => events.push(event),
      onLimit: () => atLimit.push(events.map((event) => event.type)),
    });

    recorder.text({
      channel: 'assistant',
      text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10),
      ts: 2,
    });
    recorder.warning({
      warning: {
        code: 'tool_stderr',
        source: 'stderr',
        channel: 'stderr',
        message: 'warn: from the parser',
      },
      ts: 3,
    });
    recorder.stderr({ text: 'disk full', ts: 3 });
    recorder.toolUseDone({
      toolUse: { id: 'tool-0', name: 'Read', input: { path: 'a.ts' } },
      ts: 4,
    });
    recorder.toolUseDone({
      toolUse: { id: 'tool-1', name: 'Read', input: { path: 'b.ts' } },
      ts: 5,
    });
    const result = recorder.finishCompleted({ endedAt: 9 });

    const stopWarning = {
      code: 'tool_stderr',
      severity: 'warning',
      source: 'stderr',
      surface: 'activity',
      channel: 'stderr',
      fingerprint: 'rw:f137731327a9638b06d14df0',
      message: 'warn: from the parser',
    };
    const error = {
      code: 'runner_call_tool_use_stop',
      message:
        'The call reached the maxToolCalls limit of 1 tool calls and was stopped.\nRecent tool calls:\n- Read: {"path":"a.ts"}\n- Read: {"path":"b.ts"}',
    };
    const toolUses = [
      { id: 'tool-0', name: 'Read', input: { path: 'a.ts' } },
      { id: 'tool-1', name: 'Read', input: { path: 'b.ts' } },
    ];
    expect(recordLines([...events, result])).toEqual(
      recordLines([
        implementerRecord('call_started', 1),
        implementerRecord('call_text_delta', 2, {
          channel: 'assistant',
          text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES),
        }),
        implementerRecord('call_warning', 3, { warning: stopWarning }),
        implementerRecord('call_stderr_delta', 3, { channel: 'stderr', text: 'disk full' }),
        implementerRecord('call_tool_use_done', 4, { channel: 'tool', toolUse: toolUses[0] }),
        implementerRecord('call_tool_use_done', 5, { channel: 'tool', toolUse: toolUses[1] }),
        implementerRecord('call_error', 9, {
          status: 'truncated',
          error,
          partial: true,
          rawTail: 'The call reached the maxToolCalls limit of 1 tool calls and was stopped.',
          startedAt: 1,
          endedAt: 9,
          durationMs: 8,

          nativeSessionId: null,
        }),
        {
          ...implementerContext,
          status: 'truncated',
          startedAt: 1,
          endedAt: 9,
          durationMs: 8,
          text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10),

          nativeSessionId: null,
          toolUses,
          warnings: [stopWarning],
          error,
          partial: true,
        },
      ]),
    );
    expect(atLimit).toEqual([
      [
        'call_started',
        'call_text_delta',
        'call_warning',
        'call_stderr_delta',
        'call_tool_use_done',
        'call_tool_use_done',
      ],
    ]);
  });

  it('writes the cut text note and the structured note before the completed record', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    recorder.text({
      channel: 'assistant',
      text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10),
      ts: 2,
    });
    const result = recorder.finishCompleted({
      endedAt: 9,
      structured: { answer: 'y'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES) },
    });

    expect(recordLines([...events, result])).toEqual(
      recordLines([
        record('call_started', 1),
        record('call_text_delta', 2, {
          channel: 'assistant',
          text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES),
        }),
        record('call_warning', 5_000, { warning: textLimitNote }),
        record('call_warning', 5_000, {
          warning: {
            code: 'runner_call_structured_limit',
            severity: 'debug',
            source: 'system',
            surface: 'debug',
            message: 'The answer was larger than 1 MB and was not kept in full.',
            fingerprint: 'rw:5bfb10255aca3d5ad166c6f5',
          },
        }),
        record('call_completed', 9, {
          status: 'completed',
          error: null,
          partial: false,
          startedAt: 1,
          endedAt: 9,
          durationMs: 8,

          nativeSessionId: null,
          structured: '[... oversized payload omitted ...]',
        }),
        {
          ...context,
          status: 'completed',
          startedAt: 1,
          endedAt: 9,
          durationMs: 8,
          text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10),

          nativeSessionId: null,
          toolUses: [],
          warnings: [
            textLimitResultNote,
            {
              code: 'runner_call_structured_limit',
              severity: 'debug',
              source: 'system',
              surface: 'debug',
              fingerprint: 'rw:5bfb10255aca3d5ad166c6f5',
              message: 'The answer was larger than 1 MB and was not kept in full.',
            },
          ],
          error: null,
          partial: false,
          structured: { answer: 'y'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES) },
        },
      ]),
    );
  });

  it('writes each bound note next to the record that reached the bound', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    recorder.text({
      channel: 'assistant',
      subagentId: 'agent-1',
      text: 's'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 1),
      ts: 2,
    });
    recorder.stderr({ text: 'e'.repeat(RUNNER_CALL_STDERR_MAX_BYTES + 1), ts: 3 });
    recorder.toolUseDelta({
      toolUseId: 'tool-1',
      name: 'Write',
      inputDelta: 'd'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 1),
      ts: 4,
    });
    recorder.toolUseDone({
      toolUse: {
        id: 'tool-1',
        name: 'Write',
        input: { content: 'i'.repeat(RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES + 1) },
      },
      ts: 5,
    });
    const result = recorder.finishCompleted({ endedAt: 9 });

    const omitted = '[... oversized payload omitted ...]';
    const note = (code: string, message: string, fingerprint: string) => ({
      code,
      severity: 'debug',
      source: 'system',
      surface: 'debug',
      message,
      fingerprint,
    });
    const notes = [
      textLimitNote,
      note(
        'runner_call_stderr_limit',
        'The tool error output was larger than 64 KB and was not kept in full.',
        'rw:9cc536045608c839eda377ad',
      ),
      note(
        'runner_call_tool_delta_limit',
        'The streamed tool input was larger than 1 MB and was not kept in full.',
        'rw:7fc89c8f47791443e558519e',
      ),
      note(
        'runner_call_tool_input_limit',
        'A tool call input was larger than 256 KB and was not kept in full.',
        'rw:8def01925756718e3e3b6f2c',
      ),
    ];
    const toolUse = { id: 'tool-1', name: 'Write', input: { _truncated: omitted } };
    expect(recordLines([...events, result])).toEqual(
      recordLines([
        record('call_started', 1),
        record('call_text_delta', 2, {
          channel: 'assistant',
          text: 's'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES),
          subagentId: 'agent-1',
        }),
        record('call_warning', 5_000, { warning: notes[0] }),
        record('call_stderr_delta', 3, {
          channel: 'stderr',
          text: 'e'.repeat(RUNNER_CALL_STDERR_MAX_BYTES),
        }),
        record('call_warning', 5_000, { warning: notes[1] }),
        record('call_tool_use_delta', 4, {
          channel: 'tool',
          toolUseId: 'tool-1',
          name: 'Write',
          inputDelta: 'd'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES),
        }),
        record('call_warning', 5_000, { warning: notes[2] }),
        record('call_warning', 5_000, { warning: notes[3] }),
        record('call_tool_use_done', 5, { channel: 'tool', toolUse }),
        record('call_completed', 9, {
          status: 'completed',
          error: null,
          partial: false,
          startedAt: 1,
          endedAt: 9,
          durationMs: 8,

          nativeSessionId: null,
        }),
        {
          ...context,
          status: 'completed',
          startedAt: 1,
          endedAt: 9,
          durationMs: 8,
          text: '',

          nativeSessionId: null,
          toolUses: [toolUse],
          warnings: notes.map(({ message, fingerprint, ...fields }) => ({
            ...fields,
            fingerprint,
            message,
          })),
          error: null,
          partial: false,
        },
      ]),
    );
  });

  it('keeps the budget of a subagent text apart from the budget of the main text', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    recorder.text({
      channel: 'assistant',
      subagentId: 'agent-1',
      text: 's'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 1),
      ts: 2,
    });
    recorder.text({ channel: 'assistant', text: 'Main answer.', ts: 3 });
    const result = recorder.finishCompleted({ endedAt: 9 });

    expect(recordLines(events)).toEqual(
      recordLines([
        record('call_started', 1),
        record('call_text_delta', 2, {
          channel: 'assistant',
          text: 's'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES),
          subagentId: 'agent-1',
        }),
        record('call_warning', 5_000, { warning: textLimitNote }),
        record('call_text_delta', 3, { channel: 'assistant', text: 'Main answer.' }),
        record('call_completed', 9, {
          status: 'completed',
          error: null,
          partial: false,
          startedAt: 1,
          endedAt: 9,
          durationMs: 8,

          nativeSessionId: null,
        }),
      ]),
    );
    expect(result.text).toBe('Main answer.');
  });

  it('redacts a credential before a bound cuts the text, the stderr and the tool input', () => {
    const credential = 'opaque-cut-credential-9f3a2c';
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      credentialValues: [credential],
      onEvent: (event) => events.push(event),
    });

    recorder.text({
      channel: 'assistant',
      text: `${'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES - 10)}${credential}`,
      ts: 2,
    });
    recorder.stderr({
      text: `${'e'.repeat(RUNNER_CALL_STDERR_MAX_BYTES - 10)}${credential}`,
      ts: 3,
    });
    recorder.toolUseDelta({
      toolUseId: 'tool-1',
      name: 'Write',
      inputDelta: `${'d'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES - 10)}${credential}`,
      ts: 4,
    });
    const result = recorder.finishCompleted({ endedAt: 9 });

    const cut = recordLines(
      events.filter((event) =>
        ['call_text_delta', 'call_stderr_delta', 'call_tool_use_delta'].includes(event.type),
      ),
    );
    expect(cut).toEqual([
      expect.stringContaining('"text":"<x*1048566>***REDACTE"'),
      expect.stringContaining('"text":"<e*65526>***REDACTE"'),
      expect.stringContaining('"inputDelta":"<d*1048566>***REDACTE"'),
    ]);
    expect(JSON.stringify({ events, result })).not.toContain(credential.slice(0, 10));
  });

  it('writes nothing after the terminal record of a call', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    recorder.text({ channel: 'assistant', text: 'partial', ts: 2 });
    const ended = recorder.finalResult();
    recorder.runtimeStatus({ phase: 'streaming', loadState: 'loaded' });
    recorder.text({ channel: 'assistant', text: 'late', ts: 3 });
    recorder.text({ channel: 'assistant', subagentId: 'agent-1', text: 'late', ts: 3 });
    recorder.stderr({ text: 'warn: late', ts: 3 });
    recorder.toolUseDelta({ toolUseId: 'tool-1', name: 'Read', inputDelta: '{}', ts: 3 });
    recorder.toolUseDone({ toolUse: { id: 'tool-1', name: 'Read', input: {} }, ts: 3 });

    recorder.sessionId({ nativeSessionId: 'sid-late', ts: 3 });
    recorder.warning({ warning: { code: 'late', message: 'late warning' }, ts: 3 });
    recorder.unknownUpstream({
      rawPreview: 'late',
      backendMetadata: { backendKind: 'api', source: 'test', parser: 'jsonl' },
      ts: 3,
    });
    recorder.stalled({ silentMs: 60_000, ts: 3 });
    recorder.stallCleared({ ts: 3 });
    recorder.heartbeat({ ts: 3 });
    const later = [
      recorder.finishCompleted({ endedAt: 4 }),
      recorder.finishFailed({
        status: 'failed',
        error: { code: 'late', message: 'late failure' },
        endedAt: 4,
      }),
      recorder.finalResult(),
      recorder.snapshot(),
    ];

    const error = {
      code: 'missing_terminal_event',
      message: 'Runner call ended without a terminal event',
    };
    expect(recordLines([...events, ended])).toEqual(
      recordLines([
        record('call_started', 1),
        record('call_text_delta', 2, { channel: 'assistant', text: 'partial' }),
        record('call_error', 5_000, {
          status: 'incomplete',
          error,
          partial: true,
          rawTail: 'Runner call ended without a terminal event',
          startedAt: 1,
          endedAt: 5_000,
          durationMs: 4_999,

          nativeSessionId: null,
        }),
        {
          ...context,
          status: 'incomplete',
          startedAt: 1,
          endedAt: 5_000,
          durationMs: 4_999,
          text: 'partial',

          nativeSessionId: null,
          toolUses: [],
          warnings: [],
          error,
          partial: true,
        },
      ]),
    );
    expect(recorder.hasTerminal()).toBe(true);
    expect(later).toEqual([ended, ended, ended, ended]);
  });

  it('writes one terminal record when a callback finishes the call inside a finish note', () => {
    const types: RunnerCallEvent['type'][] = [];
    const recorder: RunnerCallRecorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => {
        types.push(event.type);
        if (event.type === 'call_warning' && event.warning.code === 'runner_call_text_limit') {
          recorder.finishFailed({ status: 'failed', error: { code: 'inner', message: 'inner' } });
        }
      },
    });

    recorder.text({
      channel: 'assistant',
      text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10),
      ts: 2,
    });
    const result = recorder.finishCompleted({ endedAt: 9 });

    expect(types).toEqual(['call_started', 'call_text_delta', 'call_warning', 'call_error']);
    expect(result.status).toBe('failed');
  });
});
