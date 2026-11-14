import type {
  BillingAttribution,
  RateSnapshot,
  RequestEstimateItem,
  RequestEstimateReason,
} from '../../../core/schemas/cost.js';
import type { InvocationIdentity } from '../../../core/schemas/invocation-identity.js';
import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';

const UNKNOWN_BILLING: BillingAttribution = { posture: 'unknown', basis: 'unknown' };

/**
 * Who paid for one call, read from the identity the invocation recorded and
 * from nothing else — a configured preference is not a method, and a tool's
 * catalogued default is not evidence about this call. `InvocationIdentitySchema`
 * is where a basis becomes proof: it already refuses one whose channels
 * disagree, whose evidence id does not match the channel it names, or that
 * claims a subscription covered an api-key invocation. So a proven basis here is
 * proven, and everything else — no identity, no evidence, a channel nobody
 * enforced — is unknown.
 */
export function deriveCallBilling(identity: InvocationIdentity | undefined): BillingAttribution {
  const billing = identity?.billing;
  if (billing === undefined || billing.basis === 'unknown') return UNKNOWN_BILLING;
  return {
    posture: billing.posture,
    basis: billing.basis,
    ...(billing.evidenceId !== undefined && { evidenceId: billing.evidenceId }),
  };
}

export function unavailable(
  call: CallUsageEvidence,
  reasons: RequestEstimateReason[],
  rates: RateSnapshot | undefined,
): RequestEstimateItem {
  return {
    ...identity(call),
    amount: null,
    knownSubtotal: 0,
    completeness: 'unavailable',
    reasons,
    ...(rates !== undefined && { rates }),
  };
}

export function identity(
  call: CallUsageEvidence,
): Pick<
  RequestEstimateItem,
  | 'callId'
  | 'taskId'
  | 'attempt'
  | 'role'
  | 'model'
  | 'usageBoundary'
  | 'billing'
  | 'invocationIdentity'
> {
  return {
    callId: call.callId,
    ...(call.taskId !== undefined && { taskId: call.taskId }),
    ...(call.attempt !== undefined && { attempt: call.attempt }),
    role: call.role,
    ...((call.invocationIdentity?.model ?? call.model) !== undefined && {
      model: call.invocationIdentity?.model ?? call.model,
    }),
    usageBoundary: call.usageBoundary,
    billing: deriveCallBilling(call.invocationIdentity),
    ...(call.invocationIdentity !== undefined && {
      invocationIdentity: call.invocationIdentity,
    }),
  };
}
