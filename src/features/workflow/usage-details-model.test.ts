import { describe, expect, it } from 'vitest';
import type { RunnerCallCounterCoverage } from '../../core/runner-call-contract.js';
import type { RecoveryFact, RecoveryIssue } from '../../core/schemas/recovery/schemas.js';
import type { CostBreakdown } from '../../core/schemas/summary.js';
import { ZERO_TOKEN_USAGE, type TokenUsage } from '../../core/schemas/tokens.js';
import {
  deriveUsageDetails,
  readRecoveryContext,
  usageDetailRows,
  type UsageDetailRow,
  type UsageDetailsInput,
} from './usage-details-model.js';

function usage(fields: Partial<TokenUsage>): TokenUsage {
  return { ...ZERO_TOKEN_USAGE, ...fields };
}

function coverage(fields: Partial<RunnerCallCounterCoverage>): RunnerCallCounterCoverage {
  return {
    input: 'missing',
    output: 'missing',
    cacheRead: 'missing',
    cacheCreate: 'missing',
    reasoning: 'missing',
    ...fields,
  };
}

function breakdown(fields: Partial<CostBreakdown>): CostBreakdown {
  return {
    actualPlannerCost: 0,
    actualImplementerCost: 0,
    totalActualCost: 0,
    ...fields,
  };
}

function rows(input: UsageDetailsInput): UsageDetailRow[] {
  return usageDetailRows(deriveUsageDetails(input));
}

function facts(input: UsageDetailsInput, key: string): readonly string[] {
  const row = rows(input).find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`no row ${key}`);
  return row.facts;
}

function texts(input: UsageDetailsInput): string[] {
  return rows(input).flatMap((row) => [row.label, ...row.facts]);
}

describe('usage details counters', () => {
  it('reports a counter the provider sent as zero and leaves an unsent one unknown', () => {
    const reportedZero = {
      tokenUsage: usage({
        plannerInput: 1200,
        plannerOutput: 40,
        plannerCacheRead: 0,
        plannerCoverage: coverage({ input: 'reported', output: 'reported', cacheRead: 'reported' }),
      }),
      costBreakdown: null,
    };
    const neverReported = {
      tokenUsage: usage({
        plannerInput: 1200,
        plannerOutput: 40,
        plannerCoverage: coverage({ input: 'reported', output: 'reported' }),
      }),
      costBreakdown: null,
    };

    expect(facts(reportedZero, 'counter:cacheRead')).toEqual(['0']);
    expect(facts(neverReported, 'counter:cacheRead')).toEqual(['not reported']);
    expect(facts(reportedZero, 'counter:input')).toEqual(['1,200']);
  });

  it('keeps a seat that reported nothing out of the sum and names it', () => {
    const mixed = {
      tokenUsage: usage({
        plannerOutput: 400,
        plannerReasoning: 100,
        plannerCoverage: coverage({ output: 'reported', reasoning: 'reported' }),
        implementerOutput: 900,
        implementerCoverage: coverage({ output: 'reported' }),
      }),
      costBreakdown: null,
    };

    expect(facts(mixed, 'counter:output')).toEqual(['1,300']);
    expect(facts(mixed, 'counter:reasoning')).toEqual(['100 + unknown (BUILD)']);
  });

  it('keeps positive legacy counters visible without claiming coverage', () => {
    const legacy = {
      tokenUsage: usage({ implementerOutput: 1000 }),
      costBreakdown: null,
    };

    expect(facts(legacy, 'counter:output')).toEqual(['1,000 (legacy; coverage unknown)']);
    expect(facts(legacy, 'counter:input')).toEqual(['not reported']);
    expect(deriveUsageDetails(legacy).counters.find((row) => row.counter === 'output')).toEqual({
      counter: 'output',
      amount: { kind: 'legacy', tokens: 1000, unreported: [] },
    });
  });

  it('states nothing at all for a session that recorded nothing', () => {
    expect(rows({ tokenUsage: null, costBreakdown: null })).toEqual([
      { key: 'empty', kind: 'note', label: '', facts: ['No usage recorded'], tone: 'textDim' },
    ]);
  });
});

describe('usage details money', () => {
  it('labels a stored sum with no per-request pricing as a legacy, unattributed amount', () => {
    const legacy = {
      tokenUsage: usage({ plannerInput: 10 }),
      costBreakdown: breakdown({
        actualPlannerCost: 3.1,
        totalActualCost: 3.1,
        hasPricedUsage: true,
      }),
    };

    expect(deriveUsageDetails(legacy).basis).toBe('legacy-unattributed');
    expect(facts(legacy, 'money:amount')).toEqual(['$3.10']);
    expect(facts(legacy, 'money:basis')).toEqual(['legacy sum, no provenance']);
    expect(facts(legacy, 'rates:none')).toEqual(['not recorded']);
    expect(facts(legacy, 'money:note')).toEqual([
      'Recorded before per-request pricing; no rates were kept with it.',
    ]);
  });

  it('carries the rates a request was priced at and calls the amount an estimate', () => {
    const priced = {
      tokenUsage: usage({ plannerInput: 1_000_000 }),
      costBreakdown: breakdown({
        totalActualCost: 1,
        hasPricedUsage: true,
        requestEstimate: {
          amount: 1,
          currency: 'USD' as const,
          basis: 'catalog-estimate' as const,
          completeness: 'complete' as const,
          knownSubtotal: 1,
          reasons: [],
          items: [
            {
              callId: 'c1',
              role: 'planner' as const,
              usageBoundary: 'single-request' as const,
              amount: 1,
              knownSubtotal: 1,
              completeness: 'complete' as const,
              reasons: [],
              billing: { posture: 'api-metered' as const, basis: 'enforced-channel' as const },
              rates: {
                source: 'models-dev' as const,
                provider: 'acme',
                model: 'metered-model',
                inputPer1M: 1,
                outputPer1M: 10,
                capturedAt: 1_700_000_000_000,
                rateAsOf: '2026-06-01',
              },
            },
          ],
        },
      }),
    };

    expect(facts(priced, 'money:amount')).toEqual(['$1.00']);
    expect(facts(priced, 'money:basis')).toEqual(['catalog estimate']);
    expect(facts(priced, 'rates:0')).toEqual([
      'metered-model',
      'models.dev',
      'in $1.00/M',
      'out $10.00/M',
      'rates of 2026-06-01',
      '1 request',
    ]);
    for (const text of texts(priced)) expect(text).not.toMatch(/invoice|actual charge|billed/i);
  });

  it('reports an unpriceable request as not estimated rather than as zero dollars', () => {
    const unpriced = {
      tokenUsage: usage({ plannerInput: 500 }),
      costBreakdown: breakdown({
        hasUnpricedUsage: true,
        requestEstimate: {
          amount: null,
          currency: 'USD' as const,
          basis: 'catalog-estimate' as const,
          completeness: 'unavailable' as const,
          knownSubtotal: 0,
          reasons: ['unpriced-model' as const],
          items: [],
        },
      }),
    };

    expect(facts(unpriced, 'money:amount')).toEqual(['not estimated']);
    expect(facts(unpriced, 'money:reasons')).toEqual(['model has no published rate']);
    for (const text of texts(unpriced)) expect(text).not.toContain('$0.00');
  });

  it('does not claim subscription billing from catalog metadata alone', () => {
    const subscription = {
      tokenUsage: usage({ plannerInput: 90_000 }),
      costBreakdown: breakdown({
        providerRunMetadata: {
          'claude-code': {
            service: 'claude-code',
            offering: 'coding-subscription' as const,
            normalizedEndpoint: 'cli://claude-code',
            billing: 'subscription-included' as const,
            asOf: '2026-01-01',
          },
        },
        offeringPresentations: {
          'claude-code': { costLabel: 'Included in subscription', billingLabel: 'subscription' },
        },
      }),
    };

    expect(facts(subscription, 'money:amount')).toEqual(['not estimated']);
    for (const text of texts(subscription)) expect(text).not.toContain('$');
  });
});

describe('usage details billing', () => {
  it('keeps distinct recorded identities keyed separately when their display labels match', () => {
    const keys = ['agent:agent', 'api:Agent', 'Agent'];
    const input = {
      tokenUsage: null,
      costBreakdown: breakdown({
        providerRunMetadata: Object.fromEntries(
          keys.map((key) => [
            key,
            {
              service: key,
              offering: 'payg' as const,
              normalizedEndpoint: key,
              billing: 'unknown' as const,
              asOf: '',
            },
          ]),
        ),
      }),
    };
    const billing = rows(input).filter(
      (row) => row.kind === 'entry' && row.key.startsWith('billing:'),
    );

    expect(billing.map((row) => row.label)).toEqual(['Agent', 'Agent', 'Agent']);
    expect(billing.map((row) => row.key)).toEqual(keys.map((key) => `billing:${key}`));
  });

  it('bills an enforced api-key invocation as metered, not as the tool default', () => {
    const enforced = {
      tokenUsage: usage({ plannerInput: 10 }),
      costBreakdown: breakdown({
        providerRunMetadata: {
          'claude-code': {
            service: 'claude-code',
            offering: 'payg' as const,
            normalizedEndpoint: 'cli://claude-code',
            // The catalogued default the run's own evidence overrides.
            billing: 'subscription-included' as const,
            asOf: '2026-01-01',
            billingAttribution: {
              posture: 'api-metered' as const,
              basis: 'enforced-channel' as const,
              evidenceId: 'cli.claude-code.api-key',
            },
          },
        },
      }),
    };

    expect(deriveUsageDetails(enforced).billing).toEqual([
      {
        key: 'claude-code',
        tool: 'claude-code',
        posture: 'api-metered',
        basis: 'enforced-channel',
        proven: true,
      },
    ]);
    expect(facts(enforced, 'billing:claude-code')).toEqual(['metered', 'enforced channel']);
    for (const text of texts(enforced)) expect(text).not.toContain('subscription');
  });

  it('marks an unproven posture as the catalogued default it is', () => {
    const unproven = {
      tokenUsage: usage({ plannerInput: 10 }),
      costBreakdown: breakdown({
        providerRunMetadata: {
          codex: {
            service: 'codex',
            offering: 'payg' as const,
            normalizedEndpoint: 'cli://codex',
            billing: 'subscription-included' as const,
            asOf: '2026-01-01',
            billingAttribution: { posture: 'unknown' as const, basis: 'unknown' as const },
          },
        },
      }),
    };

    expect(facts(unproven, 'billing:codex')).toEqual(['subscription', 'no evidence, tool default']);
  });

  it.each([
    ['shell:shell', 'Custom Shell'],
    ['agent:agent', 'Agent'],
    ['shell:claude', 'claude'],
    ['shell:opencode', 'opencode'],
    ['agent:claude', 'claude'],
    ['agent:opencode', 'opencode'],
  ])('names billing identity %s without changing real command names', (key, label) => {
    const input = {
      tokenUsage: usage({ plannerInput: 10 }),
      costBreakdown: breakdown({
        providerRunMetadata: {
          [key]: {
            service: key,
            offering: 'payg',
            normalizedEndpoint: key,
            billing: 'unknown',
            asOf: '',
          },
        },
      }),
    };
    expect(deriveUsageDetails(input).billing.map((row) => row.tool)).toEqual([label]);
    expect(rows(input).find((row) => row.key === `billing:${key}`)?.label).toBe(label);
  });

  it('names a kind-qualified identity in its own words, keeping the API twin literal', () => {
    const input = {
      tokenUsage: usage({ plannerInput: 10 }),
      costBreakdown: breakdown({
        providerRunMetadata: {
          'api:opencode': {
            service: 'opencode',
            offering: 'payg' as const,
            normalizedEndpoint: 'https://my-endpoint.example/v1',
            billing: 'api-metered' as const,
            asOf: '',
            billingAttribution: { posture: 'unknown' as const, basis: 'unknown' as const },
          },
          'cli:opencode': {
            service: 'opencode',
            offering: 'payg' as const,
            normalizedEndpoint: 'cli:opencode',
            billing: 'provider-dependent' as const,
            asOf: '',
            billingAttribution: { posture: 'unknown' as const, basis: 'unknown' as const },
          },
        },
      }),
    };

    expect(deriveUsageDetails(input).billing.map((row) => row.tool)).toEqual([
      'opencode',
      'OpenCode CLI',
    ]);
    expect(facts(input, 'billing:api:opencode')).toEqual(['metered', 'no evidence, tool default']);
    expect(facts(input, 'billing:cli:opencode')).toEqual(['provider', 'no evidence, tool default']);
  });
});

function contextIssue(facts: Record<string, RecoveryFact>): RecoveryIssue {
  return {
    id: 'rec_context',
    reason: 'review-failed',
    seat: 'review',
    phase: 'final-review',
    status: 'awaiting-user',
    files: [],
    affectedTaskIds: [],
    message: 'The review seat was not given the context this call needs.',
    details: [],
    facts,
    availableActions: ['retry-same-worker', 'end-run'],
    recommendedAction: 'retry-same-worker',
    createdAt: '2026-04-29T12:00:00.000Z',
  };
}

const MEASURED_CONTEXT: Record<string, RecoveryFact> = {
  apiContextCode: 'insufficient-context',
  apiContextSeat: 'review',
  apiContextCause: 'input-budget',
  apiContextModel: 'qwen3-coder-30b',
  apiContextMissingSectionsJson: '["evidence.json","drift-report.json"]',
  apiContextInputEstimate: 404_000,
  apiContextEstimationMargin: 4_000,
  apiContextRequiredOutputTokens: 4_096,
  apiContextRequiredTokens: 412_096,
  apiContextAvailableTokens: 32_768,
  apiContextOutputCap: 8_192,
  apiContextBudgetSource: 'observed-active',
  apiContextOmittedRequestOptionsJson: JSON.stringify([
    'temperature',
    'reasoning_effort',
    'stream_options.include_usage',
  ]),
};

describe('usage details context', () => {
  it('states what the halt needed, what it had, and what it reserved', () => {
    const input = {
      tokenUsage: null,
      costBreakdown: null,
      recovery: contextIssue(MEASURED_CONTEXT),
    };

    expect(facts(input, 'context:seat')).toEqual(['REVIEW']);
    expect(facts(input, 'context:model')).toEqual(['qwen3-coder-30b']);
    expect(facts(input, 'context:cause')).toEqual(['larger than the context window']);
    expect(facts(input, 'context:missing')).toEqual(['evidence.json', 'drift-report.json']);
    expect(facts(input, 'context:needed')).toEqual([
      '412,096 tokens',
      'input 404,000',
      'margin 4,000',
      'output reserve 4,096',
    ]);
    expect(facts(input, 'context:available')).toEqual(['32,768 tokens', 'output cap 8,192']);
    expect(facts(input, 'context:budget-source')).toEqual(['active provider limit']);
    expect(facts(input, 'context:omitted-options')).toEqual([
      'temperature',
      'reasoning effort',
      'stream usage',
    ]);
    for (const text of texts(input)) expect(text).not.toMatch(/invoice|charge|billed|\$/i);
  });

  it('leads with the halt and keeps the run with no counters out of the empty state', () => {
    const input = {
      tokenUsage: null,
      costBreakdown: null,
      recovery: contextIssue(MEASURED_CONTEXT),
    };
    const keys = rows(input).map((row) => row.key);

    expect(deriveUsageDetails(input).empty).toBe(false);
    expect(keys[0]).toBe('context');
    expect(keys).toContain('tokens');
    expect(keys.indexOf('context')).toBeLessThan(keys.indexOf('tokens'));
    expect(rows({ tokenUsage: null, costBreakdown: null }).map((row) => row.key)).toEqual([
      'empty',
    ]);
  });

  it('leaves a measurement nobody took unknown instead of calling it zero', () => {
    const input = {
      tokenUsage: null,
      costBreakdown: null,
      recovery: {
        ...contextIssue({
          apiContextCode: 'insufficient-context',
          apiContextSeat: 'plan',
          apiContextCause: 'missing-required',
          apiContextMissingSectionsJson: '["evidence.json"]',
        }),
        seat: 'plan',
      } satisfies RecoveryIssue,
    };

    expect(facts(input, 'context:seat')).toEqual(['PLAN']);
    expect(facts(input, 'context:model')).toEqual(['not recorded']);
    expect(facts(input, 'context:needed')).toEqual(['not measured']);
    expect(facts(input, 'context:available')).toEqual(['not measured']);
    for (const text of texts(input)) expect(text).not.toContain('0 tokens');
  });

  it('keeps a legacy or unreadable section list unavailable rather than inventing an empty one', () => {
    const base = {
      apiContextCode: 'insufficient-context',
      apiContextSeat: 'plan',
      apiContextCause: 'input-budget',
    } satisfies Record<string, RecoveryFact>;
    const absent = { tokenUsage: null, costBreakdown: null, recovery: contextIssue(base) };
    const malformed = {
      tokenUsage: null,
      costBreakdown: null,
      recovery: contextIssue({ ...base, apiContextMissingSectionsJson: '{"sections":2}' }),
    };
    const notStrings = {
      tokenUsage: null,
      costBreakdown: null,
      recovery: contextIssue({ ...base, apiContextMissingSectionsJson: '[1,2]' }),
    };
    const recordedEmpty = {
      tokenUsage: null,
      costBreakdown: null,
      recovery: contextIssue({ ...base, apiContextMissingSectionsJson: '[]' }),
    };

    expect(facts(absent, 'context:missing')).toEqual(['not recorded']);
    expect(facts(malformed, 'context:missing')).toEqual(['not recorded']);
    expect(facts(notStrings, 'context:missing')).toEqual(['not recorded']);
    // A list the halt recorded as empty is not a missing list: nothing was missing, so no row.
    expect(rows(recordedEmpty).map((row) => row.key)).not.toContain('context:missing');
  });

  it('keeps absent or malformed limit provenance unavailable', () => {
    const base = {
      apiContextCode: 'insufficient-context',
      apiContextSeat: 'plan',
      apiContextCause: 'input-budget',
    } satisfies Record<string, RecoveryFact>;
    const absent = readRecoveryContext(contextIssue(base));
    const malformed = readRecoveryContext(
      contextIssue({
        ...base,
        apiContextBudgetSource: 'guessed',
        apiContextOmittedRequestOptionsJson: '{bad',
      }),
    );

    expect(absent?.budgetSource).toBeNull();
    expect(absent?.omittedRequestOptions).toBeNull();
    expect(malformed?.budgetSource).toBeNull();
    expect(malformed?.omittedRequestOptions).toBeNull();
  });

  it('reads only a context diagnosis, and only one that names a packet seat', () => {
    expect(readRecoveryContext(null)).toBeNull();
    expect(readRecoveryContext(contextIssue({ blocking: 2 }))).toBeNull();
    expect(readRecoveryContext(contextIssue({ reviewFailureKind: 'call-failed' }))).toBeNull();
    expect(
      readRecoveryContext({
        ...contextIssue({ apiContextCode: 'insufficient-context', apiContextSeat: 'build' }),
        seat: 'build',
      }),
    ).toBeNull();
    // The seat survives on a record whose issue predates `RecoveryIssue.seat`.
    expect(
      readRecoveryContext({
        ...contextIssue({ apiContextCode: 'insufficient-context', apiContextSeat: 'plan' }),
        seat: undefined,
      })?.seat,
    ).toBe('plan');
    expect(readRecoveryContext(contextIssue(MEASURED_CONTEXT))?.cause).toBe('input-budget');
    expect(
      readRecoveryContext(contextIssue({ ...MEASURED_CONTEXT, apiContextCause: 'guessing' }))
        ?.cause,
    ).toBeNull();
  });
});
