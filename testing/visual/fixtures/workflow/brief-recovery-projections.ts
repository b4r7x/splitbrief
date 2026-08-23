import {
  BriefRecoveryV1Schema,
  BriefRecoveryProjectionV1Schema,
  type BriefRecoveryV1,
  type BriefRecoveryProjectionV1,
} from '../../../../src/core/schemas/brief-recovery.js';
import type { WorkflowState } from '../../../../src/core/schemas/workflow.js';
import { WORKFLOW_STATE_VERSION } from '../../../../src/core/schemas/workflow.js';
import { formatTasks } from '../../../../src/engine/spec/formatter.js';
import { makeUsage } from '../../../helpers/factories/summary.js';
import { makeTask } from '../../../helpers/factories/task.js';
import type { ScenarioId } from '../../contracts/identifiers.js';
import { scenarioId } from '../../contracts/identifiers.js';
import type { WorkflowFixtureProjection } from './projections.js';

const SESSION_ID = 'visual-workflow';
const EPOCH_ID = 'visual-brief-recovery-epoch-1';
const BRIEF_HASH = 'visual-brief-hash-1';
const REPORT_HASH = 'visual-brief-report-hash-1';
const FEATURE = 'Brief recovery visual fixtures';
const BRIEF_REF = Object.freeze({
  revision: 1,
  hash: BRIEF_HASH,
  path: 'brief/tasks.md',
});
const REPORT_REF = Object.freeze({
  revision: 1,
  hash: REPORT_HASH,
  path: 'brief/quality.json',
});
const ORIGIN = Object.freeze({ mode: 'standard' as const, entry: 'initial' as const });
const CONTINUATION = Object.freeze({
  version: 1 as const,
  kind: 'approval' as const,
  mode: 'standard' as const,
  entry: 'initial' as const,
});

const REVIEW_FILE_PATH = '.splitbrief/sessions/visual-workflow/tasks.md';
const REVIEW_SOURCE = formatTasks([
  makeTask({
    id: 'T901',
    title: 'Project deterministic recovery fixture',
    action: 'modify',
    file: 'src/recovery-fixture.ts',
  }),
]);
const FIXED_TIMESTAMP = '2026-08-14T00:00:00.000Z';

const baseRecovery = {
  version: 1 as const,
  sessionId: SESSION_ID,
  recoveryRevision: 1,
  epochId: EPOCH_ID,
  origin: ORIGIN,
  continuation: CONTINUATION,
  activeBrief: BRIEF_REF,
  matchingReport: {
    briefHash: BRIEF_HASH,
    report: REPORT_REF,
    ruleVersion: 'brief-quality-v1',
    issues: [],
  },
  blocker: null,
  allowedActions: ['status'],
  activeOperation: null,
  latestAttempt: null,
  queuedInputs: {
    ids: [],
    count: 0,
    carriedCount: 0,
    heldCount: 0,
    releasedCount: 0,
  },
};

function issue(code: string, taskId: string | null, message: string) {
  return { code, severity: 'error' as const, taskId, message };
}

function qualityBlocker(issues: readonly ReturnType<typeof issue>[]) {
  return { kind: 'quality' as const, issues };
}

function attemptSummary(
  operationId: string,
  status: 'accepted' | 'unresolved' | 'settled',
  dispatchPossibility: 'none' | 'possible',
  reservationState: 'reserved' | 'held' | 'reconciled',
  outcome: 'ready' | 'provider-failed' | null,
) {
  return {
    operationId,
    status,
    dispatchPossibility,
    outcome,
    reservation: {
      accountingKey: {
        sessionId: SESSION_ID,
        epochId: EPOCH_ID,
        operationId,
        generation: 1,
      },
      amount: 1,
      state: reservationState,
    },
  };
}

function reservation(operationId: string, state: 'reserved' | 'held' | 'reconciled') {
  return {
    accountingKey: {
      sessionId: SESSION_ID,
      epochId: EPOCH_ID,
      operationId,
      generation: 1,
    },
    amount: 1,
    state,
    usageApplied: state === 'reconciled',
    appliedUsage:
      state === 'reconciled'
        ? { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: true }
        : null,
    history: [],
  };
}

function attempt(
  operationId: string,
  status: 'accepted' | 'unresolved' | 'settled',
  dispatchPossibility: 'none' | 'possible',
  reservationState: 'reserved' | 'held' | 'reconciled',
  outcome: 'ready' | 'provider-failed' | null,
) {
  const base = {
    epochId: EPOCH_ID,
    operationId,
    intentHash: 'visual-intent-hash',
    kind: 'manual-retry' as const,
    acceptedAt: FIXED_TIMESTAMP,
    baseBrief: BRIEF_REF,
    baseReport: REPORT_REF,
    frozenInputIds: [],
    reservation: reservation(operationId, reservationState),
  };
  if (status === 'accepted') {
    return {
      ...base,
      status,
      dispatchPossibility,
      automaticAllowanceConsumed: false,
    };
  }
  if (status === 'unresolved') {
    return {
      ...base,
      status,
      dispatchPossibility,
      remoteObservation: 'unknown' as const,
      requestId: `${operationId}-request`,
      unresolvedAt: FIXED_TIMESTAMP,
    };
  }
  return {
    ...base,
    status,
    dispatchPossibility,
    remoteObservation:
      dispatchPossibility === 'none' ? ('not-dispatched' as const) : ('confirmed-final' as const),
    resultId: `${operationId}-result`,
    outcome: outcome ?? 'ready',
    providerCode: outcome === 'provider-failed' ? 'provider_unavailable' : null,
    usage: null,
    settledAt: FIXED_TIMESTAMP,
    candidate: outcome === 'ready' ? BRIEF_REF : null,
    report: outcome === 'ready' ? REPORT_REF : null,
  };
}

function attemptReservationState(
  state: 'reserved' | 'released' | 'held' | 'reconciled' | 'terminal-charged' | undefined,
): 'reserved' | 'held' | 'reconciled' {
  if (state === 'held' || state === 'reconciled') return state;
  return 'reserved';
}

function attemptOutcome(
  outcome:
    | 'ready'
    | 'quality-failed'
    | 'provider-failed'
    | 'malformed-output'
    | 'storage-failed'
    | 'stale-ignored'
    | null
    | undefined,
): 'ready' | 'provider-failed' | null {
  return outcome === 'ready' || outcome === 'provider-failed' ? outcome : null;
}

function persistedRecovery(recovery: BriefRecoveryProjectionV1): BriefRecoveryV1 {
  if (recovery.status === 'storage-blocked') {
    return BriefRecoveryV1Schema.parse({
      version: 1,
      recoveryRevision: recovery.recoveryRevision,
      epochId: recovery.epochId ?? EPOCH_ID,
      origin: ORIGIN,
      continuation: CONTINUATION,
      status: 'storage-blocked',
      activeBrief: null,
      storageEvidence: { code: 'brief_storage_invalid', artifactRef: null },
      evidenceHead: 'storage-blocked',
      outbox: [],
    });
  }

  const operationId = recovery.activeOperation?.operationId ?? recovery.latestAttempt?.operationId;
  const attemptStatus =
    recovery.status === 'retrying'
      ? 'accepted'
      : recovery.status === 'unresolved'
        ? 'unresolved'
        : recovery.latestAttempt?.status === 'settled'
          ? 'settled'
          : null;
  const attempts =
    operationId !== undefined && attemptStatus !== null
      ? {
          [operationId]: attempt(
            operationId,
            attemptStatus,
            recovery.activeOperation?.dispatchPossibility ??
              recovery.latestAttempt?.dispatchPossibility ??
              'none',
            attemptReservationState(
              recovery.activeOperation?.reservation.state ??
                recovery.latestAttempt?.reservation.state,
            ),
            attemptOutcome(recovery.latestAttempt?.outcome),
          ),
        }
      : {};

  return BriefRecoveryV1Schema.parse({
    version: 1,
    recoveryRevision: recovery.recoveryRevision,
    epochId: recovery.epochId ?? EPOCH_ID,
    origin: ORIGIN,
    continuation: CONTINUATION,
    status: recovery.status,
    activeBrief: recovery.activeBrief ?? BRIEF_REF,
    matchingReport: recovery.matchingReport,
    qualityPolicyVersion: 'brief-quality-v1',
    automaticRepair: {
      policy: 'none',
      eligible: false,
      consumed: false,
      operationId: null,
    },
    committedSpend: 0,
    attempts,
    activeOperationId:
      recovery.status === 'retrying' || recovery.status === 'unresolved'
        ? (operationId ?? null)
        : null,
    inputs: [],
    nextInputSequence: 1,
    noProgress: { fingerprint: null, count: 0 },
    evidenceHead: BRIEF_HASH,
    outbox: [],
  });
}

function projection(
  recovery: Partial<BriefRecoveryProjectionV1>,
  scenario: string,
): BriefRecoveryFixtureProjection {
  const parsedRecovery = BriefRecoveryProjectionV1Schema.parse({
    ...baseRecovery,
    ...recovery,
    version: 1,
    sessionId: SESSION_ID,
    recoveryRevision: recovery.recoveryRevision ?? 1,
    epochId: recovery.epochId ?? EPOCH_ID,
    origin: ORIGIN,
    continuation: CONTINUATION,
  });
  return {
    scenarioId: scenarioId(scenario),
    feature: FEATURE,
    events: [],
    inputMode: 'review',
    sidebarVisible: true,
    review: {
      filePath: REVIEW_FILE_PATH,
      source: REVIEW_SOURCE,
    },
    recovery: parsedRecovery,
    persistedRecovery: persistedRecovery(parsedRecovery),
  };
}

const zeroTaskIssue = issue(
  'brief_zero_tasks',
  'T000',
  'The Brief contains no tasks to implement.',
);
const taskIssue = issue(
  'brief_task_missing_acceptance',
  'T901',
  'Task T901 is missing an acceptance condition.',
);
const providerIssue = issue(
  'brief_provider_unavailable',
  null,
  'The recovery provider failed before producing a result.',
);
const warningIssue = {
  code: 'brief_style_warning',
  severity: 'warning' as const,
  taskId: null,
  message: 'The repaired Brief has one style warning.',
};

const zeroTaskBlocked = projection(
  {
    stateRevision: 1,
    status: 'blocked',
    matchingReport: {
      ...baseRecovery.matchingReport,
      issues: [zeroTaskIssue],
    },
    blocker: qualityBlocker([zeroTaskIssue]),
    allowedActions: ['retry', 'edit', 'reject', 'status'],
  },
  'workflow-brief-recovery-zero-task-blocked',
);

const storageBlocked = projection(
  {
    stateRevision: 2,
    status: 'storage-blocked',
    activeBrief: null,
    matchingReport: null,
    blocker: {
      kind: 'storage' as const,
      code: 'brief_storage_invalid' as const,
      message: 'The saved Brief evidence is missing or invalid.',
    },
    allowedActions: ['edit', 'reject', 'status'],
  },
  'workflow-brief-recovery-storage-blocked',
);

const taskBlocked = projection(
  {
    stateRevision: 3,
    status: 'blocked',
    matchingReport: {
      ...baseRecovery.matchingReport,
      issues: [taskIssue],
    },
    blocker: qualityBlocker([taskIssue]),
    allowedActions: ['retry', 'edit', 'reject', 'status'],
  },
  'workflow-brief-recovery-task-blocked',
);

const retrying = projection(
  {
    stateRevision: 4,
    status: 'retrying',
    activeOperation: attemptSummary(
      'visual-recovery-retry-1',
      'accepted',
      'none',
      'reserved',
      null,
    ),
    latestAttempt: attemptSummary('visual-recovery-retry-1', 'accepted', 'none', 'reserved', null),
    allowedActions: ['edit', 'reject', 'status'],
    queuedInputs: {
      ids: ['visual-input-queued', 'visual-input-carried', 'visual-input-held'],
      count: 3,
      carriedCount: 1,
      heldCount: 1,
      releasedCount: 0,
    },
  },
  'workflow-brief-recovery-retrying-queued',
);

const unresolved = projection(
  {
    stateRevision: 5,
    status: 'unresolved',
    activeOperation: attemptSummary(
      'visual-recovery-unresolved-1',
      'unresolved',
      'possible',
      'held',
      null,
    ),
    latestAttempt: attemptSummary(
      'visual-recovery-unresolved-1',
      'unresolved',
      'possible',
      'held',
      null,
    ),
    blocker: {
      kind: 'unresolved' as const,
      code: 'brief_unresolved' as const,
      operationId: 'visual-recovery-unresolved-1',
    },
    allowedActions: ['resolve-unresolved', 'edit', 'reject', 'status'],
    queuedInputs: {
      ids: ['visual-input-held'],
      count: 1,
      carriedCount: 0,
      heldCount: 1,
      releasedCount: 0,
    },
  },
  'workflow-brief-recovery-unresolved',
);

const ready = projection(
  {
    stateRevision: 6,
    status: 'ready',
    matchingReport: {
      ...baseRecovery.matchingReport,
      issues: [warningIssue],
    },
    activeOperation: null,
    latestAttempt: attemptSummary(
      'visual-recovery-repair-1',
      'settled',
      'possible',
      'reconciled',
      'ready',
    ),
    allowedActions: ['approve', 'edit', 'reject', 'revise', 'status'],
  },
  'workflow-brief-recovery-ready',
);

const providerFailed = projection(
  {
    stateRevision: 7,
    status: 'blocked',
    matchingReport: {
      ...baseRecovery.matchingReport,
      issues: [],
    },
    blocker: {
      kind: 'provider' as const,
      code: 'provider_unavailable',
      message: providerIssue.message,
    },
    latestAttempt: attemptSummary(
      'visual-recovery-provider-1',
      'settled',
      'none',
      'reconciled',
      'provider-failed',
    ),
    allowedActions: ['retry', 'edit', 'reject', 'status'],
  },
  'workflow-brief-recovery-provider-failed',
);

const budgetBlocked = projection(
  {
    stateRevision: 8,
    status: 'blocked',
    matchingReport: {
      ...baseRecovery.matchingReport,
      issues: [],
    },
    blocker: {
      kind: 'budget' as const,
      code: 'brief_budget_exhausted' as const,
      remaining: 0,
    },
    budget: {
      state: 'refused' as const,
      refusalCode: 'brief_budget_exhausted',
      remoteUsage: 'REMOTE USAGE UNKNOWN' as const,
    },
    remoteUsage: 'REMOTE USAGE UNKNOWN' as const,
    allowedActions: ['edit', 'reject', 'status'],
  },
  'workflow-brief-recovery-budget-blocked',
);

export interface BriefRecoveryFixtureProjection extends WorkflowFixtureProjection {
  readonly recovery: BriefRecoveryProjectionV1;
  readonly persistedRecovery: BriefRecoveryV1;
}

export function persistedRecoveryWorkflowState(
  projection: BriefRecoveryFixtureProjection,
): WorkflowState {
  return {
    stateVersion: WORKFLOW_STATE_VERSION,
    stateRevision: projection.recovery.stateRevision,
    stateFence: { token: 1, ownerId: 'visual-recovery-fixture' },
    phase: 'reviewing-briefs',
    feature: projection.feature,
    currentTaskIndex: 0,
    attempt: 0,
    tasks: [],
    startedAt: FIXED_TIMESTAMP,
    tokenUsage: makeUsage(),
    awaitingContinue: false,
    messageQueue: [],
    briefRecovery: projection.persistedRecovery,
  };
}

const projections = [
  zeroTaskBlocked,
  storageBlocked,
  taskBlocked,
  retrying,
  unresolved,
  ready,
  providerFailed,
  budgetBlocked,
] as const;

export const briefRecoveryFixtureProjections: ReadonlyMap<
  ScenarioId,
  BriefRecoveryFixtureProjection
> = new Map(projections.map((fixture) => [fixture.scenarioId, fixture]));
