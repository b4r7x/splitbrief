export type ModelTokenUsage = { inputTokens: number; outputTokens: number };
export type PlannerTokenUsage = ModelTokenUsage;
export type ImplementerTokenUsage = ModelTokenUsage;

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
  error?: string;
  usage?: ImplementerTokenUsage | null;
}

export interface ValidationResult {
  passed: boolean;
  stage: 'typecheck' | 'lint' | 'test';
  error?: string;
  output?: string;
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
  taskBreakdown?: TaskTokenUsage[];
  costBreakdown?: CostBreakdown;
  plannerTool?: string;
  implementerTool?: string;
}
