import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { openCostApprovalPrompt } from '../../stores/cost-approval/prompt.js';
import {
  markInterruptParked,
  markInterruptRequested,
} from '../../stores/workflow/actions/interrupt.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { OrchestratorCallbacks } from '../../engine/orchestrator/types.js';
import { BRIEFS_REVIEW_HINT, REVIEW_HINT } from './review-parser.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from './user-edit-conflict-prompt.js';
import { formatTaskReviewPrompt, parseTaskReviewAnswer } from './task-review-prompt.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

export const CONTINUATION_PROMPT =
  'Interrupted. Type instructions to steer, or press Enter to retry.';

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
      onApprovalNeeded: async (type, filePath) => {
        reviewStore.setReviewFile(filePath);
        const hint = type === 'briefs' ? BRIEFS_REVIEW_HINT : REVIEW_HINT;
        const result = await inputMode.setReviewMode(hint);
        reviewStore.clearReview();
        return result;
      },
      onUserEditConflict: async (conflict) => {
        const answer = await inputMode.setQuestionMode(formatUserEditConflictPrompt(conflict));
        return parseUserEditConflictAnswer(answer, conflict.availableActions);
      },
      onCostApprovalNeeded: async (prediction) => openCostApprovalPrompt(prediction),
      onContinuationNeeded: async (_partial) => {
        markInterruptRequested();
        while (!controller.signal.aborted && !abortedRef.current) {
          markInterruptParked();
          // Contract: resolvers of this prompt must call markInterruptResumed()
          // before resolving, or the answer is treated as superseded and re-asked.
          const text = await inputMode.setQuestionMode(CONTINUATION_PROMPT);
          if (lifecycleStore.get().status !== 'interrupted') return text;
        }
        return '';
      },
      onTieredApproval: (request) => openApprovalPrompt(request),
      onTaskReviewNeeded: async (request) => {
        const prompt = formatTaskReviewPrompt(request);
        let decision = parseTaskReviewAnswer(
          await inputMode.setQuestionMode(prompt),
          request.availableCommands,
        );
        while (!decision) {
          feedbackStore.setError(
            `Unrecognized task review command. Use: ${request.availableCommands.join(', ')}.`,
          );
          decision = parseTaskReviewAnswer(
            await inputMode.setQuestionMode(prompt),
            request.availableCommands,
          );
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
