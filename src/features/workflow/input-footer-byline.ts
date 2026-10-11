import { SOFT_SEP } from '../../core/separators.js';
import { glyph } from '../../lib/glyphs.js';
import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
  segmentsForRowText,
} from '../../utils/display-text.js';
import { getChromeContentWidth } from './layout/chrome-rows.js';
import type { ConversationRowSegment } from './conversation-rows/types.js';
import { separatedSpans } from './conversation-rows/row-format/text.js';

// The rail's fraction counts briefs that passed their checks, never the index of the one running:
// a run on its last brief must not read as finished.
export function stageFractionText(view: { passed: number; total: number }): string {
  return view.total > 0 ? `${view.passed}/${view.total}` : '';
}

export interface InputFooterBylineInput {
  cols: number;
  lead: readonly ConversationRowSegment[];
  /** The lead's own clock. It follows the lead and survives every width: the lead is cut first. */
  leadClock?: string | null | undefined;
  hintText?: string | null;
  queuedText: string | null;
  worktreeLabel?: string | null;
}

export function joinBylineParts(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== null && part !== undefined && part.length > 0)
    .join(SOFT_SEP);
}

function bylineCells(text: string): number {
  return getTerminalCellWidth(text);
}

export function buildInputFooterByline(
  input: InputFooterBylineInput,
): readonly ConversationRowSegment[] {
  const leadParts = input.lead;
  const lead = leadParts.map((part) => part.text).join('');
  // The byline renders inside the gutter, so its one measure is the chrome content width.
  const width = getChromeContentWidth(input.cols);
  const queuedPart = input.queuedText && input.queuedText.length > 0 ? input.queuedText : null;
  const hintPart = input.hintText && input.hintText.length > 0 ? input.hintText : null;
  const clockTail = input.leadClock && input.leadClock.length > 0 ? ` ${input.leadClock}` : '';
  const fullLead = `${lead}${clockTail}`;

  const candidates: Array<{ hint: boolean; queued: boolean }> = [
    { hint: true, queued: true },
    { hint: false, queued: true },
    { hint: false, queued: false },
  ];

  let leadOut = lead;
  let hintIncluded = false;
  let queuedIncluded = false;
  let line = '';
  let matched = false;

  for (const candidate of candidates) {
    const candidateStr = joinBylineParts([
      fullLead,
      candidate.hint ? hintPart : null,
      candidate.queued ? queuedPart : null,
    ]);
    if (bylineCells(candidateStr) <= width) {
      line = candidateStr;
      hintIncluded = candidate.hint;
      queuedIncluded = candidate.queued;
      matched = true;
      break;
    }
  }

  if (!matched) {
    leadOut = truncateTerminalDisplayText(lead, Math.max(1, width - bylineCells(clockTail)));
    line = `${leadOut}${clockTail}`;
  }

  const hintOut =
    hintIncluded && hintPart !== null
      ? leadOut.length + clockTail.length > 0
        ? `${SOFT_SEP}${hintPart}`
        : hintPart
      : '';
  const queuedOut =
    queuedIncluded && queuedPart !== null
      ? leadOut.length + clockTail.length > 0 || hintOut.length > 0
        ? `${SOFT_SEP}${queuedPart}`
        : queuedPart
      : '';
  let restOut = '';

  const worktree =
    input.worktreeLabel && input.worktreeLabel.length > 0 ? input.worktreeLabel : null;
  if (worktree) {
    const labeled = `${glyph('cursor')} ${worktree}`;
    const remaining = width - bylineCells(line) - bylineCells(SOFT_SEP);
    if (remaining > 0) {
      const fitted =
        bylineCells(labeled) <= remaining
          ? labeled
          : truncateTerminalDisplayText(labeled, remaining);
      const combined = joinBylineParts([line, fitted]);
      restOut += combined.slice(line.length);
      line = combined;
    }
  }

  return [
    ...segmentsForRowText(leadParts, leadOut),
    ...(clockTail === ''
      ? []
      : [{ text: clockTail, tone: 'textDim' } satisfies ConversationRowSegment]),
    ...separatedSpans(hintOut, 'textDim'),
    ...separatedSpans(queuedOut, 'info'),
    ...separatedSpans(restOut, 'textDim'),
  ];
}
