import { SOFT_SEP } from '../../../core/separators.js';
import { ELLIPSIS } from '../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../utils/display-text/width.js';
import { wrapOnWords } from '../picker/byline.js';
import type { TerminalPane } from './types.js';

/**
 * A value line breaks at its own separators — never inside a segment, and never leaving the
 * separator hanging at a line end — so `Claude Code CLI · claude-sonnet-4` reads as two whole lines
 * on a card too narrow for one.
 */
function wrapValueLine(text: string, width: number): string[] {
  if (getTerminalCellWidth(text) <= width) return [text];
  const lines: string[] = [];
  let current = '';
  for (const segment of text.split(SOFT_SEP)) {
    const candidate = current === '' ? segment : `${current}${SOFT_SEP}${segment}`;
    if (current !== '' && getTerminalCellWidth(candidate) > width) {
      lines.push(current);
      current = segment;
      continue;
    }
    current = candidate;
  }
  return current === '' ? lines : [...lines, current];
}

function paneRowsThatFit(rows: readonly string[], slots: number): string[] {
  if (slots <= 0) return [];
  if (rows.length <= slots) return [...rows];
  const dense = rows.filter((line) => line !== '');
  if (dense.length <= slots) return dense;
  return markCut(dense.slice(0, slots), dense.length);
}

function markCut(lines: string[], sourceLength: number): string[] {
  if (lines.length >= sourceLength || lines.length === 0) return lines;
  const last = lines.at(-1);
  if (last === undefined || last.endsWith(ELLIPSIS)) return lines;
  return [...lines.slice(0, -1), `${last}${ELLIPSIS}`];
}

export function wrapPaneLines(pane: TerminalPane, width: number): string[] {
  return pane.lines.flatMap((line) =>
    typeof line !== 'string'
      ? wrapValueLine(line.whole, width)
      : line === ''
        ? ['']
        : wrapOnWords(line, width, Number.POSITIVE_INFINITY).lines,
  );
}

export function fitPaneLines(lines: readonly string[], slots: number): string[] {
  const rows = paneRowsThatFit(lines, slots);
  return rows.length < slots ? ['', ...rows] : rows;
}
