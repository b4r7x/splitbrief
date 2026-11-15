import { describe, expect, it } from 'vitest';
import { coverage } from '#testing/helpers/usage-coverage.js';
import {
  BackendTokenUsageSchema,
  normalizeRunnerCallUsage,
  runnerCallTokenDelta,
  toTokenDelta,
  toTokenDeltaFromRunnerCallUsage,
} from './normalize.js';

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
      counterCoverage: coverage({
        input: 'reported',
        output: 'partial',
        cacheRead: 'reported',
        cacheCreate: 'reported',
      }),
      providerTotals: { output: 40 },
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
      counterCoverage: coverage({
        input: 'partial',
        output: 'partial',
        cacheRead: 'reported',
      }),
      providerTotals: { input: 100, output: 30 },
    });
  });

  it('subtracts codex cached_input_tokens from input_tokens for true input', () => {
    expect(
      normalizeRunnerCallUsage({
        input_tokens: 100,
        output_tokens: 30,
        cached_input_tokens: 70,
      }),
    ).toEqual({
      inputTokens: 30,
      outputTokens: 30,
      cacheReadTokens: 70,
      counterCoverage: coverage({
        input: 'reported',
        output: 'partial',
        cacheRead: 'reported',
      }),
      providerTotals: { input: 100, output: 30 },
    });
  });

  it('rejects a subcategory larger than the total that contains it', () => {
    expect(
      normalizeRunnerCallUsage({ input_tokens: 50, output_tokens: 10, cached_input_tokens: 80 }),
    ).toBeNull();
    expect(
      normalizeRunnerCallUsage({
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 40 },
      }),
    ).toBeNull();
    expect(
      normalizeRunnerCallUsage({
        completion_tokens: 100,
        completion_tokens_details: { reasoning_tokens: 900 },
      }),
    ).toBeNull();
  });

  it('accepts camelCase usage with cache fields', () => {
    expect(
      normalizeRunnerCallUsage({
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

  it('returns null for empty or non-object usage payloads', () => {
    expect(normalizeRunnerCallUsage(null)).toBeNull();
    expect(normalizeRunnerCallUsage(undefined)).toBeNull();
    expect(normalizeRunnerCallUsage(0)).toBeNull();
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
      counterCoverage: coverage({ input: 'reported', output: 'reported', cacheCreate: 'reported' }),
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
      counterCoverage: coverage({
        input: 'reported',
        output: 'partial',
        cacheCreate: 'reported',
      }),
      providerTotals: { output: 2 },
    });
  });

  it('preserves already-normalized reasoning tokens for call usage and legacy token deltas', () => {
    const raw = {
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
    };

    const expected = {
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
    };

    expect(normalizeRunnerCallUsage(raw)).toEqual(expected);
    expect(toTokenDelta(raw)).toEqual(expected);
  });

  it('subtracts provider reasoning tokens from raw output totals', () => {
    expect(
      normalizeRunnerCallUsage({
        input_tokens: 1,
        output_tokens: 5,
        completion_tokens_details: { reasoning_tokens: 3 },
      }),
    ).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 3,
      counterCoverage: coverage({
        input: 'reported',
        output: 'reported',
        reasoning: 'reported',
      }),
      providerTotals: { output: 5 },
    });
  });

  it('subtracts nested cache reads and cache writes from the inclusive prompt total', () => {
    expect(
      normalizeRunnerCallUsage({
        prompt_tokens: 15000,
        prompt_tokens_details: { cached_tokens: 12000, cache_write_tokens: 3000 },
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 12000,
      cacheCreateTokens: 3000,
      counterCoverage: coverage({
        input: 'reported',
        cacheRead: 'reported',
        cacheCreate: 'reported',
      }),
      providerTotals: { input: 15000 },
    });
  });

  it('keeps Anthropic ordinary input whole and subtracts codex cached input once', () => {
    expect(
      normalizeRunnerCallUsage({
        input_tokens: 3000,
        cache_read_input_tokens: 12000,
        cache_creation_input_tokens: 3000,
      }),
    ).toEqual({
      inputTokens: 3000,
      outputTokens: 0,
      cacheReadTokens: 12000,
      cacheCreateTokens: 3000,
      counterCoverage: coverage({
        input: 'reported',
        cacheRead: 'reported',
        cacheCreate: 'reported',
      }),
    });

    expect(normalizeRunnerCallUsage({ input_tokens: 15000, cached_input_tokens: 12000 })).toEqual({
      inputTokens: 3000,
      outputTokens: 0,
      cacheReadTokens: 12000,
      counterCoverage: coverage({ input: 'reported', cacheRead: 'reported' }),
      providerTotals: { input: 15000 },
    });
  });

  it('carves reasoning out of the inclusive completion total exactly once', () => {
    const normalized = normalizeRunnerCallUsage({
      completion_tokens: 1000,
      completion_tokens_details: { reasoning_tokens: 900 },
    });

    expect(normalized).toEqual({
      inputTokens: 0,
      outputTokens: 100,
      reasoningTokens: 900,
      counterCoverage: coverage({ output: 'reported', reasoning: 'reported' }),
      providerTotals: { output: 1000 },
    });

    const reprojected = normalizeRunnerCallUsage(normalized);
    expect(reprojected?.outputTokens).toBe(100);
    expect(reprojected?.reasoningTokens).toBe(900);
  });

  it('never subtracts already-disjoint camelCase subcounters a second time', () => {
    expect(
      normalizeRunnerCallUsage({
        inputTokens: 1000,
        outputTokens: 400,
        cacheReadTokens: 200,
        reasoningTokens: 300,
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 400,
      cacheReadTokens: 200,
      reasoningTokens: 300,
    });

    // A camelCase reasoning count is not a documented subset of a snake_case
    // output total, so the total stands and only its split is unproven.
    expect(normalizeRunnerCallUsage({ output_tokens: 7, reasoningTokens: 1 })).toEqual({
      inputTokens: 0,
      outputTokens: 7,
      reasoningTokens: 1,
      counterCoverage: coverage({ output: 'partial', reasoning: 'reported' }),
      providerTotals: { output: 7 },
    });
  });

  it('does not read codex inclusive semantics into a bare input_tokens payload', () => {
    expect(normalizeRunnerCallUsage({ input_tokens: 15000, output_tokens: 500 })).toEqual({
      inputTokens: 15000,
      outputTokens: 500,
      counterCoverage: coverage({ input: 'reported', output: 'partial' }),
      providerTotals: { output: 500 },
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

describe('runnerCallTokenDelta', () => {
  it('gives null for a call with no usage', () => {
    expect(runnerCallTokenDelta(null)).toBeNull();
  });

  it('projects a usage like toTokenDeltaFromRunnerCallUsage', () => {
    const usage = {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 25,
      cacheCreateTokens: 10,
      reasoningTokens: 5,
      counterCoverage: coverage({
        input: 'reported',
        output: 'reported',
        cacheRead: 'reported',
        cacheCreate: 'reported',
        reasoning: 'reported',
      }),
      providerTotals: { output: 45 },
    };

    expect(runnerCallTokenDelta(usage)).toEqual(toTokenDeltaFromRunnerCallUsage(usage));
  });
});
