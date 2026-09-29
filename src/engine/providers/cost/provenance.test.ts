import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InvocationIdentitySchema,
  type InvocationIdentity,
} from '../../../core/schemas/invocation-identity.js';
import type { ModelsDevCatalog } from '../../../core/schemas/models-dev.js';
import {
  CostBreakdownSchema,
  SummarySchema,
  costAmountBasis,
  type CostBreakdown,
} from '../../../core/schemas/summary.js';
import {
  CallUsageEvidenceSchema,
  type CallUsageEvidence,
} from '../../../core/schemas/usage-evidence.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import { makeSummary, makeUsage } from '#testing/helpers/factories/summary.js';
import { buildCost } from '../../orchestrator/evidence/review-packet/sections.js';
import type { ResolvedPricing } from '../pricing-resolver.js';
import { calculateCostBreakdown } from './breakdown.js';
import { sumRequestEstimates } from './request-estimates.js';

const LOOKUP_TIME = Date.UTC(2026, 8, 16, 12, 0, 0);

const FULLY_REPORTED = {
  input: 'reported',
  output: 'reported',
  cacheRead: 'reported',
  cacheCreate: 'reported',
  reasoning: 'reported',
} as const;

function catalogAt(inputPer1M: number, outputPer1M: number): ModelsDevCatalog {
  return {
    acme: {
      id: 'acme',
      models: {
        'metered-model': {
          id: 'metered-model',
          cost: { input: inputPer1M, output: outputPer1M },
          limit: { context: 1_000_000 },
        },
      },
    },
  };
}

function makeCall(overrides: {
  callId: string;
  runnerName: string;
  backendKind?: 'api' | 'cli';
  model?: string;
  identity?: InvocationIdentity;
  inputTokens?: number;
  outputTokens?: number;
}): CallUsageEvidence {
  return CallUsageEvidenceSchema.parse({
    callId: overrides.callId,
    role: 'implementer',
    backendKind: overrides.backendKind ?? 'cli',
    runnerName: overrides.runnerName,
    ...(overrides.model !== undefined && { model: overrides.model }),
    usageBoundary: 'single-request',
    ...(overrides.identity !== undefined && { invocationIdentity: overrides.identity }),
    usage: {
      inputTokens: overrides.inputTokens ?? 1_000_000,
      outputTokens: overrides.outputTokens ?? 1_000_000,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      reasoningTokens: 0,
      counterCoverage: FULLY_REPORTED,
    },
  });
}

function identity(overrides: Record<string, unknown>): InvocationIdentity {
  return InvocationIdentitySchema.parse({
    version: 1,
    capturedAt: LOOKUP_TIME,
    runner: { kind: 'cli', id: 'claude-code' },
    billing: { posture: 'unknown', basis: 'unknown' },
    ...overrides,
  });
}

/** A matrix row proved this exact invocation ran on an API key: metered, not the subscription. */
const ENFORCED_API_KEY = identity({
  configuredChannel: 'api-key',
  enforcedChannel: { channel: 'api-key', evidenceId: 'cli.claude-code.api-key' },
  billing: {
    posture: 'api-metered',
    basis: 'enforced-channel',
    evidenceId: 'cli.claude-code.api-key',
  },
});

/** The same binary proved on its supported session channel. */
const ENFORCED_SESSION = identity({
  configuredChannel: 'session',
  enforcedChannel: { channel: 'session', evidenceId: 'cli.claude-code.session' },
  billing: {
    posture: 'subscription-included',
    basis: 'enforced-channel',
    evidenceId: 'cli.claude-code.session',
  },
});

/** A configuration declaration nobody enforced. It is a preference, not a method. */
const CONFIGURED_ONLY = identity({ configuredChannel: 'session' });

/** Nothing was admitted for this invocation; it ran on whatever the host is set to. */
const HOST_CONFIGURED = identity({});

/** Two channels that disagree. Neither is discarded, and neither gets to bill the run. */
const CONFLICTING = identity({
  observedChannel: { channel: 'session', evidenceId: 'cli.claude-code.session' },
  enforcedChannel: { channel: 'api-key', evidenceId: 'cli.claude-code.api-key' },
});

function meteredBreakdown(
  cache: ReturnType<typeof makeModelCacheAccessor>,
  callEvidence: readonly CallUsageEvidence[],
): CostBreakdown {
  return calculateCostBreakdown(
    {
      tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
      plannerTool: 'claude-code',
      implementerTool: 'acme',
      implementerModel: 'metered-model',
      callEvidence,
    },
    cache,
  );
}

function cliBreakdown(callEvidence: readonly CallUsageEvidence[] | undefined): CostBreakdown {
  return calculateCostBreakdown({
    tokenUsage: makeUsage({ implementerInput: 1_000, implementerOutput: 1_000 }),
    plannerTool: 'claude-code',
    implementerTool: 'claude-code',
    ...(callEvidence !== undefined && { callEvidence }),
  });
}

function roundTrip(breakdown: CostBreakdown): CostBreakdown {
  return CostBreakdownSchema.parse(JSON.parse(JSON.stringify(breakdown)));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('rate provenance', () => {
  it('keeps the rates a stored run was priced at when the catalog moves', () => {
    vi.useFakeTimers();
    vi.setSystemTime(LOOKUP_TIME);
    const call = makeCall({
      callId: 'c1',
      runnerName: 'acme',
      backendKind: 'api',
      model: 'metered-model',
    });
    const stored = roundTrip(
      meteredBreakdown(makeModelCacheAccessor({ catalog: catalogAt(1, 10) }), [call]),
    );

    vi.setSystemTime(LOOKUP_TIME + 86_400_000);
    const recosted = meteredBreakdown(makeModelCacheAccessor({ catalog: catalogAt(100, 1_000) }), [
      call,
    ]);

    expect(stored.requestEstimate?.items[0]?.rates).toEqual({
      source: 'models-dev',
      provider: 'acme',
      model: 'metered-model',
      inputPer1M: 1,
      outputPer1M: 10,
      capturedAt: LOOKUP_TIME,
    });
    expect(stored.requestEstimate?.amount).toBeCloseTo(11, 10);
    // The live lookup found other rates at another time; the stored record is untouched.
    expect(recosted.requestEstimate?.items[0]?.rates?.inputPer1M).toBe(100);
    expect(recosted.requestEstimate?.items[0]?.rates?.capturedAt).toBe(LOOKUP_TIME + 86_400_000);
    expect(recosted.requestEstimate?.amount).toBeCloseTo(1100, 10);

    // The export reads the stored estimate rather than recosting it.
    const exported = buildCost(makeSummary({ costBreakdown: stored }), []);
    expect(exported.costBreakdown?.requestEstimate?.items[0]?.rates).toEqual(
      stored.requestEstimate?.items[0]?.rates,
    );
    expect(exported.amountBasis).toBe('catalog-estimate');
  });

  it('records the lookup time without manufacturing a rate date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(LOOKUP_TIME);
    const breakdown = meteredBreakdown(makeModelCacheAccessor({ catalog: catalogAt(1, 10) }), [
      makeCall({ callId: 'c1', runnerName: 'acme', backendKind: 'api', model: 'metered-model' }),
    ]);

    const rates = breakdown.requestEstimate?.items[0]?.rates;
    expect(rates?.capturedAt).toBe(LOOKUP_TIME);
    expect(rates?.rateAsOf).toBeUndefined();
  });

  it('copies a rate date only from a source that publishes one', () => {
    const dated: ResolvedPricing = {
      inputPer1M: 1,
      outputPer1M: 10,
      isLocal: false,
      isPriced: true,
      pricingMode: 'api-priced',
      name: 'metered-model',
      provider: 'acme',
      source: 'bundled-fallback',
      rateAsOf: '2026-06-01',
    };

    const estimate = sumRequestEstimates(
      [makeCall({ callId: 'c1', runnerName: 'acme', model: 'metered-model' })],
      dated,
      LOOKUP_TIME,
    );

    expect(estimate.items[0]?.rates).toMatchObject({
      source: 'bundled-fallback',
      rateAsOf: '2026-06-01',
      capturedAt: LOOKUP_TIME,
    });
  });

  it('names the context tier a request was priced at', () => {
    const tiered: ResolvedPricing = {
      inputPer1M: 1,
      outputPer1M: 1,
      pricingTiers: [{ type: 'context', thresholdTokens: 200_000, inputPer1M: 2 }],
      isLocal: false,
      isPriced: true,
      pricingMode: 'api-priced',
      name: 'metered-model',
      provider: 'acme',
      source: 'models-dev',
    };

    const below = sumRequestEstimates(
      [makeCall({ callId: 'c1', runnerName: 'acme', inputTokens: 100, outputTokens: 0 })],
      tiered,
      LOOKUP_TIME,
    );
    const above = sumRequestEstimates(
      [makeCall({ callId: 'c2', runnerName: 'acme', inputTokens: 300_000, outputTokens: 0 })],
      tiered,
      LOOKUP_TIME,
    );

    expect(below.items[0]?.rates?.selectedThresholdTokens).toBeUndefined();
    expect(below.items[0]?.rates?.inputPer1M).toBe(1);
    expect(above.items[0]?.rates?.selectedThresholdTokens).toBe(200_000);
    expect(above.items[0]?.rates?.inputPer1M).toBe(2);
  });

  it('leaves a run that priced no request as an unattributed sum, never an invoice', () => {
    const legacy = cliBreakdown(undefined);

    expect(legacy.requestEstimate).toBeUndefined();
    expect(costAmountBasis(legacy)).toBe('legacy-unattributed');
    expect(buildCost(makeSummary({ costBreakdown: legacy }), []).amountBasis).toBe(
      'legacy-unattributed',
    );
    expect(buildCost(makeSummary(), []).amountBasis).toBe('unavailable');
    expect(legacy.providerRunMetadata?.['claude-code']?.billingAttribution).toEqual({
      posture: 'unknown',
      basis: 'legacy-unattributed',
    });
  });
});

describe('billing provenance', () => {
  it('bills an enforced api-key invocation as what it was, not as the tool default', () => {
    const breakdown = cliBreakdown([
      makeCall({ callId: 'c1', runnerName: 'claude-code', identity: ENFORCED_API_KEY }),
    ]);

    expect(breakdown.requestEstimate?.items[0]?.billing).toEqual({
      posture: 'api-metered',
      basis: 'enforced-channel',
      evidenceId: 'cli.claude-code.api-key',
    });
    const metadata = breakdown.providerRunMetadata?.['cli:claude-code'];
    expect(metadata?.billing).toBe('api-metered');
    expect(metadata?.offering).toBe('payg');
    expect(breakdown.offeringPresentations?.['cli:claude-code']?.billingLabel).not.toBe(
      'subscription-included',
    );
    // The same claim cannot even be recorded: the contract refuses it at the source.
    expect(
      InvocationIdentitySchema.safeParse({
        ...ENFORCED_API_KEY,
        billing: { ...ENFORCED_API_KEY.billing, posture: 'subscription-included' },
      }).success,
    ).toBe(false);
  });

  it('treats an unenforced preference and an unadmitted host as no evidence at all', () => {
    for (const unproven of [CONFIGURED_ONLY, HOST_CONFIGURED, CONFLICTING]) {
      const breakdown = cliBreakdown([
        makeCall({ callId: 'c1', runnerName: 'claude-code', identity: unproven }),
      ]);
      const item = breakdown.requestEstimate?.items[0];

      expect(item?.billing).toEqual({ posture: 'unknown', basis: 'unknown' });
      // An unknown invocation cannot inherit the tool catalog billing default.
      expect(breakdown.providerRunMetadata?.['cli:claude-code']).toMatchObject({
        billing: 'unknown',
        offering: 'payg',
        billingAttribution: { posture: 'unknown', basis: 'unknown' },
      });
    }
  });

  it('bills a call with no recorded identity as unknown', () => {
    const breakdown = cliBreakdown([makeCall({ callId: 'c1', runnerName: 'claude-code' })]);

    expect(breakdown.requestEstimate?.items[0]?.billing).toEqual({
      posture: 'unknown',
      basis: 'unknown',
    });
    expect(breakdown.requestEstimate?.items[0]?.invocationIdentity).toBeUndefined();
  });

  it('keeps one CLI reached three ways as three requests, and bills the tool as unknown', () => {
    const stored = roundTrip(
      cliBreakdown([
        makeCall({ callId: 'c1', runnerName: 'claude-code', identity: ENFORCED_API_KEY }),
        makeCall({ callId: 'c2', runnerName: 'claude-code', identity: ENFORCED_SESSION }),
        makeCall({ callId: 'c3', runnerName: 'claude-code', identity: CONFIGURED_ONLY }),
      ]),
    );

    const items = stored.requestEstimate?.items ?? [];
    expect(items.map((item) => item.billing)).toEqual([
      { posture: 'api-metered', basis: 'enforced-channel', evidenceId: 'cli.claude-code.api-key' },
      {
        posture: 'subscription-included',
        basis: 'enforced-channel',
        evidenceId: 'cli.claude-code.session',
      },
      { posture: 'unknown', basis: 'unknown' },
    ]);
    // Every identity survives the round trip whole, evidence id included.
    expect(items.map((item) => item.invocationIdentity)).toEqual([
      ENFORCED_API_KEY,
      ENFORCED_SESSION,
      CONFIGURED_ONLY,
    ]);
    // Two proven channels that disagree do not let either bill the tool.
    expect(stored.providerRunMetadata?.['cli:claude-code']).toMatchObject({
      billing: 'unknown',
      billingAttribution: { posture: 'unknown', basis: 'unknown' },
    });
    expect(stored.providerRunMetadata?.['cli:claude-code']?.offering).not.toBe(
      'coding-subscription',
    );
  });

  it('carries one agreed channel to the tool it served', () => {
    const breakdown = cliBreakdown([
      makeCall({ callId: 'c1', runnerName: 'claude-code', identity: ENFORCED_SESSION }),
      makeCall({ callId: 'c2', runnerName: 'claude-code', identity: ENFORCED_SESSION }),
    ]);

    expect(breakdown.providerRunMetadata?.['cli:claude-code']).toMatchObject({
      billing: 'subscription-included',
      offering: 'coding-subscription',
      billingAttribution: {
        posture: 'subscription-included',
        basis: 'enforced-channel',
        evidenceId: 'cli.claude-code.session',
      },
    });
  });

  it('builds a complete valid summary out of an all-unknown source matrix', () => {
    const breakdown = cliBreakdown([
      makeCall({ callId: 'c1', runnerName: 'claude-code', identity: HOST_CONFIGURED }),
      makeCall({ callId: 'c2', runnerName: 'claude-code' }),
    ]);
    const summary = SummarySchema.parse(
      JSON.parse(JSON.stringify(makeSummary({ costBreakdown: breakdown }))),
    );

    expect(summary.costBreakdown?.requestEstimate?.items).toHaveLength(2);
    expect(summary.costBreakdown?.requestEstimate?.completeness).toBe('unavailable');
    expect(costAmountBasis(summary.costBreakdown)).toBe('unavailable');
    const exported = buildCost(summary, []);
    expect(
      exported.costBreakdown?.providerRunMetadata?.['cli:claude-code']?.billingAttribution,
    ).toEqual({ posture: 'unknown', basis: 'unknown' });
  });
});

describe('kind-qualified runner identity', () => {
  const API_KEY = InvocationIdentitySchema.parse({
    version: 1,
    capturedAt: LOOKUP_TIME,
    runner: { kind: 'api', id: 'claude-code' },
    observedChannel: { channel: 'api-key', evidenceId: 'api.claude-code.api-key' },
    billing: {
      posture: 'api-metered',
      basis: 'observed-invocation',
      evidenceId: 'api.claude-code.api-key',
    },
  });
  const CLI_SESSION = InvocationIdentitySchema.parse({
    version: 1,
    capturedAt: LOOKUP_TIME,
    runner: { kind: 'cli', id: 'claude-code' },
    enforcedChannel: { channel: 'session', evidenceId: 'cli.claude-code.session' },
    billing: {
      posture: 'subscription-included',
      basis: 'enforced-channel',
      evidenceId: 'cli.claude-code.session',
    },
  });

  it('keeps an API worker named after a CLI tool apart from the CLI itself', () => {
    const cache = makeModelCacheAccessor({ catalog: catalogAt(1, 10) });
    const breakdown = calculateCostBreakdown(
      {
        tokenUsage: makeUsage({ implementerInput: 1_000_000, implementerOutput: 1_000_000 }),
        plannerTool: 'claude-code',
        implementerTool: 'claude-code',
        implementerModel: 'metered-model',
        callEvidence: [
          makeCall({
            callId: 'api-1',
            runnerName: 'claude-code',
            backendKind: 'api',
            model: 'metered-model',
            identity: API_KEY,
          }),
          makeCall({
            callId: 'cli-1',
            runnerName: 'claude-code',
            backendKind: 'cli',
            model: 'metered-model',
            identity: CLI_SESSION,
          }),
        ],
      },
      cache,
    );

    // Two runners, two keys: the API spend never merges into the CLI subscription.
    expect(Object.keys(breakdown.providerCosts ?? {}).toSorted()).toEqual([
      'api:claude-code',
      'cli:claude-code',
    ]);
    expect(breakdown.providerCosts?.['api:claude-code']?.cost).toBeGreaterThan(0);
    expect(breakdown.providerCosts?.['cli:claude-code']?.cost).toBe(0);

    // The API seat is a custom endpoint; the CLI seat keeps its catalogued identity.
    expect(breakdown.providerRunMetadata?.['api:claude-code']).toMatchObject({
      service: 'claude-code',
      offering: 'payg',
      billing: 'api-metered',
    });
    expect(breakdown.providerRunMetadata?.['cli:claude-code']).toMatchObject({
      service: 'claude-code',
      offering: 'coding-subscription',
      billing: 'subscription-included',
    });
    expect(breakdown.offeringPresentations?.['api:claude-code']?.costLabel).toMatch(/^\$/);
    expect(breakdown.offeringPresentations?.['cli:claude-code']?.costLabel).toBe(
      'subscription-included',
    );

    const items = breakdown.requestEstimate?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.completeness).toBe('complete');
    expect(items[0]?.rates?.provider).toBe('claude-code');
    expect(items[1]?.completeness).toBe('unavailable');
    expect(items[1]?.reasons).toContain('unpriced-model');
  });

  it('keeps the legacy name-only identity for a run with no recorded calls', () => {
    const legacy = cliBreakdown(undefined);
    expect(legacy.providerRunMetadata?.['claude-code']?.offering).toBe('coding-subscription');
    expect(legacy.providerRunMetadata?.['cli:claude-code']).toBeUndefined();
  });
});
