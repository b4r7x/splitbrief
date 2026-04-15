import { z } from 'zod';
import { PhaseSchema } from './enums.js';
import { TaskSchema } from './task.js';
import { TokenUsageSchema } from './tokens.js';

export const QueuedMessageSchema = z.object({
  id: z.string(),
  text: z.string(),
  queuedAt: z.string(),
  phase: PhaseSchema,
  deliveredViaNative: z.boolean(),
  drainedAt: z.string().optional(),
});

export const WorkflowStateSchema = z.object({
  stateVersion: z.number(),
  phase: PhaseSchema,
  feature: z.string(),
  currentTaskIndex: z.number(),
  attempt: z.number(),
  tasks: z.array(TaskSchema),
  plannerSessionId: z.string().nullable(),
  startedAt: z.string(),
  tokenUsage: TokenUsageSchema,
  plannerTool: z.string().optional(),
  plannerModel: z.string().optional(),
  implementerTool: z.string().optional(),
  implementerModel: z.string().optional(),
  awaitingContinue: z.boolean().default(false),
  messageQueue: z.array(QueuedMessageSchema).default([]),
  rewindPending: z.object({
    target: z.enum(['spec', 'plan']),
    comment: z.string().optional(),
  }).optional(),
});
