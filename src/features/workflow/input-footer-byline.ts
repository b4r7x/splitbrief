import { SOFT_SEP } from '../../components/separators.js';
import { glyph } from '../../lib/glyphs.js';
import { getTerminalCellWidth, truncateTerminalDisplayText } from '../../utils/display-text.js';
import { getChromeContentWidth } from './layout/chrome-rows.js';

export interface InputFooterBylineInput {
  cols: number;
  lead: string;
  queuedText: string | null;
  etaText: string | null;
  gitLabel: string;
  advisoryText: string | null;
  copyHint?: string | null;
  worktreeLabel?: string | null;
}

function joinBylineParts(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => part !== null && part !== undefined && part.length > 0)
    .join(SOFT_SEP);
}

function bylineCells(text: string): number {
  return getTerminalCellWidth(text);
}

export interface InputFooterByline {
  lead: string;
  queued: string;
  rest: string;
}

export function buildInputFooterByline(input: InputFooterBylineInput): InputFooterByline {
  const width = getChromeContentWidth(input.cols);
  const queuedPart = input.queuedText && input.queuedText.length > 0 ? input.queuedText : null;

  const candidates: Array<{ queued: boolean; tail: (string | null)[] }> = [
    { queued: true, tail: [input.etaText, input.gitLabel, input.advisoryText] },
    { queued: true, tail: [input.etaText, input.gitLabel] },
    { queued: true, tail: [input.gitLabel] },
    { queued: true, tail: [] },
    { queued: false, tail: [] },
  ];

  let leadOut = input.lead;
  let queuedIncluded = false;
  let tail: (string | null)[] = [];
  let line = '';
  let matched = false;

  for (const candidate of candidates) {
    const candidateStr = joinBylineParts([
      input.lead,
      candidate.queued ? queuedPart : null,
      ...candidate.tail,
    ]);
    if (bylineCells(candidateStr) <= width) {
      line = candidateStr;
      queuedIncluded = candidate.queued;
      tail = candidate.tail;
      matched = true;
      break;
    }
  }

  if (!matched) {
    leadOut = truncateTerminalDisplayText(input.lead, width);
    line = leadOut;
  }

  const queuedOut =
    queuedIncluded && queuedPart !== null
      ? leadOut.length > 0
        ? `${SOFT_SEP}${queuedPart}`
        : queuedPart
      : '';
  const restCore = joinBylineParts(tail);
  let restOut =
    restCore.length > 0
      ? leadOut.length > 0 || queuedOut.length > 0
        ? `${SOFT_SEP}${restCore}`
        : restCore
      : '';

  const copyFull = input.copyHint && input.copyHint.length > 0 ? input.copyHint : null;
  if (copyFull) {
    const copyBare = copyFull.split(' ')[0] ?? copyFull;
    const copyVariants = copyBare === copyFull ? [copyFull] : [copyFull, copyBare];
    for (const variant of copyVariants) {
      const combined = joinBylineParts([line, variant]);
      if (bylineCells(combined) <= width) {
        restOut += combined.slice(line.length);
        line = combined;
        break;
      }
    }
  }

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

  return { lead: leadOut, queued: queuedOut, rest: restOut };
}
