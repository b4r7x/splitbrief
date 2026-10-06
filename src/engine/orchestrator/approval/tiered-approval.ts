import type { TieredApprovalRequest } from '../../../core/approval/types.js';
import { classifyAction, isProtectedClass } from './action-classifier.js';
import { gateConfirmTier } from './confirm.js';
import { taskDeclaredPatterns } from '../../../core/scope/declared-set.js';
import type { GateActionInput, GateDecision } from './types.js';

export async function gateAction(input: GateActionInput): Promise<GateDecision> {
  const { actionDescription, task, dependsOnFiles, projectDir, phase, taskId, config } = input;

  const classified = classifyAction({
    actionDescription,
    targetPath: input.targetPath,
    taskFiles: task.suggestedFiles,
    taskInBounds: taskDeclaredPatterns(task),
    dependsOnFiles,
    projectDir,
    allowedPaths: config.approval?.allowedPaths,
  });
  const protectedWrite = isProtectedClass(classified.actionClass);
  const actionClass = classified.actionClass;
  const tier = protectedWrite ? 'confirm' : classified.tier;

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
  return gateConfirmTier({ input, request, actionClass });
}
