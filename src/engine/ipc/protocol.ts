import { z } from 'zod';
import type { EngineEvent } from '../events/types.js';
import { EngineEventSchema } from '../events/schema.js';
import { WorkflowModeSchema, type WorkflowMode, ActionClassSchema, PhaseSchema } from '../../core/schemas/enums.js';
import { ClarificationQuestionSchema, type ClarificationQuestion } from '../../core/schemas/question.js';
import type { TieredApprovalRequest, TieredApprovalResponse } from '../../core/approval/types.js';
import { ApprovalTierSchema } from '../../core/schemas/config.js';
import { TaskIdSchema } from '../../core/schemas/task.js';
import { CostPredictionSchema, type CostPrediction } from '../../core/schemas/summary.js';
import type { UserEditConflict, UserEditConflictAction, TaskReviewRequest, TaskReviewResponse } from '../events/workflow-events.js';
import { isRecord } from '../../utils/type-guards.js';
import { isUserEditConflictAction } from '../events/workflow-events.js';
import { isOptionalString } from './guards.js';

const TASK_REVIEW_ACTIONS = new Set<string>(['continue', 'redo-task', 'revise-plan', 'abort']);

const TieredApprovalRequestShape = z.object({
  tier: ApprovalTierSchema,
  actionClass: ActionClassSchema,
  actionDescription: z.string(),
  taskId: TaskIdSchema.optional(),
  phase: PhaseSchema,
});

const TieredApprovalRequestSchema = z.custom<TieredApprovalRequest>((value) =>
  TieredApprovalRequestShape.safeParse(value).success
);

const TaskReviewRequestSchema = z.custom<TaskReviewRequest>(isRecord);

const IpcPromptRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    requestId: z.string(),
    kind: z.literal('approval_needed'),
    approvalType: z.enum(['spec', 'plan', 'briefs']),
    filePath: z.string(),
  }),
  z.object({ requestId: z.string(), kind: z.literal('external_changes') }),
  z.object({
    requestId: z.string(),
    kind: z.literal('user_edit_conflict'),
    conflict: z.custom<UserEditConflict>(isRecord),
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
    kind: z.literal('budget_exceeded'),
    currentCost: z.number(),
    maxBudget: z.number(),
  }),
  z.object({
    requestId: z.string(),
    kind: z.literal('budget_paused'),
    currentCost: z.number(),
    maxBudget: z.number(),
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
]);

const ServerMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session_meta'),
    sessionId: z.string(),
    startedAt: z.number(),
    mode: WorkflowModeSchema,
    feature: z.string(),
    readonly: z.boolean(),
  }),
  z.object({ kind: z.literal('event'), payload: EngineEventSchema }),
  z.object({ kind: z.literal('prompt_request'), request: IpcPromptRequestSchema }),
  z.object({
    kind: z.literal('replay_meta'),
    totalEvents: z.number(),
    firstTs: z.number().nullable(),
    lastTs: z.number().nullable(),
  }),
  z.object({
    kind: z.literal('error'),
    code: z.literal('already_attached'),
    message: z.string(),
  }),
]);

export type IpcPromptRequest =
  | { requestId: string; kind: 'approval_needed'; approvalType: 'spec' | 'plan' | 'briefs'; filePath: string }
  | { requestId: string; kind: 'external_changes' }
  | { requestId: string; kind: 'user_edit_conflict'; conflict: UserEditConflict }
  | { requestId: string; kind: 'question_asked'; question: ClarificationQuestion; num: number; total: number }
  | { requestId: string; kind: 'budget_exceeded'; currentCost: number; maxBudget: number }
  | { requestId: string; kind: 'budget_paused'; currentCost: number; maxBudget: number }
  | { requestId: string; kind: 'continuation_needed'; partialResponse: string }
  | { requestId: string; kind: 'tiered_approval'; request: TieredApprovalRequest }
  | { requestId: string; kind: 'cost_approval'; prediction: CostPrediction }
  | { requestId: string; kind: 'task_review'; request: TaskReviewRequest };

export type IpcPromptRequestInput =
  | Omit<Extract<IpcPromptRequest, { kind: 'approval_needed' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'external_changes' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'user_edit_conflict' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'question_asked' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'budget_exceeded' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'budget_paused' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'continuation_needed' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'tiered_approval' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'cost_approval' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'task_review' }>, 'requestId'>;

export type IpcPromptResponse =
  | { kind: 'approval_needed'; approved: boolean; comment?: string | undefined; action?: 'edit' | undefined }
  | { kind: 'external_changes'; proceed: boolean }
  | { kind: 'user_edit_conflict'; selectedAction: UserEditConflictAction }
  | { kind: 'question_asked'; answer: string }
  | { kind: 'budget_exceeded'; proceed: boolean }
  | { kind: 'budget_paused'; decision: 'continue' | 'abort' | 'raise' }
  | { kind: 'continuation_needed'; text: string }
  | { kind: 'tiered_approval'; response: TieredApprovalResponse }
  | { kind: 'cost_approval'; approved: boolean }
  | { kind: 'task_review'; response: TaskReviewResponse };

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
    case 'cost_approval':
      return typeof value.approved === 'boolean'
        ? { kind: value.kind, approved: value.approved }
        : null;
    case 'task_review':
      return isTaskReviewResponse(value.response)
        ? { kind: value.kind, response: value.response }
        : null;
    default:
      return null;
  }
}

function isTaskReviewResponse(value: unknown): value is TaskReviewResponse {
  if (!isRecord(value)) return false;
  if (typeof value.action !== 'string' || !TASK_REVIEW_ACTIONS.has(value.action)) return false;
  if (value.notes !== undefined && typeof value.notes !== 'string') return false;
  return true;
}

export function parseServerMessage(value: unknown): ServerMessage | null {
  const result = ServerMessageSchema.safeParse(value);
  return result.success ? result.data : null;
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
