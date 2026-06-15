import { describe, it, expect } from 'vitest';
import { TokenUsageLikeSchema, toTokenDelta, accumulateUsage } from './token-usage.js';

describe('toTokenDelta', () => {
  it('returns null for falsy input', () => {
    expect(toTokenDelta(null)).toBeNull();
    expect(toTokenDelta(undefined)).toBeNull();
    expect(toTokenDelta(0)).toBeNull();
  });

  it('returns null when no token fields are present', () => {
    expect(toTokenDelta({ unrelated: 1 })).toBeNull();
  });

  it('extracts Anthropic-style snake_case usage', () => {
    expect(
      toTokenDelta({
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 25,
        cache_creation_input_tokens: 10,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 25,
      cacheCreateTokens: 10,
    });
  });

  it('subtracts cached tokens from OpenAI prompt_tokens for true input', () => {
    expect(
      toTokenDelta({
        prompt_tokens: 100,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 60 },
      }),
    ).toEqual({
      inputTokens: 40,
      outputTokens: 30,
      cacheReadTokens: 60,
    });
  });

  it('subtracts codex cached_input_tokens from input_tokens for true input', () => {
    expect(
      toTokenDelta({
        input_tokens: 100,
        output_tokens: 30,
        cached_input_tokens: 70,
      }),
    ).toEqual({
      inputTokens: 30,
      outputTokens: 30,
      cacheReadTokens: 70,
    });
  });

  it('clamps codex input at zero when cached exceeds input_tokens', () => {
    const delta = toTokenDelta({
      input_tokens: 50,
      output_tokens: 10,
      cached_input_tokens: 80,
    });
    expect(delta?.inputTokens).toBe(0);
    expect(delta?.cacheReadTokens).toBe(80);
  });

  it('clamps prompt input at zero when cached exceeds prompt', () => {
    const delta = toTokenDelta({
      prompt_tokens: 50,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 80 },
    });
    expect(delta?.inputTokens).toBe(0);
  });

  it('accepts camelCase usage', () => {
    expect(
      toTokenDelta({
        inputTokens: 12,
        outputTokens: 8,
        cacheReadTokens: 3,
        cacheCreateTokens: 2,
      }),
    ).toEqual({
      inputTokens: 12,
      outputTokens: 8,
      cacheReadTokens: 3,
      cacheCreateTokens: 2,
    });
  });

  it('omits cache fields when absent', () => {
    expect(toTokenDelta({ input_tokens: 5, output_tokens: 6 })).toEqual({
      inputTokens: 5,
      outputTokens: 6,
    });
  });
});

describe('TokenUsageLikeSchema', () => {
  it('passes through unknown keys (looseObject)', () => {
    const parsed = TokenUsageLikeSchema.safeParse({ input_tokens: 1, extra: 'kept' });
    expect(parsed.success).toBe(true);
  });
});

describe('accumulateUsage', () => {
  it('returns a copy of the delta when there is no current usage', () => {
    const delta = { inputTokens: 5, outputTokens: 3 };
    const result = accumulateUsage(null, delta);
    expect(result).toEqual(delta);
    expect(result).not.toBe(delta);
  });

  it('sums input and output token counts', () => {
    expect(
      accumulateUsage({ inputTokens: 10, outputTokens: 4 }, { inputTokens: 5, outputTokens: 6 }),
    ).toEqual({ inputTokens: 15, outputTokens: 10 });
  });

  it('accumulates cache tokens when either side has them', () => {
    expect(
      accumulateUsage(
        { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
        { inputTokens: 5, outputTokens: 6, cacheCreateTokens: 7 },
      ),
    ).toEqual({
      inputTokens: 15,
      outputTokens: 10,
      cacheReadTokens: 2,
      cacheCreateTokens: 7,
    });
  });
});
