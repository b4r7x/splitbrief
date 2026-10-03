import type { Config } from '../../../core/schemas/config.js';
import type { ApprovalTier } from '../../../core/approval/types.js';
import type { Task, TaskId } from '../../../core/schemas/task.js';
import type { Phase } from '../../../core/schemas/enums.js';
import type { ActionClass } from '../../../core/schemas/enums.js';
import type { OrchestratorCallbacks } from '../types.js';
import type { EventBus } from '../../events/types.js';

export type GateActionInput = {
  actionDescription: string;
  targetPath: string;
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
