import type {
  ConversationRow,
  ConversationRowKind,
  ConversationRowSegment,
  ConversationRowTone,
} from '../types.js';
import { sanitizeRowDisplayText, wrappedRowTexts } from './text.js';

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

export function segmentedRow(
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

export function wrapRows(rows: ConversationRow[], width: number): ConversationRow[] {
  const next: ConversationRow[] = [];
  for (const sourceRow of rows) {
    const text = rowText(sourceRow);
    const wrapped = wrappedRowTexts(text, width);
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
