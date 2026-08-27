import {
  type BudgetAccountingKey,
  BudgetAccountingKeySchema,
  type BudgetReservation,
  BudgetReservationSchema,
  BudgetResourceEventSchema,
  BudgetResourceStateSchema,
  type RecoveryBudgetResource,
  type RecoveryCallEstimate,
  RecoveryCallEstimateSchema,
  type RecoveryReconciliation,
  type RecoveryReconciliationInput,
  RecoveryReconciliationInputSchema,
  type RecoveryReservationDecision,
  type RecoveryReservationInput,
  RecoveryReservationInputSchema,
  type RecoveryTerminalChargeInput,
  RecoveryTerminalChargeInputSchema,
  type RecoveryUsage,
  RecoveryUsageSchema,
} from '../../../core/schemas/brief-recovery/budget.js';
import {
  OperationEnvelopeSchema,
  type TaskCompilationOperationEnvelope,
} from '../../../core/schemas/task-compilation.js';
import { nowIso } from '../../../utils/format-time.js';
import { error } from '../../../utils/error.js';

type RecoveryPricingSnapshot = NonNullable<BudgetReservation['pricing']>;

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isRecoveryPricingSnapshot(value: unknown): value is RecoveryPricingSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  if (
    !('budgetUnit' in value) ||
    !('pricingIdentity' in value) ||
    !('inputPer1M' in value) ||
    !('outputPer1M' in value)
  ) {
    return false;
  }
  return (
    value.budgetUnit === 'usd' &&
    typeof value.pricingIdentity === 'string' &&
    value.pricingIdentity.length > 0 &&
    typeof value.inputPer1M === 'number' &&
    finiteNonnegative(value.inputPer1M) &&
    typeof value.outputPer1M === 'number' &&
    finiteNonnegative(value.outputPer1M)
  );
}

function validatePricing(pricing: RecoveryPricingSnapshot): void {
  if (!isRecoveryPricingSnapshot(pricing)) {
    throw error(
      'brief-budget-invalid-pricing',
      'Recovery budget pricing must contain a finite nonnegative USD rate and identity.',
    );
  }
}

function readEstimatePricing(estimate: RecoveryCallEstimate): RecoveryPricingSnapshot | null {
  const parsed = RecoveryCallEstimateSchema.safeParse(estimate);
  if (!parsed.success) {
    throw error('brief-budget-invalid-estimate', 'The recovery budget estimate is invalid.');
  }
  if (parsed.data.kind === 'unavailable') return null;

  // Pricing is attached by estimateBriefRecoveryCall as a non-enumerable field because the
  // in-flight canonical schema currently carries only the stable estimate identity and amount.
  // Object descriptors also find an enumerable field when a newer persisted schema supplies one.
  const pricing = Object.getOwnPropertyDescriptor(estimate, 'pricing')?.value;
  if (!isRecoveryPricingSnapshot(pricing)) {
    if (parsed.data.pricingIdentity === 'local-zero') {
      return {
        budgetUnit: 'usd',
        pricingIdentity: 'local-zero',
        inputPer1M: 0,
        outputPer1M: 0,
      };
    }
    return null;
  }
  if (pricing.pricingIdentity !== parsed.data.pricingIdentity) {
    throw error(
      'brief-budget-pricing-mismatch',
      'The estimate pricing identity does not match its frozen pricing rates.',
    );
  }
  return pricing;
}

function reservationPricing(reservation: BudgetReservation): RecoveryPricingSnapshot | null {
  if (reservation.pricing === undefined) return null;
  validatePricing(reservation.pricing);
  return reservation.pricing;
}

function pricingMatches(
  left: RecoveryPricingSnapshot | null,
  right: RecoveryPricingSnapshot | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.budgetUnit === right.budgetUnit &&
    left.pricingIdentity === right.pricingIdentity &&
    left.inputPer1M === right.inputPer1M &&
    left.outputPer1M === right.outputPer1M
  );
}

function budgetKeyEquals(left: BudgetAccountingKey, right: BudgetAccountingKey): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.epochId === right.epochId &&
    left.operationId === right.operationId &&
    left.generation === right.generation
  );
}

function assertRecoveryBudgetKey(key: BudgetAccountingKey): void {
  if (!BudgetAccountingKeySchema.safeParse(key).success) {
    throw error('brief-budget-invalid-key', 'The recovery budget accounting key is invalid.', {
      key,
    });
  }
}

function assertReservation(reservation: BudgetReservation): void {
  if (
    !BudgetReservationSchema.safeParse(reservation).success ||
    !finiteNonnegative(reservation.amount) ||
    !BudgetResourceStateSchema.safeParse(reservation.state).success ||
    typeof reservation.usageApplied !== 'boolean' ||
    !Array.isArray(reservation.history) ||
    !BudgetResourceEventSchema.array().safeParse(reservation.history).success
  ) {
    throw error('brief-budget-invalid-reservation', 'The recovery budget reservation is invalid.');
  }
  if (reservation.bookedAmount !== undefined && !finiteNonnegative(reservation.bookedAmount)) {
    throw error(
      'brief-budget-invalid-booked-amount',
      'The recovery reservation booked USD amount is invalid.',
    );
  }
  if (reservation.pricing !== undefined) validatePricing(reservation.pricing);
  if (
    reservation.appliedUsage !== null &&
    !RecoveryUsageSchema.safeParse(reservation.appliedUsage).success
  ) {
    throw error('brief-budget-invalid-usage', 'The recovery budget usage is invalid.');
  }
  const lastEvent = reservation.history.at(-1);
  if (lastEvent !== undefined && lastEvent.state !== reservation.state) {
    throw error('brief-budget-invalid-reservation', 'Reservation history must end at its state.');
  }
}

function assertReservationKey(
  accountingKey: BudgetAccountingKey,
  reservation: BudgetReservation,
): void {
  assertRecoveryBudgetKey(accountingKey);
  assertReservation(reservation);
  if (!budgetKeyEquals(accountingKey, reservation.accountingKey)) {
    throw error(
      'brief-budget-accounting-key-mismatch',
      'The recovery budget accounting key does not match the reservation.',
      { accountingKey, reservationKey: reservation.accountingKey },
    );
  }
}

function assertUsage(usage: RecoveryUsage | null): void {
  if (usage !== null && !RecoveryUsageSchema.safeParse(usage).success) {
    throw error('brief-budget-invalid-usage', 'The recovery budget usage is invalid.');
  }
}

function transitionReservation(
  reservation: BudgetReservation,
  state: BudgetReservation['state'],
  reason: BudgetReservation['history'][number]['reason'],
  patch: Pick<BudgetReservation, 'usageApplied' | 'appliedUsage'> & {
    bookedAmount?: number | undefined;
  },
): BudgetReservation {
  if (
    reservation.state === state &&
    reservation.usageApplied === patch.usageApplied &&
    reservation.appliedUsage === patch.appliedUsage &&
    (patch.bookedAmount === undefined || reservation.bookedAmount === patch.bookedAmount)
  ) {
    return reservation;
  }
  const bookedAmount = patch.bookedAmount ?? reservation.bookedAmount;
  return {
    ...reservation,
    state,
    ...patch,
    ...(bookedAmount !== undefined && { bookedAmount }),
    history: [...reservation.history, { state, at: nowIso(), reason }],
  };
}

function usageEquals(left: RecoveryUsage | null, right: RecoveryUsage | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.estimated === right.estimated
  );
}

function actualUsd(usage: RecoveryUsage, pricing: RecoveryPricingSnapshot): number {
  const amount =
    (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M;
  if (!finiteNonnegative(amount) || amount > 1_000_000_000) {
    throw error(
      'brief-budget-invalid-usage',
      'The normalized actual USD usage exceeds the recovery budget bounds.',
      { pricingIdentity: pricing.pricingIdentity },
    );
  }
  return amount;
}

function bookedAmountBeforeReconciliation(reservation: BudgetReservation): number {
  if (reservation.state === 'reserved' || reservation.state === 'held') {
    return reservation.amount;
  }
  return reservation.bookedAmount ?? 0;
}

function activeReservationAmount(reservation: BudgetReservation): number {
  return reservation.state === 'reserved' || reservation.state === 'held' ? reservation.amount : 0;
}

export function reserveBriefRecoveryCall(
  input: RecoveryReservationInput,
): RecoveryReservationDecision {
  if (!RecoveryReservationInputSchema.safeParse(input).success) {
    throw error('brief-budget-invalid-input', 'The recovery reservation input is invalid.');
  }
  assertRecoveryBudgetKey(input.accountingKey);
  for (const reservation of input.activeReservations) assertReservation(reservation);
  if (!finiteNonnegative(input.currentKnownSpend)) {
    throw error('brief-budget-invalid-spend', 'The known recovery budget spend is invalid.');
  }

  const matchingReservations = input.activeReservations.filter((reservation) =>
    budgetKeyEquals(input.accountingKey, reservation.accountingKey),
  );
  if (matchingReservations.length > 1) {
    throw error(
      'brief-budget-duplicate-key',
      'Multiple recovery reservations share one complete accounting key.',
      { accountingKey: input.accountingKey },
    );
  }
  const existing = matchingReservations[0];
  if (existing !== undefined) {
    if (input.estimate.kind !== 'finite' || input.estimate.amount === null) {
      throw error(
        'brief-budget-pricing-mismatch',
        'A replayed recovery operation must retain its original finite estimate.',
        { accountingKey: input.accountingKey },
      );
    }
    const estimatePricing = readEstimatePricing(input.estimate);
    const existingPricing = reservationPricing(existing);
    if (!pricingMatches(estimatePricing, existingPricing)) {
      throw error(
        'brief-budget-pricing-mismatch',
        'A replayed recovery operation has a different frozen pricing identity or rates.',
        { accountingKey: input.accountingKey },
      );
    }
    if (existing.amount !== input.estimate.amount) {
      throw error(
        'brief-budget-estimate-mismatch',
        'A replayed recovery operation has a different frozen estimate amount.',
        { accountingKey: input.accountingKey },
      );
    }
    return { kind: 'reserved', reservation: existing };
  }

  if (input.estimate.kind !== 'finite' || input.estimate.amount === null) {
    return {
      kind: 'refused',
      code: 'brief_budget_unknown',
      reason: 'Recovery call cost is unknown; a frozen finite USD reservation is required.',
    };
  }
  const pricing = readEstimatePricing(input.estimate);
  if (pricing === null) {
    return {
      kind: 'refused',
      code: 'brief_budget_unknown',
      reason: 'Recovery call has no frozen USD pricing identity and rates to persist.',
    };
  }

  const heldAmount = input.activeReservations.reduce(
    (total, reservation) => total + activeReservationAmount(reservation),
    0,
  );
  const projected = input.currentKnownSpend + heldAmount + input.estimate.amount;
  if (!finiteNonnegative(projected)) {
    return {
      kind: 'refused',
      code: 'brief_budget_exhausted',
      reason: 'Recovery call would exceed the configured budget with active holds.',
    };
  }
  if (input.maxBudget !== undefined && projected > input.maxBudget) {
    return {
      kind: 'refused',
      code: 'brief_budget_exhausted',
      reason: `Recovery call would exceed the configured budget (${projected} > ${input.maxBudget}).`,
    };
  }

  const reservation: BudgetReservation = {
    accountingKey: input.accountingKey,
    amount: input.estimate.amount,
    state: 'reserved',
    usageApplied: false,
    appliedUsage: null,
    pricing,
    bookedAmount: 0,
    history: [{ state: 'reserved', at: nowIso(), reason: 'accepted' }],
  };
  return { kind: 'reserved', reservation };
}

export function recoveryBudgetAccountingKey(accountingKey: BudgetAccountingKey): string {
  return `${accountingKey.sessionId}/${accountingKey.epochId}/${accountingKey.operationId}`;
}

export type ProviderDependentReservationInput = Readonly<{
  accountingKey: BudgetAccountingKey;
  estimate: RecoveryCallEstimate;
  envelope: TaskCompilationOperationEnvelope;
}>;

export type ProviderDependentReservationDecision =
  | Readonly<{ kind: 'reserved'; resource: RecoveryBudgetResource }>
  | Readonly<{ kind: 'refused'; code: 'brief_budget_unknown'; reason: string }>;

export function reserveProviderDependentRecoveryCall(
  input: ProviderDependentReservationInput,
): ProviderDependentReservationDecision {
  assertRecoveryBudgetKey(input.accountingKey);
  const parsedEstimate = RecoveryCallEstimateSchema.safeParse(input.estimate);
  if (!parsedEstimate.success) {
    throw error('brief-budget-invalid-estimate', 'The recovery budget estimate is invalid.');
  }
  const estimate = parsedEstimate.data;
  if (estimate.kind !== 'unavailable') {
    throw error(
      'brief-budget-invalid-input',
      'A provider-dependent reservation requires an unpriced recovery estimate.',
    );
  }
  if (estimate.outputTokens < 1) {
    return {
      kind: 'refused',
      code: 'brief_budget_unknown',
      reason: 'Recovery call has no finite output bound to reserve.',
    };
  }
  const parsedEnvelope = OperationEnvelopeSchema.safeParse(input.envelope);
  if (!parsedEnvelope.success) {
    return {
      kind: 'refused',
      code: 'brief_budget_unknown',
      reason: 'Recovery call has no frozen bounded operation envelope to reserve.',
    };
  }
  const resource: RecoveryBudgetResource = {
    kind: 'provider-dependent',
    accountingKey: recoveryBudgetAccountingKey(input.accountingKey),
    pricingIdentity: estimate.pricingIdentity,
    envelope: parsedEnvelope.data,
    observedUsage: null,
    resolvedPricing: null,
  };
  return { kind: 'reserved', resource };
}

export function reconcileBriefRecoveryCall(
  input: RecoveryReconciliationInput,
): RecoveryReconciliation {
  if (!RecoveryReconciliationInputSchema.safeParse(input).success) {
    throw error('brief-budget-invalid-input', 'The recovery reconciliation input is invalid.');
  }
  assertReservationKey(input.accountingKey, input.reservation);
  assertUsage(input.usage);
  const reservation = input.reservation;

  if (input.remoteObservation === 'not-dispatched' && input.usage !== null) {
    throw error(
      'brief-budget-usage-conflict',
      'A not-dispatched recovery call cannot carry provider usage.',
      { accountingKey: input.accountingKey },
    );
  }

  if (reservation.state === 'terminal-charged') {
    if (input.usage === null || input.remoteObservation === 'unknown') {
      return { reservation, usageApplied: true, appliedAmount: 0 };
    }
    const pricing = reservationPricing(reservation);
    if (pricing === null) {
      throw error(
        'brief-budget-pricing-unavailable',
        'The terminal recovery reservation has no frozen pricing for late usage.',
        { accountingKey: input.accountingKey },
      );
    }
    const actual = actualUsd(input.usage, pricing);
    const delta = actual - (reservation.bookedAmount ?? reservation.amount);
    const reconciled = transitionReservation(reservation, 'reconciled', 'confirmed-final', {
      usageApplied: true,
      appliedUsage: input.usage,
      bookedAmount: actual,
    });
    return { reservation: reconciled, usageApplied: true, appliedAmount: delta };
  }

  if (reservation.usageApplied) {
    if (usageEquals(reservation.appliedUsage, input.usage)) {
      return { reservation, usageApplied: true, appliedAmount: 0 };
    }
    throw error(
      'brief-budget-usage-conflict',
      'The recovery budget resource already has different usage applied.',
      { accountingKey: input.accountingKey },
    );
  }

  if (input.remoteObservation === 'unknown') {
    const held = transitionReservation(reservation, 'held', 'unresolved', {
      usageApplied: false,
      appliedUsage: null,
    });
    return { reservation: held, usageApplied: false, appliedAmount: 0 };
  }

  if (input.remoteObservation === 'not-dispatched') {
    const released = transitionReservation(reservation, 'released', 'interrupted', {
      usageApplied: false,
      appliedUsage: null,
    });
    return { reservation: released, usageApplied: false, appliedAmount: 0 };
  }

  if (input.usage === null) {
    const held = transitionReservation(reservation, 'held', 'unresolved', {
      usageApplied: false,
      appliedUsage: null,
    });
    return { reservation: held, usageApplied: false, appliedAmount: 0 };
  }

  const pricing = reservationPricing(reservation);
  if (pricing === null) {
    throw error(
      'brief-budget-pricing-unavailable',
      'The recovery reservation has no frozen pricing for confirmed usage.',
      { accountingKey: input.accountingKey },
    );
  }
  const actual = actualUsd(input.usage, pricing);
  const delta = actual - bookedAmountBeforeReconciliation(reservation);
  const reconciled = transitionReservation(reservation, 'reconciled', 'confirmed-final', {
    usageApplied: true,
    appliedUsage: input.usage,
    bookedAmount: actual,
  });
  return { reservation: reconciled, usageApplied: true, appliedAmount: delta };
}

export function terminalChargeBriefRecoveryCall(
  input: RecoveryTerminalChargeInput,
): RecoveryReconciliation {
  if (!RecoveryTerminalChargeInputSchema.safeParse(input).success) {
    throw error('brief-budget-invalid-input', 'The recovery terminal-charge input is invalid.');
  }
  assertReservationKey(input.accountingKey, input.reservation);
  const reservation = input.reservation;
  if (reservation.state === 'terminal-charged') {
    return { reservation, usageApplied: true, appliedAmount: 0 };
  }
  if (reservation.usageApplied || reservation.state === 'reconciled') {
    return { reservation, usageApplied: reservation.usageApplied, appliedAmount: 0 };
  }
  if (reservation.state === 'released' || reservation.state === 'reserved') {
    return { reservation, usageApplied: false, appliedAmount: 0 };
  }
  const charged = transitionReservation(reservation, 'terminal-charged', 'terminal-accounting', {
    usageApplied: true,
    appliedUsage: null,
    bookedAmount: reservation.amount,
  });
  return { reservation: charged, usageApplied: true, appliedAmount: reservation.amount };
}
