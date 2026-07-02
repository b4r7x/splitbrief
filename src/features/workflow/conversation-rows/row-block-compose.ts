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
import { wrapWidthFor } from './row-markers.js';

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
  const activeRowKey = [...safeRows].reverse().find(isActiveRow)?.key;
  return {
    key,
    rowCount: safeRows.length,
    renderableUnits: 1,
    ...(activeRowKey !== undefined ? { activeRowKey } : {}),
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
  const activeRowKey = [...safeSeeds].reverse().find((seed) => isActiveKind(seed.kind))?.key;
  return {
    key,
    rowCount: safeSeeds.length,
    renderableUnits: 1,
    ...(activeRowKey !== undefined ? { activeRowKey } : {}),
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
  const wrapWidth = wrapWidthFor(input.kind ?? 'message', input.width);
  const tone = input.tone;
  const bold = input.bold;
  const kind = input.kind;
  const rowCount = countEventWrappedRows(text, wrapWidth);
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
        text,
        width: wrapWidth,
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
  const text = sanitizeRowDisplayText(input.text);
  const wrapWidth = wrapWidthFor('prompt', input.width);
  const rowCount = countEventWrappedRows(text, wrapWidth);
  if (rowCount === 0) return null;
  return {
    key: input.keyPrefix,
    rowCount,
    renderableUnits: 1,
    createRows: (windowStart, windowEnd) => {
      const rows = eventWrappedRowsWindow({
        keyPrefix: input.keyPrefix,
        text,
        width: wrapWidth,
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
  const wrapWidth = wrapWidthFor(input.kind ?? 'card', input.width);
  const labelTone = input.labelTone;
  const valueTone = input.valueTone;
  const kind = input.kind;
  const labelText = value ? `${label}  ` : label;
  const rowCount = countWrappedRowTexts(`${labelText}${value ?? ''}`, wrapWidth);
  if (rowCount === 0) return null;

  return {
    key: keyPrefix,
    rowCount,
    renderableUnits: 1,
    ...(kind !== undefined && isActiveKind(kind)
      ? { activeRowKey: `${keyPrefix}-${rowCount - 1}` }
      : {}),
    createRows: (windowStart, windowEnd) =>
      cardRowsWindow({
        keyPrefix,
        label,
        value,
        width: wrapWidth,
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
    ...lastActiveRowKey(children),
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

function lastActiveRowKey(children: readonly ConversationRowBlock[]): { activeRowKey?: string } {
  const activeRowKey = [...children]
    .reverse()
    .find((block) => block.activeRowKey !== undefined)?.activeRowKey;
  return activeRowKey === undefined ? {} : { activeRowKey };
}

function isActiveRow(rowValue: ConversationRow): boolean {
  return isActiveKind(rowValue.kind);
}

function isActiveKind(kind: ConversationRowKind | undefined): boolean {
  return kind === 'activity' || kind === 'task-header';
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
