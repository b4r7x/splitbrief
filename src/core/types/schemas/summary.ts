import { z } from 'zod';
import { TaskCompletionMethodSchema } from './enums.js';
import { TaskIdSchema } from './task.js';
import { TokenUsageSchema } from './tokens.js';

export const TaskTokenUsageSchema = z.object({
  taskId: TaskIdSchema,
  taskTitle: z.string(),
  method: TaskCompletionMethodSchema,
  implementerTokens: z.number(),
  escalationTokens: z.number(),
  retryCount: z.number(),
});

export const CostBreakdownSchema = z.object({
  hypotheticalCost: z.number(),
  actualPlannerCost: z.number(),
  actualImplementerCost: z.number(),
  totalActualCost: z.number(),
  savingsAmount: z.number(),
  savingsPercentage: z.number(),
  localCompletionRate: z.number(),
});

export const SummarySchema = z.object({
  feature: z.string(),
  totalTasks: z.number(),
  completedByLocal: z.number(),
  escalatedToPlanner: z.number(),
  skipped: z.number(),
  failed: z.number(),
  totalTime: z.number(),
  tokenUsage: TokenUsageSchema,
  estimatedCostSavings: z.string(),
  escalationRate: z.number(),
  taskBreakdown: z.array(TaskTokenUsageSchema).optional(),
  costBreakdown: CostBreakdownSchema.optional(),
  plannerTool: z.string().optional(),
  implementerTool: z.string().optional(),
});
