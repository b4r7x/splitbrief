import type { WorkflowState } from '../../../core/schemas/workflow.js';
import { RecoveryResultV1Schema } from '../../../core/schemas/brief-recovery.js';
import type { BriefQualityRunResult } from '../planning/brief-quality-run.js';
import type { PhaseRecoveryBinding } from './phases.js';

export function stateAfterRecovery(
  state: WorkflowState,
  recovery: PhaseRecoveryBinding,
): WorkflowState {
  try {
    return recovery.readState();
  } catch {
    // Keep the state already supplied by the owner when its refresh seam fails.
  }
  return state;
}

export function applyBriefQualityResult(
  recovery: PhaseRecoveryBinding,
  result: BriefQualityRunResult,
): void {
  recovery.projection = result.projection;
  recovery.authority = {
    ...recovery.authority,
    stateRevision: result.projection.stateRevision,
  };
  const parsed = RecoveryResultV1Schema.safeParse(result.recovery);
  if (parsed.success) recovery.admission = parsed.data;
}
