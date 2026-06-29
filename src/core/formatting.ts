import { countNoun } from '../utils/pluralize.js';

export function formatScoreSummary(
  score: number,
  counts: { errorCount: number; warningCount: number },
  label = 'score',
): string {
  const parts = [`${label} ${score.toFixed(2)}`];
  if (counts.errorCount > 0) parts.push(countNoun(counts.errorCount, 'error'));
  if (counts.warningCount > 0) parts.push(countNoun(counts.warningCount, 'warning'));
  return parts.join(' · ');
}

export function formatContextLength(tokens: number | undefined): string {
  if (tokens == null || tokens === 0) return '';
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export function formatCost(dollars: number): string {
  if (!Number.isFinite(dollars)) return '$0.00';
  return `$${Math.max(0, dollars).toFixed(2)}`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return 'unknown';
  return `${Math.round(value)}%`;
}

export function formatCostFact(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return `$${value.toFixed(2)}`;
}

export function budgetPercentOf(currentCost: number, maxBudget: number): number {
  if (!Number.isFinite(currentCost) || !Number.isFinite(maxBudget) || maxBudget <= 0) return 0;
  return Math.round((currentCost / maxBudget) * 10_000) / 100;
}

export function formatKnownCost(amount: number, priceState: 'known' | 'partial'): string {
  if (priceState === 'known') return formatCost(amount);
  return amount > 0 ? `${formatCost(amount)} + unknown` : 'Unknown price';
}

export function formatTokensShort(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function formatTruncatedList(values: string[], max: number): string {
  const visible = values.slice(0, max).join(' · ');
  const hidden = values.length - max;
  return hidden > 0 ? `${visible} · +${hidden} more` : visible;
}
