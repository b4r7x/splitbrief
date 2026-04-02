import { describe, it, expect } from 'vitest';
import { parseTextLine, parseJsonlLine, parseOpencodeLine, getLineParser, accumulateUsage } from './output-parsers.js';

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

  it('returns text with newline for regular line', () => {
    const result = parseTextLine('hello world');
    expect(result.text).toBe('hello world\n');
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
        content: [{ type: 'text', text: 'hello' }, { type: 'output_text', text: ' world' }],
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
});

describe('getLineParser', () => {
  it('returns parseTextLine for text format', () => {
    const parser = getLineParser('text');
    expect(parser('hello')).toEqual(parseTextLine('hello'));
  });

  it('returns parseJsonlLine for jsonl format', () => {
    const parser = getLineParser('jsonl');
    expect(parser).toBe(parseJsonlLine);
  });

  it('returns parseOpencodeLine for opencode format', () => {
    const parser = getLineParser('opencode');
    expect(parser).toBe(parseOpencodeLine);
  });
});
