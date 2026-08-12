import { SOFT_SEP } from '../../../components/separators.js';
import { formatDuration } from '../../../utils/format-time.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { getMaxVisibleDiffLines } from '../layout/diff-height.js';
import type { ConversationRowBlock, ConversationRowSegment, RowBuildContext } from './types.js';
import { prepareCardRows, type CardBodyLineInput } from './row-format/card-block.js';
import { ELLIPSIS } from '../../../utils/display-text.js';
import { sanitizeRowDisplayText } from './row-format/text.js';

const COLLAPSE_HINT = 'ctrl+d to collapse';

// Polarity, not severity: an added line is not a success and a removed line is not an error, and
// reusing those tones left a diff unable to say so once the palette gained the distinction.
function diffLineTone(line: string): 'diffAdded' | 'diffRemoved' | 'diffContext' {
  if (line.startsWith('+ ')) return 'diffAdded';
  if (line.startsWith('- ')) return 'diffRemoved';
  return 'diffContext';
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
  const card = prepareCardRows({
    keyPrefix: cardKey,
    label: event.file,
    labelTone: 'textDim' as const,
    metaSegments: [
      { text: formatDuration(event.duration), tone: 'textDim' as const },
      { text: '  ', tone: 'textDim' as const },
      { text: `+${event.linesAdded}`, tone: 'diffAdded' as const },
      { text: ` -${event.linesRemoved}`, tone: 'diffRemoved' as const },
    ],
    bodyLines,
    width: ctx.width,
  });
  if (card.rowCount === 0) return null;

  return {
    key: cardKey,
    rowCount: card.rowCount,
    renderableUnits: 1,
    createRows: card.createRows,
  };
}
