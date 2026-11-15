import { mutateEvidenceLedger } from '../../../core/evidence/ledger-storage.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { EvidenceReview } from '../../../core/schemas/evidence.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow/state.js';
import { nowIso } from '../../../utils/format/time.js';
import type { GateDecision } from '../approval/types.js';
import type { WorkflowContext } from '../types.js';
import { recordRejectionEvidence, recordApprovalEvidence } from './approval.js';
import { loadOrCreateLedger, warnEvidenceNotSaved } from './ledger.js';

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
      const ledger = existing ?? loadOrCreateLedger({ ref: wctx, state });
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
      const ledger = existing ?? loadOrCreateLedger({ ref: wctx, state });
      return { ...ledger, reviews: [...(ledger.reviews ?? []), review], generatedAt: nowIso() };
    });
  } catch (err) {
    warnEvidenceNotSaved(wctx, state.phase, err);
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
      let ledger = existing ?? loadOrCreateLedger({ ref: wctx, state });
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
    warnEvidenceNotSaved(wctx, state.phase, err);
  }
}
