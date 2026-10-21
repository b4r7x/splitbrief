import { tokensStore, type TokensState } from '../../stores/workflow/tokens.js';
import { configStore } from '../../stores/project/config.js';
import { modelCacheStore } from '../../stores/discovery/model-cache/state.js';
import { routerStore, type RouteData } from '../../stores/navigation/router.js';
import { calculateCostBreakdown } from '../../engine/providers/cost/breakdown.js';
import { resolveCallUsageEvidence } from '../../engine/orchestrator/summary/call-evidence.js';
import { reconcileTokenUsage } from '../../engine/orchestrator/summary/usage-reconcile.js';
import { addRunnerCallUsageToTokenUsage } from '../../engine/orchestrator/tokens.js';
import { isReviewSeatCall } from '../../engine/calls/review-seat.js';
import type { CallUsageEvidence } from '../../core/schemas/usage-evidence.js';
import type { ModelCacheAccessor } from '../../engine/providers/model/resolution.js';
import { runSeatIdentity } from '../../core/providers/seat-identity.js';
import type { Config } from '../../core/schemas/config.js';
import { ZERO_TOKEN_USAGE } from '../../core/schemas/tokens.js';
import type { UsageDetailsInput } from './usage-details-model.js';
import { deriveUsageDetails, formatUsageMoney, statesAmount } from './usage-details-model.js';

/** Saved runs keep their saved rates; live runs price the calls they actually recorded. */
export function usageDetailsForRun(input: {
  route: RouteData;
  tokens: Pick<TokensState, 'tokenUsage' | 'pricingContext'>;
  config: Config | null;
  modelCache: ModelCacheAccessor;
}): UsageDetailsInput {
  const { route, tokens, config, modelCache } = input;
  if (route.screen !== 'workflow') return { tokenUsage: null, costBreakdown: null };
  if (route.execution.kind === 'at-rest') {
    return {
      tokenUsage: route.run.summary?.tokenUsage ?? tokens.tokenUsage,
      costBreakdown: route.run.summary?.costBreakdown ?? null,
    };
  }
  const evidence = resolveCallUsageEvidence(route.run.ref) ?? [];
  const observed = { ...ZERO_TOKEN_USAGE };
  for (const call of evidence) {
    if (call.usage !== null) {
      addRunnerCallUsageToTokenUsage(observed, liveSeatRole(call), call.usage);
    }
  }
  const tokenUsage =
    evidence.length === 0
      ? tokens.tokenUsage
      : reconcileTokenUsage(tokens.tokenUsage ?? ZERO_TOKEN_USAGE, observed);
  const identity = tokens.pricingContext ?? (config === null ? null : runSeatIdentity(config));
  const costBreakdown =
    identity === null
      ? null
      : calculateCostBreakdown(
          {
            ...identity,
            tokenUsage: tokenUsage ?? ZERO_TOKEN_USAGE,
            callEvidence: evidence,
          },
          modelCache,
        );
  return { tokenUsage, costBreakdown };
}

function liveSeatRole(call: CallUsageEvidence): CallUsageEvidence['role'] {
  if (call.role !== 'review') return call.role;
  return isReviewSeatCall({ role: call.role, phase: call.phase }) ? 'review' : 'planner';
}

/** The explicit copy command uses the same evidence and qualification as /usage. */
export function readCostText(): string | null {
  const route = routerStore.get();
  if (route.screen !== 'workflow') return null;
  const view = deriveUsageDetails(
    usageDetailsForRun({
      route,
      tokens: tokensStore.get(),
      config: configStore.get().config,
      modelCache: modelCacheStore,
    }),
  );
  const amount = formatUsageMoney(view.money);
  if (view.money.kind === 'estimate' && statesAmount(view.money)) {
    return `${amount} (catalog estimate)`;
  }
  if (view.money.kind === 'legacy') return `${amount} (legacy estimate; rates not recorded)`;
  return amount;
}
