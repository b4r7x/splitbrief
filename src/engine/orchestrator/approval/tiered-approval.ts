import type { Config } from '../../../core/schemas/config.js';
import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import type { TierMap } from './action-classifier.js';
import { classifyAction } from './action-classifier.js';
import { ActionClassSchema } from '../../../core/schemas/enums.js';
import { error } from '../../../utils/error.js';
import { gateConfirmTier } from './confirm.js';
import { gateStickyTier } from './sticky.js';
import { taskScopePatterns } from '../task-scope.js';
import type { GateActionInput, GateDecision } from './types.js';

type ApprovalTierOverrides = NonNullable<Config['approval']>['tiers'];

function compactTierOverrides(rawTiers: ApprovalTierOverrides | undefined): TierMap | undefined {
  if (!rawTiers) return undefined;
  const tierOverrides: TierMap = {};
  for (const [key, tier] of Object.entries(rawTiers)) {
    const actionClass = ActionClassSchema.safeParse(key);
    if (actionClass.success && tier !== undefined) {
      tierOverrides[actionClass.data] = tier;
    }
  }
  return Object.keys(tierOverrides).length > 0 ? tierOverrides : undefined;
}

export async function gateAction(input: GateActionInput): Promise<GateDecision> {
  const {
    actionDescription,
    task,
    dependsOnFiles,
    projectDir,
    phase,
    taskId,
    config,
    getApprovalEnabled,
  } = input;

  if ((getApprovalEnabled ? getApprovalEnabled() : config.approval?.enabled !== false) === false) {
    return { allow: true };
  }

  const tierOverrides = compactTierOverrides(config.approval?.tiers);
  const { actionClass, tier } = classifyAction(
    {
      actionDescription,
      taskFile: task.file,
      taskInBounds: taskScopePatterns(task),
      dependsOnFiles,
      projectDir,
      allowedPaths: config.approval?.allowedPaths,
    },
    tierOverrides,
  );

  if (tier === 'auto') {
    return { allow: true };
  }

  const request: TieredApprovalRequest = {
    tier,
    actionClass,
    actionDescription,
    phase,
    ...(taskId !== undefined && { taskId }),
  };

  if (tier === 'sticky') {
    return gateStickyTier({ input, request, actionClass });
  }

  if (tier === 'confirm') {
    return gateConfirmTier({ input, request, actionClass });
  }

  tier satisfies never;
  throw error('approval-tier-unknown', 'unreachable: unknown approval tier');
}
