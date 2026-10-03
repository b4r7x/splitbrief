import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
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
  recordPromotedFilesEvidence,
  recordPromotionFailureEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
} from './task.js';
import type { BundleApplyResult } from '../../implementers/file-bundle.js';
import { recordApprovalEvidence, recordRejectionEvidence } from './approval.js';
import type { ValidationResult } from '../validation/result.js';
import type { ActionClass, TaskCompletionMethod, TaskStatus } from '../../../core/schemas/enums.js';
import { hashTaskBrief } from '../../brief-hash.js';
import type { GateDecision } from '../approval/types.js';
import type {
  EvidenceLedger,
  EvidencePromotedFile,
  EvidencePromotionAttempt,
  EvidenceValidationEntry,
} from '../../../core/schemas/evidence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';
import { isInDeclaredSet, taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import type { EventBus } from '../../events/types.js';

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

export function persistTaskEvidence(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  recordKind: 'local' | 'retry' | 'skipped';
  details: {
    status: TaskStatus;
    method?: TaskCompletionMethod | undefined;
    retries?: number | undefined;
    durationMs?: number | undefined;
    initialValidation?: ValidationResult[] | undefined;
    initialChangedFiles?: string[] | undefined;
    initialExemptStages?: readonly EvidenceValidationEntry['stage'][] | undefined;
    validation?: ValidationResult[] | undefined;
    escalated?: boolean | undefined;
    reason?: string | undefined;
    changedFiles?: string[] | undefined;
    exemptStages?: readonly EvidenceValidationEntry['stage'][] | undefined;
  };
}): void {
  const { wctx, state, task, recordKind, details } = opts;
  try {
    const briefHash = hashTaskBrief(state.tasks);
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
          validation: details.validation ?? [],
          changedFiles: details.changedFiles,
          briefHash,
          validationRetryState: details.status === 'failed' ? 'failed' : undefined,
          exemptStages: details.exemptStages,
        });
      }
      if (recordKind === 'retry') {
        let updated = ledger;
        if (details.initialValidation && details.initialValidation.length > 0) {
          updated = recordRetryOrEscalationEvidence({
            ledger: updated,
            task,
            status: details.status,
            method: details.method,
            retries: details.retries,
            durationMs: details.durationMs,
            validation: details.initialValidation,
            escalated: details.escalated ?? false,
            changedFiles: details.initialChangedFiles,
            briefHash,
            validationRetryState: 'initial-failure',
            exemptStages: details.initialExemptStages,
          });
        }
        return recordRetryOrEscalationEvidence({
          ledger: updated,
          task,
          status: details.status,
          method: details.method,
          retries: details.retries,
          durationMs: details.durationMs,
          validation: details.validation,
          escalated: details.escalated ?? false,
          changedFiles: details.changedFiles,
          briefHash,
          validationRetryState: details.escalated
            ? 'escalated'
            : details.status === 'failed'
              ? 'failed'
              : undefined,
          exemptStages: details.exemptStages,
        });
      }
      return recordSkippedTaskEvidence({
        ledger,
        task,
        reason: details.reason ?? 'skipped',
        briefHash,
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
 * §6: the bundle's receipt is written before the attempt's own outcome is
 * handled, so a brief that stops mid-application still leaves the applied prefix
 * on the record. A write that fails is a warning rather than a halt: the next
 * attempt then finds no proof of ownership and parks, which is the safe answer.
 */
export function persistApiApplyEvidence(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  result: BundleApplyResult;
  workspacePath?: string | undefined;
}): void {
  const { wctx, state, task, result } = opts;
  try {
    mutateEvidenceLedger(wctx, (existing) =>
      recordApiApplyEvidence({
        ledger: existing ?? getOrCreateLedger({ ref: wctx, state }),
        task,
        result,
        workspacePath: opts.workspacePath,
        briefHash: hashTaskBrief(state.tasks),
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

/** Stop on a known partial apply or an uncertain write without erasing its workspace. */
export function raiseApiApplyRecovery(opts: {
  wctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  result: Extract<BundleApplyResult, { status: 'partial' | 'failed' }>;
  workspacePath?: string | undefined;
}): WorkflowState {
  const { wctx, state, task, result, workspacePath } = opts;
  const landed = result.applied.map((file) => file.path).join(', ');
  const location = workspacePath === undefined ? '' : ' in the retained worker workspace';
  const message =
    result.status === 'partial'
      ? `${task.id}: the response stopped at ${result.failedPath} after applying ${landed}; partial changes kept${location}, and the brief did not advance (${result.error})`
      : `${task.id}: the outcome of writing ${result.failedPath} is uncertain${location}; reconcile this file before continuing (${result.error})`;
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
      details:
        workspacePath === undefined
          ? ['Inspect the recorded changes before retrying. They have not been rolled back.']
          : [
              `Worker output is retained at ${workspacePath}. These writes were not promoted to the project.`,
            ],
      facts: {
        apiApplyIncomplete: true,
        ...(workspacePath === undefined ? {} : { workspacePath }),
      },
      availableActions: ['retry-same-worker', 'pause-run', 'end-run'],
      recommendedAction: 'pause-run',
      createdAt: nowIso(),
    }),
  );
}

/**
 * A partial promotion is the one evidence write whose loss cannot be a warning:
 * the caller has to know whether the applied prefix is durably recorded before
 * it decides what to do with the workspace, so the failure is returned.
 */
export function persistPromotionFailureEvidence(opts: {
  ref: SessionRef;
  state: WorkflowState;
  task: Task;
  attempt: EvidencePromotionAttempt;
}): { persisted: true } | { persisted: false; error: unknown } {
  const { ref, state, task, attempt } = opts;
  try {
    mutateEvidenceLedger(ref, (existing) =>
      recordPromotionFailureEvidence({
        ledger: existing ?? getOrCreateLedger({ ref, state }),
        task,
        attempt,
        briefHash: hashTaskBrief(state.tasks),
      }),
    );
    return { persisted: true };
  } catch (err) {
    return { persisted: false, error: err };
  }
}

/** Invalidate before a possible target write, so a lost new receipt cannot revive an old one. */
export function invalidateTargetWriteEvidence(opts: {
  ref: SessionRef;
  task: Task;
  files?: readonly string[];
}): void {
  const patterns = taskDeclaredPatterns(opts.task);
  const affected = (path: string) =>
    opts.files === undefined ? isInDeclaredSet(path, patterns) : opts.files.includes(path);
  const current = readEvidenceLedger(opts.ref);
  if (!current?.tasks.some((entry) => entry.promotedFiles?.some((file) => affected(file.path)))) {
    return;
  }
  // Failure propagates before the writer runs. The existing ledger lock keeps
  // unrelated evidence written since the first read intact.
  mutateEvidenceLedger(opts.ref, (existing) => {
    const ledger = existing ?? current;
    return {
      ...ledger,
      generatedAt: nowIso(),
      tasks: ledger.tasks.map((entry) =>
        entry.promotedFiles === undefined
          ? entry
          : {
              ...entry,
              promotedFiles: entry.promotedFiles.filter((file) => !affected(file.path)),
            },
      ),
    };
  });
}

/**
 * Persist the writer's receipt before validation. A persistence error remains
 * visible as a warning; no target read is used to reconstruct missing evidence.
 */
export function persistPromotedFilesEvidence(opts: {
  ref: SessionRef;
  bus: EventBus;
  state: WorkflowState;
  task: Task;
  files: EvidencePromotedFile[];
}): void {
  const { ref, bus, state, task, files } = opts;
  try {
    mutateEvidenceLedger(ref, (existing) =>
      recordPromotedFilesEvidence({
        ledger: existing ?? getOrCreateLedger({ ref, state }),
        task,
        files,
        briefHash: hashTaskBrief(state.tasks),
      }),
    );
  } catch (err) {
    publishWarningFromError({ bus, phase: state.phase }, 'failed to record promoted files', err);
  }
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
