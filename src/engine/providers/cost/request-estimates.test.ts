import { describe, expect, it } from 'vitest';
import type { RunnerCallCounterCoverage } from '../../../core/runner-call-contract.js';
import { RequestEstimateSchema, type RequestEstimateItem } from '../../../core/schemas/summary.js';
import {
  CallUsageEvidenceSchema,
  type CallUsageEvidence,
  type UsageBoundary,
} from '../../../core/schemas/usage-evidence.js';
import type { ResolvedPricing } from '../pricing-resolver.js';
import { InvocationIdentitySchema } from '../../../core/schemas/invocation-identity.js';
import { callRunnerKey, sumRequestEstimates } from './request-estimates.js';

const FULL_COVERAGE: RunnerCallCounterCoverage = {
  input: 'reported',
  output: 'reported',
  cacheRead: 'reported',
  cacheCreate: 'reported',
  reasoning: 'reported',
};

function pricing(overrides: Partial<ResolvedPricing>): ResolvedPricing {
  return {
    inputPer1M: 1,
    outputPer1M: 0,
    isLocal: false,
    isPriced: true,
    pricingMode: 'api-priced',
    name: 'test-model',
    provider: 'acme',
    source: 'models-dev',
    ...overrides,
  };
}

// $1/M below a 200k context threshold, $2/M at or above it.
const TIERED = pricing({
  pricingTiers: [{ type: 'context', thresholdTokens: 200_000, inputPer1M: 2 }],
});

function call(opts: {
  callId: string;
  usageBoundary?: UsageBoundary;
  usage?: CallUsageEvidence['usage'];
}): CallUsageEvidence {
  // Parsed, so a fixture cannot describe a call the contract would reject.
  return CallUsageEvidenceSchema.parse({
    callId: opts.callId,
    role: 'implementer',
    backendKind: 'api',
    usageBoundary: opts.usageBoundary ?? 'single-request',
    usage: opts.usage ?? null,
  });
}

function onlyItem(items: RequestEstimateItem[]): RequestEstimateItem {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item === undefined) throw new Error('no item');
  return item;
}

describe('sumRequestEstimates — request boundaries', () => {
  it('prices two 150k requests below the threshold separately, never as one 300k request', () => {
    const request = (callId: string): CallUsageEvidence =>
      call({
        callId,
        usage: {
          inputTokens: 150_000,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          reasoningTokens: 0,
          counterCoverage: FULL_COVERAGE,
        },
      });

    const result = sumRequestEstimates([request('c1'), request('c2')], TIERED);

    expect(result.completeness).toBe('complete');
    expect(result.basis).toBe('catalog-estimate');
    expect(result.currency).toBe('USD');
    expect(result.amount).toBeCloseTo(0.3, 10);
    // The bug this card fixes: 300k summed across requests would take the $2/M tier.
    expect(result.amount).not.toBeCloseTo(0.6, 10);
    expect(result.items.map((item) => item.amount)).toEqual([
      expect.closeTo(0.15, 10),
      expect.closeTo(0.15, 10),
    ]);
    expect(RequestEstimateSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it('takes the higher tier for a single 300k request', () => {
    const result = sumRequestEstimates(
      [
        call({
          callId: 'c1',
          usage: {
            inputTokens: 300_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            reasoningTokens: 0,
            counterCoverage: FULL_COVERAGE,
          },
        }),
      ],
      TIERED,
    );

    expect(result.completeness).toBe('complete');
    expect(result.amount).toBeCloseTo(0.6, 10);
  });

  it('selects the tier from one request cache-inclusive input total', () => {
    const result = sumRequestEstimates(
      [
        call({
          callId: 'c1',
          usage: {
            inputTokens: 150_000,
            outputTokens: 0,
            cacheReadTokens: 100_000,
            cacheCreateTokens: 0,
            reasoningTokens: 0,
            counterCoverage: FULL_COVERAGE,
          },
        }),
      ],
      pricing({
        cacheReadPer1M: 0,
        pricingTiers: [{ type: 'context', thresholdTokens: 200_000, inputPer1M: 2 }],
      }),
    );

    // 250k of context takes the $2/M tier; only the 150k of ordinary input is charged at it.
    expect(result.amount).toBeCloseTo(0.3, 10);
  });
});

describe('sumRequestEstimates — aggregate and legacy data', () => {
  const aggregateCall = call({
    callId: 'cli-1',
    usageBoundary: 'aggregate',
    usage: {
      inputTokens: 300_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      reasoningTokens: 0,
      counterCoverage: FULL_COVERAGE,
    },
  });

  it('cannot price an aggregate CLI invocation at a request tier', () => {
    const result = sumRequestEstimates([aggregateCall], TIERED);

    expect(result.basis).toBe('unavailable');
    expect(result.completeness).toBe('unavailable');
    expect(result.amount).toBeNull();
    expect(result.knownSubtotal).toBe(0);
    expect(onlyItem(result.items).reasons).toEqual(['aggregate-boundary']);
  });

  it('cannot price a legacy record with no recorded boundary at a request tier', () => {
    const legacy = call({
      callId: 'legacy-1',
      usageBoundary: 'unknown',
      usage: { inputTokens: 300_000, outputTokens: 0 },
    });

    const result = sumRequestEstimates([legacy], TIERED);

    expect(result.completeness).toBe('unavailable');
    expect(result.amount).toBeNull();
    expect(onlyItem(result.items).reasons).toEqual(['unknown-boundary']);
  });

  it('still estimates the same aggregate invocation at a flat rate', () => {
    const result = sumRequestEstimates([aggregateCall], pricing({}));

    expect(result.basis).toBe('catalog-estimate');
    expect(result.completeness).toBe('complete');
    expect(result.amount).toBeCloseTo(0.3, 10);
  });

  it('reports no estimate for a call that reported no usage', () => {
    const result = sumRequestEstimates([call({ callId: 'c1' })], pricing({}));

    expect(result.completeness).toBe('unavailable');
    expect(onlyItem(result.items).reasons).toEqual(['usage-not-reported']);
  });

  it('reports no estimate for an unpriced model', () => {
    const result = sumRequestEstimates(
      [call({ callId: 'c1', usage: { inputTokens: 1000, outputTokens: 0 } })],
      pricing({ isPriced: false, pricingMode: 'unpriced-cli', source: 'unpriced' }),
    );

    expect(result.completeness).toBe('unavailable');
    expect(onlyItem(result.items).reasons).toEqual(['unpriced-model']);
  });

  it('reports partial when only some requests could be priced', () => {
    const result = sumRequestEstimates(
      [
        call({
          callId: 'priced',
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            reasoningTokens: 0,
            counterCoverage: FULL_COVERAGE,
          },
        }),
        call({ callId: 'no-usage' }),
      ],
      pricing({}),
    );

    expect(result.completeness).toBe('partial');
    expect(result.amount).toBeNull();
    expect(result.knownSubtotal).toBeCloseTo(1, 10);
    expect(result.reasons).toEqual(['usage-not-reported']);
  });
});

describe('sumRequestEstimates — generated tokens and cache premiums', () => {
  const METERED = pricing({ inputPer1M: 1, outputPer1M: 10 });

  it('prices ordinary output and reasoning at the output rate', () => {
    const result = sumRequestEstimates(
      [
        call({
          callId: 'c1',
          usage: {
            inputTokens: 1000,
            outputTokens: 100,
            reasoningTokens: 900,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            counterCoverage: FULL_COVERAGE,
          },
        }),
      ],
      METERED,
    );

    expect(result.completeness).toBe('complete');
    // 1000 input at $1/M plus 1000 generated at $10/M.
    expect(result.amount).toBeCloseTo(0.011, 12);
  });

  it('cannot claim a complete price when a cache rate is missing for reported cache tokens', () => {
    const result = sumRequestEstimates(
      [
        call({
          callId: 'c1',
          usage: {
            inputTokens: 1000,
            outputTokens: 100,
            reasoningTokens: 900,
            cacheReadTokens: 500,
            cacheCreateTokens: 0,
            counterCoverage: FULL_COVERAGE,
          },
        }),
      ],
      METERED,
    );

    const item = onlyItem(result.items);
    expect(item.completeness).toBe('partial');
    expect(item.amount).toBeNull();
    expect(item.reasons).toContain('missing-cache-rate');
    // What is known is still reported, and the unknown premium is not reported as zero.
    expect(item.knownSubtotal).toBeCloseTo(0.011, 12);
  });

  it('cannot claim a complete price when an unreported cache split is priced differently', () => {
    const partialCoverage: RunnerCallCounterCoverage = { ...FULL_COVERAGE, cacheRead: 'missing' };
    const result = sumRequestEstimates(
      [
        call({
          callId: 'c1',
          usage: {
            inputTokens: 1000,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheCreateTokens: 0,
            counterCoverage: { ...partialCoverage, input: 'partial' },
            providerTotals: { input: 1_000_000 },
          },
        }),
      ],
      pricing({ inputPer1M: 1, cacheReadPer1M: 0.1 }),
    );

    const item = onlyItem(result.items);
    expect(item.completeness).toBe('partial');
    expect(item.amount).toBeNull();
    expect(item.reasons).toContain('unknown-category-split');
  });

  it('still prices exactly when an unreported cache split carries the ordinary input rate', () => {
    const partialCoverage: RunnerCallCounterCoverage = { ...FULL_COVERAGE, cacheRead: 'missing' };
    const result = sumRequestEstimates(
      [
        call({
          callId: 'c1',
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheCreateTokens: 0,
            counterCoverage: partialCoverage,
            providerTotals: { input: 1_000_000 },
          },
        }),
      ],
      pricing({ inputPer1M: 1, cacheReadPer1M: 1 }),
    );

    expect(result.completeness).toBe('complete');
    expect(result.amount).toBeCloseTo(1, 10);
  });

  it('prices a known inclusive output total without the reasoning breakdown, and only once', () => {
    const result = sumRequestEstimates(
      [
        call({
          callId: 'c1',
          usage: {
            inputTokens: 0,
            outputTokens: 1000,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            counterCoverage: { ...FULL_COVERAGE, output: 'partial', reasoning: 'missing' },
            providerTotals: { output: 1000 },
          },
        }),
      ],
      METERED,
    );

    const item = onlyItem(result.items);
    expect(item.completeness).toBe('complete');
    expect(item.amount).toBeCloseTo(0.01, 12);
    // The breakdown is unavailable for display, which is not a reason to refuse the price.
    expect(item.reasons).toEqual(['reasoning-not-reported']);
  });

  it('never adds a reported reasoning count on top of the inclusive total that contains it', () => {
    const result = sumRequestEstimates(
      [
        call({
          callId: 'c1',
          usage: {
            inputTokens: 0,
            outputTokens: 600,
            reasoningTokens: 400,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            counterCoverage: FULL_COVERAGE,
            providerTotals: { output: 1000 },
          },
        }),
      ],
      METERED,
    );

    expect(result.amount).toBeCloseTo(0.01, 12);
    expect(result.amount).not.toBeCloseTo(0.014, 12);
  });

  it('cannot claim a complete price when the generated count was never reported', () => {
    const result = sumRequestEstimates(
      [
        call({
          callId: 'c1',
          usage: {
            inputTokens: 1000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
            counterCoverage: { ...FULL_COVERAGE, output: 'missing', reasoning: 'missing' },
          },
        }),
      ],
      METERED,
    );

    const item = onlyItem(result.items);
    expect(item.completeness).toBe('partial');
    expect(item.amount).toBeNull();
    expect(item.reasons).toContain('unknown-output-count');
  });
});

describe('callRunnerKey — kind-qualified identity', () => {
  function callWith(overrides: {
    backendKind: 'api' | 'cli' | 'shell' | 'agent';
    runnerName?: string;
    identity?: CallUsageEvidence['invocationIdentity'];
  }): CallUsageEvidence {
    return CallUsageEvidenceSchema.parse({
      callId: 'c1',
      role: 'implementer',
      backendKind: overrides.backendKind,
      ...(overrides.runnerName !== undefined && { runnerName: overrides.runnerName }),
      usageBoundary: 'unknown',
      usage: null,
      ...(overrides.identity !== undefined && { invocationIdentity: overrides.identity }),
    });
  }

  it('qualifies a recorded name with its kind, so the CLI and API twins differ', () => {
    expect(callRunnerKey(callWith({ backendKind: 'cli', runnerName: 'opencode' }))).toBe(
      'cli:opencode',
    );
    expect(callRunnerKey(callWith({ backendKind: 'api', runnerName: 'opencode' }))).toBe(
      'api:opencode',
    );
  });

  it('normalizes a CLI command to the tool it starts', () => {
    expect(callRunnerKey(callWith({ backendKind: 'cli', runnerName: 'claude' }))).toBe(
      'cli:claude-code',
    );
  });

  it('takes the invocation identity over the call name when both are recorded', () => {
    const identity = InvocationIdentitySchema.parse({
      version: 1,
      capturedAt: 1,
      runner: { kind: 'api', id: 'my-endpoint' },
      billing: { posture: 'unknown', basis: 'unknown' },
    });
    expect(callRunnerKey(callWith({ backendKind: 'cli', runnerName: 'claude', identity }))).toBe(
      'api:my-endpoint',
    );
  });

  it('leaves a call with no name keyless', () => {
    expect(callRunnerKey(callWith({ backendKind: 'shell' }))).toBeUndefined();
  });
});
