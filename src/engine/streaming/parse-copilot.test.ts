import { describe, it, expect } from 'vitest';
import { parseCopilotLine } from './parse-copilot.js';

describe('copilot planner — parses the {type, data} JSON envelope', () => {
  const parse = (event: unknown) => parseCopilotLine(JSON.stringify(event));

  it('extracts the session id from session.start', () => {
    const result = parse({
      type: 'session.start',
      data: { sessionId: 'sess-42' },
      id: 'evt-1',
      timestamp: '2026-06-11T00:00:00Z',
      parentId: null,
    });
    expect(result.sessionId).toBe('sess-42');
  });

  it('extracts assistant text from data.text', () => {
    const result = parse({
      type: 'assistant.message',
      data: { text: 'compiled brief' },
      id: 'evt-2',
    });
    expect(result.text).toBe('compiled brief');
  });

  it('extracts assistant text from a data.content block array', () => {
    const result = parse({
      type: 'assistant.message',
      data: {
        content: [
          { type: 'text', text: 'part one ' },
          { type: 'text', text: 'part two' },
        ],
      },
    });
    expect(result.text).toBe('part one part two');
  });

  it('extracts token usage nested under assistant.message data', () => {
    const result = parse({
      type: 'assistant.message',
      data: {
        text: 'done',
        usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
      },
    });
    expect(result.text).toBe('done');
    expect(result.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
    });
  });

  it('extracts token usage from a standalone assistant.usage event', () => {
    const result = parse({
      type: 'assistant.usage',
      data: { usage: { inputTokens: 500, outputTokens: 120 } },
    });
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 120 });
  });

  it('extracts cache token usage from assistant events', () => {
    const result = parse({
      type: 'assistant.usage',
      data: {
        usage: {
          inputTokens: 500,
          outputTokens: 120,
          cacheWriteTokens: 30,
          cacheReadTokens: 20,
        },
      },
    });
    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 120,
      cacheReadTokens: 20,
      cacheCreateTokens: 30,
    });
  });

  it('extracts tool-use envelopes', () => {
    const result = parse({
      type: 'tool.execution_start',
      data: { name: 'read_file', input: { path: 'src/a.ts' } },
    });
    expect(result.toolUse).toEqual([{ name: 'read_file', input: { path: 'src/a.ts' } }]);
  });

  it('does not misread the codex item.completed shape as copilot output', () => {
    const result = parse({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'codex-shaped' },
    });
    expect(result.text).toBeUndefined();
    expect(result.usage).toBeUndefined();
  });

  it('returns bounded warnings for unknown event types and empty for blank lines', () => {
    expect(parseCopilotLine('')).toEqual({});
    expect(parse({ type: 'future.event', data: {} })).toEqual({
      warning: [expect.objectContaining({ code: 'unknown_copilot_record' })],
    });
  });
});
