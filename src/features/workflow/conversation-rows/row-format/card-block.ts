import {
  getTerminalCellWidth,
  truncateTerminalDisplayText,
  truncateTerminalDisplayTextMiddle,
} from '../../../../utils/display-text.js';
import { wrapPathAware } from '../../../../utils/wrap.js';
import { wrapWidthFor } from '../row-markers.js';
import type {
  ConversationRow,
  ConversationRowKind,
  ConversationRowSegment,
  ConversationRowTone,
} from '../types.js';
import { segmentedRow } from './rows.js';
import { sanitizeRowDisplayText } from './text.js';

const CARD_MIN_WIDTH = 10;

function displayWidth(text: string): number {
  return getTerminalCellWidth(text);
}

export interface CardBodyLineInput {
  text: string;
  tone?: ConversationRowTone;
  bold?: boolean;
  segments?: ConversationRowSegment[];
}

export interface CardBlockInput {
  keyPrefix: string;
  label: string;
  labelTone?: ConversationRowTone;
  metaSegments?: ConversationRowSegment[];
  bodyLines: CardBodyLineInput[];
  width: number;
  bodyPrefix?: string;
  // The kinds the rows will actually render with. The write budget is derived from them, so a caller
  // whose rows carry a wider leading than a card's cannot compute one width and paint another.
  topKind?: ConversationRowKind;
  bodyKind?: ConversationRowKind;
}

export interface PreparedCardRows {
  rowCount: number;
  createRows: (windowStart: number, windowEnd: number) => ConversationRow[];
}

function fittedCardHeaderSegments(input: {
  label: string;
  labelTone: ConversationRowTone;
  metaSegments: ConversationRowSegment[] | undefined;
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
    segments.push({ ...segment, text, tone: segment.tone ?? 'textDim' });
    used += displayWidth(text);
  }

  if (used < input.width) {
    segments.push({ text: ' '.repeat(input.width - used) });
  }

  return segments;
}

// Segments pass through whole. Re-mapping them field by field is how a caller's href reached the
// card and never reached a row: the artifact filename rendered as plain text and every test that
// asserted on text and tone still passed.
function cardBodySegments(body: CardBodyLineInput): ConversationRowSegment[] {
  if (body.segments !== undefined && body.segments.length > 0) return body.segments;
  return [
    {
      text: body.text,
      tone: body.tone ?? 'text',
      ...(body.bold === true ? { bold: true } : {}),
    },
  ];
}

function cardBodyRowSegments(
  segments: ConversationRowSegment[],
  wrappedText: string,
  body: CardBodyLineInput,
  offset: number,
): ConversationRowSegment[] {
  const only = segments[0];
  if (segments.length === 1 && only !== undefined) {
    return [{ ...only, tone: only.tone ?? 'text', text: wrappedText }];
  }

  if (wrappedText === segments.map((segment) => segment.text).join('')) {
    return segments;
  }

  if (offset > 0) {
    return [{ text: wrappedText, tone: body.tone ?? 'textDim' }];
  }

  return [{ text: wrappedText, tone: segments[0]?.tone ?? 'text' }];
}

// Sanitizing and wrapping happen once, when the block is built; createRows only slices. Doing the
// wrap inside createRows made every scroll step re-walk the card's whole body.
export function prepareCardRows(input: CardBlockInput): PreparedCardRows {
  const width = Math.max(CARD_MIN_WIDTH, input.width);
  const topKind = input.topKind ?? 'card-top';
  const bodyKind = input.bodyKind ?? 'card-body';
  const headerWidth = wrapWidthFor(topKind, width);
  const bodyPrefix = input.bodyPrefix ?? '  ';
  const bodyWrapWidth = Math.max(
    1,
    wrapWidthFor(bodyKind, width) - getTerminalCellWidth(bodyPrefix),
  );
  const metaSegments =
    input.metaSegments === undefined
      ? undefined
      : input.metaSegments.map((segment) => ({
          ...segment,
          text: sanitizeRowDisplayText(segment.text),
        }));
  const headerSegments = fittedCardHeaderSegments({
    label: sanitizeRowDisplayText(input.label),
    labelTone: input.labelTone ?? 'textDim',
    metaSegments,
    width: headerWidth,
  });
  const bodies = input.bodyLines.map((body) => {
    const segments = cardBodySegments(body);
    return {
      body,
      segments,
      // Whole words, measured in the cells the rows paint: only a word wider than the row breaks.
      lines: wrapPathAware(
        sanitizeRowDisplayText(segments.map((segment) => segment.text).join('')),
        bodyWrapWidth,
      ).split('\n'),
    };
  });
  const rowCount = bodies.reduce((count, entry) => count + entry.lines.length, 1);

  return {
    rowCount,
    createRows: (windowStart, windowEnd) => {
      const rows: ConversationRow[] = [];
      const start = Math.max(0, windowStart);
      const end = Math.max(start, windowEnd);
      let rowIndex = 0;

      if (rowIndex >= start && rowIndex < end) {
        rows.push(segmentedRow(`${input.keyPrefix}-top`, headerSegments, topKind));
      }
      rowIndex += 1;

      for (const [index, entry] of bodies.entries()) {
        if (rowIndex >= end) return rows;
        const from = Math.max(0, start - rowIndex);
        const to = Math.min(entry.lines.length, end - rowIndex);
        for (let offset = from; offset < to; offset += 1) {
          const text = entry.lines[offset] ?? '';
          rows.push(
            segmentedRow(
              `${input.keyPrefix}-body-${index}-${offset}`,
              [
                ...(bodyPrefix === '' ? [] : [{ text: bodyPrefix }]),
                ...cardBodyRowSegments(entry.segments, text, entry.body, offset),
              ],
              bodyKind,
            ),
          );
        }
        rowIndex += entry.lines.length;
      }

      return rows;
    },
  };
}
