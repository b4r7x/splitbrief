import type { ApprovalPromptState } from '../../../stores/approval-prompt/prompt.js';
import type { CostApprovalState } from '../../../stores/cost-approval/prompt.js';
import { getApprovalPromptRows } from './approval.js';
import { getCostApprovalPromptRows } from './cost.js';
import { getQuestionPromptRows } from './question.js';

export interface WorkflowPromptRowsInput {
  approvalState: ApprovalPromptState;
  costApprovalState: CostApprovalState;
  questionHint: string | null;
  cols: number;
}

export function getWorkflowPromptRows(input: WorkflowPromptRowsInput): number {
  const { approvalState, costApprovalState, questionHint, cols } = input;
  return (
    getApprovalPromptRows(approvalState, cols) +
    getCostApprovalPromptRows(costApprovalState, cols) +
    (questionHint === null ? 0 : getQuestionPromptRows(questionHint, cols))
  );
}
