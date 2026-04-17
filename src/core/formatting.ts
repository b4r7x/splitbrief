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
