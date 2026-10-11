import { SOFT_SEP } from '../../../core/separators.js';
import { formatDuration } from '../../../utils/format-time.js';
import type { EngineEvent } from '../../../engine/events/types.js';
import { getMaxVisibleDiffLines } from '../layout/diff-height.js';
import type { ConversationRowBlock, ConversationRowSegment, RowBuildContext } from './types.js';
import { compositeBlock, wholeSegmentsBlock, wrappedSegmentsBlock } from './row-block-compose.js';
import type { CardBodyLineInput } from './row-format/card-block.js';
import { ELLIPSIS, truncateTerminalDisplayTextMiddle } from '../../../utils/display-text.js';
import { sanitizeRowDisplayText } from './row-format/text.js';
import { wrapWidthFor } from './row-markers.js';

export const COLLAPSE_HINT = 'ctrl+d to collapse';

export function implementerDoneFilesBlock(
  keyPrefix: string,
  event: Extract<EngineEvent, { type: 'implementer_generate_done' }>,
  width: number,
  expanded: boolean,
): ConversationRowBlock | null {
  const files = event.files !== undefined && event.files.length > 0 ? event.files : [event.file];
  const kind = expanded ? 'card-top' : 'message';
  const budget = wrapWidthFor(kind, width);
  const chunks: ConversationRowSegment[][] = [];
  const append = (parts: ConversationRowSegment[], separator: string): void => {
    chunks.push([{ text: separator, tone: 'textDim' }, ...parts]);
  };
  for (const file of files) {
    append(
      [
        {
          text: truncateTerminalDisplayTextMiddle(sanitizeRowDisplayText(file), budget),
          tone: 'textDim',
          ...(expanded && { bold: true }),
        },
      ],
      SOFT_SEP,
    );
  }
  append([{ text: formatDuration(event.duration), tone: 'textDim' }], '  ');
  if (
    event.noChange !== true &&
    event.linesAdded !== undefined &&
    event.linesRemoved !== undefined
  ) {
    append(
      [
        { text: `+${event.linesAdded}`, tone: 'diffAdded' },
        { text: ` -${event.linesRemoved}`, tone: 'diffRemoved' },
      ],
      '  ',
    );
  }
  const hasDiff = sanitizeRowDisplayText(event.diff ?? '')
    .split('\n')
    .some((line) => line.length > 0);
  if (!expanded && hasDiff) append([{ text: 'ctrl+d', tone: 'textDim' }], '  ');
  return wholeSegmentsBlock(`${keyPrefix}-files`, chunks, width, kind);
}

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
  return compositeBlock(cardKey, [
    implementerDoneFilesBlock(cardKey, event, ctx.width, true),
    ...bodyLines.map((body, index) =>
      wrappedSegmentsBlock({
        keyPrefix: `${cardKey}-body-${index}`,
        segments: body.segments ?? [{ text: body.text, tone: body.tone ?? 'textDim' }],
        width: ctx.width,
        kind: 'card-body',
        indent: 2,
      }),
    ),
  ]);
}
