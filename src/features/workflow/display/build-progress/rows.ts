import { cutSeatIdentity } from '../../../../core/crew/seat-line/wrap.js';
import { SOFT_SEP } from '../../../../core/separators.js';
import { stripTerminalControls } from '../../../../utils/display-text/sanitize.js';
import { truncateTerminalDisplayText } from '../../../../utils/display-text/truncate.js';
import { getTerminalCellWidth, segmentsForRowText } from '../../../../utils/display-text/width.js';
import { buildProgressRowCount } from '../../layout/chrome-rows.js';
import { type BuildProgress, type BuildProgressSpan, spansText } from './derive.js';
import { countsSpans } from './counts.js';

/**
 * The same facts at every width, regrouped rather than dropped. Where the activity and freshness
 * share a row, the activity gives way: a long command is cut, never the clock that follows it. A
 * silence first loses its trailing description, cut from the end, then whole identity segments.
 * The seat label, tool word, work and silence clock stay.
 */
export function buildProgressRows(
  progress: BuildProgress,
  width: number,
): {
  key: string;
  text: string;
  spans: readonly BuildProgressSpan[];
}[] {
  const counts = progressRow('counts', countsSpans(progress), width);
  if (buildProgressRowCount(width) === 2) {
    const freshness = progress.silent
      ? fitSilenceTail(
          progress.freshness,
          width - getTerminalCellWidth(progress.activity + SOFT_SEP),
        )
      : progress.freshness;
    const tail: BuildProgressSpan[] =
      freshness.length > 0
        ? [
            { text: SOFT_SEP, tone: 'textDim' },
            ...segmentsForRowText(progress.freshnessSpans, freshness),
          ]
        : [];
    const activity = fitActivity(
      progress,
      Math.max(0, width - getTerminalCellWidth(spansText(tail))),
    );
    return [counts, progressRow('activity', [...activity, ...tail], width)];
  }
  return [
    counts,
    progressRow('activity', fitActivity(progress, width), width),
    progressRow(
      'freshness',
      segmentsForRowText(
        progress.freshnessSpans,
        progress.silent ? fitSilenceTail(progress.freshness, width) : progress.freshness,
      ),
      width,
    ),
  ];
}

function progressRow(key: string, spans: readonly BuildProgressSpan[], width: number) {
  const fitted = fitProgressSpans(spans, width);
  return { key, text: spansText(fitted), spans: fitted };
}

function fitProgressSpans(
  spans: readonly BuildProgressSpan[],
  width: number,
): readonly BuildProgressSpan[] {
  const clean = spans.map((span) => ({ ...span, text: stripTerminalControls(span.text) }));
  const text = spansText(clean);
  const fitted = truncateTerminalDisplayText(text, width);
  return segmentsForRowText(clean, fitted);
}

function fitSilenceTail(freshness: string, width: number): string {
  const clockEnd = freshness.indexOf(SOFT_SEP);
  const clock = clockEnd === -1 ? freshness : freshness.slice(0, clockEnd);
  return width <= getTerminalCellWidth(clock + SOFT_SEP)
    ? clock
    : truncateTerminalDisplayText(freshness, width);
}

function fitActivity(progress: BuildProgress, width: number): readonly BuildProgressSpan[] {
  const parts = progress.activityIdentity;
  if (parts === null) return fitProgressSpans(progress.activitySpans, width);
  const budget = Math.max(
    0,
    width - getTerminalCellWidth(spansText([...parts.prefix, ...parts.suffix])),
  );
  const identity = { ...parts.identity, text: cutSeatIdentity(parts.identity.text, budget) };
  const suffix = identity.text === '' ? parts.suffix.slice(1) : parts.suffix;
  const spans = [...parts.prefix, identity, ...suffix];
  return segmentsForRowText(spans, spansText(spans).trimEnd());
}
