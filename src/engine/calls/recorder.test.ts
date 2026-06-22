import { describe, expect, it } from 'vitest';
import { createRunnerCallRecorder } from './recorder.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import {
  RUNNER_CALL_ARTIFACT_TEXT_MAX_BYTES,
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES,
} from './output-limit.js';
import type { RunnerCallContext, RunnerCallEvent } from './types.js';

const context: RunnerCallContext = {
  callId: 'call-1',
  role: 'planner',
  backendKind: 'api',
  runnerName: 'openai',
  model: 'gpt-5',
};

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
