import { isActiveKind } from './compose.js';
import { wrapWidthFor } from '../row-format/markers.js';
import { row } from '../row-format/rows.js';
import {
  sanitizeRowDisplayText,
  wrappedProseSegments,
  wrappedUserTexts,
} from '../row-format/text.js';
import type {
  ConversationRowTone,
  ConversationRowKind,
  ConversationRowBlock,
  ConversationRow,
} from '../types.js';

export function wrappedTextBlock(input: {
  keyPrefix: string;
  text: string;
  width: number;
  tone: ConversationRowTone;
  bold?: boolean;
  kind?: ConversationRowKind;
  /** Columns every wrapped line starts after, so a row reads as part of the row above it. */
  indent?: number;
  continuationIndent?: number;
}): ConversationRowBlock | null {
  const keyPrefix = input.keyPrefix;
  const indent = input.indent ?? 0;
  const continuationIndent = input.continuationIndent ?? 0;
  const wrapWidth = Math.max(1, wrapWidthFor(input.kind ?? 'message', input.width) - indent);
  const tone = input.tone;
  const bold = input.bold;
  const kind = input.kind;
  const lines = eventWrappedLines(
    sanitizeRowDisplayText(input.text),
    wrapWidth,
    indent,
    continuationIndent,
  );
  const rowCount = lines.length;
  if (rowCount === 0) return null;

  return {
    key: keyPrefix,
    rowCount,
    renderableUnits: 1,
    ...(kind !== undefined && isActiveKind(kind)
      ? { activeRowKey: `${keyPrefix}-${rowCount - 1}` }
      : {}),
    createRows: (windowStart, windowEnd) =>
      eventWrappedRowsWindow({
        keyPrefix,
        lines,
        tone,
        ...(bold !== undefined && { bold }),
        ...(kind !== undefined && { kind }),
        windowStart,
        windowEnd,
      }),
  };
}

export function promptTextBlock(input: {
  keyPrefix: string;
  text: string;
  width: number;
}): ConversationRowBlock | null {
  const wrapWidth = wrapWidthFor('prompt', input.width);
  const lines = wrappedUserTexts(input.text, wrapWidth);
  const rowCount = lines.length;
  if (rowCount === 0) return null;
  return {
    key: input.keyPrefix,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) => {
      const rows = eventWrappedRowsWindow({
        keyPrefix: input.keyPrefix,
        lines,
        tone: 'text',
        bold: true,
        kind: 'message',
        windowStart,
        windowEnd,
      });
      return rows.map((row) =>
        row.key === `${input.keyPrefix}-0` ? { ...row, kind: 'prompt' as const } : row,
      );
    },
  };
}

// Wrapping the whole body once, at block construction, is what keeps scrolling flat: the previous
// shape re-wrapped every line from the top of the event on each createRows call, so a long tool
// output cost its full length on every scroll step.
function eventWrappedLines(
  text: string,
  width: number,
  indent = 0,
  continuationIndent = 0,
): string[] {
  return wrappedProseSegments(
    [{ text, tone: 'textDim' }],
    width + indent,
    indent,
    continuationIndent,
  ).map((parts) => parts.map((part) => part.text).join(''));
}

function eventWrappedRowsWindow(input: {
  keyPrefix: string;
  lines: readonly string[];
  tone: ConversationRowTone;
  bold?: boolean;
  kind?: ConversationRowKind;
  windowStart: number;
  windowEnd: number;
}): ConversationRow[] {
  const start = Math.max(0, input.windowStart);
  const end = Math.max(start, input.windowEnd);
  const bold = input.bold ?? false;
  const kind = input.kind ?? 'message';

  return input.lines.slice(start, end).map((wrappedLine, offset) =>
    row({
      key: `${input.keyPrefix}-${start + offset}`,
      text: wrappedLine,
      tone: input.tone,
      bold,
      kind,
    }),
  );
}
