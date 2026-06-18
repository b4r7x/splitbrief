import { describe, expect, it } from 'vitest';
import {
  BackendTokenUsageSchema,
  accumulateRunnerCallUsage,
  accumulateRunnerCallUsageSamples,
  applyRunnerCallUsageSample,
  normalizeRunnerCallUsage,
  normalizeRunnerCallUsageSample,
  toTokenDelta,
} from './usage.js';

describe('normalizeRunnerCallUsage', () => {
  it('normalizes Anthropic-style usage with cache reads and cache creation', () => {
    expect(
      normalizeRunnerCallUsage({
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

  it('subtracts OpenAI cached prompt tokens from billable input', () => {
    expect(
      normalizeRunnerCallUsage({
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

  it('maps cache write and cache create aliases into cacheCreateTokens', () => {
    expect(
      normalizeRunnerCallUsage({
        inputTokens: 1,
        outputTokens: 2,
        cacheWriteTokens: 3,
      }),
    ).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheCreateTokens: 3,
    });

    expect(
      normalizeRunnerCallUsage({
        input_tokens: 1,
        output_tokens: 2,
        cache_write_input_tokens: 4,
      }),
    ).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheCreateTokens: 4,
    });
  });

  it('preserves reasoning tokens for call usage but strips them from legacy token deltas', () => {
    const raw = {
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
    };

    expect(normalizeRunnerCallUsage(raw)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
    });
    expect(toTokenDelta(raw)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
    });
  });

  it('returns null when no token fields are present', () => {
    expect(normalizeRunnerCallUsage({ unrelated: 1 })).toBeNull();
    expect(normalizeRunnerCallUsage(null)).toBeNull();
  });

  it('rejects negative and fractional backend token counts', () => {
    expect(normalizeRunnerCallUsage({ input_tokens: -1, output_tokens: 0 })).toBeNull();
    expect(normalizeRunnerCallUsage({ input_tokens: 1.5, output_tokens: 0 })).toBeNull();
    expect(
      normalizeRunnerCallUsage({
        prompt_tokens: 10,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: -1 },
      }),
    ).toBeNull();
  });
});

describe('BackendTokenUsageSchema', () => {
  it('keeps unknown backend fields while validating known token fields', () => {
    expect(BackendTokenUsageSchema.safeParse({ input_tokens: 1, extra: 'kept' }).success).toBe(
      true,
    );
    expect(BackendTokenUsageSchema.safeParse({ input_tokens: 1.25 }).success).toBe(false);
  });
});

describe('normalizeRunnerCallUsageSample', () => {
  it('attaches validated usage semantics to normalized usage', () => {
    expect(
      normalizeRunnerCallUsageSample({
        raw: { inputTokens: 1, outputTokens: 2 },
        semantics: 'final',
      }),
    ).toEqual({
      semantics: 'final',
      usage: { inputTokens: 1, outputTokens: 2 },
    });
  });

  it('rejects unknown usage semantics', () => {
    expect(
      normalizeRunnerCallUsageSample({
        raw: { inputTokens: 1, outputTokens: 2 },
        semantics: 'running-total',
      }),
    ).toBeNull();
  });
});

describe('usage accumulation', () => {
  it('adds delta usage samples', () => {
    expect(
      accumulateRunnerCallUsage(
        { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
        { inputTokens: 5, outputTokens: 6, cacheCreateTokens: 7 },
        'delta',
      ),
    ).toEqual({
      inputTokens: 15,
      outputTokens: 10,
      cacheReadTokens: 2,
      cacheCreateTokens: 7,
    });
  });

  it('replaces previous totals for cumulative and final samples', () => {
    let usage = accumulateRunnerCallUsage(null, { inputTokens: 10, outputTokens: 5 }, 'delta');
    usage = accumulateRunnerCallUsage(usage, { inputTokens: 12, outputTokens: 8 }, 'cumulative');
    usage = accumulateRunnerCallUsage(usage, { inputTokens: 15, outputTokens: 9 }, 'final');

    expect(usage).toEqual({
      inputTokens: 15,
      outputTokens: 9,
    });
  });

  it('applies mixed sample sequences without overcounting snapshots', () => {
    const usage = accumulateRunnerCallUsageSamples([
      { semantics: 'delta', usage: { inputTokens: 5, outputTokens: 2 } },
      { semantics: 'delta', usage: { inputTokens: 4, outputTokens: 3 } },
      { semantics: 'cumulative', usage: { inputTokens: 20, outputTokens: 10 } },
      { semantics: 'final', usage: { inputTokens: 22, outputTokens: 11 } },
    ]);

    expect(usage).toEqual({
      inputTokens: 22,
      outputTokens: 11,
    });
  });

  it('returns copies instead of exposing caller-owned usage objects', () => {
    const sample = {
      semantics: 'final',
      usage: { inputTokens: 1, outputTokens: 2 },
    } as const;
    const usage = applyRunnerCallUsageSample({ inputTokens: 99, outputTokens: 99 }, sample);

    expect(usage).toEqual(sample.usage);
    expect(usage).not.toBe(sample.usage);
  });
});
