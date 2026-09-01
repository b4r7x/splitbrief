import type { PerTaskTokens, TaskAttemptTokens } from '../../../stores/workflow/tokens.js';
import type { tokensStore } from '../../../stores/workflow/tokens.js';
import { formatTokensShort } from '../../../core/formatting.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text.js';
import { SOFT_SEP } from '../../../components/separators.js';
import { resolveTaskPricingModel } from '../../../engine/providers/cost-math.js';
import { resolvePricing, type PricingMode } from '../../../engine/providers/pricing-resolver.js';
import { modelCacheStore } from '../../../stores/discovery/model-cache/state.js';

type PricingContext = NonNullable<ReturnType<typeof tokensStore.get>['pricingContext']>;

export type TaskRow = { taskId: string } & Pick<PerTaskTokens, 'title' | 'attempts'> & {
    totalTokens: number;
  };

function attemptHasTokens(attempt: TaskAttemptTokens): boolean {
  return (
    attempt.implementerTokens +
      attempt.escalationTokens +
      (attempt.implementerCacheReadTokens ?? 0) +
      (attempt.implementerCacheCreateTokens ?? 0) +
      (attempt.escalationCacheReadTokens ?? 0) +
      (attempt.escalationCacheCreateTokens ?? 0) >
    0
  );
}

export function buildTaskRows(perTask: Record<string, PerTaskTokens>): TaskRow[] {
  return Object.entries(perTask)
    .flatMap(([taskId, data]) => {
      const attempts = data.attempts ?? [];
      if (data.totalTokens === 0 && !attempts.some(attemptHasTokens)) return [];
      return [
        {
          taskId,
          title: data.title,
          totalTokens: data.totalTokens,
          attempts: data.attempts,
        },
      ];
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export function formatTotalTokens(totalTokens: number): string {
  if (totalTokens > 1000) {
    return `${formatTokensShort(totalTokens)} tok`;
  }
  return `${totalTokens} tok`;
}

function formatAttemptFit(attempt: TaskAttemptTokens): string {
  if (!attempt.contextFit) return '';
  if (attempt.estimatedTokens !== undefined && attempt.contextLength !== undefined) {
    return `fit ${attempt.contextFit} ${formatTokensShort(attempt.estimatedTokens)}/${formatTokensShort(attempt.contextLength)}`;
  }
  if (attempt.estimatedTokens !== undefined) {
    return `fit ${attempt.contextFit} ${formatTokensShort(attempt.estimatedTokens)}`;
  }
  return `fit ${attempt.contextFit}`;
}

function formatCostPostureLabel(costPosture: string | undefined): string {
  if (!costPosture) return '';
  const lower = costPosture.toLowerCase();
  if (lower.includes('unknown') && lower.includes('price')) return 'price unknown';
  if (lower.includes('unknown') && lower.includes('cost')) return 'cost unknown';
  if (lower.includes('unpriced')) return 'unpriced';
  if (lower.includes('local')) return 'local';
  return '';
}

function pricingModeLabel(mode: PricingMode): string {
  if (mode === 'unpriced-local') return 'local';
  if (mode === 'unpriced-cli' || mode === 'unpriced-meta') return 'unpriced';
  if (mode === 'unpriced-unknown') return 'price unknown';
  return '';
}

function formatAttemptPricingLabel(
  attempt: TaskAttemptTokens,
  pricingContext: PricingContext | null,
): string {
  const posture = formatCostPostureLabel(attempt.costPosture);
  if (posture) return posture;
  const implementerUsageTokens =
    attempt.implementerTokens +
    (attempt.implementerCacheReadTokens ?? 0) +
    (attempt.implementerCacheCreateTokens ?? 0);
  if (!pricingContext || implementerUsageTokens <= 0) return '';
  const taskTool = attempt.tool ?? pricingContext.implementerTool;
  const taskModel = resolveTaskPricingModel({
    taskTool,
    fallbackTool: pricingContext.implementerTool,
    taskModel: attempt.model,
    fallbackModel: pricingContext.implementerModel,
  });
  const pricing = resolvePricing(taskTool, modelCacheStore, taskModel);
  if (
    pricing.isPriced &&
    (((attempt.implementerCacheReadTokens ?? 0) > 0 && pricing.cacheReadPer1M === undefined) ||
      ((attempt.implementerCacheCreateTokens ?? 0) > 0 && pricing.cacheWritePer1M === undefined))
  ) {
    return 'price partially unknown';
  }
  return pricingModeLabel(pricing.pricingMode);
}

function shouldShowRoutingReason(attempt: TaskAttemptTokens, pricingLabel: string): boolean {
  if (attempt.contextFit === 'tight' || attempt.contextFit === 'overflow') return true;
  return pricingLabel.includes('unknown');
}

export function formatTaskAttemptMetadata(
  attempt: TaskAttemptTokens,
  pricingContext: PricingContext | null,
): string {
  const fit = formatAttemptFit(attempt);
  const pricing = formatAttemptPricingLabel(attempt, pricingContext);
  const routingReason =
    attempt.routingReason && shouldShowRoutingReason(attempt, pricing)
      ? `why ${sanitizeTerminalDisplayText(attempt.routingReason)}`
      : '';
  const parts = [
    attempt.implementerProfile
      ? `profile ${sanitizeTerminalDisplayText(attempt.implementerProfile)}`
      : '',
    fit,
    pricing,
    routingReason,
  ];
  return parts.filter(Boolean).join(SOFT_SEP);
}
