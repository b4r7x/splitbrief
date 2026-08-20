import type { Planner } from '../engine/planners/types.js';
import type { Implementer } from '../engine/implementers/types.js';
import type { PreparedExecution } from '../engine/runners/prepared-execution.js';
import { loadStateForResume } from '../core/state/persistence.js';
import { acquireStateAuthority, releaseStateAuthority } from '../core/state/authority.js';
import type { StateAuthorityReceipt } from '../core/state/types.js';
import type { SessionRef } from '../core/types/session-ref.js';
import {
  BriefRecoveryProjectionV1Schema,
  RecoveryResultV1Schema,
  type BriefRecoveryProjectionV1,
  type RecoveryResultV1,
} from '../core/schemas/brief-recovery.js';
import type { WorkflowState } from '../core/schemas/workflow.js';
import { createBriefRecoveryController } from '../engine/orchestrator/planning/brief-recovery-controller.js';
import { readSession } from '../core/sessions/io.js';
import { runWorkflow } from '../engine/orchestrator/run/workflow.js';
import { modelCacheStore } from '../stores/discovery/model-cache.js';
import { attachmentsStore } from '../stores/workflow/attachments.js';
import { cliError } from './errors.js';
import { error } from '../utils/error.js';
import { installTerminalOutputErrorGuard } from '../lib/terminal/control.js';
import { flushOtel } from '../lib/otel.js';
import { writeHeadlessJsonRecord } from '../engine/events/public-json.js';
import { TRANSCRIPT_OMITTED_MESSAGE } from '../core/transcript-policy.js';
import type { Config } from '../core/schemas/config.js';

function buildNoopSinks() {
  return {
    setAbortHandler: () => undefined,
    setQueueHandler: () => undefined,
  };
}

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

type LoadedHeadlessState = Readonly<{
  state: WorkflowState;
  authority: StateAuthorityReceipt;
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

function loadOwnedState(ref: SessionRef): LoadedHeadlessState | null {
  let acquired: ReturnType<typeof acquireStateAuthority>;
  try {
    acquired = acquireStateAuthority({ ref, purpose: 'resume' });
  } catch {
    return null;
  }

  if (acquired.kind !== 'fenced') return null;
  const authority = acquired.receipt;
  try {
    const result = loadStateForResume({ ref, authority: acquired });
    if (result.kind !== 'loaded') return null;
    return { state: result.state, authority };
  } finally {
    releaseStateAuthority(ref, authority);
  }
}

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

function emitBriefRecoveryAndFailIfNeeded(
  state: WorkflowState,
  sessionId: string,
  persistTranscript: boolean,
): boolean {
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

function emitRecoveryAndFailIfPending(
  state: WorkflowState | null,
  sessionId: string,
  persistTranscript: boolean,
): void {
  const issue = state?.pendingRecovery;
  if (!issue) return;
  writeHeadlessJsonRecord(
    {
      type: 'recovery_required',
      sessionId,
      reason: issue.reason,
      status: issue.status,
      message: issue.message,
      taskId: issue.taskId,
      files: issue.files,
      affectedTaskIds: issue.affectedTaskIds,
      availableActions: issue.availableActions,
      recommendedAction: issue.recommendedAction,
    },
    process.stdout,
    { persistTranscript },
  );
  const message = persistTranscript ? issue.message : TRANSCRIPT_OMITTED_MESSAGE;
  const resolutionRoute = issue.availableActions.join(', ');
  throw cliError(
    `Recovery required (status: ${issue.status}): ${message} Resolve it by choosing one of: ${resolutionRoute}.`,
    1,
  );
}

function failIfFinalReviewIncomplete(state: WorkflowState | null, sessionId: string): void {
  if (state?.phase !== 'final-review') return;
  writeHeadlessJsonRecord({ type: 'final_review_failed', sessionId });
  throw cliError('Final review did not pass — workflow is incomplete.', 1);
}

function failIfSessionFailed(projectDir: string, sessionId: string): void {
  const session = readSession({ projectDir, sessionId });
  if (session?.status !== 'failed') return;
  writeHeadlessJsonRecord({
    type: 'error',
    message: `Session ${sessionId} ended with status failed.`,
  });
  throw cliError('Workflow failed — see the error output above.', 1);
}

// A run stopped short of completion — a tiered approval refused headlessly, a
// gate that ended the task loop — saves the session as 'interrupted' without a
// pendingRecovery and without a 'failed' status, so the guards above miss it.
// A user-requested abort never reaches here: the signal check in runHeadless
// returns first, keeping SIGINT/SIGTERM at exit 0.
function failIfSessionInterrupted(projectDir: string, sessionId: string): void {
  const session = readSession({ projectDir, sessionId });
  if (session?.status !== 'interrupted') return;
  writeHeadlessJsonRecord({
    type: 'error',
    message: `Session ${sessionId} ended with status interrupted.`,
  });
  throw cliError('Workflow did not complete — the run stopped early.', 1);
}

export interface RunHeadlessOptions {
  prepared: PreparedExecution;
  _planner?: Planner | undefined;
  _implementer?: Implementer | undefined;
}

export function assertHeadlessTaskReviewDisabled(config: Pick<Config, 'workflow'>): void {
  if ((config.workflow.taskReview ?? 'none') === 'none') return;
  throw cliError(
    'workflow.taskReview requires an interactive TUI run. Set workflow.taskReview: none for headless mode.',
  );
}

export async function runHeadless(options: RunHeadlessOptions): Promise<void> {
  const { prepared, _planner, _implementer } = options;
  const projectDir = prepared.session.ref.projectDir;
  const sessionId = prepared.session.ref.sessionId;
  const runConfig = prepared.config;
  installTerminalOutputErrorGuard();

  assertHeadlessTaskReviewDisabled(runConfig);

  // A resumed Brief recovery is already an owner-controlled state machine. A
  // headless observation must report it, not manufacture a retry by entering
  // the ordinary workflow loop (which would invoke a planner/provider).
  if (prepared.purpose === 'resume') {
    const preflight = loadOwnedState({ projectDir, sessionId });
    if (preflight !== null) {
      if (
        emitBriefRecoveryAndFailIfNeeded(
          preflight.state,
          sessionId,
          runConfig.workflow.persistTranscript,
        )
      ) {
        return;
      }
      if (preflight.state.pendingRecovery !== undefined) {
        emitRecoveryAndFailIfPending(
          preflight.state,
          sessionId,
          runConfig.workflow.persistTranscript,
        );
        return;
      }
    }
  }

  const abortController = new AbortController();
  const onSignal = () => abortController.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    await runWorkflow({
      prepared,
      headless: true,
      sinks: buildNoopSinks(),
      modelCache: modelCacheStore,
      drainPendingAttachments: () => attachmentsStore.drain(),
      signal: abortController.signal,
      _planner,
      _implementer,
      savedState: prepared.runtime.resumeState,
      callbacks: {
        onApprovalNeeded: async (_type, _input) => ({ approved: true }),
        onQuestionAsked: async () => '',
        onComplete: () => undefined,
      },
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await flushOtel();
  }

  if (abortController.signal.aborted) return;

  const finalState = loadOwnedState({ projectDir, sessionId })?.state ?? null;
  if (
    finalState !== null &&
    emitBriefRecoveryAndFailIfNeeded(finalState, sessionId, runConfig.workflow.persistTranscript)
  ) {
    return;
  }
  emitRecoveryAndFailIfPending(finalState, sessionId, runConfig.workflow.persistTranscript);
  failIfFinalReviewIncomplete(finalState, sessionId);
  failIfSessionFailed(projectDir, sessionId);
  failIfSessionInterrupted(projectDir, sessionId);
}
