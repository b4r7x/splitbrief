import type { ImplementerTokenUsage, TokenUsage, TaskTokenUsage, CostBreakdown } from './tokens.js';

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
  plannerName?: string;
  implementerName?: string;
}
