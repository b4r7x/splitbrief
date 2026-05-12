import { z } from 'zod';
import { TaskIdSchema } from '../../schemas/task.js';
import { RecoveryReasonSchema, RecoveryActionSchema, PhaseSchema } from '../../schemas/enums.js';

export const SessionStartPayloadSchema = z.object({
  feature: z.string(),
  mode: z.string().optional(),
  sessionId: z.string().optional(),
});
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;

export const PlanStepPayloadSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
  file: z.string(),
  action: z.enum(['create', 'modify']),
  description: z.string(),
  index: z.number().int().nonnegative(),
  total: z.number().int().positive(),
});
export type PlanStepPayload = z.infer<typeof PlanStepPayloadSchema>;

export const AgentInvocationPayloadSchema = z.object({
  taskId: TaskIdSchema.optional(),
  role: z.enum(['planner', 'implementer', 'escalator']),
  tool: z.string(),
  model: z.string().optional(),
  phase: PhaseSchema,
  status: z.enum(['started', 'completed', 'failed']),
  durationMs: z.number().int().nonnegative().optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type AgentInvocationPayload = z.infer<typeof AgentInvocationPayloadSchema>;

export const RecoveryDecisionPayloadSchema = z.object({
  issueId: z.string(),
  reason: RecoveryReasonSchema,
  taskId: TaskIdSchema.optional(),
  selectedAction: RecoveryActionSchema,
  availableActions: z.array(RecoveryActionSchema),
  message: z.string(),
  outcome: z.enum(['continued', 'retry-current-task', 'skipped-current-task', 'aborted', 'paused', 'blocked']).optional(),
});
export type RecoveryDecisionPayload = z.infer<typeof RecoveryDecisionPayloadSchema>;

export const FileStatePayloadSchema = z.object({
  path: z.string(),
  action: z.enum(['created', 'modified', 'deleted']),
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
  hash: z.string().optional(),
  taskId: TaskIdSchema.optional(),
});
export type FileStatePayload = z.infer<typeof FileStatePayloadSchema>;

export const CostCheckpointPayloadSchema = z.object({
  totalCost: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  phase: PhaseSchema,
  taskId: TaskIdSchema.optional(),
  budgetRemaining: z.number().optional(),
});
export type CostCheckpointPayload = z.infer<typeof CostCheckpointPayloadSchema>;

export const BranchSummaryPayloadSchema = z.object({
  goal: z.string(),
  progress: z.array(z.string()),
  decisions: z.array(z.string()),
  constraints: z.array(z.string()),
  nextSteps: z.array(z.string()),
  failureReason: z.string(),
  entryCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type BranchSummaryPayload = z.infer<typeof BranchSummaryPayloadSchema>;

const ENTRY_TYPES = [
  'session-start',
  'plan-step',
  'agent-invocation',
  'recovery-decision',
  'file-state',
  'cost-checkpoint',
  'branch-summary',
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
