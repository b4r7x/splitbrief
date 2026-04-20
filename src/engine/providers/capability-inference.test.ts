import { describe, it, expect } from 'vitest';
import { modelSupportsEffort } from './capability-inference.js';

describe('modelSupportsEffort', () => {
  it('detects Anthropic claude 4 models', () => {
    expect(modelSupportsEffort('anthropic', 'claude-sonnet-4-5-20250929')).toBe(true);
    expect(modelSupportsEffort('anthropic', 'claude-opus-4-1')).toBe(true);
  });
  it('rejects Anthropic claude 3 models', () => {
    expect(modelSupportsEffort('anthropic', 'claude-3-5-sonnet')).toBe(false);
  });
  it('detects OpenAI reasoning models', () => {
    expect(modelSupportsEffort('openai', 'o1-mini')).toBe(true);
    expect(modelSupportsEffort('openai', 'o3')).toBe(true);
    expect(modelSupportsEffort('openai', 'gpt-5')).toBe(true);
  });
  it('rejects OpenAI gpt-4 models', () => {
    expect(modelSupportsEffort('openai', 'gpt-4o')).toBe(false);
  });
  it('detects DeepSeek reasoner', () => {
    expect(modelSupportsEffort('deepseek', 'deepseek-r1')).toBe(true);
    expect(modelSupportsEffort('deepseek', 'deepseek-reasoner')).toBe(true);
  });
  it('returns false for groq, ollama, lm-studio', () => {
    expect(modelSupportsEffort('groq', 'llama-3.1-70b')).toBe(false);
    expect(modelSupportsEffort('ollama', 'qwen2.5')).toBe(false);
    expect(modelSupportsEffort('lm-studio', 'anything')).toBe(false);
  });
  it('returns false for empty model', () => {
    expect(modelSupportsEffort('openai', undefined)).toBe(false);
  });
});
