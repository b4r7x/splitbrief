import { prepareCardRows } from './row-format/card-block.js';
import type { ConversationRow, ConversationRowBlock, ConversationRowTone } from './types.js';

export type CalloutSeverity = 'error' | 'warning' | 'info';

// A frameless event callout: the colored left rule lives in the row leading (rowLeading maps
// callout kinds to `│ `), so structure and color carry the signal without a box frame.
function toCalloutRow(row: ConversationRow, tone: ConversationRowTone): ConversationRow {
  if (row.kind === 'card-top') return { ...row, kind: 'callout-top', markerTone: tone };
  if (row.kind === 'card-body') return { ...row, kind: 'callout-body', markerTone: tone };
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
  const bodyLines =
    input.value === undefined || input.value.length === 0
      ? []
      : ([{ text: input.value, tone: 'textDim' }] satisfies {
          text: string;
          tone: ConversationRowTone;
        }[]);
  const card = prepareCardRows({
    keyPrefix: input.keyPrefix,
    label: input.label,
    labelTone: tone,
    bodyLines,
    width: Math.max(1, input.width),
    bodyPrefix: '',
  });
  if (card.rowCount === 0) return null;

  return {
    key: input.keyPrefix,
    rowCount: card.rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      card.createRows(windowStart, windowEnd).map((row) => toCalloutRow(row, tone)),
  };
}
