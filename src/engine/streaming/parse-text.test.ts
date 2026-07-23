import { describe, it, expect } from 'vitest';
import { parseTextLine } from './parse-text.js';

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
    expect(result.channel).toBe('stdout');
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
