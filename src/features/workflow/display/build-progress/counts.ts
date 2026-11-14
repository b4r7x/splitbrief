import { SOFT_SEP } from '../../../../core/separators.js';
import { stateTone } from '../../../../core/theme/state-tone.js';
import type { BuildProgressSpan, BuildProgress } from './derive.js';

export function passedCountSpans(count: string) {
  return [
    { text: `${count} `, tone: 'textDim' },
    { text: 'passed', tone: stateTone('passed') },
  ] satisfies BuildProgressSpan[];
}

export function passedFractionSpans(count: string) {
  return [{ text: `${count} passed`, tone: 'textDim' }] satisfies BuildProgressSpan[];
}

export function taskOutcomeCountsSpans(
  head: readonly BuildProgressSpan[],
  progress: Pick<BuildProgress, 'escalated' | 'failed'>,
): BuildProgressSpan[] {
  const parts: BuildProgressSpan[] = [...head];
  if (progress.escalated > 0)
    parts.push(
      { text: `${SOFT_SEP}${progress.escalated} `, tone: 'textDim' },
      { text: 'escalated', tone: stateTone('attention') },
    );
  if (progress.failed > 0)
    parts.push(
      { text: `${SOFT_SEP}${progress.failed} `, tone: 'textDim' },
      { text: 'failed', tone: stateTone('failed') },
    );
  return parts;
}

export function countsSpans(progress: BuildProgress): BuildProgressSpan[] {
  const parts = taskOutcomeCountsSpans(
    passedFractionSpans(`${progress.passed}/${progress.total} briefs`),
    progress,
  );
  if (progress.base !== null) parts.push({ text: SOFT_SEP, tone: 'textDim' }, ...progress.base);
  return parts;
}
