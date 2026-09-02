import {
  type BriefRecoveryProjectionV1,
  BriefRecoveryProjectionV1Schema,
} from '../core/schemas/brief-recovery/document.js';
import { type RecoveryResultV1, RecoveryResultV1Schema } from '../core/schemas/brief-recovery.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { createBriefRecoveryController } from '../engine/orchestrator/planning/brief-recovery-controller.js';
import { writeHeadlessJsonRecord } from '../engine/events/public-json.js';
import { cliError } from './errors.js';
import { error } from '../utils/error.js';

export const HEADLESS_RECOVERY_STATUSES = [
  'blocked',
  'retrying',
  'unresolved',
  'storage-blocked',
  'ready',
  'readiness-blocked',
  'blocked-with-provider-failure',
  'blocked-with-budget-refusal',
  'rejected',
] as const;

export type HeadlessRecoveryStatus = (typeof HEADLESS_RECOVERY_STATUSES)[number];

export type HeadlessRecoveryOutcome = Readonly<{
  status: HeadlessRecoveryStatus;
  exitCode: 0 | 1;
}>;

function headlessRecoveryReadOnlyError(action: string) {
  return error('headless-recovery-read-only', `Headless recovery projection cannot ${action}.`);
}

// Headless status only needs the controller's read-only projection seam. Keep
// mutation ports fail-closed so observing state can never dispatch recovery or
// alter its persisted owner state.
const headlessRecoveryProjectionController = createBriefRecoveryController({
  provider: {
    dispatch: async () => {
      throw headlessRecoveryReadOnlyError('dispatch a provider call');
    },
  },
  budget: {
    estimate: () => {
      throw headlessRecoveryReadOnlyError('estimate a provider call');
    },
    reserve: () => {
      throw headlessRecoveryReadOnlyError('reserve a provider call');
    },
    reconcile: () => {
      throw headlessRecoveryReadOnlyError('reconcile a provider call');
    },
    terminalCharge: () => {
      throw headlessRecoveryReadOnlyError('charge a provider call');
    },
  },
  evaluateQuality: () => {
    throw headlessRecoveryReadOnlyError('evaluate Brief quality');
  },
  commit: () => {
    throw headlessRecoveryReadOnlyError('commit recovery state');
  },
});

export function headlessRecoveryStatus(
  projection: BriefRecoveryProjectionV1,
): HeadlessRecoveryStatus {
  if (projection.status === 'ready') return 'ready';
  if (projection.status === 'readiness-blocked') return 'readiness-blocked';
  if (projection.status === 'rejected') return 'rejected';
  if (projection.status === 'storage-blocked') return 'storage-blocked';
  if (projection.status === 'unresolved') return 'unresolved';
  if (projection.status === 'retrying' || projection.status === 'auto-repairing') {
    return 'retrying';
  }
  if (projection.blocker?.kind === 'provider') return 'blocked-with-provider-failure';
  if (projection.blocker?.kind === 'budget') return 'blocked-with-budget-refusal';
  if (projection.latestAttempt?.outcome === 'provider-failed') {
    return 'blocked-with-provider-failure';
  }
  if (projection.budget?.state === 'refused') return 'blocked-with-budget-refusal';
  return 'blocked';
}

export function headlessRecoveryOutcome(
  projection: BriefRecoveryProjectionV1,
): HeadlessRecoveryOutcome {
  const status = headlessRecoveryStatus(projection);
  return { status, exitCode: status === 'ready' ? 0 : 1 };
}

function briefRecoveryProjection(
  state: WorkflowState,
  sessionId: string,
): BriefRecoveryProjectionV1 | null {
  const recovery = state.briefRecovery;
  if (recovery === undefined || recovery === null) return null;
  return BriefRecoveryProjectionV1Schema.parse(
    headlessRecoveryProjectionController.inspectBriefRecovery({
      sessionId,
      now: new Date().toISOString(),
      state: {
        stateVersion: state.stateVersion,
        stateRevision: state.stateRevision ?? 0,
        stateFence: state.stateFence ?? { token: 0, ownerId: 'headless-recovery' },
        phase: state.phase,
        briefRecovery: recovery,
      },
    }),
  );
}

function recoveryResultForState(
  state: WorkflowState,
  projection: BriefRecoveryProjectionV1,
): RecoveryResultV1 {
  const outcome = headlessRecoveryOutcome(projection);
  const base = {
    version: 1 as const,
    sessionId: projection.sessionId,
    epochId: projection.epochId,
    projection,
  };
  const recovery = state.briefRecovery;
  const activeReceipt =
    recovery !== undefined &&
    recovery !== null &&
    recovery.status !== 'storage-blocked' &&
    recovery.status !== 'rejected' &&
    recovery.activeOperationId !== null
      ? (recovery.attempts[recovery.activeOperationId] ?? null)
      : null;

  switch (outcome.status) {
    case 'ready':
      return RecoveryResultV1Schema.parse({ ...base, kind: 'ready', operationId: null });
    case 'rejected':
      return RecoveryResultV1Schema.parse({ ...base, kind: 'rejected', operationId: null });
    case 'unresolved':
      if (activeReceipt?.status === 'unresolved') {
        return RecoveryResultV1Schema.parse({
          ...base,
          kind: 'unresolved',
          operationId: activeReceipt.operationId,
          receipt: activeReceipt,
        });
      }
      break;
    case 'retrying':
      if (
        activeReceipt !== null &&
        (activeReceipt.status === 'accepted' ||
          activeReceipt.status === 'started' ||
          activeReceipt.status === 'unresolved')
      ) {
        return RecoveryResultV1Schema.parse({
          ...base,
          kind: 'in-flight',
          operationId: activeReceipt.operationId,
          receipt: activeReceipt,
        });
      }
      break;
    case 'storage-blocked':
      return RecoveryResultV1Schema.parse({
        ...base,
        kind: 'blocked',
        code: 'brief_storage_invalid',
        operationId: null,
      });
    case 'readiness-blocked':
      return RecoveryResultV1Schema.parse({
        ...base,
        kind: 'blocked',
        code: 'brief_readiness_blocked',
        operationId: null,
      });
    case 'blocked-with-provider-failure':
      return RecoveryResultV1Schema.parse({
        ...base,
        kind: 'blocked',
        code: 'brief_provider_error',
        operationId: activeReceipt?.operationId ?? null,
        ...(activeReceipt?.status === 'settled' && activeReceipt.providerCode !== null
          ? { reason: activeReceipt.providerCode }
          : {}),
      });
    case 'blocked-with-budget-refusal':
      return RecoveryResultV1Schema.parse({
        ...base,
        kind: 'blocked',
        code: 'brief_budget_exhausted',
        operationId: activeReceipt?.operationId ?? null,
      });
    case 'blocked':
      return RecoveryResultV1Schema.parse({
        ...base,
        kind: 'blocked',
        code:
          projection.blocker?.kind === 'no-progress'
            ? 'brief_no_progress'
            : 'brief_contract_blocked',
        operationId: activeReceipt?.operationId ?? null,
      });
    default: {
      const exhaustive: never = outcome.status;
      return exhaustive;
    }
  }

  return RecoveryResultV1Schema.parse({
    ...base,
    kind: 'blocked',
    code: 'brief_contract_blocked',
    operationId: activeReceipt?.operationId ?? null,
  });
}

export function emitBriefRecoveryAndFailIfNeeded({
  state,
  sessionId,
  persistTranscript,
}: {
  state: WorkflowState;
  sessionId: string;
  persistTranscript: boolean;
}): boolean {
  const projection = briefRecoveryProjection(state, sessionId);
  if (projection === null) return false;
  writeHeadlessJsonRecord({ type: 'brief_recovery', projection }, process.stdout, {
    persistTranscript,
  });
  const result = recoveryResultForState(state, projection);
  writeHeadlessJsonRecord({ type: 'brief_recovery_result', result }, process.stdout, {
    persistTranscript,
  });
  const outcome = headlessRecoveryOutcome(projection);
  if (outcome.exitCode === 0) return true;
  throw cliError(`Brief recovery is ${outcome.status}.`, outcome.exitCode);
}
