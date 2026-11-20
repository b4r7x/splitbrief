import { SOFT_SEP } from '../../../../core/separators.js';
import { getTerminalCellWidth } from '../../../../utils/display-text/width.js';
import { cardRowsLayout, cardRowsWindow } from '../row-format/label-card.js';
import { wrapWidthFor } from '../row-format/markers.js';
import { segmentedRow, blankRow } from '../row-format/rows.js';
import { sanitizeRowDisplayText, wrappedProseSegments } from '../row-format/text.js';
import type {
  ConversationRow,
  ConversationRowBlock,
  ConversationRowSegment,
  ConversationRowKind,
  ConversationRowTone,
} from '../types.js';

export function rowsBlock(
  key: string,
  rows: readonly [ConversationRow, ...ConversationRow[]],
): ConversationRowBlock;
export function rowsBlock(
  key: string,
  rows: readonly ConversationRow[],
): ConversationRowBlock | null;
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

export function wrappedSegmentsBlock(input: {
  keyPrefix: string;
  segments: readonly ConversationRowSegment[];
  width: number;
  kind?: ConversationRowKind;
  indent?: number;
  continuationIndent?: number;
}): ConversationRowBlock | null {
  const kind = input.kind ?? 'message';
  return rowsBlock(
    input.keyPrefix,
    wrappedProseSegments(
      input.segments,
      wrapWidthFor(kind, input.width),
      input.indent,
      input.continuationIndent,
    ).map((segments, index) => segmentedRow(`${input.keyPrefix}-${index}`, segments, kind)),
  );
}

export function wholeSegmentsBlock(
  keyPrefix: string,
  chunks: readonly (readonly ConversationRowSegment[])[],
  width: number,
  kind: ConversationRowKind,
): ConversationRowBlock | null {
  const budget = wrapWidthFor(kind, width);
  const lines: ConversationRowSegment[][] = [];
  let segments: ConversationRowSegment[] = [];
  let cells = 0;
  for (const chunk of chunks) {
    const clean = chunk.map((segment) => ({
      ...segment,
      text: sanitizeRowDisplayText(segment.text),
    }));
    const size = clean.reduce((total, segment) => total + getTerminalCellWidth(segment.text), 0);
    if (cells > 0 && cells + size > budget) {
      lines.push(segments);
      segments = [];
      cells = 0;
    }
    if (cells === 0) {
      const first = clean[0];
      if (first !== undefined) first.text = first.text === SOFT_SEP ? '' : first.text.trimStart();
    }
    for (const [index, parts] of wrappedProseSegments(clean, budget).entries()) {
      if (index > 0) {
        lines.push(segments);
        segments = [];
        cells = 0;
      }
      segments.push(...parts);
      cells += parts.reduce((total, segment) => total + getTerminalCellWidth(segment.text), 0);
    }
  }
  if (segments.length > 0) lines.push(segments);
  return rowsBlock(
    keyPrefix,
    lines.map((parts, index) => segmentedRow(`${keyPrefix}-${index}`, parts, kind)),
  );
}

export function cardRowsBlock(input: {
  keyPrefix: string;
  label: string;
  value: string | undefined;
  width: number;
  labelTone: ConversationRowTone;
  valueTone?: ConversationRowTone;
  kind?: ConversationRowKind;
  markerTone?: ConversationRowTone;
  labelGap?: string | undefined;
  hangValue?: boolean;
}): ConversationRowBlock | null {
  const keyPrefix = input.keyPrefix;
  const wrapWidth = wrapWidthFor(input.kind ?? 'card', input.width);
  const labelTone = input.labelTone;
  const valueTone = input.valueTone;
  const kind = input.kind;
  const markerTone = input.markerTone;
  const layout = cardRowsLayout({
    label: input.label,
    value: input.value,
    width: wrapWidth,
    labelGap: input.labelGap,
    hangValue: input.hangValue,
  });
  const rowCount = layout.wrapped.length;
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
        ...layout,
        labelTone,
        ...(valueTone !== undefined && { valueTone }),
        ...(kind !== undefined && { kind }),
        ...(markerTone !== undefined && { markerTone }),
        windowStart,
        windowEnd,
      }),
  };
}

// One blank row separates consecutive top-level transcript sections, giving the log a calmer
// one-row rhythm. renderableUnits stays 0 so the spacer never registers as a scrolled-past event.
const SECTION_SPACER_ROWS = 1;

/** The blank row that goes before the block keyed `key` when it follows another block. */
export function sectionSpacerBlock(key: string): ConversationRowBlock {
  return {
    key: `spacer-${key}`,
    rowCount: SECTION_SPACER_ROWS,
    renderableUnits: 0,
    createRows: (windowStart, windowEnd) =>
      Array.from({ length: Math.max(0, windowEnd - windowStart) }, (_, offset) =>
        blankRow(`spacer-${key}-${windowStart + offset}`),
      ),
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

export function isActiveKind(kind: ConversationRowKind | undefined): boolean {
  return kind === 'activity' || kind === 'task-header';
}
