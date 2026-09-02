import { describe, expect, it } from 'vitest';
import {
  RecoveryBudgetResourceSchema,
  type BudgetAccountingKey,
  type BudgetReservation,
  type RecoveryUsage,
} from '../../../core/schemas/brief-recovery/budget.js';
import { estimateBriefRecoveryCall } from './recovery-estimate.js';
import {
  reconcileBriefRecoveryCall,
  reserveBriefRecoveryCall,
  reserveProviderDependentRecoveryCall,
  terminalChargeBriefRecoveryCall,
} from './recovery-reservation.js';
import { makeModelCacheAccessor } from '#testing/helpers/factories/model-cache.js';
import {
  makeBoundedOperationEnvelope as boundedEnvelope,
  makePricedRecoveryEstimate,
  makeRecoveryBudgetKey as key,
  makeUnavailableRecoveryEstimate,
} from '#testing/helpers/factories/recovery.js';

const pricingCache = makeModelCacheAccessor({
  catalog: {
    'custom-endpoint': {
      id: 'custom-endpoint',
      models: {
        'gpt-5.4': {
          id: 'gpt-5.4',
          cost: { input: 2.5, output: 15 },
          limit: { context: 400_000 },
        },
      },
    },
  },
});

const usage: RecoveryUsage = {
  inputTokens: 100,
  outputTokens: 100,
  totalTokens: 200,
  estimated: false,
};

function reserve(
  accountingKey: BudgetAccountingKey,
  activeReservations: readonly BudgetReservation[] = [],
): BudgetReservation {
  const decision = reserveBriefRecoveryCall({
    accountingKey,
    estimate: makePricedRecoveryEstimate(pricingCache),
    currentKnownSpend: 0,
    activeReservations,
    maxBudget: 1,
  });
  if (decision.kind !== 'reserved') throw new Error(decision.reason);
  return decision.reservation;
}

describe('operation-scoped recovery budget', () => {
  it('refuses priced work without a safe output cap but allows local zero-cost work', () => {
    const unknown = estimateBriefRecoveryCall({
      prompt: 'retry',
      plannerTool: 'custom-endpoint',
      plannerModel: 'gpt-5.4',
      pricingCache,
    });
    expect(unknown).toMatchObject({ kind: 'unavailable', amount: null });

    const local = estimateBriefRecoveryCall({
      prompt: 'retry',
      plannerTool: 'ollama',
      plannerModel: 'llama3',
    });
    expect(local).toMatchObject({ kind: 'finite', amount: 0, pricingIdentity: 'local-zero' });
  });

  it('counts every active hold and replays one complete accounting key', () => {
    const first = reserve(key('operation-1'));
    const refused = reserveBriefRecoveryCall({
      accountingKey: key('operation-2'),
      estimate: makePricedRecoveryEstimate(pricingCache),
      currentKnownSpend: 0,
      activeReservations: [first],
      maxBudget: first.amount + makePricedRecoveryEstimate(pricingCache).amount - Number.EPSILON,
    });
    expect(refused).toMatchObject({ kind: 'refused', code: 'brief_budget_exhausted' });

    const replay = reserveBriefRecoveryCall({
      accountingKey: key('operation-1'),
      estimate: makePricedRecoveryEstimate(pricingCache),
      currentKnownSpend: 100,
      activeReservations: [first],
      maxBudget: 0,
    });
    expect(replay).toEqual({ kind: 'reserved', reservation: first });
  });

  it('reserves the exact finite amount within the cap and refuses a known excess', () => {
    const estimate = makePricedRecoveryEstimate(pricingCache);
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

  it('releases definite no-dispatch and holds unresolved usage without duplicate history', () => {
    const reservation = reserve(key('operation-release'));
    const released = reconcileBriefRecoveryCall({
      accountingKey: key('operation-release'),
      reservation,
      usage: null,
      remoteObservation: 'not-dispatched',
    });
    const replay = reconcileBriefRecoveryCall({
      accountingKey: key('operation-release'),
      reservation: released.reservation,
      usage: null,
      remoteObservation: 'not-dispatched',
    });
    expect(released.reservation.state).toBe('released');
    expect(replay.appliedAmount).toBe(0);
    expect(replay.reservation.history).toHaveLength(released.reservation.history.length);

    const unresolved = reconcileBriefRecoveryCall({
      accountingKey: key('operation-hold'),
      reservation: reserve(key('operation-hold')),
      usage: null,
      remoteObservation: 'unknown',
    });
    expect(unresolved.reservation.state).toBe('held');
    expect(
      reconcileBriefRecoveryCall({
        accountingKey: key('operation-hold'),
        reservation: unresolved.reservation,
        usage: null,
        remoteObservation: 'unknown',
      }).reservation.history,
    ).toHaveLength(unresolved.reservation.history.length);
  });

  it('charges a held resource conservatively and applies one signed late-usage delta', () => {
    const accountingKey = key('operation-late');
    const held = reconcileBriefRecoveryCall({
      accountingKey,
      reservation: reserve(accountingKey),
      usage: null,
      remoteObservation: 'unknown',
    }).reservation;
    const charged = terminalChargeBriefRecoveryCall({ accountingKey, reservation: held });
    expect(charged.reservation).toMatchObject({
      state: 'terminal-charged',
      usageApplied: true,
      appliedUsage: null,
      bookedAmount: held.amount,
    });

    const late = reconcileBriefRecoveryCall({
      accountingKey,
      reservation: charged.reservation,
      usage,
      remoteObservation: 'confirmed-final',
    });
    expect(late.reservation).toMatchObject({ state: 'reconciled', appliedUsage: usage });
    expect(late.appliedAmount).toBeLessThan(0);

    const replay = reconcileBriefRecoveryCall({
      accountingKey,
      reservation: late.reservation,
      usage,
      remoteObservation: 'confirmed-final',
    });
    expect(replay.appliedAmount).toBe(0);
    expect(replay.reservation.history).toHaveLength(late.reservation.history.length);
  });

  it('rejects a reservation or reconciliation with a mismatched complete key', () => {
    const reservation = reserve(key('operation-key'));
    expect(() =>
      reconcileBriefRecoveryCall({
        accountingKey: { ...key('operation-key'), epochId: 'other-epoch' },
        reservation,
        usage: null,
        remoteObservation: 'not-dispatched',
      }),
    ).toThrow('does not match the reservation');
  });
});

describe('provider-dependent budget policy replaces the missing-price blanket refusal', () => {
  it('admits one bounded provider-dependent reservation without a dollar cap', () => {
    const estimate = makeUnavailableRecoveryEstimate(pricingCache);
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
      estimate: makeUnavailableRecoveryEstimate(pricingCache),
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
        estimate: makePricedRecoveryEstimate(pricingCache),
        envelope: boundedEnvelope(),
      }),
    ).toThrow('requires an unpriced recovery estimate');
  });

  it('never serializes unknown cost as zero dollars', () => {
    const decision = reserveProviderDependentRecoveryCall({
      accountingKey: key('operation-no-zero'),
      estimate: makeUnavailableRecoveryEstimate(pricingCache),
      envelope: boundedEnvelope(),
    });
    if (decision.kind !== 'reserved') throw new Error(decision.reason);
    expect(decision.resource).not.toHaveProperty('amount');
    expect(JSON.stringify(decision.resource)).not.toContain('amount');
    expect(
      RecoveryBudgetResourceSchema.safeParse({ ...decision.resource, amount: 0 }).success,
    ).toBe(false);
  });

  it('refuses an admission whose frozen envelope exceeds its own dispatch limit', () => {
    const envelope = boundedEnvelope();
    const decision = reserveProviderDependentRecoveryCall({
      accountingKey: key('operation-over-dispatch'),
      estimate: makeUnavailableRecoveryEstimate(pricingCache),
      envelope: { ...envelope, callCount: envelope.dispatchLimit + 1 },
    });
    expect(decision).toMatchObject({ kind: 'refused', code: 'brief_budget_unknown' });
  });

  it('rejects an admission whose accounting key is incomplete', () => {
    expect(() =>
      reserveProviderDependentRecoveryCall({
        accountingKey: { ...key('operation-incomplete'), operationId: '' },
        estimate: makeUnavailableRecoveryEstimate(pricingCache),
        envelope: boundedEnvelope(),
      }),
    ).toThrow('accounting key is invalid');
  });
});
