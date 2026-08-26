import type { ApprovalTier } from '../schemas/config.js';
import type { ActionClass } from '../schemas/enums.js';
import type { Phase } from '../schemas/enums.js';
import type { TaskId } from '../schemas/task.js';

export const CONFIRM_PHRASE = 'I confirm';

export type TieredApprovalRequest = {
  tier: ApprovalTier;
  actionClass: ActionClass;
  actionDescription: string;
  taskId?: TaskId | undefined;
  phase: Phase;
};

export type TieredApprovalResponse =
  | { decision: 'allow'; scope: 'once' | 'session' | 'always' }
  | { decision: 'deny'; reason: string }
  | { decision: 'confirm'; phrase: string; reason: string };

export type ApprovalReviewResult =
  | { approved: true; action?: undefined; comment?: undefined }
  | { approved: false; action: 'edit'; comment?: string | undefined }
  | { approved: false; action: 'revise'; comment: string; taskIds?: TaskId[] | undefined }
  | { approved: false; action?: undefined; comment?: undefined };
