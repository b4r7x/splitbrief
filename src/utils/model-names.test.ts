import { describe, it, expect } from 'vitest';
import { formatModelName, parseModelName } from './model-names.js';

describe('formatModelName', () => {
  describe('static registry — Anthropic Claude', () => {
    it.each([
      ['claude-opus-4-6', 'Claude Opus 4.6'],
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
      ['claude-opus-4-5', 'Claude Opus 4.5'],
      ['claude-sonnet-4-5', 'Claude Sonnet 4.5'],
      ['claude-sonnet-4', 'Claude Sonnet 4'],
      ['claude-haiku-4-5', 'Claude Haiku 4.5'],
    ])('%s → %s (dash version)', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });

    it.each([
      ['claude-opus-4.6', 'Claude Opus 4.6'],
      ['claude-sonnet-4.6', 'Claude Sonnet 4.6'],
      ['claude-opus-4.5', 'Claude Opus 4.5'],
      ['claude-sonnet-4.5', 'Claude Sonnet 4.5'],
      ['claude-haiku-4.5', 'Claude Haiku 4.5'],
    ])('%s → %s (dot version)', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('static registry — OpenAI GPT', () => {
    it.each([
      ['gpt-4o', 'GPT-4o'],
      ['gpt-5.4', 'GPT-5.4'],
      ['gpt-5.4-mini', 'GPT-5.4 Mini'],
      ['gpt-5.3-codex', 'GPT-5.3 Codex'],
      ['gpt-5.3-codex-spark', 'GPT-5.3 Codex Spark'],
      ['gpt-5.2', 'GPT-5.2'],
      ['gpt-5.2-codex', 'GPT-5.2 Codex'],
      ['gpt-5.1', 'GPT-5.1'],
      ['gpt-5.1-codex', 'GPT-5.1 Codex'],
      ['gpt-5.1-codex-max', 'GPT-5.1 Codex Max'],
      ['gpt-5-codex-mini', 'GPT-5 Codex Mini'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('static registry — o-series', () => {
    it.each([
      ['o3', 'o3'],
      ['o3-mini', 'o3 Mini'],
      ['o4-mini', 'o4 Mini'],
      ['codex-mini-latest', 'Codex Mini'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('static registry — DeepSeek', () => {
    it.each([
      ['deepseek-chat', 'DeepSeek V3'],
      ['deepseek-coder', 'DeepSeek Coder'],
      ['deepseek-reasoner', 'DeepSeek R1'],
      ['deepseek-r1', 'DeepSeek R1'],
      ['deepseek-r1-0528', 'DeepSeek R1'],
      ['deepseek-v3.2', 'DeepSeek V3.2'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('static registry — Gemini', () => {
    it.each([
      ['gemini-2.5-pro', 'Gemini 2.5 Pro'],
      ['gemini-2.5-flash', 'Gemini 2.5 Flash'],
      ['gemini-3-pro', 'Gemini 3 Pro'],
      ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('static registry — other models', () => {
    it.each([
      ['llama-4-scout', 'Llama 4 Scout'],
      ['llama3.3', 'Llama 3.3'],
      ['mistral-large-latest', 'Mistral Large'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('static registry — Ollama tagged models', () => {
    it.each([
      ['qwen2.5-coder:7b', 'Qwen 2.5 Coder 7B'],
      ['qwen2.5-coder:14b', 'Qwen 2.5 Coder 14B'],
      ['qwen2.5-coder:32b', 'Qwen 2.5 Coder 32B'],
      ['llama3.3:latest', 'Llama 3.3'],
      ['deepseek-coder-v2:16b', 'DeepSeek Coder V2 16B'],
      ['codellama:13b', 'Code Llama 13B'],
      ['starcoder2:7b', 'StarCoder2 7B'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('static registry — LM Studio models', () => {
    it.each([
      ['qwen2.5-coder-7b', 'Qwen 2.5 Coder 7B'],
      ['qwen2.5-coder-14b', 'Qwen 2.5 Coder 14B'],
      ['qwen2.5-coder-32b', 'Qwen 2.5 Coder 32B'],
      ['deepseek-coder-v2-16b', 'DeepSeek Coder V2 16B'],
      ['codellama-13b', 'Code Llama 13B'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

  describe('vendor-prefixed models (strip and lookup)', () => {
    it.each([
      ['anthropic/claude-sonnet-4.6', 'Claude Sonnet 4.6'],
      ['anthropic/claude-opus-4.6', 'Claude Opus 4.6'],
      ['anthropic/claude-haiku-4.5', 'Claude Haiku 4.5'],
      ['anthropic/claude-sonnet-4-6', 'Claude Sonnet 4.6'],
      ['openai/gpt-5.4', 'GPT-5.4'],
      ['openai/gpt-5.4-mini', 'GPT-5.4 Mini'],
      ['openai/o4-mini', 'o4 Mini'],
      ['google/gemini-3-pro', 'Gemini 3 Pro'],
      ['google/gemini-2.5-pro', 'Gemini 2.5 Pro'],
      ['deepseek/deepseek-r1', 'DeepSeek R1'],
      ['deepseek/deepseek-v3.2', 'DeepSeek V3.2'],
      ['meta-llama/llama-4-scout', 'Llama 4 Scout'],
      ['mistralai/mistral-large-latest', 'Mistral Large'],
    ])('%s → %s', (input, expected) => {
      expect(formatModelName(input)).toBe(expected);
    });
  });

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

describe('parseModelName (heuristic)', () => {
  describe('brand capitalization', () => {
    it.each([
      ['claude-haiku-5-2', 'Claude Haiku 5.2'],
      ['gpt-6-turbo', 'GPT-6 Turbo'],
      ['gemini-4-flash', 'Gemini 4 Flash'],
      ['deepseek-v4', 'DeepSeek V4'],
      ['mistral-medium', 'Mistral Medium'],
    ])('%s → %s', (input, expected) => {
      expect(parseModelName(input)).toBe(expected);
    });
  });

  describe('compound brand+version tokens', () => {
    it.each([
      ['qwen3-coder', 'Qwen 3 Coder'],
      ['llama4', 'Llama 4'],
      ['gemma4', 'Gemma 4'],
      ['phi4-mini', 'Phi 4 Mini'],
    ])('%s → %s', (input, expected) => {
      expect(parseModelName(input)).toBe(expected);
    });
  });

  describe('Ollama tags', () => {
    it.each([
      ['gemma4:31b-cloud', 'Gemma 4 31B Cloud'],
      ['llama3:8b', 'Llama 3 8B'],
      ['somemodel:latest', 'Somemodel'],
      ['deepseek-coder:6.7b', 'DeepSeek Coder 6.7B'],
    ])('%s → %s', (input, expected) => {
      expect(parseModelName(input)).toBe(expected);
    });
  });

  describe('size indicators', () => {
    it.each([
      ['custom-model-7b', 'Custom Model 7B'],
      ['custom-model-70b', 'Custom Model 70B'],
    ])('%s → %s', (input, expected) => {
      expect(parseModelName(input)).toBe(expected);
    });
  });

  describe('o-series', () => {
    it.each([
      ['o5-turbo', 'o5 Turbo'],
      ['o6-mini', 'o6 Mini'],
    ])('%s → %s', (input, expected) => {
      expect(parseModelName(input)).toBe(expected);
    });
  });

  describe('version prefixes', () => {
    it.each([
      ['deepseek-coder-v3', 'DeepSeek Coder V3'],
      ['custom-v2-pro', 'Custom V2 Pro'],
    ])('%s → %s', (input, expected) => {
      expect(parseModelName(input)).toBe(expected);
    });
  });

  describe('vendor prefix stripping', () => {
    it('strips unknown vendor prefixes', () => {
      expect(parseModelName('custom-org/some-model')).toBe('Some Model');
    });
  });

  describe('GPT hyphen format', () => {
    it('preserves hyphen after GPT brand', () => {
      expect(parseModelName('gpt-7-nano')).toBe('GPT-7 Nano');
    });
  });
});
