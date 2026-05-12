import type { EngineEvent } from '../events/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { TieredApprovalRequest, TieredApprovalResponse } from '../../core/approval/types.js';
import type { UserEditConflict, UserEditConflictAction } from '../orchestrator/user-edit/conflicts.js';
import { isRecord } from '../../utils/type-guards.js';
import { isUserEditConflictAction } from '../events/workflow-events.js';

export type IpcPromptRequest =
  | { requestId: string; kind: 'approval_needed'; approvalType: 'spec' | 'plan' | 'briefs'; filePath: string }
  | { requestId: string; kind: 'external_changes' }
  | { requestId: string; kind: 'user_edit_conflict'; conflict: UserEditConflict }
  | { requestId: string; kind: 'question_asked'; question: ClarificationQuestion; num: number; total: number }
  | { requestId: string; kind: 'budget_exceeded'; currentCost: number; maxBudget: number }
  | { requestId: string; kind: 'budget_paused'; currentCost: number; maxBudget: number }
  | { requestId: string; kind: 'continuation_needed'; partialResponse: string }
  | { requestId: string; kind: 'tiered_approval'; request: TieredApprovalRequest };

export type IpcPromptRequestInput =
  | Omit<Extract<IpcPromptRequest, { kind: 'approval_needed' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'external_changes' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'user_edit_conflict' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'question_asked' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'budget_exceeded' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'budget_paused' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'continuation_needed' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'tiered_approval' }>, 'requestId'>;

export type IpcPromptResponse =
  | { kind: 'approval_needed'; approved: boolean; comment?: string | undefined; action?: 'edit' | undefined }
  | { kind: 'external_changes'; proceed: boolean }
  | { kind: 'user_edit_conflict'; selectedAction: UserEditConflictAction }
  | { kind: 'question_asked'; answer: string }
  | { kind: 'budget_exceeded'; proceed: boolean }
  | { kind: 'budget_paused'; decision: 'continue' | 'abort' | 'raise' }
  | { kind: 'continuation_needed'; text: string }
  | { kind: 'tiered_approval'; response: TieredApprovalResponse };

export type ServerMessage =
  | { kind: 'session_meta'; sessionId: string; startedAt: number; mode: WorkflowMode; feature: string; readonly: boolean }
  | { kind: 'event'; payload: EngineEvent }
  | { kind: 'prompt_request'; request: IpcPromptRequest }
  | { kind: 'replay_meta'; totalEvents: number; firstTs: number | null; lastTs: number | null }
  | { kind: 'error'; code: 'already_attached'; message: string };

export type ClientMessage =
  | { kind: 'user_input'; text: string }
  | { kind: 'prompt_response'; requestId: string; response: IpcPromptResponse }
  | { kind: 'detach' };

export const IPC_PROTOCOL_VERSION = 1;

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isTieredApprovalResponse(value: unknown): value is TieredApprovalResponse {
  if (!isRecord(value) || typeof value.decision !== 'string') return false;
  if (value.decision === 'allow') {
    return value.scope === 'once' || value.scope === 'session' || value.scope === 'always';
  }
  if (value.decision === 'deny') {
    return typeof value.reason === 'string';
  }
  if (value.decision === 'confirm') {
    return typeof value.phrase === 'string' && typeof value.reason === 'string';
  }
  return false;
}

export function parseIpcPromptResponse(value: unknown): IpcPromptResponse | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;

  switch (value.kind) {
    case 'approval_needed':
      if (typeof value.approved !== 'boolean') return null;
      if (!isOptionalString(value.comment)) return null;
      if (value.action !== undefined && value.action !== 'edit') return null;
      return {
        kind: value.kind,
        approved: value.approved,
        ...(value.comment !== undefined && { comment: value.comment }),
        ...(value.action !== undefined && { action: value.action }),
      };
    case 'external_changes':
      return typeof value.proceed === 'boolean'
        ? { kind: value.kind, proceed: value.proceed }
        : null;
    case 'user_edit_conflict':
      return typeof value.selectedAction === 'string' && isUserEditConflictAction(value.selectedAction)
        ? { kind: value.kind, selectedAction: value.selectedAction }
        : null;
    case 'question_asked':
      return typeof value.answer === 'string'
        ? { kind: value.kind, answer: value.answer }
        : null;
    case 'budget_exceeded':
      return typeof value.proceed === 'boolean'
        ? { kind: value.kind, proceed: value.proceed }
        : null;
    case 'budget_paused':
      return value.decision === 'continue' || value.decision === 'abort' || value.decision === 'raise'
        ? { kind: value.kind, decision: value.decision }
        : null;
    case 'continuation_needed':
      return typeof value.text === 'string'
        ? { kind: value.kind, text: value.text }
        : null;
    case 'tiered_approval':
      return isTieredApprovalResponse(value.response)
        ? { kind: value.kind, response: value.response }
        : null;
    default:
      return null;
  }
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;

  if (value.kind === 'user_input') {
    return typeof value.text === 'string' ? { kind: value.kind, text: value.text } : null;
  }
  if (value.kind === 'prompt_response') {
    if (typeof value.requestId !== 'string') return null;
    const response = parseIpcPromptResponse(value.response);
    return response ? { kind: value.kind, requestId: value.requestId, response } : null;
  }
  if (value.kind === 'detach') {
    return { kind: value.kind };
  }

  return null;
}
