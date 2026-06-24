import type {
  ConversationRow,
  ConversationRowBlock,
  ConversationRowKind,
  ConversationRowTone,
} from './types.js';
import {
  cardRowsWindow,
  countWrappedRowTexts,
  row,
  sanitizeRowDisplayText,
  wrappedRowTexts,
  type RowInput,
} from './row-format.js';

export function rowsBlock(
  key: string,
  rows: readonly ConversationRow[],
): ConversationRowBlock | null {
  if (rows.length === 0) return null;
  const safeRows = rows.map((sourceRow) => ({
    ...sourceRow,
    segments: sourceRow.segments.map((segment) => ({
      ...segment,
      text: sanitizeRowDisplayText(segment.text),
    })),
  }));
  return {
    key,
    rowCount: safeRows.length,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) => safeRows.slice(windowStart, windowEnd),
  };
}

export function rowSeedsBlock(
  key: string,
  seeds: readonly RowInput[],
): ConversationRowBlock | null {
  if (seeds.length === 0) return null;
  const safeSeeds = seeds.map((seed) => ({
    ...seed,
    text: sanitizeRowDisplayText(seed.text),
  }));
  return {
    key,
    rowCount: safeSeeds.length,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      safeSeeds.slice(windowStart, windowEnd).map((seed) => row(seed)),
  };
}

export function wrappedTextBlock(input: {
  keyPrefix: string;
  text: string;
  width: number;
  tone: ConversationRowTone;
  bold?: boolean;
  kind?: ConversationRowKind;
}): ConversationRowBlock | null {
  const keyPrefix = input.keyPrefix;
  const text = sanitizeRowDisplayText(input.text);
  const width = input.width;
  const tone = input.tone;
  const bold = input.bold;
  const kind = input.kind;
  const rowCount = countEventWrappedRows(text, width);
  if (rowCount === 0) return null;

  return {
    key: keyPrefix,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      eventWrappedRowsWindow({
        keyPrefix,
        text,
        width,
        tone,
        ...(bold !== undefined && { bold }),
        ...(kind !== undefined && { kind }),
        windowStart,
        windowEnd,
      }),
  };
}

export function cardRowsBlock(input: {
  keyPrefix: string;
  label: string;
  value: string | undefined;
  width: number;
  labelTone: ConversationRowTone;
  valueTone?: ConversationRowTone;
  kind?: ConversationRowKind;
}): ConversationRowBlock | null {
  const keyPrefix = input.keyPrefix;
  const label = sanitizeRowDisplayText(input.label);
  const value = input.value === undefined ? undefined : sanitizeRowDisplayText(input.value);
  const width = input.width;
  const labelTone = input.labelTone;
  const valueTone = input.valueTone;
  const kind = input.kind;
  const labelText = value ? `${label}  ` : label;
  const rowCount = countWrappedRowTexts(`${labelText}${value ?? ''}`, width);
  if (rowCount === 0) return null;

  return {
    key: keyPrefix,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) =>
      cardRowsWindow({
        keyPrefix,
        label,
        value,
        width,
        labelTone,
        ...(valueTone !== undefined && { valueTone }),
        ...(kind !== undefined && { kind }),
        windowStart,
        windowEnd,
      }),
  };
}

export function compositeBlock(
  key: string,
  blocks: readonly (ConversationRowBlock | null)[],
): ConversationRowBlock | null {
  const children = blocks.filter((block): block is ConversationRowBlock => block !== null);
  if (children.length === 0) return null;
  const rowCount = children.reduce((count, block) => count + block.rowCount, 0);

  return {
    key,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) => {
      const rows: ConversationRow[] = [];
      const start = Math.max(0, windowStart);
      const end = Math.max(start, windowEnd);
      let cursor = 0;

      for (const block of children) {
        const blockStart = cursor;
        const blockEnd = cursor + block.rowCount;
        cursor = blockEnd;
        if (blockEnd <= start) continue;
        if (blockStart >= end) break;
        rows.push(
          ...block.createRows(
            Math.max(0, start - blockStart),
            Math.min(block.rowCount, end - blockStart),
          ),
        );
      }

      return rows;
    },
  };
}

function countEventWrappedRows(text: string, width: number): number {
  return text
    .split('\n')
    .reduce((count, rawLine) => count + countWrappedRowTexts(rawLine, width), 0);
}

function eventWrappedRowsWindow(input: {
  keyPrefix: string;
  text: string;
  width: number;
  tone: ConversationRowTone;
  bold?: boolean;
  kind?: ConversationRowKind;
  windowStart: number;
  windowEnd: number;
}): ConversationRow[] {
  const rows: ConversationRow[] = [];
  const start = Math.max(0, input.windowStart);
  const end = Math.max(start, input.windowEnd);
  const bold = input.bold ?? false;
  const kind = input.kind ?? 'message';
  let rowIndex = 0;

  for (const rawLine of input.text.split('\n')) {
    for (const wrappedLine of wrappedRowTexts(rawLine, input.width)) {
      if (rowIndex >= start && rowIndex < end) {
        rows.push(
          row({
            key: `${input.keyPrefix}-${rowIndex}`,
            text: wrappedLine,
            tone: input.tone,
            bold,
            kind,
          }),
        );
      }
      rowIndex += 1;
      if (rowIndex >= end) return rows;
    }
  }

  return rows;
}
