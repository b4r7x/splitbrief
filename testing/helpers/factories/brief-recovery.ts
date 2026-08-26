import type {
  BriefRecoveryV1,
  NormalBriefRecoveryV1,
} from '../../../src/core/schemas/brief-recovery/document.js';
import type { BriefAdmissionInput } from '../../../src/core/schemas/brief-recovery.js';
import type { EvidenceRef } from '../../../src/core/schemas/brief-recovery/primitives.js';
import type { RecoveryRefusalInput } from '../../../src/engine/orchestrator/planning/brief-recovery.js';

export const recoveryRef = (path: string, hash = path): EvidenceRef => ({
  revision: 1,
  hash,
  path,
});

export const standardAdmissionInput: BriefAdmissionInput = {
  sessionId: 'session-1',
  origin: { mode: 'standard', entry: 'initial' },
  continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
  activeBrief: recoveryRef('tasks.md', 'brief-1'),
  report: {
    briefHash: 'brief-1',
    report: recoveryRef('brief-quality.json', 'report-1'),
    ruleVersion: 'quality-v1',
    issues: [
      {
        code: 'missing_acceptance',
        severity: 'error',
        taskId: null,
        message: 'Missing acceptance',
      },
    ],
    errorCount: 1,
  },
  qualityPolicyVersion: 'quality-v1',
};

export function normalRecovery(state: BriefRecoveryV1): NormalBriefRecoveryV1 {
  if (state.status === 'storage-blocked' || state.status === 'rejected')
    throw new Error('expected normal recovery');
  return state;
}

export function recoveryRefusal(
  operationId: string,
  overrides: Partial<RecoveryRefusalInput> = {},
): RecoveryRefusalInput {
  return {
    epochId: 'epoch-1',
    operationId,
    intentHash: `${operationId}-intent`,
    action: 'retry',
    code: 'brief_budget_unknown',
    category: 'budget',
    reasonCode: 'brief_budget_unknown',
    accountingKey: null,
    budgetPolicy: 'no-dollar-cap',
    configuredCap: null,
    priceKnownness: 'provider-dependent',
    spendKnownness: 'unknown-paid',
    evidence: recoveryRef('brief-recovery/refusal.json', `refusal-${operationId}`),
    ...overrides,
  };
}
