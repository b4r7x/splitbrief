import { describe, expect, it } from 'vitest';
import { RUNNER_CALL_OUTPUT_MAX_BYTES } from '../calls/output-limit.js';
import { createRunnerCallRecorder } from '../calls/recorder/create.js';
import type { RunnerCallEvent } from '../calls/types.js';
import { createParsedLineRecorder } from './parsed-line-recorder.js';

const context = {
  callId: 'parsed-1',
  role: 'planner',
  backendKind: 'cli',
} as const;

function createHarness() {
  const events: RunnerCallEvent[] = [];
  const text: string[] = [];
  const recorder = createRunnerCallRecorder({
    context,
    startedAt: 1,
    onEvent: (event) => events.push(event),
  });
  const parsed = createParsedLineRecorder({
    recorder,
    onText: (chunk) => text.push(chunk),
  });
  return { events, parsed, recorder, text };
}

describe('createParsedLineRecorder', () => {
  it('records assistant text on the assistant channel', () => {
    const { events, parsed, recorder, text } = createHarness();

    parsed.apply({ text: 'assistant answer', channel: 'assistant' });

    expect(recorder.snapshot().text).toBe('assistant answer');
    expect(text).toEqual(['assistant answer']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'assistant',
        text: 'assistant answer',
      }),
    );
  });

  it('keeps subagent text out of the call text and gives it to the live output', () => {
    const { events, parsed, recorder, text } = createHarness();

    parsed.apply({ text: 'A says hi.', channel: 'assistant', subagentId: 'toolu_a' });
    parsed.apply({ text: 'ANSWER.', channel: 'assistant' });

    expect(recorder.snapshot().text).toBe('ANSWER.');
    expect(text).toEqual(['A says hi.', 'ANSWER.']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        text: 'A says hi.',
        subagentId: 'toolu_a',
      }),
    );
  });

  it('records result text with final usage semantics', () => {
    const { events, parsed, recorder } = createHarness();

    parsed.apply({
      text: 'final answer',
      channel: 'result',
      usage: { inputTokens: 5, outputTokens: 2 },
    });

    expect(recorder.snapshot().text).toBe('final answer');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'result',
        text: 'final answer',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_usage',
        semantics: 'final',
        usage: { inputTokens: 5, outputTokens: 2 },
      }),
    );
  });

  it('records cumulative usage semantics without double-counting local totals', () => {
    const { events, parsed } = createHarness();

    parsed.apply({
      usage: { inputTokens: 10, outputTokens: 2 },
      usageSemantics: 'cumulative',
    });
    parsed.apply({
      usage: { inputTokens: 12, outputTokens: 4 },
      usageSemantics: 'cumulative',
    });

    expect(parsed.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_usage',
        semantics: 'cumulative',
        usage: { inputTokens: 12, outputTokens: 4 },
      }),
    );
  });

  it('replaces assistant draft text with final result text', () => {
    const { events, parsed, recorder, text } = createHarness();

    parsed.apply({ text: 'draft text', channel: 'assistant' });
    parsed.apply({ text: 'final text', channel: 'result' });

    expect(recorder.snapshot().text).toBe('final text');
    expect(text).toEqual(['draft text']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'result',
        text: 'final text',
        semantics: 'final',
      }),
    );
  });

  it('records final result text after a full-size assistant draft', () => {
    const { events, parsed, recorder } = createHarness();

    parsed.apply({ text: 'x'.repeat(RUNNER_CALL_OUTPUT_MAX_BYTES), channel: 'assistant' });
    parsed.apply({ text: 'final ok', channel: 'result' });

    expect(recorder.snapshot().text).toBe('final ok');
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'result',
        text: 'final ok',
        semantics: 'final',
      }),
    );
  });

  it('streams only the final suffix when result text extends assistant text', () => {
    const { events, parsed, recorder, text } = createHarness();

    parsed.apply({ text: 'draft', channel: 'assistant' });
    parsed.apply({ text: 'draft final', channel: 'result' });

    expect(recorder.snapshot().text).toBe('draft final');
    expect(text).toEqual(['draft', ' final']);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'result',
        text: 'draft final',
      }),
    );
  });

  it('keeps system progress out of result text and output callbacks', () => {
    const { events, parsed, recorder, text } = createHarness();

    parsed.apply({ text: 'installing dependencies', channel: 'system' });

    expect(recorder.snapshot().text).toBe('');
    expect(text).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'system',
        text: 'installing dependencies',
      }),
    );
  });

  it('turns a heartbeat line into a heartbeat event and no text', () => {
    const { events, parsed, text } = createHarness();

    parsed.apply({ sessionId: 'sess-1', isHeartbeat: true });

    expect(text).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'call_heartbeat' }));
    expect(events.some((event) => event.type === 'call_text_delta')).toBe(false);
  });

  it('records the model of an init frame after a hook frame of the same session', () => {
    const { events, parsed } = createHarness();

    parsed.apply({ sessionId: 's1' });
    parsed.apply({ sessionId: 's1', resolvedModel: 'claude-opus-5-5' });

    const sessions = events.filter((event) => event.type === 'call_session_id');
    expect(sessions.at(-1)).toEqual(
      expect.objectContaining({
        type: 'call_session_id',
        nativeSessionId: 's1',
        resolvedModel: 'claude-opus-5-5',
      }),
    );
  });

  it('preserves parsed tool ids in structured tool events', () => {
    const { events, parsed } = createHarness();

    parsed.apply({
      toolUse: [{ id: 'tool-1', name: 'Read', input: { file_path: 'src/main.ts' } }],
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_tool_use_done',
        toolUse: { id: 'tool-1', name: 'Read', input: { file_path: 'src/main.ts' } },
      }),
    );
  });

  it('records the finished tools of one line in order, its toolUse list before its toolUseDone list', () => {
    const { events, parsed } = createHarness();

    parsed.apply({
      toolUse: [{ id: 'tool-1', name: 'Read', input: { file_path: 'src/a.ts' }, output: 'a' }],
      toolUseDone: [
        { id: 'tool-2', name: 'Write', input: { file_path: 'src/b.ts' } },
        { id: 'tool-3', name: 'Bash', input: { command: 'ls' }, output: 'b.ts' },
      ],
    });

    expect(
      events.flatMap((event) => (event.type === 'call_tool_use_done' ? [event.toolUse] : [])),
    ).toEqual([
      { id: 'tool-1', name: 'Read', input: { file_path: 'src/a.ts' }, output: 'a' },
      { id: 'tool-2', name: 'Write', input: { file_path: 'src/b.ts' } },
      { id: 'tool-3', name: 'Bash', input: { command: 'ls' }, output: 'b.ts' },
    ]);
  });

  it('records parsed tool lifecycle deltas and warnings', () => {
    const { events, parsed } = createHarness();

    parsed.apply({
      toolUseStart: [{ id: 'tool-1', name: 'Read', input: { file_path: 'src/start.ts' } }],
      toolUseDelta: [{ id: 'tool-1', inputDelta: '{"file_path":"src/delta.ts"}' }],
      warning: [{ code: 'retry', message: 'retrying' }],
    });

    const toolDeltas = events.filter((event) => event.type === 'call_tool_use_delta');
    expect(toolDeltas).toEqual([
      expect.objectContaining({
        type: 'call_tool_use_delta',
        toolUseId: 'tool-1',
        name: 'Read',
        inputDelta: '{"file_path":"src/start.ts"}',
      }),
      expect.objectContaining({
        type: 'call_tool_use_delta',
        toolUseId: 'tool-1',
        name: 'Read',
        inputDelta: '{"file_path":"src/delta.ts"}',
      }),
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_warning',
        warning: expect.objectContaining({
          code: 'retry',
          severity: 'warning',
          source: 'provider',
          surface: 'activity',
          message: 'retrying',
          fingerprint: expect.stringMatching(/^rw:/),
        }),
      }),
    );
  });

  // The per-event output cap was dropped, so a long stream of small lines is a healthy
  // call: only the byte bound can truncate it, and 200 KB is far below it.
  it('streams 5 000 assistant lines unwarned and does not finish the call', () => {
    const { events, parsed, recorder } = createHarness();

    for (let i = 0; i < 5_000; i++) {
      parsed.apply({ text: 'x'.repeat(40), channel: 'assistant' });
    }
    parsed.apply({ text: 'final ok', channel: 'result' });

    expect(recorder.hasTerminal()).toBe(false);
    recorder.finishCompleted();
    expect(recorder.hasTerminal()).toBe(true);

    const warnings = events.filter(
      (event) => event.type === 'call_warning' && event.warning.code.endsWith('_text_limit'),
    );
    expect(warnings).toHaveLength(0);
  });

  it('notes once, at the end, when 3 MB of assistant text is the text the call ends with', () => {
    const { events, parsed, recorder, text } = createHarness();

    const chunk = 'x'.repeat(15_000);
    for (let i = 0; i < 200; i++) {
      parsed.apply({ text: chunk, channel: 'assistant' });
    }
    expect(events.some((event) => event.type === 'call_warning')).toBe(false);
    const result = recorder.finishCompleted();

    const warnings = events.filter(
      (event) => event.type === 'call_warning' && event.warning.code === 'runner_call_text_limit',
    );
    expect(warnings).toEqual([
      expect.objectContaining({
        warning: expect.objectContaining({ severity: 'debug', surface: 'debug' }),
      }),
    ]);
    expect(result.status).toBe('completed');
    expect(result.text.length).toBe(200 * chunk.length);
    expect(text.join('').length).toBe(1024 * 1024);
  });

  it('does not warn about 3 MB of narration a final text that fits replaced', () => {
    const { events, parsed, recorder } = createHarness();

    const chunk = 'x'.repeat(15_000);
    for (let i = 0; i < 200; i++) {
      parsed.apply({ text: chunk, channel: 'assistant' });
    }
    parsed.apply({ text: 'VERDICT: widen a.ts — r', channel: 'result' });
    const result = recorder.finishCompleted();

    expect(result).toMatchObject({ status: 'completed', text: 'VERDICT: widen a.ts — r' });
    expect(result.warnings).toEqual([]);
    expect(events.some((event) => event.type === 'call_warning')).toBe(false);
  });
});
