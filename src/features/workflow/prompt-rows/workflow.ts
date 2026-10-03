import type { ApprovalPromptState } from '../../../stores/approval-prompt/prompt.js';
import {
  getApprovalPromptRows,
  getReviewDocumentPromptRows,
  type ReviewArtifact,
} from './approval.js';
import { getQuestionPromptRows } from './question.js';
import { getRecoveryPromptRows } from './recovery.js';
import type { RecoveryIssue } from '../../../core/schemas/recovery/schemas.js';
import type { ClarificationQuestion } from '../../../core/schemas/question.js';

export interface WorkflowReviewPanelInput {
  artifact: ReviewArtifact | null;
  /** What approving the plan card confirms; the panel spells it above its rows. */
  confirms: readonly string[];
  /** The rows the panel may take and leave the document its rows (`getReviewPanelBudget`). */
  budgetRows: number;
}

export interface WorkflowPromptRowsInput {
  approvalState: ApprovalPromptState;
  questionHint: string | null;
  /** Omitted by callers that measure a zone the document review panel never renders into. */
  review?: WorkflowReviewPanelInput | undefined;
  recoveryIssue?: RecoveryIssue | null | undefined;
  questions?: readonly ClarificationQuestion[] | undefined;
  questionIndex?: number | undefined;
  questionWriting?: boolean | undefined;
  cols: number;
}

export function getWorkflowPromptRows(input: WorkflowPromptRowsInput): number {
  const { approvalState, questionHint, review, recoveryIssue, questions, cols } = input;
  return (
    getApprovalPromptRows(approvalState, cols) +
    (review === undefined
      ? 0
      : getReviewDocumentPromptRows(review.artifact, review.confirms, cols, review.budgetRows)) +
    (recoveryIssue !== null && recoveryIssue !== undefined
      ? getRecoveryPromptRows(recoveryIssue, cols)
      : questionHint === null || questions?.length === 0
        ? 0
        : getQuestionPromptRows(
            questionHint,
            cols,
            questions,
            input.questionIndex,
            input.questionWriting,
          ))
  );
}
