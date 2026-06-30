import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishWarningFromError } from '../events.js';
import {
  createEvidenceLedger,
  mutateEvidenceLedger,
  readEvidenceLedger,
} from '../../../core/evidence/ledger.js';
import {
  recordLocalTaskEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
} from './task.js';
import { recordApprovalEvidence, recordRejectionEvidence } from './approval.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import type { ValidationResult } from '../validation-result.js';
import type {
  ActionClass,
  TaskCompletionMethod,
  TaskStatus,
  WorkflowMode,
} from '../../../core/schemas/enums.js';
import { hashTaskBrief } from '../../brief-hash.js';
import type { GateDecision } from '../approval/tiered-approval.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import type { SessionRef } from '../../../core/types/session-ref.js';

export function getOrCreateLedger(opts: {
  ref: SessionRef;
  state: WorkflowState;
  mode?: WorkflowMode | undefined;
}): EvidenceLedger {
  const { ref, state, mode } = opts;
  const existing = readEvidenceLedger(ref);
  const briefHash = hashTaskBrief(state.tasks);
  return (
    existing ??
    createEvidenceLedger({
      sessionId: ref.sessionId,
      feature: state.feature,
      mode: mode ?? DEFAULT_WORKFLOW_MODE,
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
    validation?: ValidationResult[] | undefined;
    escalated?: boolean | undefined;
    reason?: string | undefined;
    changedFiles?: string[] | undefined;
  };
}): void {
  const { wctx, state, task, recordKind, details } = opts;
  try {
    const briefHash = hashTaskBrief(state.tasks);
    mutateEvidenceLedger(wctx, (existing) => {
      const ledger =
        existing ?? getOrCreateLedger({ ref: wctx, state, mode: wctx.config.workflow.mode });
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
      const ledger =
        existing ?? getOrCreateLedger({ ref: wctx, state, mode: wctx.config.workflow.mode });
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
  wctx: WorkflowContext;
  state: WorkflowState;
  decision: GateDecision;
  taskId?: TaskId | undefined;
}): void {
  const { wctx, state, decision, taskId } = opts;
  const confirmApprovals = decision.confirmApprovals;
  if (!confirmApprovals || confirmApprovals.length === 0) return;
  try {
    mutateEvidenceLedger(wctx, (existing) => {
      let ledger =
        existing ?? getOrCreateLedger({ ref: wctx, state, mode: wctx.config.workflow.mode });
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
