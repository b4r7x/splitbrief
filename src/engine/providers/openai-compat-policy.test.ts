import { describe, expect, it } from 'vitest';
import {
  OPENAI_COMPAT_STANDARD_FINISH_REASONS,
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
