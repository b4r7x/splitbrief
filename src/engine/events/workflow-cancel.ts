export const WORKFLOW_CANCEL_REASONS = ['user_cancelled'] as const;
export const WORKFLOW_CANCEL_REASON_USER = WORKFLOW_CANCEL_REASONS[0];

export type WorkflowCancelReason = (typeof WORKFLOW_CANCEL_REASONS)[number];

export type WorkflowCancelledAbortReason = {
  type: 'workflow_cancelled';
  reason: WorkflowCancelReason;
};

export const WORKFLOW_USER_CANCELLED_ABORT_REASON = Object.freeze({
  type: 'workflow_cancelled',
  reason: WORKFLOW_CANCEL_REASON_USER,
} satisfies WorkflowCancelledAbortReason);

export function isWorkflowCancelledAbortReason(
  value: unknown,
): value is WorkflowCancelledAbortReason {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || !('reason' in value)) return false;
  return value.type === 'workflow_cancelled' && value.reason === WORKFLOW_CANCEL_REASON_USER;
}

export function workflowCancelledReasonFromSignal(
  signal: AbortSignal | undefined,
): WorkflowCancelReason | undefined {
  if (!signal?.aborted) return undefined;
  return isWorkflowCancelledAbortReason(signal.reason) ? signal.reason.reason : undefined;
}
