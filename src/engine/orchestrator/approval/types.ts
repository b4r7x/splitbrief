import type { Config, ApprovalTier } from '../../../core/schemas/config.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { ApprovalGrant } from '../../../core/schemas/approval-store.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';

export function isConfiguredHeadless(config: Config): boolean {
  return config.approval?.headless === true;
}

export type GateActionInput = {
  actionDescription: string;
  task: Task;
  dependsOnFiles: string[];
  projectDir: string;
  sessionId: string;
  phase: Phase;
  taskId?: TaskId;
  bus: EventBus;
  callbacks: OrchestratorCallbacks;
  config: Config;
  getApprovalEnabled?: (() => boolean) | undefined;
  grants?: ApprovalGrant[];
};

export type GateDecision = {
  allow: boolean;
  reason?: string;
  tier?: ApprovalTier;
  actionClass?: ActionClass;
  actionDescription?: string;
  confirmReason?: string;
  confirmApprovals?: Array<{
    tier: 'confirm';
    actionClass: ActionClass;
    actionDescription: string;
    reason: string;
  }>;
};
