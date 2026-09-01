import type { StateAction } from './types.js';
import type { WorkflowState } from '../schemas/workflow.js';
import type { BriefReadinessDecision } from '../schemas/brief-recovery/attempt.js';
import type {
  BriefRecoveryV1,
  NormalBriefRecoveryV1,
  RejectedStorageBriefRecoveryV1,
} from '../schemas/brief-recovery/document.js';
import { sameExecutionPermit, sameGeneration } from '../schemas/brief-owner.js';
import { transitionError } from './errors.js';

function isRejectedStorageBriefRecovery(
  recovery: BriefRecoveryV1,
): recovery is RejectedStorageBriefRecoveryV1 {
  return (
    recovery.status === 'rejected' && 'storageEvidence' in recovery && recovery.activeBrief === null
  );
}

function readinessDecisionMatchesRecovery(
  decision: BriefReadinessDecision,
  recovery: NormalBriefRecoveryV1,
): boolean {
  return (
    recovery.matchingReport !== null &&
    decision.briefHash === recovery.activeBrief.hash &&
    decision.reportHash === recovery.matchingReport.report.hash &&
    decision.qualityPolicyVersion === recovery.qualityPolicyVersion
  );
}

function hasCurrentZeroErrorReport(recovery: BriefRecoveryV1 | null | undefined): boolean {
  if (recovery === undefined || recovery === null) return false;
  if (!('matchingReport' in recovery) || !('activeBrief' in recovery)) return false;
  if (recovery.status !== 'ready') return false;
  if (recovery.activeBrief === null || recovery.matchingReport === null) return false;
  if (recovery.matchingReport.briefHash !== recovery.activeBrief.hash) return false;
  if (recovery.matchingReport.ruleVersion !== recovery.qualityPolicyVersion) return false;
  if (
    recovery.readinessDecision !== undefined &&
    !readinessDecisionMatchesRecovery(recovery.readinessDecision, recovery)
  ) {
    return false;
  }
  if (recovery.readinessDecision?.kind === 'blocked') return false;
  if (recovery.matchingReport.issues.some((issue) => issue.severity === 'error')) return false;
  if (Object.values(recovery.attempts).some((attempt) => attempt.epochId !== recovery.epochId)) {
    return false;
  }
  if (
    Object.values(recovery.attempts).some(
      (attempt) =>
        attempt.status === 'accepted' ||
        attempt.status === 'started' ||
        attempt.status === 'unresolved',
    )
  ) {
    return false;
  }
  return recovery.activeOperationId === null;
}

export function recordBriefReadiness(
  state: WorkflowState,
  decision: BriefReadinessDecision,
): WorkflowState {
  const recovery = state.briefRecovery;
  if (
    recovery === undefined ||
    recovery === null ||
    recovery.status === 'storage-blocked' ||
    recovery.status === 'rejected' ||
    !readinessDecisionMatchesRecovery(decision, recovery)
  ) {
    throw transitionError.briefReadinessBlocked(recovery?.epochId ?? 'missing');
  }
  if (
    decision.kind !== 'blocked' &&
    (recovery.status !== 'readiness-blocked' ||
      recovery.readinessDecision?.kind !== 'blocked' ||
      (decision.kind === 'override' &&
        recovery.readinessDecision.fingerprint !== decision.fingerprint))
  ) {
    throw transitionError.briefReadinessBlocked(recovery.epochId);
  }
  return {
    ...state,
    briefRecovery: {
      ...recovery,
      recoveryRevision: recovery.recoveryRevision + 1,
      status: decision.kind === 'blocked' ? 'readiness-blocked' : 'ready',
      readinessDecision: decision,
    },
  };
}

function assertBriefAdmissionMayExit(state: WorkflowState): void {
  const recovery = state.briefRecovery;
  if (recovery === undefined || recovery === null) {
    throw transitionError.briefContractBlocked('missing-recovery');
  }
  if (recovery.status === 'retrying' || recovery.status === 'auto-repairing') {
    throw transitionError.briefContractBlocked('retry-in-flight', recovery.epochId);
  }
  if (recovery.status === 'unresolved') {
    throw transitionError.briefContractBlocked('unresolved-retry', recovery.epochId);
  }
  if (recovery.status === 'readiness-blocked') {
    throw transitionError.briefReadinessBlocked(recovery.epochId);
  }
  if (!('matchingReport' in recovery) || !('activeBrief' in recovery)) {
    throw transitionError.briefContractBlocked('not-ready', recovery.epochId);
  }
  if (recovery.matchingReport?.issues.some((issue) => issue.severity === 'error')) {
    throw transitionError.briefContractBlocked('quality-errors', recovery.epochId);
  }
  if (
    recovery.matchingReport !== null &&
    recovery.activeBrief !== null &&
    recovery.matchingReport.briefHash !== recovery.activeBrief.hash
  ) {
    throw transitionError.briefContractBlocked('stale-report', recovery.epochId);
  }
  if (
    recovery.matchingReport !== null &&
    recovery.matchingReport.ruleVersion !== recovery.qualityPolicyVersion
  ) {
    throw transitionError.briefContractBlocked('stale-report', recovery.epochId);
  }
  if (Object.values(recovery.attempts).some((attempt) => attempt.epochId !== recovery.epochId)) {
    throw transitionError.briefContractBlocked('stale-report', recovery.epochId);
  }
  if (
    Object.values(recovery.attempts).some(
      (attempt) =>
        attempt.status === 'accepted' ||
        attempt.status === 'started' ||
        attempt.status === 'unresolved',
    )
  ) {
    throw transitionError.briefContractBlocked('retry-in-flight', recovery.epochId);
  }
  if (!hasCurrentZeroErrorReport(recovery)) {
    throw transitionError.briefContractBlocked('not-ready', recovery.epochId);
  }
}

export function assertCurrentExecutionPermit(
  state: WorkflowState,
  action: Extract<StateAction, { type: 'BEGIN_IMPLEMENTATION' }>,
): void {
  assertBriefAdmissionMayExit(state);
  const recovery = state.briefRecovery;
  const persistedGeneration = state.generation;
  const persistedPermit = state.permit;
  if (
    recovery === undefined ||
    recovery === null ||
    recovery.status !== 'ready' ||
    state.authorityRevision === undefined ||
    persistedGeneration === undefined ||
    persistedGeneration === null ||
    persistedPermit === undefined ||
    persistedPermit === null
  ) {
    throw transitionError.executionPermitInvalid();
  }
  if (
    action.permit.epochId !== recovery.epochId ||
    action.permit.authorityRevision !== state.authorityRevision ||
    !sameGeneration(action.generation, persistedGeneration) ||
    !sameExecutionPermit(action.permit, persistedPermit) ||
    action.permit.generationId !== action.generation.generationId ||
    action.permit.manifestDigest !== action.generation.manifestDigest ||
    action.permit.tasksDigest !== action.generation.tasksDigest ||
    action.permit.qualityDigest !== action.generation.qualityDigest
  ) {
    throw transitionError.executionPermitInvalid();
  }
}

export function rejectBriefAdmission(
  state: WorkflowState,
  idleState: WorkflowState,
): WorkflowState {
  const recovery = state.briefRecovery;
  if (recovery === undefined || recovery === null) return idleState;
  if (recovery.status === 'storage-blocked') {
    const rejectedStorageRecovery: RejectedStorageBriefRecoveryV1 = {
      ...recovery,
      status: 'rejected',
    };
    return {
      ...idleState,
      briefRecovery: rejectedStorageRecovery,
    };
  }
  if (isRejectedStorageBriefRecovery(recovery)) {
    return {
      ...idleState,
      briefRecovery: recovery,
    };
  }
  return {
    ...idleState,
    briefRecovery: {
      ...recovery,
      status: 'rejected',
      activeOperationId: null,
    },
  };
}
