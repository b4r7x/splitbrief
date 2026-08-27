import { describe, expect, it } from 'vitest';
import type {
  BudgetAccountingKey,
  BudgetReservation,
  RecoveryCallEstimate,
  RecoveryUsage,
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
} from '#testing/helpers/factories/recovery.js';

const pricingCache = makeModelCacheAccessor({
  catalog: {
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
      plannerTool: 'openai',
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
  function unavailableEstimate(): RecoveryCallEstimate {
    const estimate = estimateBriefRecoveryCall({
      prompt: 'Retry the frozen Brief once.',
      plannerTool: 'opencode',
      plannerModel: 'auto',
      configuredOutputCap: 1_000,
      pricingCache,
    });
    expect(estimate).toMatchObject({ kind: 'unavailable', amount: null });
    return estimate;
  }

  it('refuses an admission whose frozen envelope exceeds its own dispatch limit', () => {
    const envelope = boundedEnvelope();
    const decision = reserveProviderDependentRecoveryCall({
      accountingKey: key('operation-over-dispatch'),
      estimate: unavailableEstimate(),
      envelope: { ...envelope, callCount: envelope.dispatchLimit + 1 },
    });
    expect(decision).toMatchObject({ kind: 'refused', code: 'brief_budget_unknown' });
  });

  it('rejects an admission whose accounting key is incomplete', () => {
    expect(() =>
      reserveProviderDependentRecoveryCall({
        accountingKey: { ...key('operation-incomplete'), operationId: '' },
        estimate: unavailableEstimate(),
        envelope: boundedEnvelope(),
      }),
    ).toThrow('accounting key is invalid');
  });
});
