import {
  getTerminalCellWidth,
  splitTerminalGraphemes,
  wrapTerminalGraphemes,
} from '../display-text.js';
import { assertNever } from '../type-guards.js';
import {
  appendSegment,
  inlineTokenToSegment,
  measureSegments,
  trimTrailingSpace,
} from './layout-segments.js';
import type {
  MarkdownInlineToken,
  MarkdownLayoutGlyphs,
  MarkdownLayoutLine,
  MarkdownLayoutRow,
  MarkdownLayoutSegment,
  MarkdownTableAlignment,
  MarkdownTableBlock,
  MarkdownTableCell,
} from './types.js';

const MIN_COLUMN_WIDTH = 3;
// Where a token too wide for its column may break before the layout resorts to cutting
// graphemes. The break lands after the punctuation, so the reader keeps the boundary that
// separates the two halves instead of finding a path sliced mid-segment.
const CELL_BREAK_RUN = /[^/\-_.]*[/\-_.]+|[^/\-_.]+/g;

export function layoutMarkdownTable(input: {
  block: MarkdownTableBlock;
  width: number;
  key: string;
  glyphs: MarkdownLayoutGlyphs;
}): MarkdownLayoutRow[] {
  const { block, width, key, glyphs } = input;
  const columnCount = Math.max(block.header.length, ...block.rows.map((row) => row.length));
  if (columnCount === 0) return [];

  const tableWidthLimit = Math.max(1, Math.floor(width));
  const separator = ` ${glyphs.tableColumn} `;
  const separatorWidth = getTerminalCellWidth(separator);
  const minimumWidth =
    MIN_COLUMN_WIDTH * columnCount + separatorWidth * Math.max(0, columnCount - 1);
  if (tableWidthLimit < minimumWidth) {
    return layoutStackedTable({ block, width: tableWidthLimit, key, glyphs });
  }

  const columnWidths = fitColumnWidths(
    naturalColumnWidths(block, columnCount),
    tableWidthLimit,
    separatorWidth,
  );
  const separatorsWidth = separatorWidth * (columnCount - 1);
  const tableWidth = Math.min(
    tableWidthLimit,
    columnWidths.reduce((sum, value) => sum + value, 0) + separatorsWidth,
  );

  const headerLines: MarkdownLayoutLine[] = [
    ...layoutTableCells({
      cells: block.header,
      columnWidths,
      block,
      width: tableWidthLimit,
      header: true,
      separator,
    }),
    {
      segments: [{ kind: 'tableBorder', text: glyphs.divider.repeat(Math.max(1, tableWidth)) }],
    },
  ];

  return [
    makeTableRow(`${key}-header`, headerLines),
    ...block.rows.map((cells, index) =>
      makeTableRow(
        `${key}-${index}`,
        layoutTableCells({
          cells,
          columnWidths,
          block,
          width: tableWidthLimit,
          header: false,
          separator,
        }),
      ),
    ),
  ];
}

function layoutStackedTable(input: {
  block: MarkdownTableBlock;
  width: number;
  key: string;
  glyphs: MarkdownLayoutGlyphs;
}): MarkdownLayoutRow[] {
  const headerLines = stackTableCells({
    cells: input.block.header,
    width: input.width,
    block: input.block,
    header: true,
  });
  const border: MarkdownLayoutLine = {
    segments: [{ kind: 'tableBorder', text: input.glyphs.divider.repeat(input.width) }],
  };
  const rows = input.block.rows.map((cells, index) =>
    makeTableRow(
      `${input.key}-${index}`,
      stackTableCells({ cells, width: input.width, block: input.block, header: false }),
    ),
  );

  return [makeTableRow(`${input.key}-header`, [...headerLines, border]), ...rows];
}

function stackTableCells(input: {
  cells: readonly MarkdownTableCell[];
  width: number;
  block: MarkdownTableBlock;
  header: boolean;
}): MarkdownLayoutLine[] {
  const { cells, width, block, header } = input;
  const lines: MarkdownLayoutLine[] = [];
  for (const [column, cell] of cells.entries()) {
    const wrapped = wrapCellSegments(cellSegments({ cell, header }), width);
    for (const line of wrapped) {
      lines.push({
        segments: trimTrailingSpace(padCellLine(line, width, block.alignments[column] ?? 'left')),
      });
    }
  }
  return lines.length > 0 ? lines : [{ segments: [] }];
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
  separator: string;
}): MarkdownLayoutLine[] {
  const { cells, columnWidths, block, width, header, separator } = input;
  const wrappedCells = columnWidths.map((columnWidth, column) =>
    wrapCellSegments(cellSegments({ cell: cells[column], header }), columnWidth),
  );
  const lineCount = Math.max(1, ...wrappedCells.map((cellLines) => cellLines.length));
  const lines: MarkdownLayoutLine[] = [];

  for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
    const segments: MarkdownLayoutSegment[] = [];
    columnWidths.forEach((columnWidth, column) => {
      if (column > 0) {
        appendSegment(segments, { kind: 'tableBorder', text: separator });
      }
      const cellLine = trimTrailingSpace(wrappedCells[column]?.[lineIndex] ?? []);
      const padded = padCellLine(cellLine, columnWidth, block.alignments[column] ?? 'left');
      for (const segment of padded) appendSegment(segments, segment);
    });
    lines.push(...clampLineToWidth(trimTrailingSpace(segments), width));
  }

  return lines;
}

function cellSegments(input: {
  cell: MarkdownTableCell | undefined;
  header: boolean;
}): MarkdownLayoutSegment[] {
  const { cell, header } = input;
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

function fitColumnWidths(
  natural: readonly number[],
  width: number,
  separatorWidth: number,
): number[] {
  const widths = [...natural];
  const separatorsWidth = separatorWidth * Math.max(0, widths.length - 1);
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

// A cell wraps on words like every other block. A token wider than its column breaks at its
// punctuation first, and only a run with no punctuation left in it falls through to the
// grapheme split, because by then there is nowhere else for it to break.
function wrapCellSegments(
  segments: readonly MarkdownLayoutSegment[],
  maxWidth: number,
): MarkdownLayoutSegment[][] {
  const lines: MarkdownLayoutSegment[][] = [[]];
  let lineWidth = 0;

  const appendPart = (segment: MarkdownLayoutSegment, text: string) => {
    const line = lines[lines.length - 1];
    if (line === undefined) return;
    appendSegment(line, { ...segment, text });
    lineWidth += getTerminalCellWidth(text);
  };

  const appendRun = (segment: MarkdownLayoutSegment, run: string) => {
    const runWidth = getTerminalCellWidth(run);
    if (lineWidth > 0 && lineWidth + runWidth > maxWidth) {
      lines.push([]);
      lineWidth = 0;
    }
    if (runWidth <= maxWidth) {
      appendPart(segment, run);
      return;
    }
    wrapTerminalGraphemes({
      graphemes: splitTerminalGraphemes(run),
      maxWidth,
      initialWidth: lineWidth,
      flush: () => {
        lines.push([]);
        lineWidth = 0;
        return 0;
      },
      append: (grapheme) => appendPart(segment, grapheme),
    });
  };

  for (const segment of segments) {
    for (const part of segment.text.split(/(\s+)/)) {
      if (part.length === 0) continue;
      const partWidth = getTerminalCellWidth(part);

      if (/^\s+$/.test(part)) {
        if (lineWidth === 0) continue;
        if (lineWidth + partWidth > maxWidth) {
          lines.push([]);
          lineWidth = 0;
          continue;
        }
        appendPart(segment, part);
        continue;
      }

      if (partWidth > maxWidth) {
        for (const run of part.match(CELL_BREAK_RUN) ?? [part]) {
          appendRun(segment, run);
        }
        continue;
      }

      if (lineWidth > 0 && lineWidth + partWidth > maxWidth) {
        lines.push([]);
        lineWidth = 0;
      }
      appendPart(segment, part);
    }
  }

  return lines;
}

function hardWrapSegments(
  segments: readonly MarkdownLayoutSegment[],
  maxWidth: number,
): MarkdownLayoutSegment[][] {
  const lines: MarkdownLayoutSegment[][] = [[]];
  let lineWidth = 0;

  for (const segment of segments) {
    wrapTerminalGraphemes({
      graphemes: splitTerminalGraphemes(segment.text),
      maxWidth,
      initialWidth: lineWidth,
      flush: () => {
        lines.push([]);
        lineWidth = 0;
        return 0;
      },
      append: (grapheme) => {
        const line = lines[lines.length - 1];
        if (line === undefined) return;
        appendSegment(line, { ...segment, text: grapheme });
        lineWidth += getTerminalCellWidth(grapheme);
      },
    });
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
