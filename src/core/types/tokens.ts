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

export interface TaskTokenUsage {
  taskId: string;
  taskTitle: string;
  method: 'local' | 'escalated-hint' | 'escalated-full' | 'failed' | 'skipped';
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
