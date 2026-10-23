import { openApprovalPrompt } from '../../stores/approval-prompt/prompt.js';
import { openReviewChecksPrompt } from '../../stores/review-checks-prompt/prompt.js';
import { markWorkflowPaused } from '../../stores/workflow/actions/pause.js';
import { stopStore } from '../../stores/workflow/stop.js';
import { selectRunningBrief, tasksStore } from '../../stores/workflow/tasks.js';
import { lifecycleStore } from '../../stores/workflow/lifecycle.js';
import { isTaskCompleted } from '../../core/schemas/task.js';
import { reviewStore } from '../../stores/workflow/review.js';
import type { OrchestratorCallbacks } from '../../engine/orchestrator/types.js';
import type { PlannerConversation } from '../../core/schemas/workflow.js';
import { questionPromptStore } from '../../stores/question-prompt/prompt.js';
import type { UseInputModeResult } from './hooks/use-input-mode.js';
import { plainUserMessage, type UserMessageInput } from '../../core/types/user-input.js';

function runningTaskId(): string | null {
  return selectRunningBrief(tasksStore.get(), lifecycleStore.get().phase).current?.id ?? null;
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
    onApprovalNeeded: async (_type, input, confirms) => {
      const reviewOwner =
        typeof input === 'string'
          ? reviewStore.setReviewFile(input)
          : reviewStore.setReviewArtifact(input.text);
      reviewStore.setConfirms(confirms);
      try {
        // The review panel is the legend now, so the mode carries no hint text of its own.
        return await inputMode.setReviewMode('');
      } finally {
        reviewStore.clearReviewIfOwner(reviewOwner);
      }
    },
    // A stopped brief parks rather than asking a question: blank Enter never resumes it, and the
    // composer keeps its own meaning until /resume or a typed steer settles this promise.
    // A boundary park holds the run between briefs; the byline names the one it stopped after.
    onContinuationNeeded: async (_partial, at, kept) => {
      if (controller.signal.aborted || abortedRef.current) return plainUserMessage('');
      markWorkflowPaused();
      return new Promise<UserMessageInput>((resolve) => {
        if (at === 'boundary') {
          stopStore.park('boundary', lastCompletedBriefId(), resolve);
          return;
        }
        stopStore.park('mid-brief', runningTaskId(), resolve, kept);
      });
    },
    onTieredApproval: (request) => openApprovalPrompt(request),
    // The screen is what makes `validation.approve_checks: ask` answerable; a run without this
    // callback runs none of the reviewer checks.
    onReviewChecksApproval: async (request) => {
      if (controller.signal.aborted || abortedRef.current) return undefined;
      return openReviewChecksPrompt(request);
    },
    onPlannerReply: async (reply: PlannerConversation) => {
      if (controller.signal.aborted || abortedRef.current) return undefined;
      // One promise owns this turn, including the whole batch of structured answers.
      const hint =
        reply.seat === 'review'
          ? 'Reply to the reviewer…'
          : reply.questions.length > 0
            ? 'Type your answer…'
            : 'Reply to the planner…';
      const answerPromise = inputMode.setQuestionMode(hint);
      questionPromptStore.setQuestions(reply.questions);
      const { message: answer } = await answerPromise;
      if (controller.signal.aborted || abortedRef.current) return undefined;
      const batch = questionPromptStore.takeAnswerBatch();
      if (answer.text.trim() === '') return answer;
      return batch ?? answer;
    },
    // A finished run is the loop returning, and the screen settles itself there from the record it
    // re-reads. Nothing is left for this callback to say that the return does not already say.
    onComplete: () => {},
  };
}
