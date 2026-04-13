export function perTokenToPerMillion(perToken: number): number {
  return perToken * 1_000_000;
}

export function formatContextLength(tokens: number | undefined): string {
  if (tokens == null || tokens === 0) return '';
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  return `${Math.round(tokens / 1000)}K`;
}

export function formatPrice(perMillion: number | undefined): string {
  if (perMillion === undefined) return '';
  if (perMillion === 0) return 'FREE';
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}/1M`;
  if (perMillion < 1) return `$${perMillion.toFixed(2)}/1M`;
  return `$${perMillion.toFixed(perMillion % 1 === 0 ? 0 : 1)}/1M`;
}
