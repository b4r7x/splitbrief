import { describe, expect, it } from 'vitest';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import {
  RecoveryBudgetResourceSchema,
  type BudgetAccountingKey,
  type RecoveryCallEstimate,
  type RecoveryOperationEnvelope,
} from '../../../core/schemas/brief-recovery.js';
import { estimateBriefRecoveryCall, type RecoveryFiniteEstimate } from './estimate.js';
import {
  recoveryBudgetAccountingKey,
  reserveBriefRecoveryCall,
  reserveProviderDependentRecoveryCall,
} from './enforce.js';

const pricingCache: ModelCacheAccessor = {
  getModelsDevCatalog: () => ({
    openai: {
      id: 'openai',
      models: {
        'gpt-5.4': {
          id: 'gpt-5.4',
          cost: { input: 2.5, output: 15 },
          limit: { context: 400_000 },
        },
      },
    },
  }),
  getProviderModels: () => null,
};

const key = (operationId: string, generation = 3): BudgetAccountingKey => ({
  sessionId: 'session-1',
  epochId: 'epoch-1',
  operationId,
  generation,
});

function boundedEnvelope(): RecoveryOperationEnvelope {
  return {
    version: 1,
    dispatchLimit: 64,
    callCount: 1,
    totalPromptBytes: 1_000,
    totalInputTokensUpperBound: 8_000,
    totalOutputTokensUpperBound: 8_192,
    totalNormalizedOutputBytes: 96 * 1_024,
    totalDeclaredArtifactBytes: 96 * 1_024,
    callsDigest: 'calls'.padEnd(64, '0'),
  };
}

function unavailableEstimate(): RecoveryCallEstimate {
  const estimate = estimateBriefRecoveryCall({
    prompt: 'Retry the frozen Brief once.',
    plannerTool: 'opencode',
    plannerModel: 'auto',
    configuredOutputCap: 1_000,
    pricingCache,
  });
  if (estimate.kind !== 'unavailable') {
    throw new Error('expected an unpriced recovery estimate');
  }
  return estimate;
}

function pricedEstimate(): RecoveryFiniteEstimate {
  const estimate = estimateBriefRecoveryCall({
    prompt: 'Retry the frozen Brief once.',
    plannerTool: 'openai',
    plannerModel: 'gpt-5.4',
    configuredOutputCap: 1_000,
    pricingCache,
  });
  if (!isFiniteRecoveryEstimate(estimate)) {
    throw new Error('expected a priced recovery estimate');
  }
  return estimate;
}

function isFiniteRecoveryEstimate(
  estimate: ReturnType<typeof estimateBriefRecoveryCall>,
): estimate is RecoveryFiniteEstimate {
  return estimate.kind === 'finite' && estimate.amount !== null;
}

describe('provider-dependent recovery budget policy', () => {
  it('admits one bounded provider-dependent reservation without a dollar cap', () => {
    const estimate = unavailableEstimate();
    const accountingKey = key('operation-provider-dependent');

    const first = reserveProviderDependentRecoveryCall({
      accountingKey,
      estimate,
      envelope: boundedEnvelope(),
    });
    const replayed = reserveProviderDependentRecoveryCall({
      accountingKey,
      estimate,
      envelope: boundedEnvelope(),
    });
    expect(first).toEqual(replayed);
    expect(first).toMatchObject({ kind: 'reserved' });
    if (first.kind !== 'reserved') throw new Error(first.reason);
    expect(first.resource).toMatchObject({
      kind: 'provider-dependent',
      accountingKey: 'session-1/epoch-1/operation-provider-dependent',
      pricingIdentity: 'opencode/auto',
      observedUsage: null,
      resolvedPricing: null,
    });
    expect(first.resource.envelope).toEqual(boundedEnvelope());
  });

  it('refuses capped unknown price before dispatch with brief_budget_unknown', () => {
    const decision = reserveBriefRecoveryCall({
      accountingKey: key('operation-capped-unknown'),
      estimate: unavailableEstimate(),
      currentKnownSpend: 0,
      activeReservations: [],
      maxBudget: 1,
    });
    expect(decision).toMatchObject({ kind: 'refused', code: 'brief_budget_unknown' });
    expect(decision).not.toHaveProperty('reservation');
  });

  it('refuses an unbounded call even without a cap', () => {
    const unbounded = estimateBriefRecoveryCall({
      prompt: 'Retry the frozen Brief once.',
      plannerTool: 'opencode',
      plannerModel: 'auto',
      pricingCache,
    });
    expect(unbounded).toMatchObject({ kind: 'unavailable', outputTokens: 0 });

    const decision = reserveProviderDependentRecoveryCall({
      accountingKey: key('operation-unbounded'),
      estimate: unbounded,
      envelope: boundedEnvelope(),
    });
    expect(decision).toMatchObject({ kind: 'refused', code: 'brief_budget_unknown' });
  });

  it('rejects a finite estimate routed to the provider-dependent admission', () => {
    expect(() =>
      reserveProviderDependentRecoveryCall({
        accountingKey: key('operation-misroute'),
        estimate: pricedEstimate(),
        envelope: boundedEnvelope(),
      }),
    ).toThrow('requires an unpriced recovery estimate');
  });

  it('serializes the accounting key for provider-dependent resources', () => {
    expect(recoveryBudgetAccountingKey(key('operation-1'))).toBe('session-1/epoch-1/operation-1');
  });
});

describe('recovery budget finite exactness', () => {
  it('never serializes unknown cost as zero dollars', () => {
    const decision = reserveProviderDependentRecoveryCall({
      accountingKey: key('operation-no-zero'),
      estimate: unavailableEstimate(),
      envelope: boundedEnvelope(),
    });
    if (decision.kind !== 'reserved') throw new Error(decision.reason);
    expect(decision.resource).not.toHaveProperty('amount');
    expect(JSON.stringify(decision.resource)).not.toContain('amount');
    expect(
      RecoveryBudgetResourceSchema.safeParse({ ...decision.resource, amount: 0 }).success,
    ).toBe(false);
  });

  it('reserves the exact finite amount within the cap and refuses a known excess', () => {
    const estimate = pricedEstimate();
    const within = reserveBriefRecoveryCall({
      accountingKey: key('operation-exact'),
      estimate,
      currentKnownSpend: 0,
      activeReservations: [],
      maxBudget: estimate.amount,
    });
    expect(within).toMatchObject({ kind: 'reserved' });
    if (within.kind !== 'reserved') throw new Error(within.reason);
    expect(within.reservation.amount).toBe(estimate.amount);

    const over = reserveBriefRecoveryCall({
      accountingKey: key('operation-excess'),
      estimate,
      currentKnownSpend: estimate.amount,
      activeReservations: [],
      maxBudget: estimate.amount,
    });
    expect(over).toMatchObject({ kind: 'refused', code: 'brief_budget_exhausted' });
  });
});
