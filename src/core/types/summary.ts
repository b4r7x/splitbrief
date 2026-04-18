import type { z } from 'zod';
import type { TokenUsageSchema, TokenDeltaSchema } from '../schemas/tokens.js';
import type { TaskTokenUsageSchema, CostBreakdownSchema, SummarySchema, CostPredictionSchema } from '../schemas/summary.js';

export type { TaskCompletionMethod } from '../schemas/enums.js';
export { TASK_COMPLETION_METHODS } from '../schemas/enums.js';

export type TokenDelta = z.infer<typeof TokenDeltaSchema>;

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

export type TaskTokenUsage = z.infer<typeof TaskTokenUsageSchema>;

export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;

export interface ImplementerResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  usage?: TokenDelta | undefined;
}

export interface ValidationResult {
  passed: boolean;
  stage: 'tsc' | 'lint' | 'test';
  error?: string | undefined;
  output?: string | undefined;
}

export type CostPrediction = z.infer<typeof CostPredictionSchema>;

export type Summary = z.infer<typeof SummarySchema>;
