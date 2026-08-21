import { describe, expect, it } from 'vitest';
import { createRunnerCallRecorder } from './recorder.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import {
  RUNNER_CALL_ARTIFACT_TEXT_MAX_BYTES,
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES,
} from './output-limit.js';
import {
  TASK_BRIEF_COMPILER_POLICY,
  type TaskCompilationCallEnvelope,
} from '../../core/schemas/task-compilation.js';
import type { RunnerCallContext, RunnerCallEvent } from './types.js';

const context: RunnerCallContext = {
  callId: 'call-1',
  role: 'planner',
  backendKind: 'api',
  runnerName: 'openai',
  model: 'gpt-5',
};

function envelope(
  overrides: Readonly<Partial<TaskCompilationCallEnvelope>> = {},
): TaskCompilationCallEnvelope {
  return {
    version: 1,
    promptBytes: 512,
    inputTokensUpperBound: 512,
    requestedOutputTokens: TASK_BRIEF_COMPILER_POLICY.requestedOutputTokens,
    outputTokensUpperBound: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxNormalizedOutputBytes: TASK_BRIEF_COMPILER_POLICY.maxNormalizedOutputBytes,
    maxDeclaredArtifactBytes: TASK_BRIEF_COMPILER_POLICY.maxDeclaredArtifactBytes,
    maxRawProtocolBytes: TASK_BRIEF_COMPILER_POLICY.maxRawProtocolBytes,
    maxStderrBytes: TASK_BRIEF_COMPILER_POLICY.maxStderrBytes,
    deadlineMs: TASK_BRIEF_COMPILER_POLICY.deadlineMs,
    idleTimeoutMs: TASK_BRIEF_COMPILER_POLICY.idleTimeoutMs,
    ...overrides,
  };
}

describe('createRunnerCallRecorder', () => {
  it('stores events, calculates partial failures, and emits one terminal event', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 10,
      onEvent: (event) => events.push(event),
    });

    recorder.text({ channel: 'assistant', text: 'partial', ts: 12 });
    recorder.usage({
      usage: { inputTokens: 3, outputTokens: 2 },
      semantics: 'final',
      ts: 13,
    });
    const failed = recorder.finishFailed({
      status: 'truncated',
      error: { code: 'max_tokens', message: 'output limit reached' },
      endedAt: 20,
    });
    const duplicate = recorder.finishCompleted({ endedAt: 30 });

    expect(failed).toMatchObject({
      status: 'truncated',
      startedAt: 10,
      endedAt: 20,
      durationMs: 10,
      text: 'partial',
      partial: true,
      usage: { inputTokens: 3, outputTokens: 2 },
      error: { code: 'max_tokens', message: 'output limit reached' },
    });
    expect(duplicate).toEqual(failed);
    expect(events.filter((event) => event.type === 'call_error')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'call_completed')).toHaveLength(0);
  });

  it('finalizes missing terminal streams as incomplete terminal failures', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      onEvent: (event) => events.push(event),
    });

    const result = recorder.finalResult();

    expect(result).toMatchObject({
      status: 'incomplete',
      startedAt: 5,
      partial: false,
      error: { code: 'missing_terminal_event' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'call_error', status: 'incomplete' });
  });

  it('suppresses non-terminal events after the first terminal event', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      onEvent: (event) => events.push(event),
    });

    recorder.finishFailed({
      status: 'aborted',
      error: { code: 'aborted', message: 'user cancelled' },
      endedAt: 10,
    });
    recorder.text({ channel: 'assistant', text: 'late text', ts: 11 });
    recorder.warning({ warning: { code: 'late', message: 'late warning' }, ts: 12 });
    recorder.usage({ usage: { inputTokens: 1, outputTokens: 1 }, semantics: 'final', ts: 13 });

    expect(events.map((event) => event.type)).toEqual(['call_started', 'call_error']);
  });

  it('bounds oversized recorder warnings before emitting them', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      onEvent: (event) => events.push(event),
    });

    recorder.warning({
      warning: { code: 'oversized_warning', message: 'x'.repeat(20_000) },
      ts: 6,
    });

    expect(events.at(-1)).toMatchObject({
      type: 'call_warning',
      warning: {
        code: 'oversized_warning',
        message: expect.stringMatching(/\.\.\.$/),
      },
    });
    const last = events.at(-1);
    expect(last?.type === 'call_warning' ? last.warning.message.length : 0).toBeLessThanOrEqual(
      RUNNER_CALL_MESSAGE_MAX_LENGTH,
    );
  });

  it('redacts direct warning messages before emitting events and results', () => {
    const secret = 'fakesecret1234567890';
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      onEvent: (event) => events.push(event),
    });

    recorder.warning({
      warning: {
        code: 'provider_warning',
        message: `Authorization: Bearer ${secret}`,
      },
      ts: 6,
    });
    const result = recorder.finishCompleted({ endedAt: 10 });

    expect(events.at(-1)).toMatchObject({
      type: 'call_completed',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_warning',
        warning: expect.objectContaining({
          message: expect.stringContaining('Authorization: Bearer ***REDACTED***'),
        }),
      }),
    );
    expect(JSON.stringify(result.warnings)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it('redacts exact credential values from every diagnostic recorder surface', () => {
    const credential = 'opaque-cli-credential-canary-7d93c612';
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      credentialValues: [credential],
      onEvent: (event) => events.push(event),
    });

    recorder.text({ channel: 'assistant', text: `answer ${credential}`, ts: 6 });
    recorder.stderr({ text: `fatal debug ${credential}`, ts: 7 });
    recorder.toolUseDelta({
      toolUseId: `tool-${credential}`,
      name: 'Debug',
      inputDelta: `{"credential":"${credential}"}`,
      ts: 8,
    });
    recorder.toolUseDone({
      toolUse: {
        id: 'tool-done',
        name: 'Inspect',
        input: { credential, nested: [credential] },
        output: { diagnostic: credential },
      },
      ts: 9,
    });
    recorder.sessionId({ nativeSessionId: credential, ts: 10 });
    recorder.artifact({
      artifact: {
        id: 'artifact-1',
        source: 'stream',
        name: 'debug.txt',
        path: `/tmp/${credential}`,
        mimeType: 'text/plain',
        text: credential,
      },
      ts: 11,
    });
    recorder.warning({
      warning: { code: 'debug_warning', surface: 'debug', message: credential },
      ts: 12,
    });
    recorder.unknownUpstream({
      rawPreview: `debug=${credential}`,
      backendMetadata: { backendKind: 'api', source: credential },
      ts: 13,
    });
    const result = recorder.finishFailed({
      status: 'failed',
      error: { code: 'provider-error', message: credential },
      nativeSessionId: credential,
      endedAt: 20,
    });

    const persisted = JSON.stringify({ events, result });
    expect(persisted).not.toContain(credential);
    expect(persisted).toContain('***REDACTED***');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'debug_warning', redacted: true }),
    );
  });

  it('truncates direct recorder text and returns a truncated terminal status', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    recorder.text({ channel: 'assistant', text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10) });
    const result = recorder.finishCompleted({ endedAt: 20 });

    expect(result).toMatchObject({
      status: 'truncated',
      partial: true,
      error: { code: 'runner_call_text_limit' },
      warnings: [expect.objectContaining({ code: 'runner_call_text_limit' })],
    });
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(
      RUNNER_CALL_OUTPUT_MAX_BYTES,
    );
    expect(events.filter((event) => event.type === 'call_text_delta')).toHaveLength(1);
  });

  it('replaces a full-size draft with final result text', () => {
    const recorder = createRunnerCallRecorder({ context, startedAt: 1 });

    recorder.text({ channel: 'assistant', text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES) });
    recorder.text({ channel: 'result', text: 'final ok', semantics: 'final' });
    const result = recorder.finishCompleted({ endedAt: 20 });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('final ok');
    expect(result.error).toBeNull();
  });

  it('bounds direct tool and artifact payloads before storing result values', () => {
    const recorder = createRunnerCallRecorder({ context, startedAt: 1 });
    recorder.toolUseDone({
      toolUse: {
        id: 'tool-1',
        name: 'Write',
        input: { content: 'x'.repeat(RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES + 10) },
        output: { content: 'y'.repeat(RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES + 10) },
      },
    });
    recorder.artifact({
      artifact: {
        id: 'artifact-1',
        source: 'stream',
        name: 'large.txt',
        path: null,
        mimeType: 'text/plain',
        text: 'z'.repeat(RUNNER_CALL_ARTIFACT_TEXT_MAX_BYTES + 10),
      },
    });

    const result = recorder.finishCompleted({ endedAt: 20 });

    expect(result.status).toBe('truncated');
    expect(JSON.stringify(result.toolUses)).not.toContain('x'.repeat(1024));
    expect(JSON.stringify(result.toolUses)).not.toContain('y'.repeat(1024));
    expect(result.artifacts[0]?.text).not.toContain('z'.repeat(1024));
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['runner_call_tool_input_limit', 'runner_call_artifact_text_limit']),
    );
  });

  it('stalled and stallCleared emit stall events', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      onEvent: (event) => events.push(event),
    });

    recorder.stalled({ silentMs: 60_000, ts: 6 });
    recorder.stallCleared({ ts: 7 });

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'call_stalled', silentMs: 60_000 }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: 'call_stall_cleared' }));
  });

  it('emits a session id once per distinct value however often it is restated', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    for (let repeat = 0; repeat < 5; repeat += 1) {
      recorder.sessionId({ nativeSessionId: 'sid-1', ts: 2 + repeat });
    }
    recorder.sessionId({ nativeSessionId: 'sid-2', ts: 7 });

    expect(events.filter((event) => event.type === 'call_session_id')).toEqual([
      expect.objectContaining({ type: 'call_session_id', nativeSessionId: 'sid-1', ts: 2 }),
      expect.objectContaining({ type: 'call_session_id', nativeSessionId: 'sid-2', ts: 7 }),
    ]);
    expect(recorder.snapshot().nativeSessionId).toBe('sid-2');
  });

  it('sanitizes direct unknown-upstream raw previews before emitting events', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    recorder.unknownUpstream({
      rawPreview: 'payload sk-abcdefghijklmnopqrstuvwxyz',
      backendMetadata: { backendKind: 'api', source: 'test', parser: 'jsonl' },
      ts: 2,
    });

    const event = events.find((event) => event.type === 'call_unknown_upstream');
    expect(event).toMatchObject({
      type: 'call_unknown_upstream',
      rawPreview: expect.stringContaining('sk-***REDACTED***'),
    });
    expect(JSON.stringify(events)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});

describe('createRunnerCallRecorder with a canonical call envelope', () => {
  function envelopeContext(
    overrides: Readonly<Partial<TaskCompilationCallEnvelope>> = {},
  ): RunnerCallContext {
    return { ...context, envelope: envelope(overrides) };
  }

  it('latches the cumulative normalized bound so a shorter final response cannot clear an overflow', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ maxNormalizedOutputBytes: 100 }),
      startedAt: 1,
    });

    recorder.text({ channel: 'assistant', text: 'x'.repeat(101), ts: 100 });
    recorder.text({ channel: 'result', text: 'ok', semantics: 'final', ts: 101 });
    const result = recorder.finishCompleted({ endedAt: 200 });

    expect(result.status).toBe('truncated');
    expect(result.partial).toBe(true);
    expect(result.error).toMatchObject({ code: 'task_compiler_output_limited' });
    expect(result.text).toBe('ok');
  });

  it('accepts an exact cumulative normalized boundary and completes', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ maxNormalizedOutputBytes: 100 }),
      startedAt: 1,
    });

    recorder.text({ channel: 'assistant', text: 'x'.repeat(100), ts: 100 });
    const result = recorder.finishCompleted({ endedAt: 200 });

    expect(result.status).toBe('completed');
    expect(result.error).toBeNull();
    expect(result.text).toBe('x'.repeat(100));
  });

  it('replaces a draft with the final response only when no cumulative breach occurred', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ maxNormalizedOutputBytes: 200 }),
      startedAt: 1,
    });

    recorder.text({ channel: 'assistant', text: 'x'.repeat(150), ts: 100 });
    recorder.text({ channel: 'result', text: 'final ok', semantics: 'final', ts: 101 });
    const result = recorder.finishCompleted({ endedAt: 200 });

    expect(result.status).toBe('completed');
    expect(result.error).toBeNull();
    expect(result.text).toBe('final ok');
  });

  it('keeps the terminal failure status outranking accumulated bytes', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ maxNormalizedOutputBytes: 100 }),
      startedAt: 1,
    });

    recorder.text({ channel: 'assistant', text: 'x'.repeat(101), ts: 100 });
    const result = recorder.finishFailed({
      status: 'failed',
      error: { code: 'provider_failure', message: 'provider failed' },
      endedAt: 200,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toMatchObject({ code: 'provider_failure' });
  });

  it('latches the envelope deadline and classifies completion as a truncated timeout', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ deadlineMs: 100 }),
      startedAt: Date.now() - 200,
    });

    recorder.text({ channel: 'assistant', text: 'late' });
    const result = recorder.finishCompleted({ endedAt: Date.now() });

    expect(result.status).toBe('truncated');
    expect(result.error).toMatchObject({ code: 'task_compiler_timeout' });
  });

  it('latches an idle stall beyond the envelope idle bound', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ idleTimeoutMs: 100 }),
      startedAt: 1,
    });

    recorder.stalled({ silentMs: 101 });
    const result = recorder.finishCompleted({ endedAt: 200 });

    expect(result.status).toBe('truncated');
    expect(result.error).toMatchObject({ code: 'task_compiler_timeout' });
  });

  it('latches cumulative stderr overflow', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ maxStderrBytes: 100 }),
      startedAt: 1,
    });

    recorder.stderr({ text: 'e'.repeat(101), ts: 100 });
    const result = recorder.finishCompleted({ endedAt: 200 });

    expect(result.status).toBe('truncated');
    expect(result.error).toMatchObject({ code: 'task_compiler_output_limited' });
  });

  it('counts tool payload bytes toward the envelope raw protocol bound', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ maxRawProtocolBytes: 100 }),
      startedAt: 1,
    });

    recorder.toolUseDone({
      toolUse: { id: 'tool-1', name: 'Write', input: { content: 'y'.repeat(200) } },
      ts: 100,
    });
    const result = recorder.finishCompleted({ endedAt: 200 });

    expect(result.status).toBe('truncated');
    expect(result.error).toMatchObject({ code: 'task_compiler_output_limited' });
  });

  it('counts artifact text bytes toward the envelope raw protocol bound', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ maxRawProtocolBytes: 100 }),
      startedAt: 1,
    });

    recorder.artifact({
      artifact: {
        id: 'artifact-1',
        source: 'stream',
        name: 'large.txt',
        path: null,
        mimeType: 'text/plain',
        text: 'z'.repeat(200),
      },
      ts: 100,
    });
    const result = recorder.finishCompleted({ endedAt: 200 });

    expect(result.status).toBe('truncated');
    expect(result.error).toMatchObject({ code: 'task_compiler_output_limited' });
  });

  it('counts unknown-upstream preview bytes toward the envelope raw protocol bound', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ maxRawProtocolBytes: 100 }),
      startedAt: 1,
    });

    recorder.unknownUpstream({
      rawPreview: 'p'.repeat(200),
      backendMetadata: { backendKind: 'api', source: 'test', parser: 'jsonl' },
      ts: 100,
    });
    const result = recorder.finishCompleted({ endedAt: 200 });

    expect(result.status).toBe('truncated');
    expect(result.error).toMatchObject({ code: 'task_compiler_output_limited' });
  });

  it('classifies a latched call without a terminal as truncated rather than incomplete', () => {
    const recorder = createRunnerCallRecorder({
      context: envelopeContext({ maxNormalizedOutputBytes: 100 }),
      startedAt: 1,
    });

    recorder.text({ channel: 'assistant', text: 'x'.repeat(101), ts: 100 });
    const result = recorder.finalResult();

    expect(result.status).toBe('truncated');
    expect(result.error).toMatchObject({ code: 'task_compiler_output_limited' });
  });
});
