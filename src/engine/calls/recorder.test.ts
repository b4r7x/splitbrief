import { describe, expect, it } from 'vitest';
import { createRunnerCallRecorder } from './recorder.js';
import { RUNNER_CALL_MESSAGE_MAX_LENGTH } from './schema.js';
import {
  RUNNER_CALL_ARTIFACT_TEXT_MAX_BYTES,
  RUNNER_CALL_OUTPUT_MAX_BYTES,
  RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES,
  RUNNER_CALL_TOOL_USE_MAX_ITEMS,
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

  it('redacts a credential inside a structured answer', () => {
    const credential = 'opaque-cli-credential-canary-7d93c612';
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      credentialValues: [credential],
      onEvent: (event) => events.push(event),
    });

    const result = recorder.finishCompleted({
      endedAt: 20,
      structured: { note: `token ${credential}`, nested: [{ key: credential }], count: 2 },
    });

    expect(result.status).toBe('completed');
    if (result.status !== 'completed') throw new Error('expected a completed call');
    expect(result.structured).toMatchObject({ count: 2 });
    expect(JSON.stringify(result.structured)).not.toContain(credential);
    expect(JSON.stringify(events)).not.toContain(credential);
  });

  it('fails a structured answer past the output bound as truncated', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    const result = recorder.finishCompleted({
      endedAt: 20,
      structured: { answer: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES) },
    });

    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'runner_call_structured_limit' },
    });
    expect(JSON.stringify(events).length).toBeLessThan(RUNNER_CALL_OUTPUT_MAX_BYTES);
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

  it('does not warn about narration past the budget that a final text which fits replaced', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });

    recorder.text({ channel: 'assistant', text: 'n'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10) });
    recorder.text({ channel: 'result', text: '### Verdict\npass', semantics: 'final' });
    const result = recorder.finishCompleted({ endedAt: 20 });

    expect(result).toMatchObject({ status: 'completed', text: '### Verdict\npass', warnings: [] });
    expect(events.some((event) => event.type === 'call_warning')).toBe(false);
  });

  it('warns about a cut text on a failed terminal as well', () => {
    const recorder = createRunnerCallRecorder({ context, startedAt: 1 });

    recorder.text({ channel: 'assistant', text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES + 10) });
    const result = recorder.finishFailed({
      status: 'failed',
      error: { code: 'runner_process_error', message: 'exited' },
    });

    expect(result.warnings).toEqual([expect.objectContaining({ code: 'runner_call_text_limit' })]);
  });

  it('caps recorded tool uses at the item limit without truncating the call', () => {
    const recorder = createRunnerCallRecorder({ context, startedAt: 1 });
    for (let index = 0; index < RUNNER_CALL_TOOL_USE_MAX_ITEMS + 44; index += 1) {
      recorder.toolUseDone({
        toolUse: { id: `tool-${index}`, name: 'Read', input: {}, output: {} },
      });
    }

    const result = recorder.finishCompleted({ endedAt: 20 });

    expect(result.status).toBe('completed');
    expect(result.toolUses).toHaveLength(RUNNER_CALL_TOOL_USE_MAX_ITEMS);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'runner_call_tool_use_count_limit' }),
    ]);
  });

  it('publishes every tool completion past the item limit while the result keeps the cap', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 1,
      onEvent: (event) => events.push(event),
    });
    const total = RUNNER_CALL_TOOL_USE_MAX_ITEMS * 2 + 91;
    for (let index = 0; index < total; index += 1) {
      recorder.toolUseDone({
        toolUse: { id: `tool-${index}`, name: 'Read', input: {}, output: {} },
      });
    }

    const result = recorder.finishCompleted({ endedAt: 20 });
    const completions = events.flatMap((event) =>
      event.type === 'call_tool_use_done' ? [event.toolUse.id] : [],
    );

    expect(completions).toHaveLength(total);
    expect(completions.at(RUNNER_CALL_TOOL_USE_MAX_ITEMS)).toBe(
      `tool-${RUNNER_CALL_TOOL_USE_MAX_ITEMS}`,
    );
    expect(completions.at(-1)).toBe(`tool-${total - 1}`);
    expect(result.status).toBe('completed');
    expect(result.toolUses).toHaveLength(RUNNER_CALL_TOOL_USE_MAX_ITEMS);
    expect(
      events.filter(
        (event) =>
          event.type === 'call_warning' &&
          event.warning.code === 'runner_call_tool_use_count_limit',
      ),
    ).toHaveLength(1);
  });

  it('ends an implementer call at the tool-use bound and names the last calls', () => {
    const events: RunnerCallEvent[] = [];
    let limitCalls = 0;
    const recorder = createRunnerCallRecorder({
      context: { ...context, callId: 'call-impl', role: 'implementer' },
      startedAt: 1,
      onLimit: () => {
        limitCalls += 1;
      },
      onEvent: (event) => events.push(event),
    });
    const total = RUNNER_CALL_TOOL_USE_MAX_ITEMS + 20;
    for (let index = 0; index < total; index += 1) {
      recorder.toolUseDone({
        toolUse: { id: `tool-${index}`, name: 'Read', input: { path: `file-${index}.ts` } },
      });
    }

    const result = recorder.finishCompleted({ endedAt: 20 });

    expect(limitCalls).toBe(1);
    expect(result.status).toBe('truncated');
    expect(result.partial).toBe(true);
    expect(result.error?.code).toBe('runner_call_tool_use_count_limit');
    expect(result.error?.message).toContain(`file-${total - 1}.ts`);
    expect(result.error?.message).not.toContain('file-0.ts');
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'runner_call_tool_use_count_limit' }),
    ]);
  });

  // A tool announcement replays input that `toolUseDone` carries again, so a run with hundreds of
  // tool starts spends the delta budget on a diagnostic and must not lose its result to it. The
  // streamed stage is the result's own text and still does.
  it('keeps a call completed when announced tool input exhausts the delta budget', () => {
    const recorder = createRunnerCallRecorder({ context, startedAt: 1 });
    for (let index = 0; index < 600; index += 1) {
      recorder.toolUseDelta({
        toolUseId: `tool-${index}`,
        name: 'Write',
        inputDelta: JSON.stringify({ path: `f${index}.ts`, content: 'x'.repeat(2048) }),
        stage: 'started',
      });
    }

    const result = recorder.finishCompleted({ endedAt: 20 });

    expect(result.status).toBe('completed');
    expect(result.error).toBeNull();
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'runner_call_tool_delta_limit' }),
    ]);
  });

  it('truncates a call when streamed tool deltas exhaust the delta budget', () => {
    const recorder = createRunnerCallRecorder({ context, startedAt: 1 });
    for (let index = 0; index < 600; index += 1) {
      recorder.toolUseDelta({ toolUseId: 'tool-0', name: 'Write', inputDelta: 'x'.repeat(2048) });
    }

    const result = recorder.finishCompleted({ endedAt: 20 });

    expect(result).toMatchObject({
      status: 'truncated',
      error: { code: 'runner_call_tool_delta_limit' },
    });
  });

  it('bounds direct tool payloads without truncating the call', () => {
    const recorder = createRunnerCallRecorder({ context, startedAt: 1 });
    recorder.toolUseDone({
      toolUse: {
        id: 'tool-1',
        name: 'Write',
        input: { content: 'x'.repeat(RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES + 10) },
        output: { content: 'y'.repeat(RUNNER_CALL_TOOL_PAYLOAD_MAX_BYTES + 10) },
      },
    });

    const result = recorder.finishCompleted({ endedAt: 20 });

    expect(result.status).toBe('completed');
    expect(JSON.stringify(result.toolUses)).not.toContain('x'.repeat(1024));
    expect(JSON.stringify(result.toolUses)).not.toContain('y'.repeat(1024));
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'runner_call_tool_input_limit' }),
    ]);
  });

  it('bounds direct artifact payloads before storing result values', () => {
    const recorder = createRunnerCallRecorder({ context, startedAt: 1 });
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
    expect(result.artifacts[0]?.text).not.toContain('z'.repeat(1024));
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['runner_call_artifact_text_limit']),
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

  it('sends the feed one heartbeat a second at most and keeps none in the result', () => {
    const events: RunnerCallEvent[] = [];
    const recorder = createRunnerCallRecorder({
      context,
      startedAt: 5,
      onEvent: (event) => events.push(event),
    });

    for (const ts of [6, 7, 500, 1_005, 1_006, 2_500]) recorder.heartbeat({ ts });
    const result = recorder.finishCompleted({ endedAt: 3_000 });

    const heartbeats = events.filter((event) => event.type === 'call_heartbeat');
    expect(heartbeats.map((event) => event.ts)).toEqual([6, 1_006, 2_500]);
    expect(result).toMatchObject({ status: 'completed', warnings: [], toolUses: [] });
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
