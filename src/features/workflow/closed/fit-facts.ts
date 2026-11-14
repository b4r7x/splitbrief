import { SOFT_SEP } from '../../../core/separators.js';
import {
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../utils/display-text/truncate.js';
import { ELLIPSIS } from '../../../utils/display-text/truncate.js';
import { segmentsForRowText } from '../../../utils/display-text/width.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { stripTerminalControls } from '../../../utils/display-text/sanitize.js';
import type { CopyTone } from './copy/types.js';

type FactSpan = Readonly<{ text: string; tone: CopyTone }>;

const SEPARATOR: FactSpan = { text: SOFT_SEP, tone: 'textDim' };

/**
 * The facts a row can seat, each whole and joined with ` · `: half a fact states a different
 * fact. The first fact names the row and the last one closes it (a stage ends on its time), so the
 * facts between them go first, from the right, and the last one goes after them. A first fact too wide for the budget
 * leaves nothing: the caller decides how that one is cut.
 */
export function fitFacts<Span extends FactSpan>(
  facts: readonly (readonly Span[])[],
  budget: number,
): (Span | FactSpan)[] {
  const kept = [...facts];
  while (kept.length > 2 && factCells(kept) > budget) kept.splice(-2, 1);
  while (kept.length > 0 && factCells(kept) > budget) kept.pop();
  return kept.flatMap<Span | FactSpan>((fact, index) =>
    index === 0 ? fact : [SEPARATOR, ...fact],
  );
}

/** One fact cut in the middle, so a path keeps its directory and its file name. */
export function cutFactMiddle<Span extends FactSpan>(
  fact: readonly Span[],
  budget: number,
): Span[] {
  const clean = fact.map((span) => ({ ...span, text: stripTerminalControls(span.text) }));
  const text = clean.map((span) => span.text).join('');
  const fitted = truncateTerminalDisplayTextMiddle(text, budget);
  const head = truncateTerminalDisplayText(text, Math.floor((budget - 1) / 2) + 1).slice(
    0,
    -ELLIPSIS.length,
  );
  const tail = fitted.slice(head.length + ELLIPSIS.length);
  return [
    ...segmentsForRowText(clean, head),
    ...segmentsForRowText(clean, ELLIPSIS, head.length),
    ...segmentsForRowText(clean, tail, text.length - tail.length),
  ];
}

function factCells(facts: readonly (readonly FactSpan[])[]): number {
  return getTerminalCellWidth(
    facts.map((fact) => fact.map((span) => span.text).join('')).join(SOFT_SEP),
  );
}
