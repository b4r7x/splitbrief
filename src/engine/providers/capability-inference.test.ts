import { describe, it, expect } from 'vitest';
import {
  usesOpenAiMaxCompletionTokens,
  isOpenAiReasoningModel,
  anthropicModelSupportsTemperature,
  clampOpenAiEffort,
  clampToMaxOutput,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './capability-inference.js';

describe('usesOpenAiMaxCompletionTokens', () => {
  it.each([
    ['openai', 'o3', 'https://api.openai.com/v1', true],
    ['openai', 'o1-mini', 'https://api.openai.com/v1', true],
    ['openai', 'gpt-5', 'https://api.openai.com/v1', true],
    ['openai', 'gpt-5.1-mini', 'https://api.openai.com/v1', true],
    ['openai', 'gpt-4o', 'https://api.openai.com/v1', false],
    ['openrouter', 'openai/o3', 'https://openrouter.ai/api/v1', false],
    ['openai', 'o3', 'https://example.com/v1', false],
  ] as const)('%s / %s / %s => %s', (provider, model, apiBase, expected) => {
    expect(usesOpenAiMaxCompletionTokens(provider, model, apiBase)).toBe(expected);
  });
});

describe('isOpenAiReasoningModel', () => {
  it.each([
    ['o3', true],
    ['o1-mini', true],
    ['gpt-5', true],
    ['gpt-5.1', true],
    ['gpt-9-turbo', true],
    ['gpt-4o', false],
    ['gpt-4.1', false],
  ] as const)('%s => %s', (model, expected) => {
    expect(isOpenAiReasoningModel(model)).toBe(expected);
  });
});

describe('anthropicModelSupportsTemperature', () => {
  it.each([
    ['claude-opus-4-8', false],
    ['claude-opus-4-7', false],
    ['claude-fable-5', false],
    ['claude-mythos-5', false],
    ['claude-opus-4-6', true],
    ['claude-sonnet-4-6', true],
    ['claude-opus-4-1', true],
    ['claude-3-5-sonnet', true],
  ] as const)('%s => %s', (model, expected) => {
    expect(anthropicModelSupportsTemperature(model)).toBe(expected);
  });
});

describe('clampOpenAiEffort', () => {
  it('clamps xhigh down to high (OpenAI rejects xhigh)', () => {
    expect(clampOpenAiEffort('xhigh')).toBe('high');
  });

  it('passes the supported levels through unchanged', () => {
    expect(clampOpenAiEffort('low')).toBe('low');
    expect(clampOpenAiEffort('medium')).toBe('medium');
    expect(clampOpenAiEffort('high')).toBe('high');
  });
});

describe('clampToMaxOutput', () => {
  it('clamps to the per-model output cap when known', () => {
    expect(clampToMaxOutput(1_000_000, 8192)).toBe(8192);
  });

  it('passes through a value already under the cap', () => {
    expect(clampToMaxOutput(4096, 8192)).toBe(4096);
  });

  it('falls back to the conservative default when the cap is unknown', () => {
    expect(clampToMaxOutput(1_000_000)).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
  });
});
