import { describe, expect, it } from 'vitest';
import {
  OPENAI_COMPAT_STANDARD_FINISH_REASONS,
  resolveEffectiveRequestOptions,
  resolveOpenAICompatPolicy,
  type OpenAICompatPolicy,
} from './openai-compat-policy.js';

const conservativePolicy: OpenAICompatPolicy = {
  tokenField: 'max_tokens',
  streamUsage: false,
  temperature: 'omit',
  effort: 'omit',
  reasoning: 'omit',
  extraBody: undefined,
  finishReasons: OPENAI_COMPAT_STANDARD_FINISH_REASONS,
};

describe('OpenAI-compatible policy', () => {
  it('uses a conservative closed policy for an unknown provider', () => {
    expect(
      resolveOpenAICompatPolicy({ provider: 'unregistered-provider', model: 'model-1' }),
    ).toEqual(conservativePolicy);
  });

  it('keeps unknown policy optional fields omitted even when an endpoint is supplied', () => {
    expect(
      resolveOpenAICompatPolicy({
        provider: 'unregistered-provider',
        model: 'model-1',
        apiBase: 'https://api.example.test/v1',
      }),
    ).toEqual(conservativePolicy);
  });

  it('fails closed for a reasoning model at the official OpenAI endpoint', () => {
    expect(
      resolveOpenAICompatPolicy({
        provider: 'openai',
        model: 'o3-mini',
        apiBase: 'https://api.openai.com/v1',
      }),
    ).toEqual(conservativePolicy);
  });

  it('fails closed for a non-reasoning model at the official OpenAI endpoint', () => {
    expect(
      resolveOpenAICompatPolicy({
        provider: 'openai',
        model: 'gpt-4o',
        apiBase: 'https://api.openai.com/v1',
      }),
    ).toEqual(conservativePolicy);
  });

  it('fails closed for an OpenAI lookalike endpoint', () => {
    expect(
      resolveOpenAICompatPolicy({
        provider: 'openai',
        model: 'o3',
        apiBase: 'https://api.openai.com.attacker.test/v1',
      }),
    ).toEqual(conservativePolicy);
  });

  it('fails closed for every removed remote preset name', () => {
    for (const [provider, model] of [
      ['openai', 'o3'],
      ['openrouter', 'openai/o3'],
      ['deepseek', 'deepseek-v4-pro'],
      ['groq', 'openai/gpt-oss-120b'],
      ['together', 'model-1'],
    ] as const) {
      expect(resolveOpenAICompatPolicy({ provider, model })).toEqual(conservativePolicy);
    }
  });

  it('fails closed for the surviving local services', () => {
    for (const [provider, model] of [
      ['ollama', 'qwen3-coder:30b'],
      ['lm-studio', 'qwen2.5-coder-7b'],
    ] as const) {
      expect(resolveOpenAICompatPolicy({ provider, model })).toEqual(conservativePolicy);
    }
  });

  it('accepts only the standard finish reasons until a fixture proves an extension', () => {
    expect(OPENAI_COMPAT_STANDARD_FINISH_REASONS).toEqual([
      'stop',
      'length',
      'content_filter',
      'tool_calls',
      'function_call',
    ]);
    expect(resolveOpenAICompatPolicy({ provider: 'unregistered-provider' }).finishReasons).toBe(
      OPENAI_COMPAT_STANDARD_FINISH_REASONS,
    );
  });
});

const RETRY_TEMPERATURE_STEP = 0.1;

function retryTemperature(base: number, attempt: number): number {
  return base + RETRY_TEMPERATURE_STEP * attempt;
}

describe('effective request policy', () => {
  it('reports a configured temperature as omitted rather than effective', () => {
    const policy = resolveOpenAICompatPolicy({ provider: 'ollama', model: 'qwen3-coder:30b' });

    expect(resolveEffectiveRequestOptions({ policy, temperature: 0.2 }).temperature).toEqual({
      state: 'omitted-unsupported',
      configured: 0.2,
    });
  });

  it('keeps every retry temperature increment off the wire', () => {
    const policy = resolveOpenAICompatPolicy({ provider: 'lm-studio', model: 'qwen2.5-coder-7b' });

    for (const attempt of [1, 2, 3]) {
      const temperature = retryTemperature(0.2, attempt);
      expect(resolveEffectiveRequestOptions({ policy, temperature }).temperature).toEqual({
        state: 'omitted-unsupported',
        configured: temperature,
      });
    }
  });

  it('reports a configured effort as omitted for every level', () => {
    const policy = resolveOpenAICompatPolicy({ provider: 'openai', model: 'o3-mini' });

    for (const effort of ['low', 'medium', 'high', 'xhigh'] as const) {
      expect(resolveEffectiveRequestOptions({ policy, effort }).effort).toEqual({
        state: 'omitted-unsupported',
        configured: effort,
      });
    }
  });

  it('separates a control nobody configured from one the policy omits', () => {
    const policy = resolveOpenAICompatPolicy({ provider: 'unregistered-provider' });
    const unconfigured = resolveEffectiveRequestOptions({ policy });

    expect(unconfigured.temperature).toEqual({ state: 'not-configured' });
    expect(unconfigured.effort).toEqual({ state: 'not-configured' });
  });

  it('does not claim stream usage is enabled while the policy omits it', () => {
    const policy = resolveOpenAICompatPolicy({ provider: 'unregistered-provider' });

    expect(policy.streamUsage).toBe(false);
    expect(resolveEffectiveRequestOptions({ policy }).streamUsage).toBe(false);
  });

  it('keeps a custom endpoint conservative across its whole result', () => {
    const policy = resolveOpenAICompatPolicy({
      provider: 'unregistered-provider',
      model: 'model-1',
      apiBase: 'https://api.example.test/v1',
    });

    expect(
      resolveEffectiveRequestOptions({ policy, temperature: 0.7, effort: 'high', maxTokens: 4096 }),
    ).toEqual({
      tokenField: 'max_tokens',
      maxTokens: 4096,
      temperature: { state: 'omitted-unsupported', configured: 0.7 },
      effort: { state: 'omitted-unsupported', configured: 'high' },
      streamUsage: false,
      extraBody: undefined,
      finishReasons: OPENAI_COMPAT_STANDARD_FINISH_REASONS,
    });
  });

  it('preserves the max token field and the strict finish statuses', () => {
    const policy = resolveOpenAICompatPolicy({ provider: 'ollama', model: 'qwen3-coder:30b' });
    const options = resolveEffectiveRequestOptions({ policy, maxTokens: 2048 });

    expect(options.tokenField).toBe(policy.tokenField);
    expect(options.maxTokens).toBe(2048);
    expect(options.finishReasons).toBe(OPENAI_COMPAT_STANDARD_FINISH_REASONS);
    expect(resolveEffectiveRequestOptions({ policy }).maxTokens).toBeUndefined();
  });

  it('carries no credential and no endpoint into the result', () => {
    const policy = resolveOpenAICompatPolicy({
      provider: 'unregistered-provider',
      apiBase: 'https://user:secret@api.example.test/v1',
    });

    expect(
      Object.keys(resolveEffectiveRequestOptions({ policy, temperature: 0.3 })).sort(),
    ).toEqual([
      'effort',
      'extraBody',
      'finishReasons',
      'maxTokens',
      'streamUsage',
      'temperature',
      'tokenField',
    ]);
  });
});
