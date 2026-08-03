import type { TieredApprovalResponse } from '../../core/approval/types.js';
import { CONFIRM_PHRASE } from '../../core/approval/types.js';
import type {
  TaskReviewCommand,
  TaskReviewRequest,
  TaskReviewResponse,
} from '../../engine/events/workflow-events.js';
import type { RunWorkflowOptions } from '../../engine/orchestrator/run/init.js';
import { isUserEditConflictAction } from '../../engine/events/workflow-events.js';
import { normalizeUserEditConflictAction } from '../../engine/orchestrator/user-edit/conflicts.js';
import { validateConfirmApprovalFields, type ApprovalGateResult } from './gates.js';

function parseTaskReviewResponse(
  text: string,
  availableCommands: readonly TaskReviewCommand[],
): TaskReviewResponse | null {
  const [rawAction, ...rest] = text.trim().split(/\s+/);
  const notes = rest.join(' ').trim() || undefined;
  if ((rawAction === 'notes' || rawAction === 'edit-notes' || rawAction === 'edit') && notes) {
    return allowedTaskReviewResponse({ action: 'continue', notes }, availableCommands);
  }
  if (rawAction === 'continue')
    return allowedTaskReviewResponse(
      notes ? { action: 'continue', notes } : { action: 'continue' },
      availableCommands,
    );
  if (rawAction === 'redo' || rawAction === 'redo-task') {
    return allowedTaskReviewResponse(
      notes ? { action: 'redo-task', notes } : { action: 'redo-task' },
      availableCommands,
    );
  }
  if (rawAction === 'revise-plan')
    return allowedTaskReviewResponse(
      notes ? { action: 'revise-plan', notes } : { action: 'revise-plan' },
      availableCommands,
    );
  if (rawAction === 'abort')
    return allowedTaskReviewResponse(
      notes ? { action: 'abort', notes } : { action: 'abort' },
      availableCommands,
    );
  return null;
}

function allowedTaskReviewResponse(
  response: TaskReviewResponse,
  availableCommands: readonly TaskReviewCommand[],
): TaskReviewResponse | null {
  if (response.notes !== undefined && response.action === 'continue') {
    return availableCommands.includes('edit-notes') ? response : null;
  }
  return availableCommands.includes(response.action) ? response : null;
}

export function createWorkflowCallbacks(deps: {
  waitForApproval: (data: unknown) => Promise<ApprovalGateResult>;
  waitForMessage: (data: unknown) => Promise<string>;
  reportError: (message: string) => void;
}): RunWorkflowOptions['callbacks'] {
  return {
    onApprovalNeeded: async (approvalType, input) => {
      const result = await deps.waitForApproval(
        approvalType === 'artifact'
          ? { pending: 'approval', approvalType, review: input }
          : { pending: 'approval', approvalType, filePath: input },
      );
      if (result.approved) return { approved: true };
      if (result.action === 'edit') {
        return { approved: false, action: 'edit' };
      }
      if (result.action === 'revise') {
        return {
          approved: false,
          action: 'revise',
          comment: result.comment,
          ...(result.taskIds !== undefined && { taskIds: result.taskIds }),
        };
      }
      return { approved: false };
    },
    onUserEditConflict: async (conflict) => {
      const answer = await deps.waitForMessage({ pending: 'user_edit_conflict', conflict });
      const action = isUserEditConflictAction(answer) ? answer : 'pause';
      return normalizeUserEditConflictAction(conflict, action);
    },
    onQuestionAsked: async (question, num, total) =>
      deps.waitForMessage({ pending: 'question', question, num, total }),
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
        const confirmed = validateConfirmApprovalFields(result);
        if (!confirmed.ok) {
          return { decision: 'deny', reason: 'invalid_confirm_phrase' };
        }
        return { decision: 'confirm', phrase: CONFIRM_PHRASE, reason: confirmed.reason };
      }
      return { decision: 'allow', scope: 'once' };
    },
    onTaskReviewNeeded: async (request: TaskReviewRequest) => {
      while (true) {
        const answer = await deps.waitForMessage({ pending: 'task_review', request });
        const response = parseTaskReviewResponse(answer, request.availableCommands);
        if (response) {
          return response;
        }
        deps.reportError(
          `Invalid task review response. Use: ${request.availableCommands.join(', ')}.`,
        );
      }
    },
    onComplete: () => undefined,
  };
}
