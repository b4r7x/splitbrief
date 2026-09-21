import { describe, expect, it } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { StreamUsageSchema, toStreamChunk } from './chunk.js';
import { normalizeRunnerCallUsage } from '../../calls/usage.js';

function sdkChunk(usage: ChatCompletionChunk['usage']): ChatCompletionChunk {
  return {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
    ...(usage !== undefined && { usage }),
  };
}

describe('toStreamChunk usage', () => {
  it('carries nested cache writes from the SDK into the normalizer', () => {
    const chunk = toStreamChunk(
      sdkChunk({
        prompt_tokens: 15000,
        completion_tokens: 500,
        total_tokens: 15500,
        prompt_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 },
        completion_tokens_details: { reasoning_tokens: 100 },
      }),
    );

    expect(chunk.usage).toEqual({
      prompt_tokens: 15000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 },
      completion_tokens_details: { reasoning_tokens: 100 },
    });

    expect(normalizeRunnerCallUsage(chunk.usage)).toEqual({
      inputTokens: 0,
      outputTokens: 400,
      cacheReadTokens: 12000,
      cacheCreateTokens: 3000,
      reasoningTokens: 100,
      counterCoverage: {
        input: 'reported',
        output: 'reported',
        cacheRead: 'reported',
        cacheCreate: 'reported',
        reasoning: 'reported',
      },
      providerTotals: { input: 15000, output: 500 },
    });
  });

  it('keeps absent prompt details distinct from explicitly reported zeros', () => {
    const absent = toStreamChunk(
      sdkChunk({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
    );
    expect(absent.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20 });
    expect(normalizeRunnerCallUsage(absent.usage)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      counterCoverage: {
        input: 'partial',
        output: 'partial',
        cacheRead: 'missing',
        cacheCreate: 'missing',
        reasoning: 'missing',
      },
    });

    const zeroed = toStreamChunk(
      sdkChunk({
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      }),
    );
    expect(zeroed.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    });
    expect(normalizeRunnerCallUsage(zeroed.usage)).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      counterCoverage: {
        input: 'reported',
        cacheRead: 'reported',
        cacheCreate: 'reported',
      },
    });
  });

  it('projects a cache write without a cache read and leaves reasoning details unchanged', () => {
    const chunk = toStreamChunk(
      sdkChunk({
        prompt_tokens: 900,
        completion_tokens: 40,
        total_tokens: 940,
        prompt_tokens_details: { cache_write_tokens: 400 },
        completion_tokens_details: { reasoning_tokens: 10 },
      }),
    );

    expect(chunk.usage).toEqual({
      prompt_tokens: 900,
      completion_tokens: 40,
      prompt_tokens_details: { cache_write_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });

    expect(normalizeRunnerCallUsage(chunk.usage)).toMatchObject({
      inputTokens: 500,
      outputTokens: 30,
      cacheCreateTokens: 400,
      reasoningTokens: 10,
      counterCoverage: {
        input: 'partial',
        cacheRead: 'missing',
        cacheCreate: 'reported',
        reasoning: 'reported',
      },
    });
  });

  it('accepts a nested cache write in the stream usage schema', () => {
    const parsed = StreamUsageSchema.safeParse({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 },
    });
  });
});
