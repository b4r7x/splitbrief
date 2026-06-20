import { z } from 'zod';
import {
  EngineEventSchema,
  taskReviewRequestFields,
  userEditConflictSchema,
} from '../events/schema.js';
import { isTaskReviewAction, type TaskReviewResponse } from '../events/workflow-events.js';
import type { UserEditConflictAction } from '../../core/schemas/enums.js';
import {
  WorkflowModeSchema,
  ActionClassSchema,
  PhaseSchema,
  UserEditConflictActionSchema,
  RecoveryActionSchema,
  type RecoveryAction,
} from '../../core/schemas/enums.js';
import { ClarificationQuestionSchema } from '../../core/schemas/question.js';
import type { TieredApprovalResponse } from '../../core/approval/types.js';
import { ApprovalTierSchema } from '../../core/schemas/config.js';
import { TaskIdSchema } from '../../core/schemas/task.js';
import { CostPredictionSchema } from '../../core/schemas/summary.js';
import { IpcRecoveryIssueSchema } from '../../core/schemas/recovery.js';
import { isRecord } from '../../utils/type-guards.js';

const IPC_MAX_AUTH_TOKEN_BYTES = 512;
export const IPC_MAX_FRAME_BYTES = 1024 * 1024;
export const IPC_MAX_TEXT_BYTES = 256 * 1024;

const TieredApprovalRequestSchema = z.object({
  tier: ApprovalTierSchema,
  actionClass: ActionClassSchema,
  actionDescription: z.string(),
  taskId: TaskIdSchema.optional(),
  phase: PhaseSchema,
});

const TaskReviewRequestSchema = z.looseObject(taskReviewRequestFields);

const IpcPromptRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    requestId: z.string(),
    kind: z.literal('approval_needed'),
    approvalType: z.enum(['spec', 'plan', 'briefs']),
    filePath: z.string(),
  }),
  z.object({
    requestId: z.string(),
    kind: z.literal('user_edit_conflict'),
    conflict: userEditConflictSchema,
  }),
  z.object({
    requestId: z.string(),
    kind: z.literal('question_asked'),
    question: ClarificationQuestionSchema,
    num: z.number(),
    total: z.number(),
  }),
  z.object({
    requestId: z.string(),
    kind: z.literal('continuation_needed'),
    partialResponse: z.string(),
  }),
  z.object({
    requestId: z.string(),
    kind: z.literal('tiered_approval'),
    request: TieredApprovalRequestSchema,
  }),
  z.object({
    requestId: z.string(),
    kind: z.literal('cost_approval'),
    prediction: CostPredictionSchema,
  }),
  z.object({
    requestId: z.string(),
    kind: z.literal('task_review'),
    request: TaskReviewRequestSchema,
  }),
  z.object({
    requestId: z.string(),
    kind: z.literal('recovery_needed'),
    issue: IpcRecoveryIssueSchema,
  }),
]);

const ServerMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session_meta'),
    sessionId: z.string(),
    startedAt: z.number(),
    mode: WorkflowModeSchema,
    feature: z.string(),
  }),
  z.object({ kind: z.literal('event'), payload: EngineEventSchema }),
  z.object({ kind: z.literal('prompt_request'), request: IpcPromptRequestSchema }),
  z.object({
    kind: z.literal('error'),
    code: z.union([z.literal('already_attached'), z.literal('unauthorized')]),
    message: z.string(),
  }),
  z.object({ kind: z.literal('server_complete') }),
]);

export type IpcPromptRequest = z.infer<typeof IpcPromptRequestSchema>;

export type IpcPromptRequestInput =
  | Omit<Extract<IpcPromptRequest, { kind: 'approval_needed' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'user_edit_conflict' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'question_asked' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'continuation_needed' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'tiered_approval' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'cost_approval' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'task_review' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'recovery_needed' }>, 'requestId'>;

export type IpcPromptResponse =
  | { kind: 'approval_needed'; approved: boolean; comment?: string; action?: 'edit' }
  | { kind: 'user_edit_conflict'; selectedAction: UserEditConflictAction }
  | { kind: 'question_asked'; answer: string }
  | { kind: 'continuation_needed'; text: string }
  | { kind: 'tiered_approval'; response: TieredApprovalResponse }
  | { kind: 'cost_approval'; approved: boolean }
  | { kind: 'task_review'; response: TaskReviewResponse }
  | { kind: 'recovery_needed'; action: RecoveryAction };

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type ClientMessage =
  | { kind: 'authenticate'; token: string }
  | { kind: 'user_input'; text: string }
  | { kind: 'queue_clear' }
  | { kind: 'prompt_response'; requestId: string; response: IpcPromptResponse }
  | { kind: 'detach' };

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
      if (value.comment !== undefined && !isBoundedString(value.comment, IPC_MAX_TEXT_BYTES)) {
        return null;
      }
      if (value.action !== undefined && value.action !== 'edit') return null;
      return {
        kind: value.kind,
        approved: value.approved,
        ...(value.comment !== undefined && { comment: value.comment }),
        ...(value.action !== undefined && { action: value.action }),
      };
    case 'user_edit_conflict': {
      const selectedAction = UserEditConflictActionSchema.safeParse(value.selectedAction);
      return selectedAction.success
        ? { kind: value.kind, selectedAction: selectedAction.data }
        : null;
    }
    case 'question_asked':
      return isBoundedString(value.answer, IPC_MAX_TEXT_BYTES)
        ? { kind: value.kind, answer: value.answer }
        : null;
    case 'continuation_needed':
      return isBoundedString(value.text, IPC_MAX_TEXT_BYTES)
        ? { kind: value.kind, text: value.text }
        : null;
    case 'tiered_approval':
      return isTieredApprovalResponse(value.response)
        ? { kind: value.kind, response: value.response }
        : null;
    case 'cost_approval':
      return typeof value.approved === 'boolean'
        ? { kind: value.kind, approved: value.approved }
        : null;
    case 'task_review': {
      if (!isRecord(value.response) || !isTaskReviewAction(value.response.action)) return null;
      if (
        value.response.notes !== undefined &&
        !isBoundedString(value.response.notes, IPC_MAX_TEXT_BYTES)
      ) {
        return null;
      }
      return {
        kind: value.kind,
        response: {
          action: value.response.action,
          ...(value.response.notes !== undefined && { notes: value.response.notes }),
        },
      };
    }
    case 'recovery_needed': {
      const action = RecoveryActionSchema.safeParse(value.action);
      return action.success ? { kind: value.kind, action: action.data } : null;
    }
    default:
      return null;
  }
}

export function parseServerMessage(value: unknown): ServerMessage | null {
  const result = ServerMessageSchema.safeParse(value);
  return result.success ? result.data : null;
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

export function parseClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;

  if (value.kind === 'authenticate') {
    return isBoundedString(value.token, IPC_MAX_AUTH_TOKEN_BYTES)
      ? { kind: value.kind, token: value.token }
      : null;
  }
  if (value.kind === 'user_input') {
    return isBoundedString(value.text, IPC_MAX_TEXT_BYTES)
      ? { kind: value.kind, text: value.text }
      : null;
  }
  if (value.kind === 'queue_clear') {
    return { kind: value.kind };
  }
  if (value.kind === 'prompt_response') {
    if (!isBoundedString(value.requestId, IPC_MAX_TEXT_BYTES)) return null;
    const response = parseIpcPromptResponse(value.response);
    return response ? { kind: value.kind, requestId: value.requestId, response } : null;
  }
  if (value.kind === 'detach') {
    return { kind: value.kind };
  }

  return null;
}
