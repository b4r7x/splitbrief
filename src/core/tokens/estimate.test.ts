import { describe, it, expect } from 'vitest';
import { estimateTokens, resolveCharsPerToken } from './estimate.js';

describe('resolveCharsPerToken', () => {
  it('returns 3.5 for Claude models', () => {
    expect(resolveCharsPerToken('claude-sonnet-4-6')).toBe(3.5);
    expect(resolveCharsPerToken('claude-opus-4-6')).toBe(3.5);
  });

  it('returns 4.0 for GPT models', () => {
    expect(resolveCharsPerToken('gpt-4o')).toBe(4.0);
  });

  it('returns 3.6 for Qwen models', () => {
    expect(resolveCharsPerToken('qwen2.5-coder:32b')).toBe(3.6);
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

  it('returns default for unknown model', () => {
    expect(resolveCharsPerToken('some-custom-model')).toBe(4);
  });

  it('returns default when no modelId provided', () => {
    expect(resolveCharsPerToken()).toBe(4);
    expect(resolveCharsPerToken(undefined)).toBe(4);
  });
});

describe('estimateTokens', () => {
  it('estimates without model (backward compatible)', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('estimates with Claude model (fewer tokens per char)', () => {
    expect(estimateTokens('a'.repeat(350), 'claude-sonnet-4-6')).toBe(100);
    expect(estimateTokens('a'.repeat(350))).toBe(88);
  });
});
