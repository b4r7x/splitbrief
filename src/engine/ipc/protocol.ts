import { z } from 'zod';
import {
  EngineEventSchema,
  taskReviewRequestFields,
  userEditConflictSchema,
} from '../events/schema.js';
import type { UserEditConflictAction } from '../../core/schemas/enums.js';
import { WorkflowModeSchema, ActionClassSchema, PhaseSchema } from '../../core/schemas/enums.js';
import { ClarificationQuestionSchema } from '../../core/schemas/question.js';
import type { TieredApprovalResponse } from '../../core/approval/types.js';
import { ApprovalTierSchema } from '../../core/schemas/config.js';
import { TaskIdSchema } from '../../core/schemas/task.js';
import { CostPredictionSchema } from '../../core/schemas/summary.js';
import { RecoveryReasonSchema, RecoveryActionSchema } from '../../core/schemas/enums.js';
import { isRecord } from '../../utils/type-guards.js';

const IpcRecoveryIssueSchema = z.object({
  reason: RecoveryReasonSchema,
  message: z.string(),
  availableActions: z.array(RecoveryActionSchema).min(1),
  recommendedAction: RecoveryActionSchema,
});

const TASK_REVIEW_ACTIONS = new Set<string>(['continue', 'redo-task', 'revise-plan', 'abort']);
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

const TaskReviewRequestSchema = z.object(taskReviewRequestFields).passthrough();

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
    code: z.union([z.literal('already_attached'), z.literal('unauthorized')]),
    message: z.string(),
  }),
  z.object({ kind: z.literal('server_complete') }),
]);

export type IpcPromptRequest = z.infer<typeof IpcPromptRequestSchema>;

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
  | Omit<Extract<IpcPromptRequest, { kind: 'task_review' }>, 'requestId'>
  | Omit<Extract<IpcPromptRequest, { kind: 'recovery_needed' }>, 'requestId'>;

export type IpcPromptResponse =
  | { kind: 'approval_needed'; approved: boolean; comment?: string; action?: 'edit' }
  | { kind: 'external_changes'; proceed: boolean }
  | { kind: 'user_edit_conflict'; selectedAction: UserEditConflictAction }
  | { kind: 'question_asked'; answer: string }
  | { kind: 'budget_exceeded'; proceed: boolean }
  | { kind: 'budget_paused'; decision: 'continue' | 'abort' | 'raise' }
  | { kind: 'continuation_needed'; text: string }
  | { kind: 'tiered_approval'; response: TieredApprovalResponse }
  | { kind: 'cost_approval'; approved: boolean }
  | {
      kind: 'task_review';
      response: { action: 'continue' | 'redo-task' | 'revise-plan' | 'abort'; notes?: string };
    }
  | { kind: 'recovery_needed'; action: string };

export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export type ClientMessage =
  | { kind: 'authenticate'; token: string }
  | { kind: 'user_input'; text: string }
  | { kind: 'prompt_response'; requestId: string; response: IpcPromptResponse }
  | { kind: 'detach' }
  | { kind: 'recovery_response'; issueId: string; action: string };

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

const VALID_USER_EDIT_CONFLICT_ACTIONS = new Set<string>([
  'continue-unrelated',
  'regenerate-rebase',
  'pause',
  'skip-current-task',
  'abort-workflow',
]);

function isUserEditConflictActionVal(value: unknown): value is UserEditConflictAction {
  return typeof value === 'string' && VALID_USER_EDIT_CONFLICT_ACTIONS.has(value);
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
    case 'external_changes':
      return typeof value.proceed === 'boolean'
        ? { kind: value.kind, proceed: value.proceed }
        : null;
    case 'user_edit_conflict':
      return typeof value.selectedAction === 'string' &&
        isUserEditConflictActionVal(value.selectedAction)
        ? { kind: value.kind, selectedAction: value.selectedAction }
        : null;
    case 'question_asked':
      return isBoundedString(value.answer, IPC_MAX_TEXT_BYTES)
        ? { kind: value.kind, answer: value.answer }
        : null;
    case 'budget_exceeded':
      return typeof value.proceed === 'boolean'
        ? { kind: value.kind, proceed: value.proceed }
        : null;
    case 'budget_paused':
      return value.decision === 'continue' ||
        value.decision === 'abort' ||
        value.decision === 'raise'
        ? { kind: value.kind, decision: value.decision }
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
    case 'task_review':
      return isRecord(value.response) &&
        typeof value.response.action === 'string' &&
        TASK_REVIEW_ACTIONS.has(value.response.action) &&
        (value.response.notes === undefined ||
          isBoundedString(value.response.notes, IPC_MAX_TEXT_BYTES))
        ? {
            kind: value.kind,
            response: {
              action: value.response.action as 'continue' | 'redo-task' | 'revise-plan' | 'abort',
              ...(value.response.notes !== undefined && { notes: value.response.notes }),
            },
          }
        : null;
    case 'recovery_needed':
      return isBoundedString(value.action, IPC_MAX_TEXT_BYTES)
        ? { kind: value.kind, action: value.action }
        : null;
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
  if (value.kind === 'prompt_response') {
    if (!isBoundedString(value.requestId, IPC_MAX_TEXT_BYTES)) return null;
    const response = parseIpcPromptResponse(value.response);
    return response ? { kind: value.kind, requestId: value.requestId, response } : null;
  }
  if (value.kind === 'detach') {
    return { kind: value.kind };
  }
  if (value.kind === 'recovery_response') {
    if (
      !isBoundedString(value.issueId, IPC_MAX_TEXT_BYTES) ||
      !isBoundedString(value.action, IPC_MAX_TEXT_BYTES)
    ) {
      return null;
    }
    return { kind: value.kind, issueId: value.issueId, action: value.action };
  }

  return null;
}
