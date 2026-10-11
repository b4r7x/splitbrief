import { countNoun } from '../utils/pluralize.js';
import { SOFT_SEP } from './separators.js';

export function formatScoreSummaryParts(
  score: number,
  counts: { errorCount: number; warningCount: number },
  label = 'score',
): Readonly<{ text: string; kind: 'score' | 'separator' | 'error' | 'warning' }>[] {
  const parts: ReturnType<typeof formatScoreSummaryParts> = [
    { text: `${label} ${score.toFixed(2)}`, kind: 'score' },
  ];
  if (counts.errorCount > 0)
    parts.push(
      { text: SOFT_SEP, kind: 'separator' },
      { text: countNoun(counts.errorCount, 'error'), kind: 'error' },
    );
  if (counts.warningCount > 0)
    parts.push(
      { text: SOFT_SEP, kind: 'separator' },
      { text: countNoun(counts.warningCount, 'warning'), kind: 'warning' },
    );
  return parts;
}

/** Floors: a context window may be shown smaller than it is, never larger. */
export function formatContextLength(tokens: number | undefined): string {
  if (tokens == null || tokens === 0) return '';
  if (tokens >= 1_000_000) {
    const millions = Math.floor(tokens / 100_000) / 10;
    return `${millions % 1 === 0 ? String(millions) : millions.toFixed(1)}M`;
  }
  return `${Math.floor(tokens / 1000)}K`;
}

export function formatCost(dollars: number): string {
  if (!Number.isFinite(dollars)) return '$0.00';
  return `$${Math.max(0, dollars).toFixed(2)}`;
}

export function formatTruncatedList(values: string[], max: number): string {
  const visible = values.slice(0, max).join(SOFT_SEP);
  const hidden = values.length - max;
  return hidden > 0 ? `${visible}${SOFT_SEP}+${hidden} more` : visible;
}
