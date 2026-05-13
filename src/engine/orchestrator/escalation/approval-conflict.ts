import type { Task } from '../../../core/schemas/task.js';
import type { WorkflowState } from '../../../core/schemas/workflow.js';
import type { WorkflowContext } from '../types.js';
import { transitionAndSave } from '../state-ops.js';
import { publishRecoveryPrompted, publishUserEditConflict } from '../events.js';
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
  publishUserEditConflict(opts.ctx.bus, opts.state.phase, conflict, 'pause');
  const issue = buildApprovalPromotionConflictRecoveryIssue({
    conflict,
    currentTask: opts.task,
    phase: opts.state.phase,
    createdAt: nowIso(),
  });
  const next = transitionAndSave(opts.ctx.projectDir, opts.ctx.sessionId, opts.state, { type: 'SET_PENDING_RECOVERY', issue });
  publishRecoveryPrompted(opts.ctx.bus, issue);
  opts.setTrackedState?.(next);
  return next;
}
