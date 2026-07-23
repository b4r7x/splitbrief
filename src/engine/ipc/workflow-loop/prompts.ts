import type { IpcPromptResponse } from '../protocol.js';
import { error } from '../../../utils/error.js';
import type { OrchestratorCallbacks } from '../../orchestrator/types.js';
import { briefReviewCommandToApprovalReviewResult } from '../../../core/schemas/brief-review-command.js';
import type { IpcServer } from '../server.js';

const ipcWorkflowLoopError = {
  promptResponseKindMismatch: (expected: string, actual: string) =>
    error(
      'ipc-prompt-response-kind-mismatch',
      `IPC prompt response kind mismatch: expected ${expected}, got ${actual}`,
      { expected, actual },
    ),
  nonSettlingApprovalCommand: (action: string) =>
    error(
      'ipc-non-settling-approval-command',
      `IPC approval command does not resolve the prompt: ${action}`,
      { action },
    ),
} as const;

export function assertPromptResponse<T extends IpcPromptResponse['kind']>(
  response: IpcPromptResponse,
  kind: T,
): Extract<IpcPromptResponse, { kind: T }> {
  if (response.kind !== kind) {
    throw ipcWorkflowLoopError.promptResponseKindMismatch(kind, response.kind);
  }
  return response as Extract<IpcPromptResponse, { kind: T }>;
}

export function makeCallbacks(ipcServer: IpcServer): OrchestratorCallbacks {
  // Approval, question, and tiered prompts round-trip over IPC (prompt_response). Rewind commands
  // (/revise-spec, /revise-plan, /redo-task) are not exposed to attach clients — send revision
  // text via user_input or settle at the next prompt instead.
  return {
    onApprovalNeeded: async (approvalType: 'spec' | 'plan' | 'briefs', filePath: string) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'approval_needed', approvalType, filePath }),
        'approval_needed',
      );
      if ('command' in response) {
        const result = briefReviewCommandToApprovalReviewResult(response.command);
        if (result === null) {
          throw ipcWorkflowLoopError.nonSettlingApprovalCommand(response.command.action);
        }
        return result;
      }
      if (response.approved) return { approved: true };
      if (response.action === 'edit') {
        return response.comment !== undefined
          ? { approved: false, action: response.action, comment: response.comment }
          : { approved: false, action: response.action };
      }
      if (response.action === 'revise') {
        return {
          approved: false,
          action: response.action,
          comment: response.comment,
          ...(response.taskIds !== undefined && { taskIds: response.taskIds }),
        };
      }
      return { approved: false };
    },
    onUserEditConflict: async (conflict) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'user_edit_conflict', conflict }),
        'user_edit_conflict',
      );
      return response.selectedAction;
    },
    onQuestionAsked: async (question, num, total) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({
          kind: 'question_asked',
          question,
          num,
          total,
        }),
        'question_asked',
      );
      return response.answer;
    },
    onContinuationNeeded: async (partialResponse: string) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'continuation_needed', partialResponse }),
        'continuation_needed',
      );
      return response.text;
    },
    onTieredApproval: async (request) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'tiered_approval', request }),
        'tiered_approval',
      );
      return response.response;
    },
    onCostApprovalNeeded: async (prediction) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'cost_approval', prediction }),
        'cost_approval',
      );
      return response.approved;
    },
    onTaskReviewNeeded: async (request) => {
      const response = assertPromptResponse(
        await ipcServer.requestClientPrompt({ kind: 'task_review', request }),
        'task_review',
      );
      return response.response;
    },
    onComplete: () => undefined,
  };
}
