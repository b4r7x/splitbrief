import { getTerminalCellWidth, splitTerminalGraphemes } from '../display-text.js';
import { assertNever } from '../type-guards.js';
import {
  appendSegment,
  inlineTokenToSegment,
  measureSegments,
  trimTrailingSpace,
} from './layout-segments.js';
import type {
  MarkdownInlineToken,
  MarkdownLayoutLine,
  MarkdownLayoutRow,
  MarkdownLayoutSegment,
  MarkdownTableAlignment,
  MarkdownTableBlock,
  MarkdownTableCell,
} from './types.js';

const COLUMN_SEPARATOR = ' \u2502 ';
const COLUMN_SEPARATOR_WIDTH = getTerminalCellWidth(COLUMN_SEPARATOR);
const HEADER_UNDERLINE_CHAR = '\u2500';
const MIN_COLUMN_WIDTH = 3;

export function layoutMarkdownTable(input: {
  block: MarkdownTableBlock;
  width: number;
  key: string;
}): MarkdownLayoutRow[] {
  const { block, width, key } = input;
  const columnCount = Math.max(block.header.length, ...block.rows.map((row) => row.length));
  if (columnCount === 0) return [];

  const columnWidths = fitColumnWidths(naturalColumnWidths(block, columnCount), width);
  const separatorsWidth = COLUMN_SEPARATOR_WIDTH * (columnCount - 1);
  const tableWidth = Math.min(
    width,
    columnWidths.reduce((sum, value) => sum + value, 0) + separatorsWidth,
  );

  const headerLines: MarkdownLayoutLine[] = [
    ...layoutTableCells({ cells: block.header, columnWidths, block, width, header: true }),
    {
      segments: [
        { kind: 'tableBorder', text: HEADER_UNDERLINE_CHAR.repeat(Math.max(1, tableWidth)) },
      ],
    },
  ];

  return [
    makeTableRow(`${key}-header`, headerLines),
    ...block.rows.map((cells, index) =>
      makeTableRow(
        `${key}-${index}`,
        layoutTableCells({ cells, columnWidths, block, width, header: false }),
      ),
    ),
  ];
}

function makeTableRow(key: string, lines: readonly MarkdownLayoutLine[]): MarkdownLayoutRow {
  const safeLines = lines.length > 0 ? lines : [{ segments: [] }];
  return { key, blockKind: 'table', lines: safeLines, height: safeLines.length };
}

function layoutTableCells(input: {
  cells: readonly MarkdownTableCell[];
  columnWidths: readonly number[];
  block: MarkdownTableBlock;
  width: number;
  header: boolean;
}): MarkdownLayoutLine[] {
  const { cells, columnWidths, block, width, header } = input;
  const wrappedCells = columnWidths.map((columnWidth, column) =>
    hardWrapSegments(cellSegments(cells[column], header), columnWidth),
  );
  const lineCount = Math.max(1, ...wrappedCells.map((cellLines) => cellLines.length));
  const lines: MarkdownLayoutLine[] = [];

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const segments: MarkdownLayoutSegment[] = [];
    columnWidths.forEach((columnWidth, column) => {
      if (column > 0) {
        appendSegment(segments, { kind: 'tableBorder', text: COLUMN_SEPARATOR });
      }
      const cellLine = wrappedCells[column]?.[lineIndex] ?? [];
      const padded = padCellLine(cellLine, columnWidth, block.alignments[column] ?? 'left');
      for (const segment of padded) appendSegment(segments, segment);
    });
    lines.push(...clampLineToWidth(trimTrailingSpace(segments), width));
  }

  return lines;
}

function cellSegments(
  cell: MarkdownTableCell | undefined,
  header: boolean,
): MarkdownLayoutSegment[] {
  if (cell === undefined) return [];
  if (header) {
    const text = concatInlineText(cell.inlines);
    return text.length > 0 ? [{ kind: 'tableHeader', text }] : [];
  }
  return cell.inlines.map(inlineTokenToSegment);
}

function concatInlineText(inlines: readonly MarkdownInlineToken[]): string {
  return inlines.map((token) => token.text).join('');
}

function naturalColumnWidths(block: MarkdownTableBlock, columnCount: number): number[] {
  const widths = new Array<number>(columnCount).fill(1);
  const widen = (row: readonly MarkdownTableCell[]) => {
    row.forEach((cell, column) => {
      widths[column] = Math.max(
        widths[column] ?? 1,
        getTerminalCellWidth(concatInlineText(cell.inlines)),
      );
    });
  };
  widen(block.header);
  for (const row of block.rows) widen(row);
  return widths;
}

function fitColumnWidths(natural: readonly number[], width: number): number[] {
  const widths = [...natural];
  const separatorsWidth = COLUMN_SEPARATOR_WIDTH * Math.max(0, widths.length - 1);
  let total = widths.reduce((sum, value) => sum + value, 0) + separatorsWidth;

  while (total > width) {
    let widest = -1;
    for (let column = 0; column < widths.length; column += 1) {
      const candidate = widths[column] ?? 0;
      if (candidate <= MIN_COLUMN_WIDTH) continue;
      if (widest === -1 || candidate > (widths[widest] ?? 0)) widest = column;
    }
    if (widest === -1) break;
    widths[widest] = (widths[widest] ?? 0) - 1;
    total -= 1;
  }

  return widths;
}

function hardWrapSegments(
  segments: readonly MarkdownLayoutSegment[],
  maxWidth: number,
): MarkdownLayoutSegment[][] {
  const lines: MarkdownLayoutSegment[][] = [[]];
  let lineWidth = 0;

  for (const segment of segments) {
    for (const grapheme of splitTerminalGraphemes(segment.text)) {
      const graphemeWidth = getTerminalCellWidth(grapheme);
      if (lineWidth > 0 && lineWidth + graphemeWidth > maxWidth) {
        lines.push([]);
        lineWidth = 0;
      }
      const line = lines[lines.length - 1];
      if (line === undefined) break;
      appendSegment(line, { ...segment, text: grapheme });
      lineWidth += graphemeWidth;
    }
  }

  return lines;
}

function padCellLine(
  segments: readonly MarkdownLayoutSegment[],
  columnWidth: number,
  alignment: MarkdownTableAlignment,
): MarkdownLayoutSegment[] {
  const pad = Math.max(0, columnWidth - measureSegments(segments));
  if (pad === 0) return [...segments];

  switch (alignment) {
    case 'left':
      return [...segments, paddingSegment(pad)];
    case 'right':
      return [paddingSegment(pad), ...segments];
    case 'center': {
      const left = Math.floor(pad / 2);
      const right = pad - left;
      return left > 0
        ? [paddingSegment(left), ...segments, paddingSegment(right)]
        : [...segments, paddingSegment(right)];
    }
    default:
      return assertNever(alignment);
  }
}

function paddingSegment(width: number): MarkdownLayoutSegment {
  return { kind: 'tableBorder', text: ' '.repeat(width) };
}

function clampLineToWidth(segments: MarkdownLayoutSegment[], width: number): MarkdownLayoutLine[] {
  if (measureSegments(segments) <= width) return [{ segments }];
  return hardWrapSegments(segments, width).map((lineSegments) => ({
    segments: trimTrailingSpace(lineSegments),
  }));
}
