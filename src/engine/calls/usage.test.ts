import { describe, expect, it } from 'vitest';
import type { RunnerCallCounterCoverage } from '../../core/runner-call-contract.js';
import {
  BackendTokenUsageSchema,
  accumulateRunnerCallUsage,
  applyRunnerCallUsageSample,
  normalizeRunnerCallUsage,
  toTokenDelta,
  accumulateTokenUsage,
} from './usage.js';

// Every category a sample does not report stays missing; each test names only
// the counters its payload actually carries.
function coverage(reported: Partial<RunnerCallCounterCoverage>): RunnerCallCounterCoverage {
  return {
    input: 'missing',
    output: 'missing',
    cacheRead: 'missing',
    cacheCreate: 'missing',
    reasoning: 'missing',
    ...reported,
  };
}

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

describe('counter coverage', () => {
  it('keeps numeric zero for an unreported input counter and marks it missing', () => {
    expect(normalizeRunnerCallUsage({ output_tokens: 40 })).toEqual({
      inputTokens: 0,
      outputTokens: 40,
      counterCoverage: coverage({ input: 'missing', output: 'partial' }),
      providerTotals: { output: 40 },
    });
  });

  it('reports an explicit zero input counter instead of calling it missing', () => {
    expect(
      normalizeRunnerCallUsage({ input_tokens: 0, output_tokens: 40 })?.counterCoverage,
    ).toEqual(coverage({ input: 'reported', output: 'partial' }));
  });

  it('keeps the inclusive output total without inventing a reported reasoning zero', () => {
    const usage = normalizeRunnerCallUsage({ prompt_tokens: 200, completion_tokens: 1000 });

    expect(usage?.providerTotals).toEqual({ input: 200, output: 1000 });
    expect(usage?.outputTokens).toBe(1000);
    expect(usage?.reasoningTokens).toBeUndefined();
    expect(usage?.counterCoverage?.reasoning).toBe('missing');
  });

  it('does not claim an ordinary category reported when the inclusive remainder hides a subcounter', () => {
    const partial = normalizeRunnerCallUsage({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 10 },
    });
    expect(partial?.counterCoverage?.input).toBe('partial');

    const complete = normalizeRunnerCallUsage({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 10 },
      cache_write_input_tokens: 20,
    });
    expect(complete?.inputTokens).toBe(70);
    expect(complete?.counterCoverage?.input).toBe('reported');
  });

  it('takes the input count, inclusive total and coverage from the same field', () => {
    expect(
      normalizeRunnerCallUsage({
        input_tokens: 100,
        prompt_tokens: 999,
        output_tokens: 50,
        completion_tokens: 888,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      counterCoverage: coverage({ input: 'reported', output: 'partial' }),
      providerTotals: { output: 50 },
    });
  });

  it('rejects empty, invalid and negative samples rather than coercing them to zero', () => {
    expect(normalizeRunnerCallUsage({})).toBeNull();
    expect(normalizeRunnerCallUsage('usage')).toBeNull();
    expect(normalizeRunnerCallUsage({ output_tokens: -5 })).toBeNull();
  });

  it('degrades a mismatched pair of delta coverages to partial and adds observed numbers only', () => {
    const missingInput = normalizeRunnerCallUsage({ output_tokens: 7, reasoningTokens: 1 });
    const reportedInput = normalizeRunnerCallUsage({ input_tokens: 5, output_tokens: 3 });
    if (missingInput === null || reportedInput === null)
      throw new Error('fixture did not normalize');

    const summed = accumulateRunnerCallUsage(missingInput, reportedInput, 'delta');

    expect(summed.inputTokens).toBe(5);
    expect(summed.outputTokens).toBe(10);
    expect(summed.counterCoverage).toEqual(
      coverage({ input: 'partial', output: 'partial', reasoning: 'partial' }),
    );
  });

  it('lets a final sample replace the coverage of the call it closes', () => {
    const running = normalizeRunnerCallUsage({ output_tokens: 7 });
    const final = normalizeRunnerCallUsage({ inputTokens: 20, outputTokens: 9 });
    if (running === null || final === null) throw new Error('fixture did not normalize');

    expect(accumulateRunnerCallUsage(running, final, 'final')).toEqual(final);
    expect(accumulateRunnerCallUsage(final, final, 'final')).toEqual(final);
  });

  it('keeps already-normalized usage free of undefined optional fields', () => {
    const usage = normalizeRunnerCallUsage({ output_tokens: 7 });
    if (usage === null) throw new Error('fixture did not normalize');

    expect(normalizeRunnerCallUsage(usage)).toStrictEqual(usage);
  });

  it('leaves a legacy record without coverage unknown instead of fabricating one', () => {
    const legacy = { inputTokens: 10, outputTokens: 4 };

    expect(accumulateRunnerCallUsage(null, legacy, 'final')).toEqual(legacy);
    expect(accumulateRunnerCallUsage(legacy, { inputTokens: 1, outputTokens: 1 }, 'delta')).toEqual(
      { inputTokens: 11, outputTokens: 5 },
    );

    const normalized = normalizeRunnerCallUsage({ inputTokens: 1, outputTokens: 1 });
    if (normalized === null) throw new Error('fixture did not normalize');
    expect(accumulateRunnerCallUsage(legacy, normalized, 'delta').counterCoverage).toBeUndefined();
  });

  it('carries coverage and provider totals through the TokenDelta projection', () => {
    expect(toTokenDelta({ prompt_tokens: 100, completion_tokens: 20 })).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      counterCoverage: coverage({ input: 'partial', output: 'partial' }),
      providerTotals: { input: 100, output: 20 },
    });
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

  it('returns copies instead of exposing caller-owned usage objects', () => {
    const sample = {
      semantics: 'final',
      usage: { inputTokens: 1, outputTokens: 2 },
    } as const;
    const usage = applyRunnerCallUsageSample({ inputTokens: 99, outputTokens: 99 }, sample);

    expect(usage).toEqual(sample.usage);
    expect(usage).not.toBe(sample.usage);
  });

  it('returns a copy of the delta when there is no current usage', () => {
    const delta = { inputTokens: 5, outputTokens: 3 };
    const result = accumulateTokenUsage(null, delta);
    expect(result).toEqual(delta);
    expect(result).not.toBe(delta);
  });

  it('sums zero deltas without changing totals', () => {
    expect(
      accumulateTokenUsage(
        { inputTokens: 10, outputTokens: 4 },
        {
          inputTokens: 0,
          outputTokens: 0,
        },
      ),
    ).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});
