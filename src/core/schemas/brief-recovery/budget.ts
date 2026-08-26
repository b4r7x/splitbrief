import { z } from 'zod';
import { OperationEnvelopeSchema } from '../task-compilation.js';
import {
  MAX_ATTEMPTS,
  MAX_BRIEF,
  MAX_HISTORY,
  finiteAmount,
  id,
  message,
  nonNegativeInteger,
  signedFiniteAmount,
  timestamp,
} from './primitives.js';

export const RecoveryUsageSchema = z
  .object({
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    totalTokens: nonNegativeInteger,
    estimated: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (value.totalTokens !== value.inputTokens + value.outputTokens) {
      ctx.addIssue({
        code: 'custom',
        path: ['totalTokens'],
        message: 'totalTokens must equal inputTokens plus outputTokens',
      });
    }
  })
  .strict();
export type RecoveryUsage = z.infer<typeof RecoveryUsageSchema>;

export const FrozenPricingSchema = z
  .object({
    budgetUnit: z.literal('usd'),
    pricingIdentity: id,
    inputPer1M: finiteAmount,
    outputPer1M: finiteAmount,
  })
  .strict();
export type FrozenPricing = z.infer<typeof FrozenPricingSchema>;

export const RecoveryBudgetResourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('finite-usd'),
      accountingKey: id,
      amount: finiteAmount,
      envelope: OperationEnvelopeSchema,
      pricing: FrozenPricingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('provider-dependent'),
      accountingKey: id,
      pricingIdentity: id,
      envelope: OperationEnvelopeSchema,
      observedUsage: RecoveryUsageSchema.nullable(),
      resolvedPricing: FrozenPricingSchema.nullable(),
    })
    .strict(),
]);
export type RecoveryBudgetResource = z.infer<typeof RecoveryBudgetResourceSchema>;

export const BUDGET_RESOURCE_STATES = [
  'reserved',
  'released',
  'held',
  'reconciled',
  'terminal-charged',
] as const;
export const BudgetResourceStateSchema = z.enum(BUDGET_RESOURCE_STATES);

export const BudgetResourceEventSchema = z
  .object({
    state: BudgetResourceStateSchema,
    at: timestamp,
    reason: z.enum([
      'accepted',
      'interrupted',
      'confirmed-final',
      'unresolved',
      'superseded',
      'rebind',
      'abandon',
      'terminal-accounting',
    ]),
  })
  .strict();

export const BudgetAccountingKeySchema = z
  .object({
    sessionId: id,
    epochId: id,
    operationId: id,
    generation: nonNegativeInteger,
  })
  .strict();
export type BudgetAccountingKey = z.infer<typeof BudgetAccountingKeySchema>;

export const BudgetReservationSchema = z
  .object({
    accountingKey: BudgetAccountingKeySchema,
    amount: finiteAmount,
    pricing: FrozenPricingSchema.optional(),
    bookedAmount: finiteAmount.optional(),
    state: BudgetResourceStateSchema,
    usageApplied: z.boolean(),
    appliedUsage: RecoveryUsageSchema.nullable(),
    history: z.array(BudgetResourceEventSchema).max(MAX_HISTORY).readonly(),
  })
  .superRefine((value, ctx) => {
    if (value.state === 'terminal-charged') {
      if (!value.usageApplied || value.appliedUsage !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['usageApplied'],
          message: 'terminal-charged resources have usageApplied true and no appliedUsage',
        });
      }
      return;
    }
    if (value.usageApplied !== (value.appliedUsage !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['appliedUsage'],
        message: 'usageApplied must match whether appliedUsage is present',
      });
    }
    if (value.state === 'reconciled' && !value.usageApplied) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'reconciled resources must have applied usage',
      });
    }
    if (
      (value.state === 'reserved' || value.state === 'released' || value.state === 'held') &&
      value.usageApplied
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'reserved, released, and held resources cannot have applied usage',
      });
    }
  })
  .strict();
export type BudgetReservation = z.infer<typeof BudgetReservationSchema>;

export const RecoveryEstimateInputSchema = z
  .object({
    prompt: z.string().max(MAX_BRIEF),
    plannerTool: id,
    plannerModel: id.optional(),
    configuredOutputCap: nonNegativeInteger.optional(),
    pricingCache: z.unknown().optional(),
  })
  .strict();
export type RecoveryEstimateInput = z.infer<typeof RecoveryEstimateInputSchema>;

export const RecoveryCallEstimateSchema = z
  .object({
    kind: z.enum(['finite', 'unavailable']),
    budgetUnit: z.literal('usd'),
    inputTokens: nonNegativeInteger,
    outputTokens: nonNegativeInteger,
    amount: finiteAmount.nullable(),
    pricingIdentity: id,
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'finite' && value.amount === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'finite estimates require an amount',
      });
    }
    if (value.kind === 'unavailable' && value.amount !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'unavailable estimates cannot reserve an amount',
      });
    }
  })
  .strict();
export type RecoveryCallEstimate = z.infer<typeof RecoveryCallEstimateSchema>;

export const RecoveryReservationInputSchema = z
  .object({
    accountingKey: BudgetAccountingKeySchema,
    estimate: RecoveryCallEstimateSchema,
    currentKnownSpend: finiteAmount,
    activeReservations: z.array(BudgetReservationSchema).max(MAX_ATTEMPTS).readonly(),
    maxBudget: finiteAmount.optional(),
  })
  .strict();
export type RecoveryReservationInput = z.infer<typeof RecoveryReservationInputSchema>;

export const RecoveryReservationDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('reserved'), reservation: BudgetReservationSchema }).strict(),
  z
    .object({
      kind: z.literal('refused'),
      code: z.enum(['brief_budget_exhausted', 'brief_budget_unknown']),
      reason: message,
    })
    .strict(),
]);
export type RecoveryReservationDecision = z.infer<typeof RecoveryReservationDecisionSchema>;

export const RecoveryReconciliationInputSchema = z
  .object({
    accountingKey: BudgetAccountingKeySchema,
    reservation: BudgetReservationSchema,
    usage: RecoveryUsageSchema.nullable(),
    remoteObservation: z.enum(['not-dispatched', 'confirmed-final', 'unknown']),
  })
  .strict();
export type RecoveryReconciliationInput = z.infer<typeof RecoveryReconciliationInputSchema>;

export const RecoveryReconciliationSchema = z
  .object({
    reservation: BudgetReservationSchema,
    usageApplied: z.boolean(),
    appliedAmount: signedFiniteAmount,
  })
  .strict();
export type RecoveryReconciliation = z.infer<typeof RecoveryReconciliationSchema>;

export const RecoveryTerminalChargeInputSchema = z
  .object({ accountingKey: BudgetAccountingKeySchema, reservation: BudgetReservationSchema })
  .strict();
export type RecoveryTerminalChargeInput = z.infer<typeof RecoveryTerminalChargeInputSchema>;

export type BriefRecoveryBudgetPort = {
  estimate(input: RecoveryEstimateInput): RecoveryCallEstimate;
  reserve(input: RecoveryReservationInput): RecoveryReservationDecision;
  reconcile(input: RecoveryReconciliationInput): RecoveryReconciliation;
  terminalCharge(input: RecoveryTerminalChargeInput): RecoveryReconciliation;
};
