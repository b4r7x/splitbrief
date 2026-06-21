import { describe, expect, it } from 'vitest';
import { createRunnerCallRecorder } from '../calls/recorder.js';
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
  return { events, parsed, text };
}

describe('createParsedLineRecorder', () => {
  it('records assistant text on the assistant channel', () => {
    const { events, parsed, text } = createHarness();

    parsed.apply({ text: 'assistant answer', channel: 'assistant' });

    expect(parsed.text).toBe('assistant answer');
    expect(text).toEqual(['assistant answer']);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'assistant',
        text: 'assistant answer',
      }),
    );
  });

  it('records result text with final usage semantics', () => {
    const { events, parsed } = createHarness();

    parsed.apply({
      text: 'final answer',
      channel: 'result',
      usage: { inputTokens: 5, outputTokens: 2 },
    });

    expect(parsed.text).toBe('final answer');
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

  it('replaces assistant draft text with final result text', () => {
    const { events, parsed, text } = createHarness();

    parsed.apply({ text: 'draft text', channel: 'assistant' });
    parsed.apply({ text: 'final text', channel: 'result' });

    expect(parsed.text).toBe('final text');
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

  it('streams only the final suffix when result text extends assistant text', () => {
    const { events, parsed, text } = createHarness();

    parsed.apply({ text: 'draft', channel: 'assistant' });
    parsed.apply({ text: 'draft final', channel: 'result' });

    expect(parsed.text).toBe('draft final');
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
    const { events, parsed, text } = createHarness();

    parsed.apply({ text: 'installing dependencies', channel: 'system' });

    expect(parsed.text).toBe('');
    expect(text).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_text_delta',
        channel: 'system',
        text: 'installing dependencies',
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

  it('records parsed tool lifecycle deltas and warnings', () => {
    const { events, parsed } = createHarness();

    parsed.apply({
      toolUseStart: [{ id: 'tool-1', name: 'Read', input: { file_path: 'src/main.ts' } }],
      toolUseDelta: [{ id: 'tool-1', inputDelta: '{"file_path":"src/main.ts"}' }],
      warning: [{ code: 'retry', message: 'retrying' }],
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_tool_use_delta',
        toolUseId: 'tool-1',
        name: 'Read',
        inputDelta: '{"file_path":"src/main.ts"}',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_tool_use_delta',
        toolUseId: 'tool-1',
        name: 'Read',
        inputDelta: '{"file_path":"src/main.ts"}',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'call_warning',
        warning: { code: 'retry', message: 'retrying' },
      }),
    );
  });
});
