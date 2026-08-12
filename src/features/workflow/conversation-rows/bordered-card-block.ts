import type { ConversationRowBlock, ConversationRowTone } from './types.js';
import { prepareCardRows } from './row-format/card-block.js';
import { sanitizeRowDisplayText } from './row-format/text.js';

export function borderedCardRowsBlock(input: {
  keyPrefix: string;
  label: string;
  value: string | undefined;
  width: number;
  labelTone: ConversationRowTone;
  valueTone?: ConversationRowTone;
}): ConversationRowBlock | null {
  const keyPrefix = input.keyPrefix;
  const label = sanitizeRowDisplayText(input.label);
  const value = input.value === undefined ? undefined : sanitizeRowDisplayText(input.value);
  const labelTone = input.labelTone;
  const valueTone = input.valueTone;

  const cardWidth = Math.max(1, input.width);
  const bodyLines =
    value === undefined || value.length === 0
      ? []
      : [
          {
            text: value,
            ...(valueTone !== undefined ? { tone: valueTone } : {}),
          },
        ];

  const card = prepareCardRows({
    keyPrefix,
    label,
    labelTone,
    bodyLines,
    width: cardWidth,
  });
  if (card.rowCount === 0) return null;

  return {
    key: keyPrefix,
    rowCount: card.rowCount,
    renderableUnits: 1,
    createRows: card.createRows,
  };
}
