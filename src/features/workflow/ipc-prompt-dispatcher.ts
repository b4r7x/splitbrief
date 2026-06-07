import type { IpcPromptRequest, IpcPromptResponse } from '../../engine/ipc/protocol.js';
import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { BRIEFS_REVIEW_HINT, REVIEW_HINT } from './review-parser.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from './user-edit-conflict-prompt.js';
import { assertNever } from '../../utils/type-guards.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

export function createIpcPromptDispatcher(
  inputMode: UseInputModeResult,
): (request: IpcPromptRequest) => Promise<IpcPromptResponse> {
  return async (request: IpcPromptRequest): Promise<IpcPromptResponse> => {
    if (request.kind === 'approval_needed') {
      reviewStore.setReviewFile(request.filePath);
      const hint = request.approvalType === 'briefs' ? BRIEFS_REVIEW_HINT : REVIEW_HINT;
      const result = await inputMode.setReviewMode(hint);
      reviewStore.clearReview();
      return {
        kind: 'approval_needed',
        approved: result.approved,
        ...(result.comment !== undefined && { comment: result.comment }),
        ...(result.action !== undefined && { action: result.action }),
      };
    }

    if (request.kind === 'external_changes') {
      const result = await inputMode.setReviewMode('External changes detected. continue / quit');
      return { kind: 'external_changes', proceed: result.approved };
    }

    if (request.kind === 'user_edit_conflict') {
      const answer = await inputMode.setQuestionMode(
        formatUserEditConflictPrompt(request.conflict),
      );
      return {
        kind: 'user_edit_conflict',
        selectedAction: parseUserEditConflictAnswer(answer, request.conflict.availableActions),
      };
    }

    if (request.kind === 'question_asked') {
      const answer = await inputMode.setQuestionMode(
        `Question ${request.num}/${request.total}: ${request.question.text}`,
      );
      return { kind: 'question_asked', answer };
    }

    if (request.kind === 'budget_exceeded') {
      const result = await inputMode.setReviewMode(
        `Budget exceeded: $${request.currentCost.toFixed(2)} of $${request.maxBudget.toFixed(2)}. continue / quit`,
      );
      return { kind: 'budget_exceeded', proceed: result.approved };
    }

    if (request.kind === 'budget_paused') {
      const result = await inputMode.setReviewMode(
        `Budget ${Math.round((request.currentCost / request.maxBudget) * 100)}% reached: ${request.currentCost.toFixed(2)} of ${request.maxBudget.toFixed(2)}. continue / abort`,
      );
      return { kind: 'budget_paused', decision: result.approved ? 'continue' : 'abort' };
    }

    if (request.kind === 'continuation_needed') {
      const text = await inputMode.setQuestionMode(
        'Task interrupted. Enter instructions to continue (or press Enter to retry):',
      );
      return { kind: 'continuation_needed', text };
    }

    if (request.kind === 'cost_approval') {
      const result = await inputMode.setReviewMode('Cost estimate ready. approve / reject');
      return { kind: 'cost_approval', approved: result.approved };
    }

    if (request.kind === 'task_review') {
      const result = await inputMode.setReviewMode(
        `Review task ${request.request.taskId}: continue / abort`,
      );
      return { kind: 'task_review', response: { action: result.approved ? 'continue' : 'abort' } };
    }

    if (request.kind === 'tiered_approval') {
      const response = await openApprovalPrompt(request.request);
      return { kind: 'tiered_approval', response };
    }

    if (request.kind === 'recovery_needed') {
      const result = await inputMode.setReviewMode(
        `Recovery needed: ${request.issue.message}. retry / abort`,
      );
      return {
        kind: 'recovery_needed',
        action: result.approved ? 'retry-same-worker' : 'abort-workflow',
      };
    }

    return assertNever(request);
  };
}
