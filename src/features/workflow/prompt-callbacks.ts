import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { markWorkflowPaused } from '../../stores/workflow/actions/pause.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { selectRunningBrief, tasksStore } from '../../stores/workflow/tasks.js';
import { isTaskCompleted } from '../../core/schemas/task.js';
import { reviewStore } from '../../stores/workflow/review.js';
import { feedbackStore } from '../../stores/ui/feedback.js';
import type { OrchestratorCallbacks } from '../../engine/orchestrator/types.js';
import type { PlannerConversation } from '../../core/schemas/workflow.js';
import { questionPromptStore } from '../../stores/question-prompt/prompt.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from './user-edit-conflict-prompt.js';
import { formatTaskReviewPrompt, parseTaskReviewAnswer } from './task-review-prompt.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';

function runningTaskId(): string | null {
  return selectRunningBrief(tasksStore.get()).current?.id ?? null;
}

/** A boundary park has no running brief; the one it stopped after is the subject. */
function lastCompletedBriefId(): string | null {
  const tasks = tasksStore.get().tasks;
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i];
    if (task !== undefined && isTaskCompleted(task.status)) return task.id;
  }
  return null;
}

interface BuildCallbacksOptions {
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  controller: AbortController;
}

export function buildPromptCallbacks(opts: BuildCallbacksOptions): OrchestratorCallbacks {
  const { inputMode, abortedRef, controller } = opts;
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
    // A stopped brief parks rather than asking a question: blank Enter never resumes it, and the
    // composer keeps its own meaning until /resume or a typed steer settles this promise.
    // A boundary park holds the run between briefs; the byline names the one it stopped after.
    onContinuationNeeded: async (_partial, at) => {
      if (controller.signal.aborted || abortedRef.current) return '';
      markWorkflowPaused();
      return new Promise<string>((resolve) => {
        if (at === 'boundary') {
          stopStore.park('boundary', lastCompletedBriefId(), resolve);
          return;
        }
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
    onPlannerReply: async (reply: PlannerConversation) => {
      if (controller.signal.aborted || abortedRef.current) return undefined;
      // One promise owns this turn, including the whole batch of structured answers.
      const hint = reply.questions.length > 0 ? 'Type your answer…' : 'Reply to the planner…';
      const answerPromise = inputMode.setQuestionMode(hint);
      questionPromptStore.setQuestions(reply.questions);
      const answer = await answerPromise;
      if (controller.signal.aborted || abortedRef.current) return undefined;
      const trimmed = answer.trim();
      return trimmed === '' ? undefined : answer;
    },
    // A finished run is the loop returning, and the screen settles itself there from the record it
    // re-reads. Nothing is left for this callback to say that the return does not already say.
    onComplete: () => {},
  };
}
