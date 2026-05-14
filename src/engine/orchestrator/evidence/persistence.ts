import { join } from 'node:path';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { publishWarningFromError } from '../events.js';
import { createEvidenceLedger } from './ledger.js';
import { recordLocalTaskEvidence, recordRetryOrEscalationEvidence, recordSkippedTaskEvidence } from './task-evidence.js';
import { recordApprovalEvidence, recordRejectionEvidence } from './approval-evidence.js';
import { DEFAULT_WORKFLOW_MODE } from '../../../core/schemas/config.js';
import type { ValidationResult } from '../validation.js';
import type { ActionClass, TaskCompletionMethod, TaskStatus, WorkflowMode } from '../../../core/schemas/enums.js';
import { hashTaskBrief } from '../../../core/brief-hash.js';
import type { GateDecision } from '../approval/tiered-approval.js';
import type { EvidenceLedger } from '../../../core/schemas/evidence.js';
import { EvidenceLedgerSchema } from '../../../core/schemas/evidence.js';
import { EVIDENCE_FILE, sessionDir } from '../../../core/paths.js';
import { readJsonSafe, writeSecureFile } from '../../../lib/fs.js';

export function evidenceLedgerPath(projectDir: string, sessionId: string): string {
  return join(sessionDir(projectDir, sessionId), EVIDENCE_FILE);
}

export function writeEvidenceLedger(projectDir: string, sessionId: string, ledger: EvidenceLedger): void {
  writeSecureFile(evidenceLedgerPath(projectDir, sessionId), `${JSON.stringify(ledger, null, 2)}\n`);
}

export function readEvidenceLedger(projectDir: string, sessionId: string): EvidenceLedger | null {
  const raw = readJsonSafe(evidenceLedgerPath(projectDir, sessionId));
  if (raw === null) return null;
  const result = EvidenceLedgerSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function getOrCreateLedger(projectDir: string, sessionId: string, state: WorkflowState, mode?: WorkflowMode): EvidenceLedger {
  const existing = readEvidenceLedger(projectDir, sessionId);
  const briefHash = hashTaskBrief(state.tasks);
  return existing ?? createEvidenceLedger({ sessionId, feature: state.feature, mode: mode ?? DEFAULT_WORKFLOW_MODE, tasks: state.tasks, briefHash });
}

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
    const briefHash = hashTaskBrief(state.tasks);
    const ledger = getOrCreateLedger(wctx.projectDir, wctx.sessionId, state, wctx.config.workflow.mode);
    let updated = ledger;
    if (recordKind === 'local') {
      updated = recordLocalTaskEvidence({ ledger, task, status: details.status, method: details.method, retries: details.retries, durationMs: details.durationMs, validation: details.validation ?? [], changedFiles: details.changedFiles, briefHash, validationRetryState: details.status === 'failed' ? 'failed' : undefined });
    } else if (recordKind === 'retry') {
      updated = recordRetryOrEscalationEvidence({ ledger, task, status: details.status, method: details.method, retries: details.retries, durationMs: details.durationMs, validation: details.validation, escalated: details.escalated ?? false, changedFiles: details.changedFiles, briefHash, validationRetryState: details.escalated ? 'escalated' : details.status === 'failed' ? 'failed' : 'initial-failure' });
    } else {
      updated = recordSkippedTaskEvidence({ ledger, task, reason: details.reason ?? 'skipped', briefHash });
    }
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, updated);
  } catch (err) {
    publishWarningFromError(wctx.bus, state.phase, 'failed to persist evidence ledger', err);
  }
}

export function persistRejectionEvidence(
  wctx: WorkflowContext,
  state: WorkflowState,
  reason: string,
  actionClass: ActionClass,
  tier: 'sticky' | 'confirm',
  actionDescription: string,
  taskId?: TaskId,
): void {
  try {
    const ledger = getOrCreateLedger(wctx.projectDir, wctx.sessionId, state, wctx.config.workflow.mode);
    const updated = recordRejectionEvidence({ ledger, tier, actionClass, actionDescription, ...(taskId !== undefined && { taskId }), reason });
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
    let ledger = getOrCreateLedger(wctx.projectDir, wctx.sessionId, state, wctx.config.workflow.mode);
    for (const approval of decision.confirmApprovals) {
      ledger = recordApprovalEvidence({ ledger, tier: approval.tier, actionClass: approval.actionClass, actionDescription: approval.actionDescription, ...(taskId !== undefined && { taskId }), reason: approval.reason });
    }
    writeEvidenceLedger(wctx.projectDir, wctx.sessionId, ledger);
  } catch (err) {
    publishWarningFromError(wctx.bus, state.phase, 'failed to persist approval evidence', err);
  }
}
