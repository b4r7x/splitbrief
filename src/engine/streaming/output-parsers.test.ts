import { describe, it, expect } from 'vitest';
import { parseTextLine } from './parse-text.js';
import { parseJsonlLine } from './parse-jsonl.js';
import { parseOpencodeLine } from './parse-opencode.js';
import { accumulateUsage } from './token-utils.js';

describe('parseTextLine', () => {
  it('returns empty for blank line', () => {
    expect(parseTextLine('')).toEqual({});
    expect(parseTextLine('   ')).toEqual({});
  });

  it('extracts token usage with k suffix', () => {
    const result = parseTextLine('Tokens: 1.5k sent, 0.8k received');
    expect(result.usage).toEqual({ inputTokens: 1500, outputTokens: 800 });
  });

  it('extracts token usage with plain numbers', () => {
    const result = parseTextLine('Tokens: 150 sent, 80 received');
    expect(result.usage).toEqual({ inputTokens: 150, outputTokens: 80 });
  });

  it('is case-insensitive for token matching', () => {
    const result = parseTextLine('TOKENS: 2K SENT, 1K RECEIVED');
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 1000 });
  });

  it('handles fractional k values with rounding', () => {
    const result = parseTextLine('Tokens: 0.1k sent, 0.05k received');
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('does not match partial token lines (missing received)', () => {
    const result = parseTextLine('Tokens: 1.5k sent');
    expect(result.usage).toBeUndefined();
    expect(result.text).toBe('Tokens: 1.5k sent\n');
  });

  it('handles token line with surrounding whitespace', () => {
    const result = parseTextLine('  Tokens:  500  sent,  200  received  ');
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 200 });
  });

  it('handles large plain token numbers', () => {
    const result = parseTextLine('Tokens: 128000 sent, 4096 received');
    expect(result.usage).toEqual({ inputTokens: 128000, outputTokens: 4096 });
  });
});

describe('parseJsonlLine', () => {
  it('returns empty for blank line', () => {
    expect(parseJsonlLine('')).toEqual({});
    expect(parseJsonlLine('  ')).toEqual({});
  });

  it('parses item.completed with text content array', () => {
    const event = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'output_text', text: ' world' },
        ],
      },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('hello world');
  });

  it('parses item.completed with item.text string', () => {
    const event = {
      type: 'item.completed',
      item: { type: 'agent_message', content: [], text: 'fallback text' },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('fallback text');
  });

  it('parses turn.completed with usage (input_tokens/output_tokens)', () => {
    const event = { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('parses turn.completed with usage (prompt_tokens/completion_tokens)', () => {
    const event = { type: 'turn.completed', usage: { prompt_tokens: 200, completion_tokens: 75 } };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 75 });
  });

  it('returns text from event.text field', () => {
    const event = { text: 'some text' };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('some text');
  });

  it('returns text from event.content string field', () => {
    const event = { content: 'content string' };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('content string');
  });

  it('returns empty for invalid JSON', () => {
    expect(parseJsonlLine('not json {{')).toEqual({});
  });

  it('JSON-stringifies non-string content field', () => {
    const event = { content: { key: 'value' } };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('{"key":"value"}');
  });

  it('ignores item.completed with non-agent_message type', () => {
    const event = {
      type: 'item.completed',
      item: { type: 'tool_call', content: [{ type: 'text', text: 'should skip' }] },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBeUndefined();
  });

  it('falls back to item.text when content array has no text blocks', () => {
    const event = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        content: [{ type: 'image', url: 'http://example.com' }],
        text: 'fallback',
      },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('fallback');
  });

  it('returns empty for item.completed with empty content and no item.text', () => {
    const event = {
      type: 'item.completed',
      item: { type: 'agent_message', content: [] },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result).toEqual({});
  });

  it('skips content blocks with empty text', () => {
    const event = {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        content: [
          { type: 'text', text: '' },
          { type: 'text', text: 'real text' },
        ],
      },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.text).toBe('real text');
  });

  it('prefers input_tokens over prompt_tokens when both present', () => {
    const event = {
      type: 'turn.completed',
      usage: { input_tokens: 100, prompt_tokens: 999, output_tokens: 50, completion_tokens: 888 },
    };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it('returns empty for turn.completed without usage', () => {
    const event = { type: 'turn.completed' };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result).toEqual({});
  });

  it('returns empty for event with no recognizable fields', () => {
    const event = { type: 'unknown', metadata: {} };
    const result = parseJsonlLine(JSON.stringify(event));
    expect(result).toEqual({});
  });
});

describe('parseOpencodeLine', () => {
  it('returns empty for blank line', () => {
    expect(parseOpencodeLine('')).toEqual({});
    expect(parseOpencodeLine('   ')).toEqual({});
  });

  it('parses text type event', () => {
    const event = { type: 'text', text: 'generated code' };
    const result = parseOpencodeLine(JSON.stringify(event));
    expect(result.text).toBe('generated code');
  });

  it('parses step_finish with usage tokens', () => {
    const event = { type: 'step_finish', usage: { tokens: { input: 500, output: 200 } } };
    const result = parseOpencodeLine(JSON.stringify(event));
    expect(result.usage).toEqual({ inputTokens: 500, outputTokens: 200 });
  });

  it('returns empty for invalid JSON', () => {
    expect(parseOpencodeLine('broken')).toEqual({});
  });

  it('returns empty for unknown event type', () => {
    const event = { type: 'unknown_type', data: 'whatever' };
    expect(parseOpencodeLine(JSON.stringify(event))).toEqual({});
  });

  it('ignores text type with non-string text field', () => {
    const event = { type: 'text', text: 42 };
    expect(parseOpencodeLine(JSON.stringify(event))).toEqual({});
  });

  it('handles text type with empty string', () => {
    const event = { type: 'text', text: '' };
    // empty string is still a valid string
    expect(parseOpencodeLine(JSON.stringify(event))).toEqual({ text: '' });
  });
});

describe('accumulateUsage', () => {
  it('returns delta when current is null', () => {
    const delta = { inputTokens: 100, outputTokens: 50 };
    const result = accumulateUsage(null, delta);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result).not.toBe(delta);
  });

  it('adds delta to existing current', () => {
    const current = { inputTokens: 100, outputTokens: 50 };
    const delta = { inputTokens: 200, outputTokens: 75 };
    expect(accumulateUsage(current, delta)).toEqual({ inputTokens: 300, outputTokens: 125 });
  });

  it('chains multiple accumulations correctly', () => {
    let usage = accumulateUsage(null, { inputTokens: 100, outputTokens: 50 });
    usage = accumulateUsage(usage, { inputTokens: 200, outputTokens: 100 });
    usage = accumulateUsage(usage, { inputTokens: 50, outputTokens: 25 });
    expect(usage).toEqual({ inputTokens: 350, outputTokens: 175 });
  });

  it('handles zero-value deltas', () => {
    const current = { inputTokens: 100, outputTokens: 50 };
    expect(accumulateUsage(current, { inputTokens: 0, outputTokens: 0 })).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
  });
});
