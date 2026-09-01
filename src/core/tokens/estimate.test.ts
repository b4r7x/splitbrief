import { describe, it, expect } from 'vitest';
import { estimateTokens, resolveCharsPerToken } from './estimate.js';

describe('resolveCharsPerToken', () => {
  it.each([
    ['claude-sonnet-4-6', 3.5],
    ['claude-opus-4-6', 3.5],
    ['gpt-4o', 4.0],
    ['qwen2.5-coder:32b', 3.6],
    ['some-custom-model', 4],
    [undefined, 4],
  ] as const)('resolves %s to %s chars per token', (modelId, expected) => {
    expect(resolveCharsPerToken(modelId)).toBe(expected);
  });

  it('does not match short keys as substrings of unrelated model names', () => {
    expect(resolveCharsPerToken('proto3-model')).toBe(4);
    expect(resolveCharsPerToken('foo1-bar')).toBe(4);
    expect(resolveCharsPerToken('studio4k')).toBe(4);
  });

  it('matches short keys at start or after separators', () => {
    expect(resolveCharsPerToken('o1-preview')).toBe(4.0);
    expect(resolveCharsPerToken('openrouter/o3-mini')).toBe(4.0);
    expect(resolveCharsPerToken('provider-o4-latest')).toBe(4.0);
  });
});

describe('estimateTokens', () => {
  it.each([
    ['known text', 'Hello, world!', Math.ceil(13 / 4)],
    ['empty string', '', 0],
    ['an exact multiple of 4 chars', '1234', 1],
    ['a partial trailing token', '12345', 2],
    ['a long string', 'a'.repeat(400), 100],
  ] as const)('estimates %s at 4 chars per token', (_name, text, expected) => {
    expect(estimateTokens(text)).toBe(expected);
  });

  it('estimates with the Claude 3.5 chars-per-token divisor', () => {
    expect(estimateTokens('a'.repeat(350), 'claude-sonnet-4-6')).toBe(100);
  });
});
