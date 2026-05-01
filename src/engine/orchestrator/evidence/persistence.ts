import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { toErrorMessage } from '../../../utils/format-errors.js';
import { publishWarning } from '../events.js';
import {
  createEvidenceLedger,
  readEvidenceLedger,
  recordApprovalEvidence,
  recordLocalTaskEvidence,
  recordRejectionEvidence,
  recordRetryOrEscalationEvidence,
  recordSkippedTaskEvidence,
  writeEvidenceLedger,
} from './evidence.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import type { ValidationResult } from '../validation.js';
import type { TaskCompletionMethod, TaskStatus } from '../../../core/schemas/enums.js';
import { hashTaskBrief } from '../../../core/brief-hash.js';
import type { GateDecision } from '../approval/tiered-approval.js';

export function persistTaskEvidence(
  wctx: WorkflowContext,
  state: WorkflowState,
  task: Task,
  recordKind: 'local' | 'retry' | 'skipped',
  details: {
    status: TaskStatus;
    method?: TaskCompletionMethod | undefined;
    retries?: number | undefined;
    durationMs?: number | undefined;
    validation?: ValidationResult[] | undefined;
    escalated?: boolean | undefined;
    reason?: string | undefined;
    changedFiles?: string[] | undefined;
  },
): void {
  try {
    const existing = readEvidenceLedger(wctx.projectDir, wctx.sessionId);
    const briefHash = hashTaskBrief(state.tasks);
    const ledger = existing ?? createEvidenceLedger({
      sessionId: wctx.sessionId,
      feature: state.feature,
      mode: wctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
      briefHash,
    });
    let updated = ledger;
    if (recordKind === 'local') {
      updated = recordLocalTaskEvidence({
        ledger, task,
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
      updated = recordRetryOrEscalationEvidence({
        ledger, task,
        status: details.status,
        method: details.method,
        retries: details.retries,
        durationMs: details.durationMs,
        validation: details.validation,
        escalated: details.escalated ?? false,
        changedFiles: details.changedFiles,
        briefHash,
        validationRetryState: details.escalated ? 'escalated' : details.status === 'failed' ? 'failed' : 'initial-failure',
      });
    } else {
      updated = recordSkippedTaskEvidence({
        ledger, task, reason: details.reason ?? 'skipped', briefHash,
      });
    }
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, updated);
  } catch (err) {
    publishWarning(wctx.bus, state.phase, `failed to persist evidence ledger: ${toErrorMessage(err)}`);
  }
}

export function persistRejectionEvidence(
  wctx: WorkflowContext,
  state: WorkflowState,
  reason: string,
  actionClass: import('../../../core/schemas/enums.js').ActionClass,
  tier: 'sticky' | 'confirm',
  actionDescription: string,
  taskId?: TaskId,
): void {
  try {
    const existing = readEvidenceLedger(wctx.projectDir, wctx.sessionId);
    const briefHash = hashTaskBrief(state.tasks);
    const ledger = existing ?? createEvidenceLedger({
      sessionId: wctx.sessionId,
      feature: state.feature,
      mode: wctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
      briefHash,
    });
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

export function persistApprovalEvidence(
  wctx: WorkflowContext,
  state: WorkflowState,
  decision: GateDecision,
  taskId?: TaskId,
): void {
  if (!decision.confirmApprovals || decision.confirmApprovals.length === 0) return;
  try {
    const existing = readEvidenceLedger(wctx.projectDir, wctx.sessionId);
    const briefHash = hashTaskBrief(state.tasks);
    let ledger = existing ?? createEvidenceLedger({
      sessionId: wctx.sessionId,
      feature: state.feature,
      mode: wctx.config.workflow.mode ?? DEFAULT_WORKFLOW_MODE,
      tasks: state.tasks,
      briefHash,
    });
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
    publishWarning(wctx.bus, state.phase, `failed to persist approval evidence: ${toErrorMessage(err)}`);
  }
}
