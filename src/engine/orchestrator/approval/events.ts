import type { Phase } from '../../../core/schemas/enums.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { ApprovalTier } from '../../../core/schemas/config.js';
import type { TaskId } from '../../../core/schemas/task.js';
import type { EventBus } from '../../events/types.js';

export type ApprovalEventBase = {
  bus: EventBus;
  phase: Phase;
  tier: ApprovalTier;
  actionClass: ActionClass;
  taskId?: TaskId | undefined;
};

export function publishApprovalRejected(args: ApprovalEventBase & { reason: string }): void {
  const { bus, phase, tier, actionClass, taskId, reason } = args;
  bus.publish({
    type: 'approval_rejected',
    ts: Date.now(),
    phase,
    tier,
    actionClass,
    ...(taskId !== undefined && { taskId }),
    reason,
  });
}

export function publishApprovalGranted(
  args: ApprovalEventBase & {
    scope: 'once' | 'session' | 'always';
    confirmReason?: string | undefined;
  },
): void {
  const { bus, phase, tier, actionClass, taskId, scope, confirmReason } = args;
  bus.publish({
    type: 'approval_granted',
    ts: Date.now(),
    phase,
    tier,
    actionClass,
    ...(taskId !== undefined && { taskId }),
    scope,
    ...(confirmReason !== undefined && { confirmReason }),
  });
}

export function publishApprovalPrompted(args: ApprovalEventBase): void {
  const { bus, phase, tier, actionClass, taskId } = args;
  bus.publish({
    type: 'approval_prompted',
    ts: Date.now(),
    phase,
    tier,
    actionClass,
    ...(taskId !== undefined && { taskId }),
  });
}
