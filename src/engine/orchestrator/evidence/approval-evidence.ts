import type { TaskId } from '../../../core/schemas/task.js';
import type {
  EvidenceLedger,
  EvidenceApproval,
  EvidenceRejection,
} from '../../../core/schemas/evidence.js';
import { withAppendedApproval, withAppendedRejection } from './ledger.js';

export type RecordRejectionEvidenceInput = {
  ledger: EvidenceLedger;
  tier: 'sticky' | 'confirm';
  actionClass: EvidenceRejection['actionClass'];
  actionDescription: string;
  taskId?: TaskId;
  reason: string;
};

export type RecordApprovalEvidenceInput = {
  ledger: EvidenceLedger;
  tier: 'confirm';
  actionClass: EvidenceApproval['actionClass'];
  actionDescription: string;
  taskId?: TaskId;
  reason: string;
};

export function recordApprovalEvidence(input: RecordApprovalEvidenceInput): EvidenceLedger {
  const entry: EvidenceApproval = {
    ts: new Date().toISOString(),
    tier: input.tier,
    actionClass: input.actionClass,
    actionDescription: input.actionDescription,
    ...(input.taskId !== undefined && { taskId: input.taskId }),
    reason: input.reason,
  };
  return withAppendedApproval(input.ledger, entry);
}

export function recordRejectionEvidence(input: RecordRejectionEvidenceInput): EvidenceLedger {
  const entry: EvidenceRejection = {
    ts: new Date().toISOString(),
    tier: input.tier,
    actionClass: input.actionClass,
    actionDescription: input.actionDescription,
    ...(input.taskId !== undefined && { taskId: input.taskId }),
    reason: input.reason,
  };
  return withAppendedRejection(input.ledger, entry);
}
