import { describe, it, expect } from 'vitest';
import { formatModelName, formatToolModel } from './model-display.js';

describe('formatModelName', () => {
  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(formatModelName('')).toBe('');
    });

    it('formats default as capitalized word (no longer special case)', () => {
      expect(formatModelName('default')).toBe('Default');
    });

    it('returns the ID unchanged for single-word unknown model', () => {
      expect(formatModelName('custom')).toBe('Custom');
    });

    it('returns already-pretty names unchanged', () => {
      expect(formatModelName('MyModel')).toBe('MyModel');
    });
  });
});

describe('formatModelName (heuristic)', () => {
  it.each([
    ['claude-haiku-5-2', 'Claude Haiku 5.2'],
    ['gpt-6-turbo', 'GPT-6 Turbo'],
    ['gemini-4-flash', 'Gemini 4 Flash'],
    ['deepseek-v4', 'DeepSeek V4'],
    ['mistral-medium', 'Mistral Medium'],
  ])('brand capitalization: %s → %s', (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });

  it.each([
    ['qwen3-coder', 'Qwen 3 Coder'],
    ['llama4', 'Llama 4'],
    ['gemma4', 'Gemma 4'],
    ['phi4-mini', 'Phi 4 Mini'],
  ])('compound tokens: %s → %s', (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });

  it.each([
    ['gemma4:31b-cloud', 'Gemma 4 31B Cloud'],
    ['llama3:8b', 'Llama 3 8B'],
    ['somemodel:latest', 'Somemodel'],
    ['deepseek-coder:6.7b', 'DeepSeek Coder 6.7B'],
  ])('Ollama tags: %s → %s', (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });

  it.each([
    ['custom-model-7b', 'Custom Model 7B'],
    ['custom-model-70b', 'Custom Model 70B'],
  ])('size indicators: %s → %s', (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });

  it.each([
    ['o5-turbo', 'o5 Turbo'],
    ['o6-mini', 'o6 Mini'],
  ])('o-series: %s → %s', (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });

  it.each([
    ['deepseek-coder-v3', 'DeepSeek Coder V3'],
    ['custom-v2-pro', 'Custom V2 Pro'],
  ])('version prefixes: %s → %s', (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });

  it.each([
    ['custom-org/some-model', 'Some Model'],
  ])('vendor prefix stripping: %s → %s', (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });

  it.each([
    ['gpt-7-nano', 'GPT-7 Nano'],
  ])('GPT hyphen format: %s → %s', (input, expected) => {
    expect(formatModelName(input)).toBe(expected);
  });
});

describe('formatToolModel', () => {
  it('returns empty string when both tool and model are undefined', () => {
    expect(formatToolModel(undefined, undefined)).toBe('');
  });

  it('returns empty string when both tool and model are empty strings', () => {
    expect(formatToolModel('', '')).toBe('');
  });

  it('returns display name + separator + model for known tool', () => {
    expect(formatToolModel('ollama', 'qwen2.5-coder:7b')).toBe('Ollama \u00b7 qwen2.5-coder:7b');
  });

  it('passes through raw tool name + model for unknown tool', () => {
    expect(formatToolModel('my-provider', 'some-model')).toBe('my-provider \u00b7 some-model');
  });

  it('returns just the display name when only tool is provided', () => {
    expect(formatToolModel('ollama')).toBe('Ollama');
  });

  it('returns just the model when only model is provided', () => {
    expect(formatToolModel(undefined, 'gpt-4o')).toBe('gpt-4o');
  });
});
