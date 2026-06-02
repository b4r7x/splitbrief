import { z } from 'zod';
import { TaskIdSchema } from '../../schemas/task.js';
import {
  RecoveryReasonSchema,
  RecoveryActionSchema,
  PhaseSchema,
  FileActionSchema,
} from '../../schemas/enums.js';

export const PlanStepPayloadSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
  file: z.string(),
  action: FileActionSchema,
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
  outcome: z
    .enum([
      'continued',
      'retry-current-task',
      'skipped-current-task',
      'aborted',
      'paused',
      'blocked',
    ])
    .optional(),
});
export type RecoveryDecisionPayload = z.infer<typeof RecoveryDecisionPayloadSchema>;

export const CostCheckpointPayloadSchema = z.object({
  totalCost: z.number().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  phase: PhaseSchema,
  taskId: TaskIdSchema.optional(),
  budgetRemaining: z.number().optional(),
});
export type CostCheckpointPayload = z.infer<typeof CostCheckpointPayloadSchema>;
