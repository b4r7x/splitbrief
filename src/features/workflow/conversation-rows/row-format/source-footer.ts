import { glyph } from '../../../../lib/glyphs.js';
import {
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text/truncate.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { countNoun } from '../../../../utils/pluralize.js';
import type { ConversationRowSegment } from '../types.js';

const FOOTER_GAP = ' · ';

interface SourceFooterInput {
  hidden: number;
  pointer?: ConversationRowSegment | undefined;
  width: number;
}

// One closing row for every block that shows part of something larger: a marker that can never be
// mistaken for content, what was left out and in what unit, and the one thing to act on. The count
// is dropped when nothing was left out, but the row and its marker stay — a bare path appearing
// only sometimes is what made a missing line invisible.
export function sourceFooterSegments(input: SourceFooterInput): ConversationRowSegment[] | null {
  const width = Math.max(1, input.width);
  const marker = footerMarker(width);
  const count = input.hidden > 0 ? `+ ${countNoun(input.hidden, 'more line')}` : '';
  if (count === '' && input.pointer === undefined) return null;

  const segments: ConversationRowSegment[] =
    marker.length === 0 ? [] : [{ text: marker, tone: 'border' }];
  let used = getTerminalCellWidth(marker);
  if (count !== '') {
    const countWidth = width - used;
    if (countWidth > 0) {
      const fittedCount = truncateTerminalDisplayText(count, countWidth);
      segments.push({ text: fittedCount, tone: 'textDim' });
      used += getTerminalCellWidth(fittedCount);
    }
  }
  if (input.pointer === undefined) return segments;

  const gap = count === '' ? '' : FOOTER_GAP;
  const gapWidth = getTerminalCellWidth(gap);
  const pointerWidth = width - used - gapWidth;
  if (pointerWidth <= 0) return segments;

  if (gap !== '') segments.push({ text: gap, tone: 'textDim' });
  segments.push({
    ...input.pointer,
    text: truncateTerminalDisplayText(
      truncateTerminalDisplayTextMiddle(input.pointer.text, pointerWidth),
      pointerWidth,
    ),
  });
  return segments;
}

function footerMarker(width: number): string {
  const full = `${glyph('treeLast')} `;
  if (getTerminalCellWidth(full) < width) return full;

  const compact = glyph('treeLast');
  return getTerminalCellWidth(compact) < width ? compact : '';
}
