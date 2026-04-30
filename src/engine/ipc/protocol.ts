import type { EngineEvent } from '../events/types.js';
import type { WorkflowMode } from '../../core/schemas/enums.js';
import type { ClarificationQuestion } from '../../core/schemas/question.js';
import type { TieredApprovalRequest, TieredApprovalResponse } from '../../core/approval/types.js';
import type { UserEditConflict, UserEditConflictAction } from '../orchestrator/user-edit/conflicts.js';

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
