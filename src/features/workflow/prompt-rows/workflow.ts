import type { ApprovalPromptState } from '../../../stores/approval-prompt/prompt.js';
import type { CostApprovalState } from '../../../stores/cost-approval/prompt.js';
import {
  getApprovalPromptRows,
  getReviewDocumentPromptRows,
  type ReviewArtifact,
} from './approval.js';
import { getCostApprovalPromptRows } from './cost.js';
import { getQuestionPromptRows } from './question.js';

export interface WorkflowPromptRowsInput {
  approvalState: ApprovalPromptState;
  costApprovalState: CostApprovalState;
  questionHint: string | null;
  /** Omitted by callers that measure a zone the document review panel never renders into. */
  reviewArtifact?: ReviewArtifact | null | undefined;
  cols: number;
}

export function getWorkflowPromptRows(input: WorkflowPromptRowsInput): number {
  const { approvalState, costApprovalState, questionHint, reviewArtifact, cols } = input;
  return (
    getApprovalPromptRows(approvalState, cols) +
    getCostApprovalPromptRows(costApprovalState, cols) +
    getReviewDocumentPromptRows(reviewArtifact ?? null, cols) +
    (questionHint === null ? 0 : getQuestionPromptRows(questionHint, cols))
  );
}
