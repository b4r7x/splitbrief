import type { CheckoutStartNotice } from '../../../../core/schemas/readiness.js';
import { foldRow } from '../fold-row.js';
import { compositeBlock, rowsBlock } from './compose.js';
import { prepareCardRows } from '../row-format/card-block.js';
import type { ConversationRowBlock, ConversationRowTone } from '../types.js';

export type CalloutSeverity = 'error' | 'warning' | 'info';

export function calloutRowsBlock(input: {
  keyPrefix: string;
  label: string;
  /** A dim note beside the label, such as the clock a halt's quota comes back on. */
  meta?: string | undefined;
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
  // The callout rows lead with the colored rule (`rowLeading` maps the callout kinds to `│ `), so
  // their kinds go in: `prepareCardRows` sizes the header and body from the leading those kinds
  // render with, and a card's budget would overrun the row by the rule's two cells.
  const card = prepareCardRows({
    keyPrefix: input.keyPrefix,
    label: input.label,
    labelTone: tone,
    ...(input.meta !== undefined && { metaSegments: [{ text: input.meta, tone: 'textDim' }] }),
    bodyLines,
    width: Math.max(1, input.width),
    bodyPrefix: '',
    topKind: 'callout-top',
    bodyKind: 'callout-body',
  });
  if (card.rowCount === 0) return null;

  return {
    key: input.keyPrefix,
    rowCount: card.rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      card.createRows(windowStart, windowEnd).map((row) => ({ ...row, markerTone: tone })),
  };
}

export function checkoutFoldKey(index: number): string {
  return `checkout:${index}`;
}

export function checkoutWarningBlock(
  checkout: CheckoutStartNotice,
  index: number,
  width: number,
  expanded: boolean,
): ConversationRowBlock | null {
  const key = checkoutFoldKey(index);
  const fold = foldRow({ foldKey: key, expanded, hidden: ['Files and backup'], width });
  const notice = calloutRowsBlock({
    keyPrefix: key,
    label: 'This run edits your checkout',
    value: expanded ? [checkout.summary, ...checkout.details].join('\n') : checkout.summary,
    severity: 'warning',
    width,
  });
  const block = compositeBlock(key, [notice, rowsBlock(fold.key, [fold])]);
  return block === null ? null : { ...block, foldRowKey: fold.key };
}
