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

  it('routes direct OpenAI reasoning models through the proved fields', () => {
    expect(
      resolveOpenAICompatPolicy({
        provider: 'openai',
        model: 'o3-mini',
        apiBase: 'https://api.openai.com/v1',
      }),
    ).toMatchObject({
      tokenField: 'max_completion_tokens',
      streamUsage: true,
      temperature: 'omit',
      effort: 'clamp-xhigh',
      reasoning: 'reasoning_effort',
      extraBody: undefined,
    });
  });

  it('keeps sampling for a direct OpenAI non-reasoning model', () => {
    expect(
      resolveOpenAICompatPolicy({
        provider: 'openai',
        model: 'gpt-4o',
        apiBase: 'https://api.openai.com/v1',
      }),
    ).toMatchObject({
      tokenField: 'max_tokens',
      streamUsage: true,
      temperature: 'verbatim',
      effort: 'omit',
      reasoning: 'omit',
    });
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

  it('uses model-aware reasoning only for existing OpenRouter and DeepSeek behavior', () => {
    expect(resolveOpenAICompatPolicy({ provider: 'openrouter', model: 'openai/o3' })).toMatchObject(
      {
        streamUsage: true,
        tokenField: 'max_tokens',
        effort: 'verbatim',
        reasoning: 'reasoning_effort',
      },
    );
    expect(
      resolveOpenAICompatPolicy({ provider: 'deepseek', model: 'deepseek-v4-flash' }),
    ).toMatchObject({
      streamUsage: true,
      tokenField: 'max_tokens',
      effort: 'map-medium-to-high',
      reasoning: 'reasoning_effort',
    });
    expect(
      resolveOpenAICompatPolicy({ provider: 'deepseek', model: 'deepseek-v4-pro' }),
    ).toMatchObject({
      streamUsage: true,
      tokenField: 'max_tokens',
      effort: 'map-medium-to-high',
      reasoning: 'reasoning_effort',
    });
  });

  it('uses completion-token requests for the Groq GPT OSS recommendation', () => {
    expect(
      resolveOpenAICompatPolicy({ provider: 'groq', model: 'openai/gpt-oss-120b' }),
    ).toMatchObject({
      tokenField: 'max_completion_tokens',
      streamUsage: true,
    });
  });

  it('keeps Together and unknown Groq models on the standard request contract', () => {
    for (const [provider, model] of [
      ['together', 'model-1'],
      ['groq', 'other-model'],
    ] as const) {
      expect(resolveOpenAICompatPolicy({ provider, model })).toEqual({
        tokenField: 'max_tokens',
        streamUsage: true,
        temperature: 'verbatim',
        effort: 'omit',
        reasoning: 'omit',
        extraBody: undefined,
        finishReasons: OPENAI_COMPAT_STANDARD_FINISH_REASONS,
      });
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
