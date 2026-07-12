import {
  getTerminalCellWidth,
  iterateTerminalGraphemes,
  sanitizeTerminalDisplayText,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../utils/display-text.js';
import { wrapHard } from '../../../utils/wrap.js';
import { wrapWidthFor } from './row-markers.js';
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

export function wrappedRowTexts(text: string, width: number): string[] {
  return wrapHard(sanitizeRowDisplayText(text), Math.max(MIN_ROW_WIDTH, width)).split('\n');
}

export function countWrappedRowTexts(text: string, width: number): number {
  return wrappedRowTexts(text, width).length;
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

export function sanitizeRowDisplayText(text: string): string {
  if (!text.includes('\n')) return sanitizeTerminalDisplayText(text);

  const placeholder = unusedLineBreakPlaceholder(text);
  return sanitizeTerminalDisplayText(text.replaceAll('\n', placeholder)).replaceAll(
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

const CARD_MIN_WIDTH = 10;

function displayWidth(text: string): number {
  return getTerminalCellWidth(text);
}

interface WrappedDisplayLine {
  offset: number;
  text: string;
}

interface WrappedDisplayLineWindow {
  lines: WrappedDisplayLine[];
  totalRows: number;
  exhausted: boolean;
}

function countHardWrappedDisplayLines(text: string, width: number): number {
  return wrappedDisplayLineWindow(text, width, 0, Number.POSITIVE_INFINITY).totalRows;
}

function wrappedDisplayLineWindow(
  text: string,
  width: number,
  windowStart: number,
  windowEnd: number,
): WrappedDisplayLineWindow {
  const maxWidth = Math.max(1, width);
  const start = Math.max(0, windowStart);
  const end = Math.max(start, windowEnd);
  const lines: WrappedDisplayLine[] = [];
  let offset = 0;
  let line = '';
  let lineWidth = 0;

  const emitLine = (): boolean => {
    if (offset >= start && offset < end) {
      lines.push({ offset, text: line });
    }
    offset += 1;
    line = '';
    lineWidth = 0;
    return offset >= end;
  };

  for (const grapheme of iterateTerminalGraphemes(text, { preserveLineBreaks: true })) {
    if (grapheme === '\n') {
      if (emitLine()) {
        return { lines, totalRows: offset, exhausted: false };
      }
      continue;
    }

    const graphemeWidth = displayWidth(grapheme);
    if (line.length > 0 && lineWidth + graphemeWidth > maxWidth) {
      if (emitLine()) {
        return { lines, totalRows: offset, exhausted: false };
      }
    }
    line += grapheme;
    lineWidth += graphemeWidth;
  }

  emitLine();
  return { lines, totalRows: offset, exhausted: true };
}

export interface CardBodyLineInput {
  text: string;
  tone?: ConversationRowTone;
  bold?: boolean;
  segments?: ConversationRowSegment[];
}

export interface CardMetaSegmentInput {
  text: string;
  tone?: ConversationRowTone;
}

export interface CardBlockInput {
  keyPrefix: string;
  label: string;
  labelTone?: ConversationRowTone;
  metaSegments?: CardMetaSegmentInput[];
  bodyLines: CardBodyLineInput[];
  width: number;
  bodyPrefix?: string;
}

export function countCardRows(input: CardBlockInput): number {
  const width = Math.max(CARD_MIN_WIDTH, input.width);
  const bodyPrefix = input.bodyPrefix ?? '  ';
  const bodyWrapWidth = Math.max(
    1,
    wrapWidthFor('card-body', width) - getTerminalCellWidth(bodyPrefix),
  );
  let count = 1;
  for (const body of input.bodyLines) {
    const cleanBody = sanitizeRowDisplayText(cardBodyLineDisplayText(body));
    count += countHardWrappedDisplayLines(cleanBody, bodyWrapWidth);
  }
  return count;
}

function fittedCardHeaderSegments(input: {
  label: string;
  labelTone: ConversationRowTone;
  metaSegments: CardMetaSegmentInput[] | undefined;
  width: number;
}): ConversationRowSegment[] {
  if (input.width <= 0) return [];
  if (input.metaSegments === undefined || input.metaSegments.length === 0) {
    const text = truncateTerminalDisplayText(input.label, input.width);
    return [
      {
        text: `${text}${' '.repeat(Math.max(0, input.width - displayWidth(text)))}`,
        tone: input.labelTone,
        bold: true,
      },
    ];
  }

  const separator = '  ';
  const separatorWidth = displayWidth(separator);
  const metaWidth = input.metaSegments.reduce(
    (sum, segment) => sum + displayWidth(segment.text),
    0,
  );
  const labelBudget =
    metaWidth + separatorWidth < input.width
      ? input.width - metaWidth - separatorWidth
      : Math.max(1, Math.floor(input.width / 2));
  const segments: ConversationRowSegment[] = [];
  const label = truncateTerminalDisplayTextMiddle(input.label, labelBudget);
  let used = displayWidth(label);

  segments.push({ text: label, tone: input.labelTone, bold: true });
  if (used < input.width) {
    const fittedSeparator = ' '.repeat(Math.min(separatorWidth, input.width - used));
    segments.push({ text: fittedSeparator, tone: input.labelTone, bold: true });
    used += displayWidth(fittedSeparator);
  }

  for (const segment of input.metaSegments) {
    if (used >= input.width) break;
    const text = truncateTerminalDisplayText(segment.text, input.width - used);
    if (text.length === 0) continue;
    segments.push({ text, tone: segment.tone ?? 'textDim' });
    used += displayWidth(text);
  }

  if (used < input.width) {
    segments.push({ text: ' '.repeat(input.width - used) });
  }

  return segments;
}

function cardBodyLineDisplayText(body: CardBodyLineInput): string {
  if (body.segments !== undefined && body.segments.length > 0) {
    return body.segments.map((segment) => segment.text).join('');
  }
  return body.text;
}

interface ResolvedBodySegment {
  text: string;
  tone: ConversationRowTone;
  bold: boolean;
}

function cardBodySegments(body: CardBodyLineInput): ResolvedBodySegment[] {
  if (body.segments !== undefined && body.segments.length > 0) {
    return body.segments.map((segment) => ({
      text: segment.text,
      tone: segment.tone ?? 'text',
      bold: segment.bold === true,
    }));
  }
  return [
    {
      text: body.text,
      tone: body.tone ?? 'text',
      bold: body.bold === true,
    },
  ];
}

function cardBodyRowSegments(
  segments: ResolvedBodySegment[],
  wrappedText: string,
  body: CardBodyLineInput,
  offset: number,
): ConversationRowSegment[] {
  if (segments.length === 1) {
    return [
      {
        text: wrappedText,
        tone: segments[0]?.tone ?? 'text',
        ...(segments[0]?.bold === true ? { bold: true } : {}),
      },
    ];
  }

  const joined = segments.map((segment) => segment.text).join('');
  if (wrappedText.length === joined.length && wrappedText === joined) {
    return segments.map((segment) => ({
      text: segment.text,
      tone: segment.tone,
      ...(segment.bold === true ? { bold: true } : {}),
    }));
  }

  if (offset > 0) {
    return [{ text: wrappedText, tone: body.tone ?? 'textDim' }];
  }

  return [{ text: wrappedText, tone: segments[0]?.tone ?? 'text' }];
}

export function cardRowsWindowSlice(
  input: CardBlockInput & { windowStart: number; windowEnd: number },
): ConversationRow[] {
  const width = Math.max(CARD_MIN_WIDTH, input.width);
  const headerWidth = wrapWidthFor('card-top', width);
  const bodyPrefix = input.bodyPrefix ?? '  ';
  const bodyWrapWidth = Math.max(
    1,
    wrapWidthFor('card-body', width) - getTerminalCellWidth(bodyPrefix),
  );
  const label = sanitizeRowDisplayText(input.label);
  const metaSegments =
    input.metaSegments === undefined
      ? undefined
      : input.metaSegments.map((segment) => ({
          text: sanitizeRowDisplayText(segment.text),
          ...(segment.tone !== undefined ? { tone: segment.tone } : {}),
        }));
  const labelTone: ConversationRowTone = input.labelTone ?? 'textDim';

  const rows: ConversationRow[] = [];
  const start = Math.max(0, input.windowStart);
  const end = Math.max(start, input.windowEnd);
  let rowIndex = 0;

  const appendTop = (): void => {
    if (rowIndex < start || rowIndex >= end) {
      rowIndex += 1;
      return;
    }
    const segments = fittedCardHeaderSegments({
      label,
      labelTone,
      metaSegments,
      width: headerWidth,
    });
    rows.push(segmentedRow(`${input.keyPrefix}-top`, segments, 'card-top'));
    rowIndex += 1;
  };

  appendTop();

  for (const [index, body] of input.bodyLines.entries()) {
    if (rowIndex >= end) return rows;
    const bodySegments = cardBodySegments(body);
    const cleanBody = sanitizeRowDisplayText(bodySegments.map((segment) => segment.text).join(''));
    const bodyWindow = wrappedDisplayLineWindow(
      cleanBody,
      bodyWrapWidth,
      start - rowIndex,
      end - rowIndex,
    );
    for (const { offset, text } of bodyWindow.lines) {
      rows.push(
        segmentedRow(
          `${input.keyPrefix}-body-${index}-${offset}`,
          [
            ...(bodyPrefix === '' ? [] : [{ text: bodyPrefix }]),
            ...cardBodyRowSegments(bodySegments, text, body, offset),
          ],
          'card-body',
        ),
      );
    }
    if (!bodyWindow.exhausted) return rows;
    rowIndex += bodyWindow.totalRows;
  }

  return rows;
}
