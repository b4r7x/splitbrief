import type { ConversationRowKind, ConversationRowTone } from '../types.js';
import type { ConversationRow } from '../types.js';
import { row, segmentedRow } from './rows.js';
import { sanitizeRowDisplayText, wrappedRowTexts } from './text.js';

export interface CardRowsLayout {
  labelText: string;
  hasValue: boolean;
  wrapped: string[];
}

export interface CardRowsWindowInput extends CardRowsLayout {
  keyPrefix: string;
  labelTone: ConversationRowTone;
  valueTone?: ConversationRowTone;
  kind?: ConversationRowKind;
  markerTone?: ConversationRowTone;
  windowStart: number;
  windowEnd: number;
}

// Wrapping is done once per card, at block construction, and the lines are reused for every window.
// Re-wrapping inside createRows made each scroll step cost the whole card again.
export function cardRowsLayout(input: {
  label: string;
  value: string | undefined;
  width: number;
}): CardRowsLayout {
  const cleanLabel = sanitizeRowDisplayText(input.label);
  const cleanValue = input.value === undefined ? undefined : sanitizeRowDisplayText(input.value);
  const labelText = cleanValue ? `${cleanLabel}  ` : cleanLabel;
  return {
    labelText,
    hasValue: cleanValue !== undefined && cleanValue !== '',
    wrapped: wrappedRowTexts(`${labelText}${cleanValue ?? ''}`, input.width),
  };
}

export function cardRowsWindow(input: CardRowsWindowInput): ConversationRow[] {
  const {
    keyPrefix,
    labelText,
    hasValue,
    wrapped,
    labelTone,
    valueTone = 'textDim',
    kind = 'card',
    markerTone,
  } = input;
  const start = Math.max(0, input.windowStart);
  const end = Math.min(wrapped.length, Math.max(start, input.windowEnd));

  return wrapped.slice(start, end).map((line, offset) => {
    const index = start + offset;
    if (index > 0 || !hasValue) {
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
          { text: line.slice(0, labelText.length), tone: labelTone },
          { text: line.slice(labelText.length), tone: valueTone },
        ],
        kind,
      ),
      ...(markerTone === undefined ? {} : { markerTone }),
    };
  });
}
