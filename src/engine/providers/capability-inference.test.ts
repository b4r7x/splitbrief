import { describe, it, expect } from 'vitest';
import { modelSupportsEffort, modelSupportsImages } from './capability-inference.js';

describe('modelSupportsEffort', () => {
  it.each([
    ['anthropic', 'claude-sonnet-4-5-20250929', true],
    ['anthropic', 'claude-opus-4-1', true],
    ['anthropic', 'claude-3-5-sonnet', false],
    ['openai', 'o1-mini', true],
    ['openai', 'o3', true],
    ['openai', 'gpt-5', true],
    ['openai', 'gpt-4o', false],
    ['openrouter', 'openai/o3-mini', true],
    ['openrouter', 'openai/gpt-5', true],
    ['openrouter', 'deepseek/deepseek-r1', true],
    ['openrouter', 'anthropic/claude-3.5-sonnet', false],
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

describe('modelSupportsImages', () => {
  it.each([
    ['openai', 'gpt-4o', true],
    ['anthropic', 'claude-3-5-sonnet', true],
    ['openrouter', 'openai/gpt-4o', true],
    ['openrouter', 'anthropic/claude-3-5-sonnet', true],
    ['openrouter', 'anthropic/claude-3.5-sonnet', true],
    ['openrouter', 'google/gemini-2.5-pro-preview', true],
    ['groq', 'llama-3.1-70b', false],
  ] as const)('%s / %s => %s', (provider, model, expected) => {
    expect(modelSupportsImages(provider, model)).toBe(expected);
  });
});
