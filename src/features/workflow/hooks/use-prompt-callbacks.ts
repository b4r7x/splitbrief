import type { RecoveryIssue } from '../../../core/schemas/recovery.js';
import { openApprovalPrompt } from '../../../stores/approval-prompt/actions.js';
import { openCostApprovalPrompt } from '../../../stores/cost-approval/actions.js';
import { lifecycleStore } from '../../../stores/workflow/lifecycle.js';
import { reviewStore } from '../../../stores/workflow/review.js';
import { feedbackStore } from '../../../stores/ui/feedback.js';
import type { OrchestratorCallbacks } from '../../../engine/orchestrator/types.js';
import { formatCost } from '../../../core/formatting.js';
import { formatCostGateSummary } from '../../../core/cost-gate-summary.js';
import { REVIEW_HINT } from '../review-parser.js';
import {
  formatUserEditConflictPrompt,
  parseUserEditConflictAnswer,
} from '../user-edit-conflict-prompt.js';
import { formatRecoveryPrompt, parseRecoveryActionAnswer } from '../recovery-prompt.js';
import { formatTaskReviewPrompt, parseTaskReviewAnswer } from '../task-review-prompt.js';
import { requestCancel, requestRewind } from '../handlers.js';
import type { UseInputModeResult } from './use-input-mode.js';

function buildBudgetPromptIssue(
  reason: 'budget-paused' | 'budget-exceeded',
  currentCost: number,
  maxBudget: number,
): RecoveryIssue {
  const budgetPercent = maxBudget > 0 ? Math.round((currentCost / maxBudget) * 100) : 0;
  const exceeded = reason === 'budget-exceeded';
  return {
    id: `rec_budget_callback_${Date.now()}`,
    reason,
    phase: lifecycleStore.get().phase,
    status: 'awaiting-user',
    files: [],
    affectedTaskIds: [],
    message: exceeded
      ? `Budget exceeded at ${budgetPercent}%`
      : `Budget pause at ${budgetPercent}%`,
    details: [
      `Spent ${formatCost(currentCost)} of ${formatCost(maxBudget)}`,
      ...(exceeded ? ['Continuing requires a separate raise-budget flow.'] : []),
    ],
    facts: {
      currentCost,
      maxBudget,
      budgetPercent,
      belowMaxBudget: currentCost < maxBudget,
    },
    availableActions: exceeded
      ? ['pause-run', 'abort-workflow']
      : ['continue', 'pause-run', 'abort-workflow'],
    recommendedAction: 'pause-run',
    createdAt: new Date().toISOString(),
  };
}

interface BuildCallbacksOptions {
  inputMode: UseInputModeResult;
  abortedRef: { current: boolean };
  controller: AbortController;
  onComplete: OrchestratorCallbacks['onComplete'];
}

export function usePromptCallbacks(): (opts: BuildCallbacksOptions) => OrchestratorCallbacks {
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
      onBudgetExceeded: async (currentCost, maxBudget) => {
        const issue = buildBudgetPromptIssue('budget-exceeded', currentCost, maxBudget);
        // Budget exceeded is a hard stop: the prompt only offers pause/abort, so there is
        // no 'continue' to honor. Continuing requires a separate raise-budget flow.
        await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
        return false;
      },
      onBudgetPaused: async (currentCost, maxBudget) => {
        const issue = buildBudgetPromptIssue('budget-paused', currentCost, maxBudget);
        const answer = await inputMode.setQuestionMode(formatRecoveryPrompt(issue));
        return parseRecoveryActionAnswer(answer, issue) === 'continue' ? 'continue' : 'abort';
      },
      onCostApprovalNeeded: async (prediction) => {
        const summary = formatCostGateSummary(prediction);
        if (!summary) return true;
        return openCostApprovalPrompt(prediction);
      },
      onContinuationNeeded: async (_partial) =>
        inputMode.setQuestionMode(
          'Task interrupted. Enter instructions to continue (or press Enter to retry):',
        ),
      onTieredApproval: (request) => openApprovalPrompt(request),
      onTaskReviewNeeded: async (request) => {
        const answer = await inputMode.setQuestionMode(formatTaskReviewPrompt(request));
        const decision = parseTaskReviewAnswer(answer);
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
