import { sanitizeWorkflowDisplayText } from '../display/safe-text.js';
import { wrapHard } from '../../../utils/wrap.js';
import type {
  ConversationRow,
  ConversationRowKind,
  ConversationRowSegment,
  ConversationRowTone,
} from './types.js';

const MIN_ROW_WIDTH = 1;
const LINE_BREAK_PLACEHOLDER_PREFIX = '\ue000diptych-line-break';

export interface RowInput {
  key: string;
  text: string;
  tone?: ConversationRowTone;
  bold?: boolean;
  kind?: ConversationRowKind;
}

export function row(input: RowInput): ConversationRow {
  const { key, text, tone = 'text', bold = false, kind = 'message' } = input;
  return { key, kind, segments: [{ text: sanitizeRowDisplayText(text), tone, bold }] };
}

export function blankRow(key: string): ConversationRow {
  return row({ key, text: '', kind: 'spacer' });
}

export function rowText(rowValue: ConversationRow): string {
  return rowValue.segments.map((segment) => segment.text).join('');
}

function wrapText(text: string, width: number): string[] {
  return wrapHard(sanitizeRowDisplayText(text), Math.max(MIN_ROW_WIDTH, width)).split('\n');
}

function segmentedRow(
  key: string,
  segments: ConversationRowSegment[],
  kind: ConversationRowKind,
): ConversationRow {
  return {
    key,
    kind,
    segments: segments.map((segment) => ({
      ...segment,
      text: sanitizeRowDisplayText(segment.text),
    })),
  };
}

export function sanitizeRowDisplayText(text: string): string {
  if (!text.includes('\n')) return sanitizeWorkflowDisplayText(text);

  const placeholder = unusedLineBreakPlaceholder(text);
  return sanitizeWorkflowDisplayText(text.replaceAll('\n', placeholder)).replaceAll(
    placeholder,
    '\n',
  );
}

function unusedLineBreakPlaceholder(text: string): string {
  let index = 0;
  let placeholder = `${LINE_BREAK_PLACEHOLDER_PREFIX}-${index}\ue000`;
  while (text.includes(placeholder)) {
    index += 1;
    placeholder = `${LINE_BREAK_PLACEHOLDER_PREFIX}-${index}\ue000`;
  }
  return placeholder;
}

export interface EventRowsInput {
  keyPrefix: string;
  text: string;
  width: number;
  tone: ConversationRowTone;
  bold?: boolean;
  kind?: ConversationRowKind;
}

export function eventWrappedRows(input: EventRowsInput): ConversationRow[] {
  const { keyPrefix, text, width, tone, bold = false, kind = 'message' } = input;
  const rows: ConversationRow[] = [];
  const cleanText = sanitizeRowDisplayText(text);

  for (const rawLine of cleanText.split('\n')) {
    const wrapped = wrapText(rawLine, width);
    for (const wrappedLine of wrapped) {
      rows.push(row({ key: `${keyPrefix}-${rows.length}`, text: wrappedLine, tone, bold, kind }));
    }
  }

  return rows;
}

export interface CardRowsInput {
  keyPrefix: string;
  label: string;
  value: string | undefined;
  width: number;
  labelTone: ConversationRowTone;
  valueTone?: ConversationRowTone;
  kind?: ConversationRowKind;
}

export function cardRows(input: CardRowsInput): ConversationRow[] {
  const { keyPrefix, label, value, width, labelTone, valueTone = 'textDim', kind = 'card' } = input;
  const cleanLabel = sanitizeRowDisplayText(label);
  const cleanValue = value === undefined ? undefined : sanitizeRowDisplayText(value);
  const labelText = cleanValue ? `${cleanLabel}  ` : cleanLabel;
  const text = `${labelText}${cleanValue ?? ''}`;
  const wrapped = wrapText(text, width);
  return wrapped.map((line, index) => {
    if (index > 0 || !cleanValue) {
      return row({
        key: `${keyPrefix}-${index}`,
        text: line,
        tone: index > 0 ? valueTone : labelTone,
        kind,
      });
    }
    return segmentedRow(
      `${keyPrefix}-${index}`,
      [
        { text: labelText, tone: labelTone },
        { text: line.slice(labelText.length), tone: valueTone },
      ],
      kind,
    );
  });
}

export function wrapRows(rows: ConversationRow[], width: number): ConversationRow[] {
  const next: ConversationRow[] = [];
  for (const sourceRow of rows) {
    const text = rowText(sourceRow);
    const wrapped = wrapText(text, width);
    for (const line of wrapped) {
      next.push(
        row({
          key: `${sourceRow.key}-${next.length}`,
          text: line,
          tone: sourceRow.segments[0]?.tone ?? 'text',
          bold: sourceRow.segments[0]?.bold ?? false,
          kind: sourceRow.kind,
        }),
      );
    }
  }
  return next;
}
