import { Box } from 'ink';
import { useTheme, ThemeText as Text } from '../../../components/theme.js';
import { SOFT_SEP } from '../../../core/separators.js';
import { borderStyleFor } from '../../../lib/glyphs.js';
import { sanitizeTerminalDisplayText } from '../../../utils/display-text/sanitize.js';
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

/**
 * The read-only pane a terminal left row opens: fixed height matching
 * columnHeight so the right box never collapses.
 */
export function TerminalPaneCard({
  pane,
  contentWidth,
  height,
}: {
  pane: TerminalPane;
  contentWidth: number;
  height: number;
}) {
  const t = useTheme();
  const rows = paneRowsThatFit(
    pane.lines.flatMap((line) =>
      typeof line !== 'string'
        ? wrapValueLine(line.whole, contentWidth)
        : line === ''
          ? ['']
          : wrapOnWords(line, contentWidth, Number.POSITIVE_INFINITY).lines,
    ),
    height - 3,
  );
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      height={height}
      borderStyle={borderStyleFor('round')}
      borderColor={t.border}
      borderDimColor
      paddingX={1}
    >
      <Text color={t.text}>{sanitizeTerminalDisplayText(pane.label)}</Text>
      <Box height={1} />
      {rows.map((line, i) =>
        line === '' ? (
          <Box key={`blank-${i}`} height={1} />
        ) : (
          <Text key={`line-${i}`} color={t.textDim} wrap="truncate-end">
            {sanitizeTerminalDisplayText(line)}
          </Text>
        ),
      )}
    </Box>
  );
}
