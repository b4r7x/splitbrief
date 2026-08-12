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
import { SOFT_SEP } from '../../components/separators.js';
import { REVIEW_HINT } from './review-parser.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from './user-edit-conflict-prompt.js';
import { formatTaskReviewPrompt, parseTaskReviewAnswer } from './task-review-prompt.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

export const CONTINUATION_PROMPT =
  'Interrupted. Type instructions to steer, or press Enter to retry.';
export const ARTIFACT_REVIEW_HINT = `y approve${SOFT_SEP}q reject`;

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
      // `type` stays in the positional signature because `OrchestratorCallbacks` defines it and the
      // engine passes it; the review legend no longer varies by approval type, so nothing reads it.
      onApprovalNeeded: async (_type, input) => {
        const artifactReview = typeof input !== 'string';
        const reviewOwner = artifactReview
          ? reviewStore.setReviewArtifact(input.text)
          : reviewStore.setReviewFile(input);
        const hint = artifactReview ? ARTIFACT_REVIEW_HINT : REVIEW_HINT;
        try {
          return await inputMode.setReviewMode(hint);
        } finally {
          reviewStore.clearReviewIfOwner(reviewOwner);
        }
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
