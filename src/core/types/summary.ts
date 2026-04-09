export type PlannerTokenUsage = { inputTokens: number; outputTokens: number };
export type ImplementerTokenUsage = { inputTokens: number; outputTokens: number };

export interface TokenUsage {
  plannerInput: number;
  plannerOutput: number;
  implementerInput: number;
  implementerOutput: number;
  escalationInput: number;
  escalationOutput: number;
}

export type TaskCompletionMethod = 'local' | 'escalated-hint' | 'escalated-full' | 'failed' | 'skipped';

export interface TaskTokenUsage {
  taskId: string;
  taskTitle: string;
  method: TaskCompletionMethod;
  implementerTokens: number;
  escalationTokens: number;
  retryCount: number;
}

export interface CostBreakdown {
  hypotheticalCost: number;
  actualPlannerCost: number;
  actualImplementerCost: number;
  totalActualCost: number;
  savingsAmount: number;
  savingsPercentage: number;
  localCompletionRate: number;
}

export interface ImplementerResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  usage?: ImplementerTokenUsage | null | undefined;
}

export interface ValidationResult {
  passed: boolean;
  stage: 'typecheck' | 'lint' | 'test';
  error?: string | undefined;
  output?: string | undefined;
}

export interface Summary {
  feature: string;
  totalTasks: number;
  completedByLocal: number;
  escalatedToPlanner: number;
  skipped: number;
  failed: number;
  totalTime: number;
  tokenUsage: TokenUsage;
  estimatedCostSavings: string;
  escalationRate: number;
  taskBreakdown?: TaskTokenUsage[] | undefined;
  costBreakdown?: CostBreakdown | undefined;
  plannerTool?: string | undefined;
  implementerTool?: string | undefined;
}
