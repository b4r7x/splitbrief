import { z } from 'zod';
import { TaskCompletionMethodSchema } from './enums.js';
import { TaskIdSchema } from './task.js';
import { TokenUsageSchema } from './tokens.js';

export const TaskTokenUsageSchema = z.object({
  taskId: TaskIdSchema,
  taskTitle: z.string(),
  method: TaskCompletionMethodSchema,
  implementerTokens: z.number().nonnegative(),
  escalationTokens: z.number().nonnegative(),
  retryCount: z.number().nonnegative(),
  cost: z.number().nonnegative().optional(),
  tool: z.string().optional(),
  model: z.string().optional(),
});

export const ProviderCostSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cost: z.number().nonnegative(),
});

export const CostBreakdownSchema = z.object({
  hypotheticalCost: z.number().nonnegative(),
  actualPlannerCost: z.number().nonnegative(),
  actualImplementerCost: z.number().nonnegative(),
  totalActualCost: z.number().nonnegative(),
  savingsAmount: z.number(),
  savingsPercentage: z.number(),
  localCompletionRate: z.number().nonnegative().max(1),
  providerCosts: z.record(z.string(), ProviderCostSchema).optional(),
});

export const SummarySchema = z.object({
  feature: z.string(),
  totalTasks: z.number().nonnegative(),
  completedByLocal: z.number().nonnegative(),
  escalatedToPlanner: z.number().nonnegative(),
  skipped: z.number().nonnegative(),
  failed: z.number().nonnegative(),
  totalTime: z.number().nonnegative(),
  tokenUsage: TokenUsageSchema,
  estimatedCostSavings: z.string(),
  escalationRate: z.number().nonnegative(),
  taskBreakdown: z.array(TaskTokenUsageSchema).optional(),
  costBreakdown: CostBreakdownSchema.optional(),
  plannerTool: z.string().optional(),
  plannerModel: z.string().optional(),
  implementerTool: z.string().optional(),
  implementerModel: z.string().optional(),
  phaseTimings: z.record(z.string(), z.number()).optional(),
});

export const CostPredictionSchema = z.object({
  estimatedTasks: z.number().nonnegative(),
  lowCost: z.number().nonnegative(),
  expectedCost: z.number().nonnegative(),
  highCost: z.number().nonnegative(),
  plannerTool: z.string(),
  implementerTool: z.string(),
});
