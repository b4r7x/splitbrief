import { z } from 'zod';
import {
  CurrentCodeContextModeSchema,
  RunnerKindSchema,
  TaskCompletionMethodSchema,
  TaskContextFitSchema,
} from './enums.js';
import { TaskIdSchema } from './task.js';

export const RoutingReasonSchema = z
  .string()
  .transform((reason) =>
    reason.startsWith('Selected profile ')
      ? reason
          .replace(/(\((?:fits|tight|overflow)), estimated \d+\/\d+ tokens/, '$1')
          .replace(
            /(current code reduced to function-level context|current code truncated) from \d+ (?:whole-file|untruncated) tokens/g,
            '$1',
          )
      : reason,
  );

export const BriefExecutionSchema = z.object({
  taskId: TaskIdSchema,
  taskTitle: z.string(),
  method: TaskCompletionMethodSchema,
  retryCount: z.number().nonnegative(),
  tool: z.string().optional(),
  kind: RunnerKindSchema.optional(),
  model: z.string().optional(),
  implementerProfile: z.string().optional(),
  contextFit: TaskContextFitSchema.optional(),
  currentCodeTruncated: z.boolean().optional(),
  currentCodeContextMode: CurrentCodeContextModeSchema.optional(),
  routingReason: RoutingReasonSchema.optional(),
});

export type BriefExecution = z.infer<typeof BriefExecutionSchema>;
