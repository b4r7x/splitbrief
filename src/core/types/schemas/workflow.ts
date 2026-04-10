import { z } from 'zod';
import { PhaseSchema } from './enums.js';
import { TaskSchema } from './task.js';
import { TokenUsageSchema } from './tokens.js';

export const WorkflowStateSchema = z.object({
  stateVersion: z.number(),
  phase: PhaseSchema,
  feature: z.string(),
  currentTaskIndex: z.number(),
  attempt: z.number(),
  tasks: z.array(TaskSchema),
  sessionId: z.string().nullable(),
  startedAt: z.string(),
  tokenUsage: TokenUsageSchema,
});
