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

export interface WorkflowPromptRowsInput {
  approvalState: ApprovalPromptState;
  questionHint: string | null;
  /** Omitted by callers that measure a zone the document review panel never renders into. */
  reviewArtifact?: ReviewArtifact | null | undefined;
  recoveryIssue?: RecoveryIssue | null | undefined;
  questions?: readonly ClarificationQuestion[] | undefined;
  cols: number;
}

export function getWorkflowPromptRows(input: WorkflowPromptRowsInput): number {
  const { approvalState, questionHint, reviewArtifact, recoveryIssue, questions, cols } = input;
  return (
    getApprovalPromptRows(approvalState, cols) +
    getReviewDocumentPromptRows(reviewArtifact ?? null, cols) +
    (recoveryIssue !== null && recoveryIssue !== undefined
      ? getRecoveryPromptRows(recoveryIssue, cols)
      : questionHint === null || questions?.length === 0
        ? 0
        : getQuestionPromptRows(questionHint, cols, questions))
  );
}
