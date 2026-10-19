import { existsSync } from 'node:fs';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { ChangedFilesSnapshot, WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishError, publishWarningFromError } from '../events.js';
import { raisePendingRecovery } from '../state-ops.js';
import { createRecoveryIssue } from '../recovery/builders/issue.js';
import { nowIso } from '../../../utils/format-time.js';
import { createEvidenceLedger } from '../../../core/evidence/ledger-state.js';
import { mutateEvidenceLedger, readEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import {
  recordApiApplyEvidence,
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
} from './task.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { recordApprovalEvidence, recordRejectionEvidence } from './approval.js';
import type { ActionClass, TaskCompletionMethod, TaskStatus } from '../../../core/schemas/enums.js';
import { hashTaskBrief } from '../../../core/evidence/brief-hash.js';
import type { GateDecision } from '../approval/types.js';
import type { EvidenceLedger, EvidenceReview } from '../../../core/schemas/evidence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import type { AttemptWorkspace } from '../isolation/types.js';
import { revertedDir, sessionDir } from '../../../core/paths.js';
import { checkSessionLockStatus } from '../../../core/sessions/lockfile-status.js';
import { getChangedFilesSinceSnapshot } from '../approval/file-snapshots/capture.js';
import { briefInFlight } from '../../../core/state/selectors.js';
import { changedSinceAtRest } from '../../snapshots/run/rest-changes.js';

export function getOrCreateLedger(opts: { ref: SessionRef; state: WorkflowState }): EvidenceLedger {
  const { ref, state } = opts;
  const existing = readEvidenceLedger(ref);
  const briefHash = hashTaskBrief(state.tasks);
  return (
    existing ??
    createEvidenceLedger({
      sessionId: ref.sessionId,
      feature: state.feature,
      tasks: state.tasks,
      briefHash,
    })
  );
}

export async function persistTaskEvidence(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  task: Task;
  recordKind: 'local' | 'retry';
  details: {
    status: TaskStatus;
    method?: TaskCompletionMethod | undefined;
    retries?: number | undefined;
    durationMs?: number | undefined;
    initialChangedFiles?: string[] | undefined;
    escalated?: boolean | undefined;
    changedFiles?: string[] | undefined;
  };
}): Promise<void> {
  const { wctx, state, task, recordKind, details } = opts;
  try {
    mutateEvidenceLedger(wctx, (existing) => {
      const ledger = existing ?? getOrCreateLedger({ ref: wctx, state });
      if (recordKind === 'local') {
        return recordLocalTaskEvidence({
          ledger,
          task,
          status: details.status,
          method: details.method,
          retries: details.retries,
          durationMs: details.durationMs,
          changedFiles: details.changedFiles,
        });
      }
      return recordRetryOrEscalationEvidence({
        ledger,
        task,
        status: details.status,
        method: details.method,
        retries: details.retries,
        durationMs: details.durationMs,
        escalated: details.escalated ?? false,
        changedFiles: [...(details.initialChangedFiles ?? []), ...(details.changedFiles ?? [])],
      });
    });
  } catch (err) {
    publishWarningFromError(
      { bus: wctx.bus, phase: state.phase },
      'failed to persist evidence ledger',
      err,
    );
  }
}

/**
 * A skip takes back the brief's files from its task-start snapshot, so the skipped brief answers
 * only for the files still changed since then.
 */
export async function persistSkippedBriefFiles(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus' | 'workspaceDir'>;
  state: WorkflowState;
  task: Task;
  reason: string;
  taskStartSnapshot: ChangedFilesSnapshot | undefined;
}): Promise<void> {
  const { wctx, state, task, taskStartSnapshot } = opts;
  try {
    const keptFiles =
      taskStartSnapshot === undefined
        ? undefined
        : await getChangedFilesSinceSnapshot(wctx.workspaceDir, taskStartSnapshot);
    mutateEvidenceLedger(wctx, (existing) =>
      recordSkippedTaskEvidence({
        ledger: existing ?? getOrCreateLedger({ ref: wctx, state }),
        task,
        reason: opts.reason,
        keptFiles,
      }),
    );
  } catch (err) {
    publishWarningFromError(
      { bus: wctx.bus, phase: state.phase },
      'failed to persist evidence ledger',
      err,
    );
  }
}

/**
 * A run that closes inside a brief books what the brief left: the ledger books a brief when an
 * attempt ends, and a stop cuts the attempt before that. Without it the record would name fewer
 * files than the run's changes hold. An isolated workspace stays the run's until it closes, so it
 * is read as it is. A checkout is the user's once its run's process exits: that process records a
 * snapshot as it exits, and later edits and a reject change the checkout, so the brief's files are
 * then the ones that changed up to that snapshot. A process that died took no such snapshot, so
 * its checkout, like a live one, is read as it is.
 */
export async function persistStoppedBriefEvidence(
  ref: SessionRef,
  state: WorkflowState,
): Promise<void> {
  const task = briefInFlight(state);
  const taskStart = state.changedFilesBaseline?.activeTaskSnapshot;
  const workspace = state.workspace;
  if (task === undefined || taskStart === undefined || workspace === undefined) return;
  if (!existsSync(workspace.path)) return;
  const changedFiles =
    workspace.kind === 'checkout' &&
    checkSessionLockStatus({ sessionDir: sessionDir(ref.projectDir, ref.sessionId) }).kind ===
      'exited'
      ? await changedSinceAtRest(ref, taskStart)
      : await getChangedFilesSinceSnapshot(workspace.path, taskStart);
  mutateEvidenceLedger(ref, (existing) =>
    recordLocalTaskEvidence({
      ledger: existing ?? getOrCreateLedger({ ref, state }),
      task,
      status: 'in_progress',
      changedFiles,
    }),
  );
}

/**
 * §6: the bundle's receipt is written before the attempt's own outcome is
 * handled, so a brief that stops mid-application still leaves the applied prefix
 * on the record. A write that fails is a warning rather than a halt: the next
 * attempt then finds no proof of ownership and parks, which is the safe answer.
 */
export function persistApiApplyEvidence(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  task: Task;
  result: BundleApplyResult;
  workspacePath: string;
}): void {
  const { wctx, state, task, result } = opts;
  try {
    mutateEvidenceLedger(wctx, (existing) =>
      recordApiApplyEvidence({
        ledger: existing ?? getOrCreateLedger({ ref: wctx, state }),
        task,
        result,
        workspacePath: opts.workspacePath,
      }),
    );
  } catch (err) {
    publishWarningFromError(
      { bus: wctx.bus, phase: state.phase },
      'failed to persist bundle application evidence',
      err,
    );
  }
}

/** A checkout attempt is put back before recovery; an isolated attempt keeps its partial output. */
export async function raiseApiApplyRecovery(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  result: Extract<BundleApplyResult, { status: 'partial' | 'failed' }>;
  workspace: AttemptWorkspace;
}): Promise<WorkflowState> {
  const { wctx, state, task, result, workspace } = opts;
  const workspacePath = workspace.projectDir;
  const inPlace = state.workspace?.kind === 'checkout';
  if (inPlace) {
    await workspace.revert(await workspace.changedFiles());
  }
  const landed = result.applied.map((file) => file.path).join(', ');
  const message =
    result.status === 'partial'
      ? `${task.id}: the response stopped at ${result.failedPath} after applying ${landed}; ${inPlace ? 'partial changes put back in your checkout' : 'partial changes kept in the run workspace'}, and the brief did not advance (${result.error})`
      : inPlace
        ? `${task.id}: the outcome of writing ${result.failedPath} was uncertain; the attempt changes were put back in your checkout (${result.error})`
        : `${task.id}: the outcome of writing ${result.failedPath} is uncertain in the run workspace; reconcile this file before continuing (${result.error})`;
  publishError({ bus: wctx.bus, phase: state.phase, message });
  return raisePendingRecovery(
    wctx,
    state,
    createRecoveryIssue({
      reason: 'implementation-error',
      phase: state.phase,
      seat: 'build',
      task,
      files: [...result.applied.map((file) => file.path), result.failedPath],
      affectedTaskIds: [task.id],
      message,
      details: [
        inPlace
          ? `The partial writes were put back to the attempt start in your checkout. The replaced bytes are in ${revertedDir(wctx)}.`
          : `The partial writes stay in the run workspace at ${workspacePath}; the checkout is unchanged.`,
      ],
      facts: { apiApplyIncomplete: true, workspacePath },
      availableActions: ['retry-same-worker', 'skip-current-task', 'end-run'],
      recommendedAction: 'retry-same-worker',
      createdAt: nowIso(),
    }),
  );
}

export function persistRejectionEvidence(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  reason: string;
  actionClass: ActionClass;
  tier: 'sticky' | 'confirm';
  actionDescription: string;
  taskId?: TaskId | undefined;
}): void {
  const { wctx, state, reason, actionClass, tier, actionDescription, taskId } = opts;
  try {
    mutateEvidenceLedger(wctx, (existing) => {
      const ledger = existing ?? getOrCreateLedger({ ref: wctx, state });
      return recordRejectionEvidence({
        ledger,
        tier,
        actionClass,
        actionDescription,
        ...(taskId !== undefined && { taskId }),
        reason,
      });
    });
  } catch {
    // non-fatal: rejection evidence loss is acceptable vs crashing
  }
}

/** Appends one review to the ledger; a lost entry warns and never fails the review. */
export function persistReviewEvidence(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'bus'>;
  state: WorkflowState;
  review: EvidenceReview;
}): void {
  const { wctx, state, review } = opts;
  try {
    mutateEvidenceLedger(wctx, (existing) => {
      const ledger = existing ?? getOrCreateLedger({ ref: wctx, state });
      return { ...ledger, reviews: [...(ledger.reviews ?? []), review], generatedAt: nowIso() };
    });
  } catch (err) {
    publishWarningFromError(
      { bus: wctx.bus, phase: state.phase },
      'failed to persist review evidence',
      err,
    );
  }
}

export function persistApprovalEvidence(opts: {
  wctx: Pick<WorkflowContext, 'projectDir' | 'sessionId' | 'config' | 'bus'>;
  state: WorkflowState;
  decision: GateDecision;
  taskId?: TaskId | undefined;
}): void {
  const { wctx, state, decision, taskId } = opts;
  const confirmApprovals = decision.confirmApprovals;
  if (!confirmApprovals || confirmApprovals.length === 0) return;
  try {
    mutateEvidenceLedger(wctx, (existing) => {
      let ledger = existing ?? getOrCreateLedger({ ref: wctx, state });
      for (const approval of confirmApprovals) {
        ledger = recordApprovalEvidence({
          ledger,
          tier: approval.tier,
          actionClass: approval.actionClass,
          actionDescription: approval.actionDescription,
          ...(taskId !== undefined && { taskId }),
          reason: approval.reason,
        });
      }
      return ledger;
    });
  } catch (err) {
    publishWarningFromError(
      { bus: wctx.bus, phase: state.phase },
      'failed to persist approval evidence',
      err,
    );
  }
}
