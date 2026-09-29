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
  | {
      approved: false;
      action: 'revise';
      comment: string;
      taskIds?: TaskId[] | undefined;
      /** The continuation already recorded this correction as a user message. */
      recorded?: boolean | undefined;
    }
  | { approved: false; action: 'end-run'; comment?: undefined }
  // No decision: a superseded or torn-down prompt. The gate re-asks rather than
  // reading silence as an answer; only 'end-run' ends a run.
  | { approved: false; action?: undefined; comment?: undefined };
