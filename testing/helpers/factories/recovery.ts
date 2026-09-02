import { taskId } from '../../../src/core/schemas/task.js';
import type { RecoveryIssue } from '../../../src/core/schemas/recovery/schemas.js';
import type {
  BudgetAccountingKey,
  RecoveryCallEstimate,
} from '../../../src/core/schemas/brief-recovery/budget.js';
import type { TaskCompilationOperationEnvelope } from '../../../src/core/schemas/task-compilation.js';
import type { BudgetReservation } from '../../../src/core/schemas/brief-recovery/budget.js';
import type {
  BriefAdmissionInput,
  StateAuthorityReceipt,
} from '../../../src/core/schemas/brief-recovery.js';
import type {
  BriefQualityIssue,
  EvidenceRef,
} from '../../../src/core/schemas/brief-recovery/primitives.js';
import type {
  RecoveryProviderRequest,
  RecoveryProviderResult,
} from '../../../src/core/schemas/brief-recovery/provider-call.js';
import type {
  BriefOwnerCommitPort,
  BriefRecoveryControllerDeps,
} from '../../../src/core/schemas/brief-owner.js';
import { makeTestOwnerCommit } from '../brief-owner.js';
import type { ModelCacheAccessor } from '../../../src/engine/providers/model/resolution.js';
import {
  estimateBriefRecoveryCall,
  type RecoveryFiniteEstimate,
  type RecoveryUnavailableEstimate,
} from '../../../src/engine/orchestrator/budget/recovery-estimate.js';

export function makeRecoveryIssue(overrides: Partial<RecoveryIssue> = {}): RecoveryIssue {
  return {
    id: 'rec_2026_04_28_001',
    reason: 'validation-failed',
    phase: 'validating-task',
    status: 'awaiting-user',
    taskId: taskId('T001'),
    taskTitle: 'Fix login validation',
    files: ['src/auth/session.ts'],
    affectedTaskIds: [taskId('T001')],
    message: 'T001 validation failed after 3 attempts',
    details: ['npm test failed in src/auth/session.test.ts'],
    attempts: 3,
    maxAttempts: 3,
    selectedImplementerProfile: 'local-qwen',
    availableActions: [
      'retry-same-worker',
      'route-bigger-worker',
      'skip-current-task',
      'pause-run',
      'abort-workflow',
    ],
    recommendedAction: 'retry-same-worker',
    createdAt: '2026-04-28T12:00:00.000Z',
    ...overrides,
  };
}

export function makeRecoveryBudgetKey(operationId: string, generation = 3): BudgetAccountingKey {
  return {
    sessionId: 'session-1',
    epochId: 'epoch-1',
    operationId,
    generation,
  };
}

export function makeBoundedOperationEnvelope(): TaskCompilationOperationEnvelope {
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

function isFiniteRecoveryEstimate(
  estimate: RecoveryCallEstimate,
): estimate is RecoveryFiniteEstimate {
  return estimate.kind === 'finite' && estimate.amount !== null;
}

export function makePricedRecoveryEstimate(
  pricingCache: ModelCacheAccessor,
): RecoveryFiniteEstimate {
  const estimate = estimateBriefRecoveryCall({
    prompt: 'Retry the frozen Brief once.',
    plannerTool: 'custom-endpoint',
    plannerModel: 'gpt-5.4',
    configuredOutputCap: 1_000,
    pricingCache,
  });
  if (!isFiniteRecoveryEstimate(estimate)) {
    throw new Error('expected a finite priced estimate');
  }
  return estimate;
}

function isUnavailableRecoveryEstimate(
  estimate: RecoveryCallEstimate,
): estimate is RecoveryUnavailableEstimate {
  return estimate.kind === 'unavailable' && estimate.amount === null;
}

export function makeUnavailableRecoveryEstimate(
  pricingCache: ModelCacheAccessor,
): RecoveryUnavailableEstimate {
  const estimate = estimateBriefRecoveryCall({
    prompt: 'Retry the frozen Brief once.',
    plannerTool: 'opencode',
    plannerModel: 'auto',
    configuredOutputCap: 1_000,
    pricingCache,
  });
  if (!isUnavailableRecoveryEstimate(estimate)) {
    throw new Error('expected an unpriced recovery estimate');
  }
  return estimate;
}

export type MutableBriefRecoveryControllerDeps = {
  -readonly [Key in keyof BriefRecoveryControllerDeps]: BriefRecoveryControllerDeps[Key];
};

export function makeRecoveryAuthority(revision = 0): StateAuthorityReceipt {
  return {
    kind: 'usable',
    sessionId: 'session-1',
    ownerId: 'owner-1',
    pid: 1,
    processStart: 'start-1',
    runId: 'run-1',
    acquisitionId: 'acquisition-1',
    fence: 1,
    stateRevision: revision,
    stateDigest: 'digest-1',
  };
}

export function makeRecoveryReservation(accountingKey: BudgetAccountingKey): BudgetReservation {
  return {
    accountingKey,
    amount: 0.1,
    state: 'reserved',
    usageApplied: false,
    appliedUsage: null,
    history: [{ state: 'reserved', at: '2026-01-01T00:00:00.000Z', reason: 'accepted' }],
  };
}

export function makeBriefAdmission(
  overrides: Partial<BriefAdmissionInput> = {},
): BriefAdmissionInput {
  const activeBrief: EvidenceRef = { revision: 1, hash: 'brief-hash', path: 'tasks.md' };
  return {
    sessionId: 'session-1',
    origin: { mode: 'quick', entry: 'initial' },
    continuation: { version: 1, kind: 'quick-start', entry: 'initial' },
    activeBrief,
    report: {
      briefHash: activeBrief.hash,
      report: { revision: 1, hash: 'report-hash', path: 'brief-quality.json' },
      ruleVersion: 'brief-quality-v1',
      issues: [
        { code: 'missing_scope', severity: 'error', taskId: 'T001', message: 'scope is missing' },
      ],
      errorCount: 1,
    },
    qualityPolicyVersion: 'brief-quality-v1',
    ...overrides,
  };
}

export function makeStandardBriefAdmission(
  overrides: Partial<BriefAdmissionInput> = {},
): BriefAdmissionInput {
  return makeBriefAdmission({
    origin: { mode: 'standard', entry: 'initial' },
    continuation: { version: 1, kind: 'approval', mode: 'standard', entry: 'initial' },
    ...overrides,
  });
}

export function makeBriefRecoveryControllerDeps(
  overrides: {
    providerResult?: (input: RecoveryProviderRequest) => RecoveryProviderResult;
    budgetRefused?: boolean;
    qualityIssues?: readonly BriefQualityIssue[];
    commit?: BriefOwnerCommitPort;
    reconcile?: MutableBriefRecoveryControllerDeps['budget']['reconcile'];
    terminalCharge?: MutableBriefRecoveryControllerDeps['budget']['terminalCharge'];
    now?: (() => string) | undefined;
    nextId?: (() => string) | undefined;
  } = {},
): {
  deps: MutableBriefRecoveryControllerDeps;
  providerCalls: RecoveryProviderRequest[];
  readonly estimateCalls: number;
} {
  const providerCalls: RecoveryProviderRequest[] = [];
  let estimateCalls = 0;
  const deps: MutableBriefRecoveryControllerDeps = {
    provider: {
      async dispatch(input) {
        providerCalls.push(input);
        return (
          overrides.providerResult?.(input) ?? {
            kind: 'completed',
            requestId: input.requestId,
            dispatchPossibility: 'possible',
            remoteObservation: 'confirmed-final',
            text: 'corrected brief',
            providerCode: null,
            usage: null,
          }
        );
      },
    },
    budget: {
      estimate: () => {
        estimateCalls += 1;
        return {
          kind: 'finite',
          budgetUnit: 'usd',
          inputTokens: 1,
          outputTokens: 1,
          amount: 0.1,
          pricingIdentity: 'test',
        };
      },
      reserve: ({ accountingKey }) =>
        overrides.budgetRefused === true
          ? { kind: 'refused', code: 'brief_budget_exhausted', reason: 'budget refused' }
          : { kind: 'reserved', reservation: makeRecoveryReservation(accountingKey) },
      reconcile:
        overrides.reconcile ??
        (({ reservation, remoteObservation, usage }) => ({
          reservation: {
            ...reservation,
            state:
              remoteObservation === 'not-dispatched'
                ? 'released'
                : remoteObservation === 'unknown'
                  ? 'held'
                  : 'reconciled',
            usageApplied: usage !== null,
            appliedUsage: usage,
          },
          usageApplied: usage !== null,
          appliedAmount: 0,
        })),
      terminalCharge:
        overrides.terminalCharge ??
        (({ reservation }) => ({
          reservation: { ...reservation, state: 'terminal-charged' },
          usageApplied: reservation.usageApplied,
          appliedAmount: reservation.amount,
        })),
    },
    evaluateQuality: () => [...(overrides.qualityIssues ?? [])],
    readRetryContext: () => ({
      prompt: 'repair the original Task Briefs',
      projectDir: '/tmp/original-project',
      currentKnownSpend: 0,
      maxBudget: 1,
    }),
    commit: overrides.commit ?? makeTestOwnerCommit(),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.nextId === undefined ? {} : { nextId: overrides.nextId }),
  };
  return {
    deps,
    providerCalls,
    get estimateCalls() {
      return estimateCalls;
    },
  };
}
