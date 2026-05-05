import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { getOrCreateLedger, writeEvidenceLedger } from '../evidence/persistence.js';
import { recordApprovalEvidence, recordRejectionEvidence } from '../evidence/approval-evidence.js';
import type { GateDecision } from '../approval/tiered-approval.js';
import type { EscalationContext } from './types.js';

export function persistRetryApprovalEvidence(
  ctx: EscalationContext,
  state: WorkflowState,
  task: Task,
  decision: GateDecision,
): void {
  if (!decision.confirmApprovals || decision.confirmApprovals.length === 0) return;
  try {
    let ledger = getOrCreateLedger(ctx.projectDir, ctx.sessionId, state, ctx.config.workflow.mode);
    for (const approval of decision.confirmApprovals) {
      ledger = recordApprovalEvidence({
        ledger,
        tier: approval.tier,
        actionClass: approval.actionClass,
        actionDescription: approval.actionDescription,
        taskId: task.id,
        reason: approval.reason,
      });
    }
    writeEvidenceLedger(ctx.projectDir, ctx.sessionId, ledger);
  } catch {
    // Approval evidence is best-effort; the approval decision already allowed the retry.
  }
}

export function persistRetryRejectionEvidence(
  ctx: EscalationContext,
  state: WorkflowState,
  task: Task,
  decision: GateDecision,
): void {
  const rejectedTier = decision.tier;
  if (!rejectedTier || rejectedTier === 'auto' || !decision.actionClass || !decision.actionDescription) return;
  try {
    const ledger = getOrCreateLedger(ctx.projectDir, ctx.sessionId, state, ctx.config.workflow.mode);
    const updated = recordRejectionEvidence({
      ledger,
      tier: rejectedTier,
      actionClass: decision.actionClass,
      actionDescription: decision.actionDescription,
      taskId: task.id,
      reason: decision.reason ?? 'denied',
    });
    writeEvidenceLedger(ctx.projectDir, ctx.sessionId, updated);
  } catch {
    // Rejection evidence is best-effort; the approval decision already blocked the task.
  }
}
