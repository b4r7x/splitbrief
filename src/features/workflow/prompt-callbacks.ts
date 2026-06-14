import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { openCostApprovalPrompt } from '../../stores/cost-approval/prompt.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { OrchestratorCallbacks } from '../../engine/orchestrator/types.js';
import { REVIEW_HINT } from './review-parser.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from './user-edit-conflict-prompt.js';
import { formatTaskReviewPrompt, parseTaskReviewAnswer } from './task-review-prompt.js';
import { requestCancel, requestRewind } from './handlers.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

interface BuildCallbacksOptions {
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  controller: AbortController;
  onComplete: OrchestratorCallbacks['onComplete'];
}

export function buildPromptCallbacks(): (opts: BuildCallbacksOptions) => OrchestratorCallbacks {
  return (opts: BuildCallbacksOptions): OrchestratorCallbacks => {
    const { inputMode, abortedRef, controller, onComplete } = opts;
    return {
      onApprovalNeeded: async (_type, filePath) => {
        reviewStore.setReviewFile(filePath);
        const result = await inputMode.setReviewMode(REVIEW_HINT);
        reviewStore.clearReview();
        return result;
      },
      onUserEditConflict: async (conflict) => {
        const answer = await inputMode.setQuestionMode(formatUserEditConflictPrompt(conflict));
        return parseUserEditConflictAnswer(answer, conflict.availableActions);
      },
      onCostApprovalNeeded: async (prediction) => openCostApprovalPrompt(prediction),
      onContinuationNeeded: async (_partial) =>
        inputMode.setQuestionMode(
          'Task interrupted. Enter instructions to continue (or press Enter to retry):',
        ),
      onTieredApproval: (request) => openApprovalPrompt(request),
      onTaskReviewNeeded: async (request) => {
        const prompt = formatTaskReviewPrompt(request);
        let decision = parseTaskReviewAnswer(await inputMode.setQuestionMode(prompt));
        while (!decision) {
          feedbackStore.setError(
            'Unrecognized task review command. Use: continue, redo, notes <text>, revise-plan <notes>, or abort.',
          );
          decision = parseTaskReviewAnswer(await inputMode.setQuestionMode(prompt));
        }
        if (decision.action === 'redo-task') {
          if (!requestRewind({ target: 'task', taskId: request.taskId })) {
            feedbackStore.setError('Cannot redo task: no active workflow.');
          }
        } else if (decision.action === 'revise-plan') {
          if (
            !requestRewind({
              target: 'plan',
              ...(decision.notes ? { comment: decision.notes } : {}),
            })
          ) {
            feedbackStore.setError('Cannot revise plan: no active workflow.');
          }
        } else if (decision.action === 'abort') {
          requestCancel();
        }
        return decision;
      },
      onQuestionAsked: (question, num, total) =>
        inputMode.setQuestionMode(`Question ${num}/${total}: ${question.text}`),
      onComplete: (summary) => {
        if (!controller.signal.aborted && !abortedRef.current) onComplete(summary);
      },
    };
  };
}
