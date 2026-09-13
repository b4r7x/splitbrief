import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { openCostApprovalPrompt } from '../../stores/cost-approval/prompt.js';
import { markWorkflowPaused } from '../../stores/workflow/actions/pause.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { selectRunningBrief, tasksStore } from '../../stores/workflow/tasks.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { OrchestratorCallbacks } from '../../engine/orchestrator/types.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from './user-edit-conflict-prompt.js';
import { formatTaskReviewPrompt, parseTaskReviewAnswer } from './task-review-prompt.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

function runningTaskId(): string | null {
  return selectRunningBrief(tasksStore.get()).current?.id ?? null;
}

interface BuildCallbacksOptions {
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  controller: AbortController;
  onComplete: OrchestratorCallbacks['onComplete'];
}

export function buildPromptCallbacks(opts: BuildCallbacksOptions): OrchestratorCallbacks {
  const { inputMode, abortedRef, controller, onComplete } = opts;
  return {
    // `type` stays in the positional signature because `OrchestratorCallbacks` defines it and the
    // engine passes it; the review legend no longer varies by approval type, so nothing reads it.
    onApprovalNeeded: async (_type, input) => {
      const artifactReview = typeof input !== 'string';
      const reviewOwner = artifactReview
        ? reviewStore.setReviewArtifact(input.text)
        : reviewStore.setReviewFile(input);
      try {
        // The review panel is the legend now, so the mode carries no hint text of its own.
        return await inputMode.setReviewMode('');
      } finally {
        reviewStore.clearReviewIfOwner(reviewOwner);
      }
    },
    onUserEditConflict: async (conflict) => {
      const answer = await inputMode.setQuestionMode(formatUserEditConflictPrompt(conflict));
      return parseUserEditConflictAnswer(answer, conflict.availableActions);
    },
    onCostApprovalNeeded: async (prediction) => openCostApprovalPrompt(prediction),
    // A stopped brief parks rather than asking a question: blank Enter never resumes it, and the
    // composer keeps its own meaning until /resume or a typed steer settles this promise.
    onContinuationNeeded: async (_partial) => {
      if (controller.signal.aborted || abortedRef.current) return '';
      markWorkflowPaused();
      return new Promise<string>((resolve) => {
        stopStore.park('mid-brief', runningTaskId(), resolve);
      });
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
}
