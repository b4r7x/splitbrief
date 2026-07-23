import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import { CONFIRM_PHRASE } from '../../../core/approval/types.js';
import {
  publishApprovalGranted,
  publishApprovalPrompted,
  publishApprovalRejected,
} from './events.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import { isConfiguredHeadless, type GateActionInput, type GateDecision } from './types.js';

export type ConfirmTierInput = {
  input: GateActionInput;
  request: TieredApprovalRequest;
  actionClass: ActionClass;
};

export async function gateConfirmTier(args: ConfirmTierInput): Promise<GateDecision> {
  const { input, request, actionClass } = args;
  const { actionDescription, phase, taskId, bus, callbacks, config } = input;
  const tier = 'confirm' as const;

  publishApprovalPrompted({ bus, phase, tier, actionClass, taskId });

  if (!callbacks.onTieredApproval || isConfiguredHeadless(config)) {
    publishApprovalRejected({
      bus,
      phase,
      tier,
      actionClass,
      taskId,
      reason: 'APPROVAL_REQUIRED',
    });
    return { allow: false, reason: 'APPROVAL_REQUIRED', tier, actionClass, actionDescription };
  }

  const response = await callbacks.onTieredApproval(request);

  if (response.decision === 'confirm') {
    if (response.phrase !== CONFIRM_PHRASE || !response.reason) {
      publishApprovalRejected({
        bus,
        phase,
        tier,
        actionClass,
        taskId,
        reason: 'invalid_confirm_phrase',
      });
      return {
        allow: false,
        reason: 'invalid_confirm_phrase',
        tier,
        actionClass,
        actionDescription,
      };
    }
    publishApprovalGranted({
      bus,
      phase,
      tier,
      actionClass,
      taskId,
      scope: 'once',
      confirmReason: response.reason,
    });
    return {
      allow: true,
      tier,
      actionClass,
      actionDescription,
      confirmReason: response.reason,
      confirmApprovals: [{ tier, actionClass, actionDescription, reason: response.reason }],
    };
  }

  if (response.decision === 'deny') {
    publishApprovalRejected({ bus, phase, tier, actionClass, taskId, reason: response.reason });
    return { allow: false, reason: response.reason, tier, actionClass, actionDescription };
  }

  publishApprovalRejected({
    bus,
    phase,
    tier,
    actionClass,
    taskId,
    reason: 'invalid_confirm_response',
  });
  return {
    allow: false,
    reason: 'invalid_confirm_response',
    tier,
    actionClass,
    actionDescription,
  };
}
