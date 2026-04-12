import { describe, it, expect } from 'vitest';
import { formatModelName, resolveAutoModel } from './providers.js';

describe('resolveAutoModel', () => {
  it('returns undefined for "auto"', () => {
    expect(resolveAutoModel('auto')).toBeUndefined();
  });

  it('returns undefined when model is undefined', () => {
    expect(resolveAutoModel(undefined)).toBeUndefined();
  });

  it('passes through a real model name', () => {
    expect(resolveAutoModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('resolves empty string to undefined', () => {
    expect(resolveAutoModel('')).toBeUndefined();
  });

  it('resolves whitespace-only string to undefined', () => {
    expect(resolveAutoModel('   ')).toBeUndefined();
  });

  it('is case-insensitive for "Auto"', () => {
    expect(resolveAutoModel('Auto')).toBeUndefined();
  });

  it('is case-insensitive for "AUTO"', () => {
    expect(resolveAutoModel('AUTO')).toBeUndefined();
  });

  it('is case-insensitive for "aUtO"', () => {
    expect(resolveAutoModel('aUtO')).toBeUndefined();
  });
});

describe('formatModelName', () => {
  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(formatModelName('')).toBe('');
    });

    it('returns the ID unchanged for single-word unknown model', () => {
      expect(formatModelName('custom')).toBe('Custom');
    });

    it('handles already-pretty names gracefully', () => {
      expect(formatModelName('MyModel')).toBe('MyModel');
    });
  });
});

describe('formatModelName (heuristic)', () => {
  describe('brand capitalization', () => {
    it.each([
      ['claude-haiku-5-2', 'Claude Haiku 5.2'],
      ['gpt-6-turbo', 'GPT-6 Turbo'],
      ['gemini-4-flash', 'Gemini 4 Flash'],
      ['deepseek-v4', 'DeepSeek V4'],
      ['mistral-medium', 'Mistral Medium'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('compound brand+version tokens', () => {
    it.each([
      ['qwen3-coder', 'Qwen 3 Coder'],
      ['llama4', 'Llama 4'],
      ['gemma4', 'Gemma 4'],
      ['phi4-mini', 'Phi 4 Mini'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('Ollama tags', () => {
    it.each([
      ['gemma4:31b-cloud', 'Gemma 4 31B Cloud'],
      ['llama3:8b', 'Llama 3 8B'],
      ['somemodel:latest', 'Somemodel'],
      ['deepseek-coder:6.7b', 'DeepSeek Coder 6.7B'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('size indicators', () => {
    it.each([
      ['custom-model-7b', 'Custom Model 7B'],
      ['custom-model-70b', 'Custom Model 70B'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('o-series', () => {
    it.each([
      ['o5-turbo', 'o5 Turbo'],
      ['o6-mini', 'o6 Mini'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('version prefixes', () => {
    it.each([
      ['deepseek-coder-v3', 'DeepSeek Coder V3'],
      ['custom-v2-pro', 'Custom V2 Pro'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('vendor prefix stripping', () => {
    it('strips unknown vendor prefixes', () => {
      expect(formatModelName('custom-org/some-model')).toBe('Some Model');
    });
  });

  describe('GPT hyphen format', () => {
    it('preserves hyphen after GPT brand', () => {
      expect(formatModelName('gpt-7-nano')).toBe('GPT-7 Nano');
    });
  });
});
