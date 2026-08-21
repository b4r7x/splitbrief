import { describe, expect, it } from 'vitest';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import type {
  BudgetAccountingKey,
  BudgetReservation,
  RecoveryOperationEnvelope,
  RecoveryUsage,
} from '../../../core/schemas/brief-recovery.js';
import { estimateBriefRecoveryCall, type RecoveryFiniteEstimate } from './estimate.js';
import {
  reconcileBriefRecoveryCall,
  reserveBriefRecoveryCall,
  reserveProviderDependentRecoveryCall,
  terminalChargeBriefRecoveryCall,
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

const usage: RecoveryUsage = {
  inputTokens: 100,
  outputTokens: 100,
  totalTokens: 200,
  estimated: false,
};

function pricedEstimate(): RecoveryFiniteEstimate {
  const estimate = estimateBriefRecoveryCall({
    prompt: 'Retry the frozen Brief once.',
    plannerTool: 'openai',
    plannerModel: 'gpt-5.4',
    configuredOutputCap: 1_000,
    pricingCache,
  });
  if (!isFiniteRecoveryEstimate(estimate)) {
    throw new Error('expected a finite priced estimate');
  }
  return estimate;
}

function isFiniteRecoveryEstimate(
  estimate: ReturnType<typeof estimateBriefRecoveryCall>,
): estimate is RecoveryFiniteEstimate {
  return estimate.kind === 'finite' && estimate.amount !== null;
}

function reserve(
  accountingKey: BudgetAccountingKey,
  activeReservations: readonly BudgetReservation[] = [],
): BudgetReservation {
  const decision = reserveBriefRecoveryCall({
    accountingKey,
    estimate: pricedEstimate(),
    currentKnownSpend: 0,
    activeReservations,
    maxBudget: 1,
  });
  if (decision.kind !== 'reserved') throw new Error(decision.reason);
  return decision.reservation;
}

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
      estimate: pricedEstimate(),
      currentKnownSpend: 0,
      activeReservations: [first],
      maxBudget: first.amount + pricedEstimate().amount - Number.EPSILON,
    });
    expect(refused).toMatchObject({ kind: 'refused', code: 'brief_budget_exhausted' });

    const replay = reserveBriefRecoveryCall({
      accountingKey: key('operation-1'),
      estimate: pricedEstimate(),
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
  it('admits a bounded unknown-price call once without a cap and refuses it with a cap', () => {
    const unavailable = estimateBriefRecoveryCall({
      prompt: 'Retry the frozen Brief once.',
      plannerTool: 'opencode',
      plannerModel: 'auto',
      configuredOutputCap: 1_000,
      pricingCache,
    });
    expect(unavailable).toMatchObject({ kind: 'unavailable', amount: null });

    const accountingKey = key('operation-provider-dependent');
    const first = reserveProviderDependentRecoveryCall({
      accountingKey,
      estimate: unavailable,
      envelope: boundedEnvelope(),
    });
    const replayed = reserveProviderDependentRecoveryCall({
      accountingKey,
      estimate: unavailable,
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
    expect(first.resource).not.toHaveProperty('amount');

    const capped = reserveBriefRecoveryCall({
      accountingKey: key('operation-capped-unknown'),
      estimate: unavailable,
      currentKnownSpend: 0,
      activeReservations: [],
      maxBudget: 1,
    });
    expect(capped).toMatchObject({ kind: 'refused', code: 'brief_budget_unknown' });
  });
});
