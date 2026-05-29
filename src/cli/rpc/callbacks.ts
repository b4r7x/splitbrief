import type { TieredApprovalResponse } from '../../core/approval/types.js';
import type { TaskReviewRequest, TaskReviewResponse } from '../../engine/events/workflow-events.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import { isUserEditConflictAction } from '../../engine/events/workflow-events.js';
import { normalizeUserEditConflictAction } from '../../engine/orchestrator/user-edit/conflicts.js';
import type { ApprovalGateResult } from './gates.js';

export function parseTaskReviewResponse(text: string): TaskReviewResponse | null {
  const [rawAction, ...rest] = text.trim().split(/\s+/);
  const notes = rest.join(' ').trim() || undefined;
  if (rawAction === 'continue')
    return notes ? { action: 'continue', notes } : { action: 'continue' };
  if (rawAction === 'redo' || rawAction === 'redo-task') {
    return notes ? { action: 'redo-task', notes } : { action: 'redo-task' };
  }
  if (rawAction === 'revise-plan')
    return notes ? { action: 'revise-plan', notes } : { action: 'revise-plan' };
  if (rawAction === 'abort') return notes ? { action: 'abort', notes } : { action: 'abort' };
  return null;
}

export function createWorkflowCallbacks(deps: {
  waitForApproval: (data: unknown) => Promise<ApprovalGateResult>;
  waitForMessage: (data: unknown) => Promise<string>;
  reportError: (message: string) => void;
}): RunWorkflowOptions['callbacks'] {
  return {
    onApprovalNeeded: async (approvalType, filePath) => {
      const result = await deps.waitForApproval({ pending: 'approval', approvalType, filePath });
      return {
        approved: result.approved,
        ...(result.comment !== undefined && { comment: result.comment }),
      };
    },
    onUserEditConflict: async (conflict) => {
      const answer = await deps.waitForMessage({ pending: 'user_edit_conflict', conflict });
      const action = isUserEditConflictAction(answer) ? answer : 'pause';
      return normalizeUserEditConflictAction(conflict, action);
    },
    onQuestionAsked: async (question, num, total) =>
      deps.waitForMessage({ pending: 'question', question, num, total }),
    onBudgetExceeded: async (currentCost, maxBudget) => {
      const result = await deps.waitForApproval({
        pending: 'budget_exceeded',
        currentCost,
        maxBudget,
      });
      return result.approved;
    },
    onBudgetPaused: async (currentCost, maxBudget) => {
      const result = await deps.waitForApproval({
        pending: 'budget_paused',
        currentCost,
        maxBudget,
      });
      return result.approved ? 'continue' : 'abort';
    },
    onCostApprovalNeeded: async (prediction) => {
      const result = await deps.waitForApproval({ pending: 'cost_approval', prediction });
      return result.approved;
    },
    onContinuationNeeded: async (partialResponse) =>
      deps.waitForMessage({ pending: 'continuation', partialResponse }),
    onTieredApproval: async (request): Promise<TieredApprovalResponse> => {
      const result = await deps.waitForApproval({ pending: 'tiered_approval', request });
      if (!result.approved) {
        return { decision: 'deny', reason: result.comment ?? 'Rejected via RPC' };
      }
      if (request.tier === 'confirm') {
        return {
          decision: 'confirm',
          phrase: 'I confirm',
          reason: result.comment ?? 'Approved via RPC',
        };
      }
      return { decision: 'allow', scope: 'once' };
    },
    onTaskReviewNeeded: async (request: TaskReviewRequest) => {
      while (true) {
        const answer = await deps.waitForMessage({ pending: 'task_review', request });
        const response = parseTaskReviewResponse(answer);
        if (response) return response;
        deps.reportError(
          'Invalid task review response. Use: continue, redo, revise-plan, or abort.',
        );
      }
    },
    onComplete: () => undefined,
  };
}
