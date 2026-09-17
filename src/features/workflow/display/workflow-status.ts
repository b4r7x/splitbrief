import type { RailHalt } from '../../../core/rail-stages.js';
import type { LifecycleState } from '../../../stores/workflow/lifecycle.js';

export type WorkflowDisplayKind = 'working' | 'waiting' | 'stopped';

export interface WorkflowDisplayProjection {
  kind: WorkflowDisplayKind;
  animate: boolean;
  halted?: RailHalt | undefined;
}

/** One status projection for every workflow chrome surface. */
export function deriveWorkflowDisplay(input: {
  status: LifecycleState['status'];
  cancelled: boolean;
  pendingQuestion: boolean;
  pendingRecovery: boolean;
  pendingApproval: boolean;
}): WorkflowDisplayProjection {
  if (input.pendingRecovery) return { kind: 'waiting', animate: false, halted: 'failed' };
  if (input.pendingQuestion || input.pendingApproval) return { kind: 'waiting', animate: false };
  if (input.status === 'running' && !input.cancelled) return { kind: 'working', animate: true };
  if (input.cancelled || input.status === 'cancelled') {
    return { kind: 'stopped', animate: false, halted: 'cancelled' };
  }
  return { kind: 'stopped', animate: false };
}
