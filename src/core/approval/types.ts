import type { ApprovalTier } from '../schemas/config.js';
import type { ActionClass } from '../schemas/approval-store.js';
import type { Phase } from '../schemas/enums.js';
import type { TaskId } from '../schemas/task.js';

export type TieredApprovalRequest = {
  tier: ApprovalTier;
  actionClass: ActionClass;
  actionDescription: string;
  taskId?: TaskId;
  phase: Phase;
};

export type TieredApprovalResponse =
  | { decision: 'allow'; scope: 'once' | 'session' | 'always' }
  | { decision: 'deny'; reason: string }
  | { decision: 'confirm'; phrase: string; reason: string };
