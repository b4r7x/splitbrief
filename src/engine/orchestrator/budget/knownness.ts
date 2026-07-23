import type { TaskTokenUsage, TokenUsage } from '../../../core/schemas/tokens.js';
import { calculateCostBreakdown } from '../../providers/cost/breakdown.js';
import type { ModelCacheAccessor } from '../../providers/model/resolution.js';
import {
  allocatedCacheTokens,
  buildProviderUsageSegment,
  resolveTaskPricingModel,
  splitTokens,
  type ProviderUsageSegment,
} from '../../providers/cost-math.js';
import { resolvePricing } from '../../providers/pricing-resolver.js';

export interface BudgetCostKnownness {
  currentKnownCost: number;
  isKnown: boolean;
  hasUnknownPaidUsage: boolean;
  hasLocalOnlyUnpricedUsage: boolean;
  unknownReason: string | null;
}

export type BudgetCheckOptions = {
  tokenUsage: TokenUsage;
  maxBudget: number;
  totalTasks: number;
  escalatedCount: number;
  plannerTool: string;
  implementerTool: string;
  plannerModel?: string | undefined;
  implementerModel?: string | undefined;
  taskBreakdowns?: TaskTokenUsage[] | undefined;
  pricingCache?: ModelCacheAccessor | undefined;
};

function pricingSubject(identity: ProviderUsageSegment): string {
  if (identity.model) return `${identity.tool}/${identity.pricing.name}`;
  return identity.tool;
}

function collectBudgetUsageIdentities(
  opts: Omit<BudgetCheckOptions, 'maxBudget'>,
): ProviderUsageSegment[] {
  const identities: ProviderUsageSegment[] = [];
  const addIdentity = (identity: ProviderUsageSegment) => {
    if (identity.usageTokens > 0) identities.push(identity);
  };
  const plannerInput = opts.tokenUsage.plannerInput + opts.tokenUsage.escalationInput;
  const plannerOutput = opts.tokenUsage.plannerOutput + opts.tokenUsage.escalationOutput;
  const plannerPricing = resolvePricing(opts.plannerTool, opts.pricingCache, opts.plannerModel);
  addIdentity(
    buildProviderUsageSegment({
      tool: opts.plannerTool,
      model: opts.plannerModel,
      pricing: plannerPricing,
      inputTokens: plannerInput,
      outputTokens: plannerOutput,
      cacheReadTokens: opts.tokenUsage.plannerCacheRead ?? 0,
      cacheCreateTokens: opts.tokenUsage.plannerCacheCreate ?? 0,
    }),
  );

  const totalImplementerTokens =
    opts.tokenUsage.implementerInput + opts.tokenUsage.implementerOutput;
  if (opts.taskBreakdowns === undefined) {
    const implementerPricing = resolvePricing(
      opts.implementerTool,
      opts.pricingCache,
      opts.implementerModel,
    );
    addIdentity(
      buildProviderUsageSegment({
        tool: opts.implementerTool,
        model: opts.implementerModel,
        pricing: implementerPricing,
        inputTokens: opts.tokenUsage.implementerInput,
        outputTokens: opts.tokenUsage.implementerOutput,
        cacheReadTokens: opts.tokenUsage.implementerCacheRead ?? 0,
        cacheCreateTokens: opts.tokenUsage.implementerCacheCreate ?? 0,
      }),
    );
    return identities;
  }

  let accountedTokens = 0;
  let accountedCacheReadTokens = 0;
  let accountedCacheCreateTokens = 0;
  for (const task of opts.taskBreakdowns) {
    const tool = task.tool ?? opts.implementerTool;
    const model = resolveTaskPricingModel({
      taskTool: tool,
      fallbackTool: opts.implementerTool,
      taskModel: task.model,
      fallbackModel: opts.implementerModel,
    });
    const split = splitTokens({
      tokens: task.implementerTokens,
      inputTotal: opts.tokenUsage.implementerInput,
      outputTotal: opts.tokenUsage.implementerOutput,
    });
    const cacheReadTokens =
      task.implementerCacheReadTokens ??
      allocatedCacheTokens({
        cacheTokens: opts.tokenUsage.implementerCacheRead,
        tokens: task.implementerTokens,
        totalTokens: totalImplementerTokens,
      });
    const cacheCreateTokens =
      task.implementerCacheCreateTokens ??
      allocatedCacheTokens({
        cacheTokens: opts.tokenUsage.implementerCacheCreate,
        tokens: task.implementerTokens,
        totalTokens: totalImplementerTokens,
      });
    const pricing = resolvePricing(tool, opts.pricingCache, model);
    addIdentity(
      buildProviderUsageSegment({
        tool,
        model,
        pricing,
        inputTokens: split.inputTokens,
        outputTokens: split.outputTokens,
        primaryTokens: task.implementerTokens,
        cacheReadTokens,
        cacheCreateTokens,
      }),
    );
    accountedTokens += task.implementerTokens;
    accountedCacheReadTokens += cacheReadTokens;
    accountedCacheCreateTokens += cacheCreateTokens;
  }

  const residualTokens = Math.max(0, totalImplementerTokens - accountedTokens);
  const residualCacheReadTokens = Math.max(
    0,
    (opts.tokenUsage.implementerCacheRead ?? 0) - accountedCacheReadTokens,
  );
  const residualCacheCreateTokens = Math.max(
    0,
    (opts.tokenUsage.implementerCacheCreate ?? 0) - accountedCacheCreateTokens,
  );
  if (residualTokens > 0 || residualCacheReadTokens > 0 || residualCacheCreateTokens > 0) {
    const split = splitTokens({
      tokens: residualTokens,
      inputTotal: opts.tokenUsage.implementerInput,
      outputTotal: opts.tokenUsage.implementerOutput,
    });
    const pricing = resolvePricing(opts.implementerTool, opts.pricingCache, opts.implementerModel);
    addIdentity(
      buildProviderUsageSegment({
        tool: opts.implementerTool,
        model: opts.implementerModel,
        pricing,
        inputTokens: split.inputTokens,
        outputTokens: split.outputTokens,
        cacheReadTokens: residualCacheReadTokens,
        cacheCreateTokens: residualCacheCreateTokens,
      }),
    );
  }

  return identities;
}

export function getBudgetCostKnownness(
  opts: Omit<BudgetCheckOptions, 'maxBudget'>,
): BudgetCostKnownness {
  const breakdown = calculateCostBreakdown(
    {
      tokenUsage: opts.tokenUsage,
      totalTasks: opts.totalTasks,
      escalatedCount: opts.escalatedCount,
      plannerTool: opts.plannerTool,
      implementerTool: opts.implementerTool,
      ...(opts.plannerModel !== undefined && { plannerModel: opts.plannerModel }),
      ...(opts.implementerModel !== undefined && { implementerModel: opts.implementerModel }),
      ...(opts.taskBreakdowns !== undefined && { taskBreakdowns: opts.taskBreakdowns }),
    },
    opts.pricingCache,
  );
  let hasUnknownPaidUsage = false;
  let hasLocalUnpricedUsage = false;
  let hasPricedUsage = false;
  let hasOtherUnpricedUsage = false;
  let unknownReason: string | null = null;

  for (const identity of collectBudgetUsageIdentities(opts)) {
    if (identity.pricing.isPriced) {
      hasPricedUsage = true;
      if (!identity.costKnown) {
        hasUnknownPaidUsage = true;
        unknownReason ??= `pricing unknown for ${pricingSubject(identity)}`;
      }
      continue;
    }
    if (identity.pricing.pricingMode === 'unpriced-local') {
      hasLocalUnpricedUsage = true;
      continue;
    }
    if (identity.pricing.pricingMode === 'unpriced-unknown') {
      hasUnknownPaidUsage = true;
      unknownReason ??= `pricing unknown for ${pricingSubject(identity)}`;
      continue;
    }
    hasOtherUnpricedUsage = true;
  }

  return {
    currentKnownCost: breakdown.totalActualCost,
    isKnown: !hasUnknownPaidUsage,
    hasUnknownPaidUsage,
    hasLocalOnlyUnpricedUsage:
      hasLocalUnpricedUsage && !hasPricedUsage && !hasOtherUnpricedUsage && !hasUnknownPaidUsage,
    unknownReason,
  };
}
