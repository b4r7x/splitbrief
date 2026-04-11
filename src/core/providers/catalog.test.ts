import { describe, expect, it } from 'vitest';
import { resolveDefaultApiBase, KNOWN_API_BASE_URLS } from './catalog.js';

describe('resolveDefaultApiBase', () => {
  it('returns base URL for ollama', () => {
    expect(resolveDefaultApiBase('ollama')).toBe('http://localhost:11434/v1');
  });

  it('returns base URL for lm-studio', () => {
    expect(resolveDefaultApiBase('lm-studio')).toBe('http://localhost:1234/v1');
  });

  it('returns base URL for anthropic', () => {
    expect(resolveDefaultApiBase('anthropic')).toBe('https://api.anthropic.com/v1');
  });

  it('returns base URL for openrouter', () => {
    expect(resolveDefaultApiBase('openrouter')).toBe('https://openrouter.ai/api/v1');
  });

  it('returns base URL for deepseek', () => {
    expect(resolveDefaultApiBase('deepseek')).toBe('https://api.deepseek.com/v1');
  });

  it('returns null for unknown provider', () => {
    expect(resolveDefaultApiBase('my-custom-provider')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(resolveDefaultApiBase('')).toBeNull();
  });
});

describe('KNOWN_API_BASE_URLS', () => {
  it('includes all expected providers', () => {
    expect(Object.keys(KNOWN_API_BASE_URLS)).toEqual(
      expect.arrayContaining(['ollama', 'lm-studio', 'deepseek', 'openrouter', 'anthropic']),
    );
  });
});
