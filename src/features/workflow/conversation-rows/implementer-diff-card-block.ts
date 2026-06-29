import { SOFT_SEP } from '../../../components/separators.js';
import { formatDuration } from '../../../utils/format-time.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { getMaxVisibleDiffLines } from '../layout/diff-height.js';
import type { ConversationRowBlock, ConversationRowSegment, RowBuildContext } from './types.js';
import {
  cardRowsWindowSlice,
  countCardRows,
  sanitizeRowDisplayText,
  type CardBodyLineInput,
} from './row-format.js';

const ELLIPSIS = '\u2026';
const COLLAPSE_HINT = 'ctrl+d to collapse';

function diffLineTone(line: string): 'success' | 'error' | 'textDim' {
  if (line.startsWith('+ ')) return 'success';
  if (line.startsWith('- ')) return 'error';
  return 'textDim';
}

export function implementerExpandedDiffCardBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_done' }>,
  ctx: RowBuildContext,
): ConversationRowBlock | null {
  const diffLines = sanitizeRowDisplayText(event.diff ?? '')
    .split('\n')
    .filter((line) => line.length > 0);
  if (diffLines.length === 0) return null;

  const maxLines = getMaxVisibleDiffLines(ctx.viewportRows);
  const visibleLines = diffLines.slice(0, maxLines);
  const remaining = diffLines.length - visibleLines.length;

  const bodyLines: CardBodyLineInput[] = visibleLines.map((line, index) => ({
    text: `${String(index + 1).padStart(3, '0')} ${line}`,
    tone: diffLineTone(line),
  }));
  if (remaining > 0) {
    const hintSegments: ConversationRowSegment[] = [
      { text: `${ELLIPSIS} ${remaining} more lines`, tone: 'textDim' },
      { text: SOFT_SEP, tone: 'textDim' },
      { text: COLLAPSE_HINT, tone: 'textDim' },
    ];
    bodyLines.push({
      text: hintSegments.map((segment) => segment.text).join(''),
      segments: hintSegments,
    });
  } else {
    bodyLines.push({ text: COLLAPSE_HINT, tone: 'textDim' });
  }

  const cardKey = `${keyPrefix}-diff-card`;
  const cardInput = {
    keyPrefix: cardKey,
    label: event.file,
    labelTone: 'textDim' as const,
    metaSegments: [
      { text: formatDuration(event.duration), tone: 'textDim' as const },
      { text: '  ', tone: 'textDim' as const },
      { text: `+${event.linesAdded}`, tone: 'success' as const },
      { text: ` -${event.linesRemoved}`, tone: 'error' as const },
    ],
    bodyLines,
    width: ctx.width - 2,
  };
  const rowCount = countCardRows(cardInput);
  if (rowCount === 0) return null;

  return {
    key: cardKey,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      cardRowsWindowSlice({ ...cardInput, windowStart, windowEnd }),
  };
}
