import type { ConversationRowKind, ConversationRowTone } from '../types.js';
import type { ConversationRow } from '../types.js';
import { row, segmentedRow } from './rows.js';
import { sanitizeRowDisplayText, wrappedRowTexts } from './text.js';

export interface CardRowsInput {
  keyPrefix: string;
  label: string;
  value: string | undefined;
  width: number;
  labelTone: ConversationRowTone;
  valueTone?: ConversationRowTone;
  kind?: ConversationRowKind;
  markerTone?: ConversationRowTone;
}

export interface CardRowsWindowInput extends CardRowsInput {
  windowStart: number;
  windowEnd: number;
}

export function cardRowsWindow(input: CardRowsWindowInput): ConversationRow[] {
  const {
    keyPrefix,
    label,
    value,
    width,
    labelTone,
    valueTone = 'textDim',
    kind = 'card',
    markerTone,
  } = input;
  const cleanLabel = sanitizeRowDisplayText(label);
  const cleanValue = value === undefined ? undefined : sanitizeRowDisplayText(value);
  const labelText = cleanValue ? `${cleanLabel}  ` : cleanLabel;
  const text = `${labelText}${cleanValue ?? ''}`;
  const wrapped = wrappedRowTexts(text, width);
  const start = Math.max(0, input.windowStart);
  const end = Math.min(wrapped.length, Math.max(start, input.windowEnd));

  return wrapped.slice(start, end).map((line, offset) => {
    const index = start + offset;
    if (index > 0 || !cleanValue) {
      return {
        ...row({
          key: `${keyPrefix}-${index}`,
          text: line,
          tone: index > 0 ? valueTone : labelTone,
          kind,
        }),
        ...(markerTone === undefined ? {} : { markerTone }),
      };
    }
    return {
      ...segmentedRow(
        `${keyPrefix}-${index}`,
        [
          { text: labelText, tone: labelTone },
          { text: line.slice(labelText.length), tone: valueTone },
        ],
        kind,
      ),
      ...(markerTone === undefined ? {} : { markerTone }),
    };
  });
}
