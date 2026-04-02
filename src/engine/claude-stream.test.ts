import { describe, it, expect } from 'vitest';
import { parseStreamLine } from './claude-stream.js';

describe('parseStreamLine', () => {
  it('extracts text from assistant event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        content: [
          { type: 'text', text: 'Hello world' },
          { type: 'text', text: ' more text' },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('Hello world more text');
    expect(result.sessionId).toBe('sess-1');
    expect(result.isResult).toBe(false);
    expect(result.usage).toBe(null);
    expect(result.costUsd).toBe(null);
  });

  it('extracts text, usage, and costUsd from result event', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 'sess-2',
      result: 'Final answer here',
      usage: { input_tokens: 1000, output_tokens: 500 },
      total_cost_usd: 0.42,
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('Final answer here');
    expect(result.sessionId).toBe('sess-2');
    expect(result.isResult).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect(result.costUsd).toBe(0.42);
  });

  it('extracts session_id from any event type', () => {
    const line = JSON.stringify({
      type: 'system',
      session_id: 'sess-3',
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe('sess-3');
    expect(result.isResult).toBe(false);
  });

  it('returns null fields for malformed JSON', () => {
    const result = parseStreamLine('not valid json {{{');
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe(null);
    expect(result.isResult).toBe(false);
    expect(result.usage).toBe(null);
    expect(result.costUsd).toBe(null);
  });

  it('returns null fields for empty line', () => {
    const result = parseStreamLine('');
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe(null);
    expect(result.isResult).toBe(false);
  });

  it('returns null fields for whitespace-only line', () => {
    const result = parseStreamLine('   \t  ');
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe(null);
  });

  it('handles result event without usage', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Answer',
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('Answer');
    expect(result.isResult).toBe(true);
    expect(result.usage).toBe(null);
    expect(result.costUsd).toBe(null);
    expect(result.sessionId).toBe(null);
  });

  it('handles assistant event with no text blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'something' }] },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe(null);
  });

  it('result event without total_cost_usd returns costUsd null', () => {
    const line = JSON.stringify({
      type: 'result',
      session_id: 'sess-no-cost',
      result: 'Some result',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const result = parseStreamLine(line);
    expect(result.isResult).toBe(true);
    expect(result.costUsd).toBe(null);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('assistant event with multiple content blocks concatenates text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: 'sess-multi',
      message: {
        content: [
          { type: 'text', text: 'First ' },
          { type: 'text', text: 'Second ' },
          { type: 'text', text: 'Third' },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('First Second Third');
    expect(result.sessionId).toBe('sess-multi');
  });

  it('assistant event with non-text content blocks skips them', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'read_file' },
          { type: 'text', text: 'visible text' },
          { type: 'image', source: {} },
        ],
      },
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe('visible text');
  });

  it('event with session_id but no other useful data', () => {
    const line = JSON.stringify({
      type: 'ping',
      session_id: 'sess-ping',
    });
    const result = parseStreamLine(line);
    expect(result.text).toBe(null);
    expect(result.sessionId).toBe('sess-ping');
    expect(result.isResult).toBe(false);
    expect(result.usage).toBe(null);
    expect(result.costUsd).toBe(null);
  });
});
