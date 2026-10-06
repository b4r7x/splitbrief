import type { ApproveLevel, WorkflowMode } from '../schemas/enums.js';

/**
 * Whether an old run's planner steps opened the plan gate: quick mode never did, the others only
 * at `plan`.
 */
export function opensPlanGate(mode: WorkflowMode, approveLevel: ApproveLevel): boolean {
  return mode !== 'quick' && approveLevel === 'plan';
}
