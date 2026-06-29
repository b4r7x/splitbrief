import { glyph } from '../../../lib/glyphs.js';
import { cardRowsWindowSlice, countCardRows } from './row-format.js';
import type { ConversationRow, ConversationRowBlock, ConversationRowTone } from './types.js';

export type CalloutSeverity = 'error' | 'warning' | 'info';

// A frameless event callout: a colored left rule in the gutter (error red / warning yellow / info
// blue) plus a colored label and a dim body. Structure and color carry the signal instead of a box
// frame. Reuses the de-boxed card machinery (cell-aware wrapping, redaction, windowing) and swaps
// the body indent for a tinted rail.
function injectLeftRule(row: ConversationRow, tone: ConversationRowTone): ConversationRow {
  const bar = `${glyph('treeMid')} `;
  if (row.kind === 'card-top') {
    return { ...row, segments: [{ text: bar, tone }, ...row.segments] };
  }
  if (row.kind === 'card-body') {
    return { ...row, segments: [{ text: bar, tone }, ...row.segments.slice(1)] };
  }
  return row;
}

export function calloutRowsBlock(input: {
  keyPrefix: string;
  label: string;
  value: string | undefined;
  width: number;
  severity: CalloutSeverity;
}): ConversationRowBlock | null {
  const tone: ConversationRowTone = input.severity;
  const cardWidth = Math.max(1, input.width - 2);
  const bodyLines =
    input.value === undefined || input.value.length === 0
      ? []
      : ([{ text: input.value, tone: 'textDim' }] satisfies {
          text: string;
          tone: ConversationRowTone;
        }[]);
  const cardInput = {
    keyPrefix: input.keyPrefix,
    label: input.label,
    labelTone: tone,
    bodyLines,
    width: cardWidth,
  };
  const rowCount = countCardRows(cardInput);
  if (rowCount === 0) return null;

  return {
    key: input.keyPrefix,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      cardRowsWindowSlice({ ...cardInput, windowStart, windowEnd }).map((row) =>
        injectLeftRule(row, tone),
      ),
  };
}
