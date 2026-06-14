import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { raisePendingRecovery } from '../state-ops.js';
import { publishUserEditConflict } from '../events.js';
import { createApprovalPromotionConflict } from '../user-edit/conflicts.js';
import { buildApprovalPromotionConflictRecoveryIssue } from '../recovery/builders/workflow.js';
import { nowIso } from '../../../utils/format-time.js';

export async function handleApprovalTimeUserEditConflict(opts: {
  ctx: WorkflowContext;
  state: WorkflowState;
  task: Task;
  files: string[];
  setTrackedState?: ((s: WorkflowState) => void) | undefined;
}): Promise<WorkflowState> {
  const conflict = createApprovalPromotionConflict({
    files: opts.files,
    currentTaskId: opts.task.id,
  });
  publishUserEditConflict({ bus: opts.ctx.bus, phase: opts.state.phase }, conflict, 'pause');
  const issue = buildApprovalPromotionConflictRecoveryIssue({
    conflict,
    currentTask: opts.task,
    phase: opts.state.phase,
    createdAt: nowIso(),
  });
  return raisePendingRecovery(opts.ctx, opts.state, issue, opts.setTrackedState);
}
