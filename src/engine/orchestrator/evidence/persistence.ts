import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishWarningFromError } from '../events.js';
import {
  createEvidenceLedger,
  readEvidenceLedger,
  writeEvidenceLedger,
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

export function getOrCreateLedger(
  projectDir: string,
  sessionId: string,
  state: WorkflowState,
  mode?: WorkflowMode,
): EvidenceLedger {
  const existing = readEvidenceLedger(projectDir, sessionId);
  const briefHash = hashTaskBrief(state.tasks);
  return (
    existing ??
    createEvidenceLedger({
      sessionId,
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
    const ledger = getOrCreateLedger(
      wctx.projectDir,
      wctx.sessionId,
      state,
      wctx.config.workflow.mode,
    );
    let updated = ledger;
    if (recordKind === 'local') {
      updated = recordLocalTaskEvidence({
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
    } else if (recordKind === 'retry') {
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
      updated = recordRetryOrEscalationEvidence({
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
    } else {
      updated = recordSkippedTaskEvidence({
        ledger,
        task,
        reason: details.reason ?? 'skipped',
        briefHash,
      });
    }
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, updated);
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
    const ledger = getOrCreateLedger(
      wctx.projectDir,
      wctx.sessionId,
      state,
      wctx.config.workflow.mode,
    );
    const updated = recordRejectionEvidence({
      ledger,
      tier,
      actionClass,
      actionDescription,
      ...(taskId !== undefined && { taskId }),
      reason,
    });
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, updated);
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
  if (!decision.confirmApprovals || decision.confirmApprovals.length === 0) return;
  try {
    let ledger = getOrCreateLedger(
      wctx.projectDir,
      wctx.sessionId,
      state,
      wctx.config.workflow.mode,
    );
    for (const approval of decision.confirmApprovals) {
      ledger = recordApprovalEvidence({
        ledger,
        tier: approval.tier,
        actionClass: approval.actionClass,
        actionDescription: approval.actionDescription,
        ...(taskId !== undefined && { taskId }),
        reason: approval.reason,
      });
    }
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, ledger);
  } catch (err) {
    publishWarningFromError(
      { bus: wctx.bus, phase: state.phase },
      'failed to persist approval evidence',
      err,
    );
  }
}
