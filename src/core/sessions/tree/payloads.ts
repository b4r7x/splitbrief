import { z } from 'zod';
import { TaskIdSchema } from '../../schemas/task.js';
import {
  RecoveryReasonSchema,
  RecoveryActionSchema,
  PhaseSchema,
  FileActionSchema,
} from '../../schemas/enums.js';
import {
  RUNNER_CALL_BACKEND_KINDS,
  RUNNER_CALL_ROLES,
  RUNNER_CALL_STATUSES,
  RunnerCallUsageContractSchema,
} from '../../runner-call-contract.js';

const AGENT_INVOCATION_STATUSES = ['started', ...RUNNER_CALL_STATUSES] as const;

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
  callId: z.string().optional(),
  role: z.enum(RUNNER_CALL_ROLES),
  backendKind: z.enum(RUNNER_CALL_BACKEND_KINDS).optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
  attempt: z.number().int().nonnegative().optional(),
  phase: PhaseSchema,
  status: z.enum(AGENT_INVOCATION_STATUSES),
  startedAt: z.number().int().nonnegative().optional(),
  endedAt: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  usage: RunnerCallUsageContractSchema.nullable().optional(),
  partial: z.boolean().optional(),
  warningCount: z.number().int().nonnegative().optional(),
  warningCodes: z.array(z.string().min(1).max(256)).max(64).optional(),
  errorCode: z.string().optional(),
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
