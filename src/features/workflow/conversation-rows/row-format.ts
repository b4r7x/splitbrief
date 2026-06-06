import { wrapHard } from '../../../utils/wrap.js';
import type { GutterRole } from './event-role.js';
import type { ConversationRow, ConversationRowSegment, ConversationRowTone } from './types.js';

const MIN_ROW_WIDTH = 1;
const PLANNER_PREFIX = '│ ';
const PLANNER_CONTINUATION_PREFIX = '  ';
const IMPLEMENTER_PREFIX = '  ┆ ';
const IMPLEMENTER_CONTINUATION_PREFIX = '    ';

export function row(
  key: string,
  text: string,
  tone: ConversationRowTone = 'text',
  bold = false,
): ConversationRow {
  return { key, segments: [{ text, tone, bold }] };
}

export function blankRow(key: string): ConversationRow {
  return row(key, '');
}

export function rowText(rowValue: ConversationRow): string {
  return rowValue.segments.map((segment) => segment.text).join('');
}

function wrapText(text: string, width: number): string[] {
  return wrapHard(text, Math.max(MIN_ROW_WIDTH, width)).split('\n');
}

function segmentedRow(key: string, segments: ConversationRowSegment[]): ConversationRow {
  return { key, segments };
}

function rolePrefixes(role: GutterRole): { first: string; continuation: string } {
  if (role === 'planner')
    return { first: PLANNER_PREFIX, continuation: PLANNER_CONTINUATION_PREFIX };
  if (role === 'implementer')
    return { first: IMPLEMENTER_PREFIX, continuation: IMPLEMENTER_CONTINUATION_PREFIX };
  return { first: '', continuation: '' };
}

export interface PrefixedRowsInput {
  keyPrefix: string;
  text: string;
  width: number;
  tone: ConversationRowTone;
  role: GutterRole;
  bold?: boolean;
}

export function prefixedWrappedRows(input: PrefixedRowsInput): ConversationRow[] {
  const { keyPrefix, text, width, tone, role, bold = false } = input;
  const prefixes = rolePrefixes(role);
  const rows: ConversationRow[] = [];
  let isFirst = true;

  for (const rawLine of text.split('\n')) {
    const prefix = isFirst ? prefixes.first : prefixes.continuation;
    const wrapped = wrapText(rawLine, width - prefix.length);
    for (const wrappedLine of wrapped) {
      rows.push(row(`${keyPrefix}-${rows.length}`, `${prefix}${wrappedLine}`, tone, bold));
      isFirst = false;
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
}

export function cardRows(input: CardRowsInput): ConversationRow[] {
  const { keyPrefix, label, value, width, labelTone, valueTone = 'textDim' } = input;
  const labelText = value ? `${label}  ` : label;
  const text = `${labelText}${value ?? ''}`;
  const wrapped = wrapText(text, width);
  return wrapped.map((line, index) => {
    if (index > 0 || !value) {
      return row(`${keyPrefix}-${index}`, line, index > 0 ? valueTone : labelTone);
    }
    return segmentedRow(`${keyPrefix}-${index}`, [
      { text: labelText, tone: labelTone },
      { text: line.slice(labelText.length), tone: valueTone },
    ]);
  });
}

export function wrapRows(rows: ConversationRow[], width: number): ConversationRow[] {
  const next: ConversationRow[] = [];
  for (const sourceRow of rows) {
    const text = rowText(sourceRow);
    const wrapped = wrapText(text, width);
    for (const line of wrapped) {
      next.push(
        row(
          `${sourceRow.key}-${next.length}`,
          line,
          sourceRow.segments[0]?.tone ?? 'text',
          sourceRow.segments[0]?.bold ?? false,
        ),
      );
    }
  }
  return next;
}
