import { z } from 'zod';
import { PhaseSchema } from './enums.js';
import { TaskSchema } from './task.js';
import { TokenUsageSchema } from './tokens.js';
import { AnalyzeResultSchema } from './analyze.js';
import { RecoveryIssueSchema } from './recovery.js';

export const DiscoveredValidationSchema = z.object({
  typecheckCommand: z.string().optional(),
  lintCommand: z.string().optional(),
  testCommand: z.string().optional(),
  testPattern: z.string().optional(),
  language: z.string().optional(),
});

export type DiscoveredValidation = z.infer<typeof DiscoveredValidationSchema>;

export const QueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  queuedAt: z.string(),
  phase: PhaseSchema,
  deliveredViaNative: z.boolean(),
  drainedAt: z.string().optional(),
  origin: z.enum(['user-input', 'clarification']).optional(),
  question: z.string().optional(),
  questionId: z.string().optional(),
});

export const WorkflowStateSchema = z.object({
  stateVersion: z.number(),
  phase: PhaseSchema,
  feature: z.string(),
  currentTaskIndex: z.number(),
  attempt: z.number(),
  tasks: z.array(TaskSchema),
  plannerSessionId: z.string().nullable().optional(),
  startedAt: z.string(),
  tokenUsage: TokenUsageSchema,
  plannerTool: z.string().optional(),
  plannerModel: z.string().optional(),
  implementerTool: z.string().optional(),
  implementerModel: z.string().optional(),
  awaitingContinue: z.boolean().default(false),
  messageQueue: z.array(QueuedMessageSchema).default([]),
  rewindPending: z
    .object({
      target: z.enum(['spec', 'plan']),
      comment: z.string().optional(),
    })
    .optional(),
  clarifications: z
    .array(
      z.object({
        id: z.string(),
        question: z.string(),
        answer: z.string(),
      }),
    )
    .optional(),
  analysisResult: AnalyzeResultSchema.optional(),
  pendingRecovery: RecoveryIssueSchema.optional(),
  discoveredValidation: DiscoveredValidationSchema.optional(),
});

export type WorkflowState = z.infer<typeof WorkflowStateSchema>;
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;
