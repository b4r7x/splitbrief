import type { TokenUsage, TaskTokenUsage } from '../../../core/schemas/tokens.js';
import type { CallUsageEvidence } from '../../../core/schemas/usage-evidence.js';

export type CostBreakdownOptions = {
  tokenUsage: TokenUsage;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  reviewerTool?: string | undefined;
  reviewerModel?: string | undefined;
  taskBreakdowns?: TaskTokenUsage[] | undefined;
  /**
   * Per-call usage records for this run. Present, they price every provider
   * request on its own; absent, the breakdown is the run-wide sum alone and
   * carries no request estimate.
   */
  callEvidence?: readonly CallUsageEvidence[] | undefined;
};
