import { describe, it, expect } from 'vitest';
import { modelSupportsEffort } from './capability-inference.js';

describe('modelSupportsEffort', () => {
  it.each([
    ['anthropic', 'claude-sonnet-4-5-20250929', true],
    ['anthropic', 'claude-opus-4-1', true],
    ['anthropic', 'claude-3-5-sonnet', false],
    ['openai', 'o1-mini', true],
    ['openai', 'o3', true],
    ['openai', 'gpt-5', true],
    ['openai', 'gpt-4o', false],
    ['deepseek', 'deepseek-r1', true],
    ['deepseek', 'deepseek-reasoner', true],
    ['groq', 'llama-3.1-70b', false],
    ['ollama', 'qwen2.5', false],
    ['lm-studio', 'anything', false],
    ['openai', undefined, false],
  ] as const)('%s / %s => %s', (provider, model, expected) => {
    expect(modelSupportsEffort(provider, model)).toBe(expected);
  });
});
