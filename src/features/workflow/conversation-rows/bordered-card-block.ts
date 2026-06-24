import type { ConversationRowBlock, ConversationRowTone } from './types.js';
import { cardRowsWindowSlice, countCardRows, sanitizeRowDisplayText } from './row-format.js';

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

  const cardWidth = Math.max(1, input.width - 2);
  const bodyLines =
    value === undefined || value.length === 0
      ? []
      : [
          {
            text: value,
            ...(valueTone !== undefined ? { tone: valueTone } : {}),
          },
        ];

  const cardInput = {
    keyPrefix,
    label,
    labelTone,
    bodyLines,
    width: cardWidth,
  };
  const rowCount = countCardRows(cardInput);
  if (rowCount === 0) return null;

  return {
    key: keyPrefix,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      cardRowsWindowSlice({ ...cardInput, windowStart, windowEnd }),
  };
}
